// path: nerdlets/home/alerts/exportAlerts.js
//
// Reads the selected alerting config out of the account the user is signed into and
// denormalizes every account-scoped ID into the NAME of the thing it points at.
//
// This is the whole trick of cross-org migration. In the live path, a workflow's
// `channelId` can be remapped because both accounts are reachable in one session. Across an
// org boundary nothing is reachable, so a reference has to survive as something reproducible:
//
//   channel.destinationId              -> destinationName
//   workflow.destinationConfigurations -> channelName
//   workflow labels.policyIds          -> policy names
//   mutingRule condition policyId      -> policy names
//   mutingRule condition conditionId   -> condition names
//   mutingRule condition accountId     -> SOURCE_ACCOUNT_SENTINEL
//
// Anything that cannot be named cannot cross, and is reported rather than silently dropped.

import {
  fetchDestinationsAndChannels,
  fetchSingleDestinationDetails,
  fetchSingleChannelDetails,
  discoverAlertPolicies,
  fetchPolicyConditionsList,
  fetchSingleConditionDetails,
  discoverWorkflows,
  discoverMutingRules,
  discoverNonNrqlConditions,
  canRecreateDestinationType
} from '../utils';
import { SOURCE_ACCOUNT_SENTINEL } from '../bundle';

/**
 * Lists everything exportable, without fetching per-item detail.
 *
 * Kept separate from gatherAlertsForExport so the picker can be shown against a cheap list.
 * Detail fetches (condition definitions, destination and channel properties) then happen only
 * for what the user actually ticked.
 */
export async function discoverAlertsInventory({ client, accountId }) {
  const { destinations, channels } = await fetchDestinationsAndChannels(client, accountId);
  const discoveredPolicies = await discoverAlertPolicies(client, accountId, { type: 'ALL' });

  const policies = [];
  for (const p of discoveredPolicies) {
    let conditions = [];
    try {
      conditions = await fetchPolicyConditionsList(client, accountId, p.id);
    } catch (e) {
      console.warn(`Could not list conditions for policy ${p.name}: ${e.message}`);
    }
    policies.push({ ...p, conditions });
  }

  const workflows = await discoverWorkflows(client, accountId);

  // Non-fatal: an account may have none, and a read failure should not block the export.
  let mutingRules = [];
  try {
    mutingRules = await discoverMutingRules(client, accountId);
  } catch (e) {
    console.warn(`Could not read muting rules: ${e.message}`);
  }

  const allNrqlIds = policies.flatMap(p => (p.conditions || []).map(c => c.id));
  const nonNrqlReport = await discoverNonNrqlConditions(client, accountId, allNrqlIds);

  return { destinations, channels, policies, workflows, mutingRules, nonNrqlReport };
}

/**
 * Attributes in a muting rule condition whose values are account-scoped IDs, mapped to the
 * field the name list is written to. Plural, because the values are always an array - and
 * because importAlerts.js reads these exact keys.
 */
const MUTING_ID_ATTRS = { policyId: 'policyNames', conditionId: 'conditionNames' };

/** Attributes that point at a specific source entity and have no cross-org equivalent. */
const MUTING_UNPORTABLE_ATTRS = new Set(['entity.guid', 'entityGuid', 'targetId']);

/**
 * Builds the bundle payload for the selected subset of an inventory.
 *
 * Name maps are built from the FULL inventory, not the selection: a selected workflow may
 * reference an unselected policy, and recording that policy's name (plus a warning) is more
 * useful than writing an unresolvable reference.
 *
 * @param {object}   args.client       session client for the account being exported
 * @param {string}   args.accountId
 * @param {object}   args.inventory    from discoverAlertsInventory
 * @param {object}   args.selections   { destinations, policies, conditions, workflows, mutingRules } id -> bool
 * @param {function} args.onLog        (row) => void, progress for the UI
 * @returns {Promise<{payload: object, warnings: string[]}>}
 */
export async function gatherAlertsForExport({ client, accountId, inventory, selections, onLog }) {
  const warnings = [];
  const log = (stepName, status, detail = '', error = '') => onLog({ stepName, status, detail, error });

  const { destinations, channels, policies: allPolicies, workflows: allWorkflows, mutingRules: allRules } = inventory;
  const picked = (group, id) => !!selections?.[group]?.[id];

  // ---- Destinations & channels -------------------------------------------------
  const destById = new Map(destinations.map(d => [String(d.id), d]));
  const chosenDestinations = destinations.filter(d => picked('destinations', d.id));
  // Channels are not selected directly; they travel with their destination.
  const chosenChannels = channels.filter(c => picked('destinations', c.destinationId));

  const exportedDestinations = [];
  for (const dest of chosenDestinations) {
    try {
      const details = await fetchSingleDestinationDetails(client, accountId, dest.id);
      const portable = canRecreateDestinationType(dest.type);

      exportedDestinations.push({
        name: details.name,
        type: details.type,
        properties: details.properties || [],
        // Recorded so the importer can tell the user which ones it will only match, never
        // create. Secrets are not in `properties` - NerdGraph does not return them.
        requiresManualSetup: !portable
      });

      log(
        `Destination: ${dest.name} (${dest.type})`,
        portable ? 'SUCCESS' : 'MANUAL',
        portable ? 'Exported' : '',
        portable ? '' : 'Credentials cannot be read from the API. Create this destination by hand in the target account with the same name before importing.'
      );
      if (!portable) {
        warnings.push(`Destination "${dest.name}" (${dest.type}) must exist in the target account before import.`);
      }
    } catch (e) {
      log(`Destination: ${dest.name}`, 'FAILED', '', e.message);
    }
  }

  const exportedChannels = [];
  for (const chan of chosenChannels) {
    const parentDest = destById.get(String(chan.destinationId));
    if (!parentDest) {
      log(`Channel: ${chan.name}`, 'FAILED', '', 'Its destination was not found, so it cannot be described by name.');
      continue;
    }

    try {
      const details = await fetchSingleChannelDetails(client, accountId, chan.id);
      exportedChannels.push({
        name: details.name,
        type: details.type,
        product: details.product,
        properties: details.properties || [],
        destinationName: parentDest.name,
        destinationType: parentDest.type
      });
      log(`Channel: ${chan.name}`, 'SUCCESS', `Exported (via destination "${parentDest.name}")`);
    } catch (e) {
      log(`Channel: ${chan.name}`, 'FAILED', '', e.message);
    }
  }

  const channelNameById = new Map(channels.map(c => [String(c.id), c.name]));

  // ---- Policies & conditions ---------------------------------------------------
  const policyNameById = new Map(allPolicies.map(p => [String(p.id), p.name]));
  const conditionNameById = new Map();
  allPolicies.forEach(p => (p.conditions || []).forEach(c => conditionNameById.set(String(c.id), c.name)));

  // Names must resolve for unselected policies too (see the note above), so the map is built
  // from everything while only the ticked policies are actually exported.
  const chosenPolicies = allPolicies.filter(p => picked('policies', p.id));
  const exportedPolicies = [];

  for (const policy of chosenPolicies) {
    const conditions = (policy.conditions || []).filter(c => picked('conditions', c.id));
    const exportedConditions = [];
    const failures = [];

    for (const cond of conditions) {
      try {
        const details = await fetchSingleConditionDetails(client, accountId, cond.id);
        // Stored as fetched. The importer feeds this straight into the same
        // createTargetNrqlCondition() the live path uses, so the schema handling
        // (static vs baseline, signal timing, the degraded-retry) is shared.
        exportedConditions.push(details);
      } catch (e) {
        failures.push(`${cond.name}: ${e.message}`);
      }
    }

    exportedPolicies.push({
      name: policy.name,
      incidentPreference: policy.incidentPreference,
      conditions: exportedConditions
    });

    if (failures.length > 0) {
      log(`Policy: ${policy.name}`, 'FAILED', `${exportedConditions.length} condition(s) exported`, failures.join(' | '));
    } else {
      log(`Policy: ${policy.name}`, 'SUCCESS', `${exportedConditions.length} condition(s) exported`);
    }
  }

  // ---- Workflows ---------------------------------------------------------------
  const exportedWorkflows = [];

  for (const wf of allWorkflows.filter(w => picked('workflows', w.id))) {
    const filter = wf.issuesFilter || {};
    const unresolved = [];

    const predicates = (filter.predicates || []).map(p => {
      if (p.attribute !== 'labels.policyIds') return { ...p, values: (p.values || []).map(String) };

      // Policy IDs are replaced by policy names, and the attribute is marked so the
      // importer knows to translate it back rather than treat the names as literal values.
      const names = (p.values || []).map(id => {
        const name = policyNameById.get(String(id));
        if (!name) unresolved.push(`policy ${id}`);
        return name;
      }).filter(Boolean);

      return { attribute: p.attribute, operator: p.operator, policyNames: names };
    });

    const channelRefs = (wf.destinationConfigurations || []).map(dc => {
      const name = channelNameById.get(String(dc.channelId));
      if (!name) unresolved.push(`channel ${dc.channelId}`);
      return name ? { channelName: name, notificationTriggers: dc.notificationTriggers } : null;
    }).filter(Boolean);

    if (unresolved.length > 0) {
      log(`Workflow: ${wf.name}`, 'MANUAL', '', `References ${[...new Set(unresolved)].join(', ')} that could not be resolved to a name, so those links will be missing after import.`);
      warnings.push(`Workflow "${wf.name}" has references that could not be named.`);
    }

    exportedWorkflows.push({
      name: wf.name,
      workflowEnabled: wf.workflowEnabled,
      destinationsEnabled: wf.destinationsEnabled,
      mutingRulesHandling: wf.mutingRulesHandling,
      issuesFilter: { name: filter.name, type: filter.type, predicates },
      channelRefs
    });

    if (unresolved.length === 0) log(`Workflow: ${wf.name}`, 'SUCCESS', 'Exported');
  }

  // ---- Muting rules ------------------------------------------------------------
  const exportedMutingRules = [];
  for (const rule of allRules.filter(r => picked('mutingRules', r.id))) {
    const group = rule.condition;
    if (!group?.conditions?.length) {
      log(`Muting rule: ${rule.name}`, 'FAILED', '', 'Rule has no conditions.');
      continue;
    }

    let unportable = null;
    const unresolved = [];

    const conditions = group.conditions.map(c => {
      const values = (c.values || []).map(String);

      if (MUTING_UNPORTABLE_ATTRS.has(c.attribute)) {
        unportable = c.attribute;
        return { attribute: c.attribute, operator: c.operator, values };
      }

      if (c.attribute === 'accountId') {
        // Substituted at import with the real target account ID.
        return {
          attribute: c.attribute,
          operator: c.operator,
          values: values.map(v => (String(v) === String(accountId) ? SOURCE_ACCOUNT_SENTINEL : v))
        };
      }

      const nameField = MUTING_ID_ATTRS[c.attribute];
      if (nameField) {
        const lookup = c.attribute === 'policyId' ? policyNameById : conditionNameById;
        const names = values.map(id => {
          const name = lookup.get(String(id));
          if (!name) unresolved.push(`${c.attribute} ${id}`);
          return name;
        }).filter(Boolean);
        return { attribute: c.attribute, operator: c.operator, [nameField]: names };
      }

      return { attribute: c.attribute, operator: c.operator, values };
    });

    if (unportable) {
      log(`Muting rule: ${rule.name}`, 'MANUAL', '', `Targets specific source entities via "${unportable}", which has no equivalent in another organization. Recreate this rule by hand.`);
      warnings.push(`Muting rule "${rule.name}" targets source entities directly and cannot be imported.`);
      continue;
    }
    if (unresolved.length > 0) {
      log(`Muting rule: ${rule.name}`, 'MANUAL', '', `References ${[...new Set(unresolved)].join(', ')} that could not be resolved to a name.`);
      warnings.push(`Muting rule "${rule.name}" has references that could not be named.`);
      continue;
    }

    exportedMutingRules.push({
      name: rule.name,
      description: rule.description,
      enabled: rule.enabled,
      schedule: rule.schedule,
      condition: { operator: group.operator || 'AND', conditions }
    });
    log(`Muting rule: ${rule.name}`, 'SUCCESS', 'Exported');
  }

  return {
    payload: {
      destinations: exportedDestinations,
      channels: exportedChannels,
      policies: exportedPolicies,
      workflows: exportedWorkflows,
      mutingRules: exportedMutingRules
    },
    warnings
  };
}
