// path: nerdlets/home/alerts/importAlerts.js
//
// Applies an alerts bundle to the account the user is signed into, resolving the names
// recorded at export back into the IDs created here.
//
// Creation order is the same dependency chain as the live path, and for the same reason:
//   destinations -> channels -> policies + conditions -> workflows -> muting rules
// Workflows need channel and policy IDs; muting rules need policy and condition IDs.
//
// Every create goes through the same createTarget* functions the live path uses, so schema
// handling (static vs baseline conditions, signal timing, the degraded-retry, idempotent
// name matching) is shared rather than reimplemented.

import {
  createTargetDestination,
  createTargetChannel,
  createTargetAlertPolicy,
  createTargetNrqlCondition,
  fetchExistingConditionNames,
  createTargetWorkflow,
  createTargetMutingRule,
  fetchDestinationsAndChannels
} from '../utils';
import { SOURCE_ACCOUNT_SENTINEL } from '../bundle';

/** Progress rows in the exact order applyAlertsBundle processes them. */
export function buildImportTaskList(payload, selections) {
  const rows = [];
  const add = (stepName) => rows.push({ stepName, status: 'PENDING', error: '', detail: '' });

  (payload.destinations || []).filter(d => selections.destinations[d.name]).forEach(d => add(`Destination: ${d.name} (${d.type})`));
  (payload.channels || []).filter(c => selections.destinations[c.destinationName]).forEach(c => add(`Channel: ${c.name}`));
  (payload.policies || []).filter(p => selections.policies[p.name]).forEach(p => add(`Policy: ${p.name}`));
  (payload.workflows || []).filter(w => selections.workflows[w.name]).forEach(w => add(`Workflow: ${w.name}`));
  (payload.mutingRules || []).filter(r => selections.mutingRules[r.name]).forEach(r => add(`Muting rule: ${r.name}`));

  return rows;
}

/**
 * @param {object}   args.client      session client for the target account
 * @param {string}   args.accountId   target account
 * @param {object}   args.payload     bundle payload
 * @param {object}   args.selections  { destinations, policies, workflows, mutingRules } name -> bool
 * @param {function} args.onProgress  (index, patch) => void, indexes matching buildImportTaskList
 */
export async function applyAlertsBundle({ client, accountId, payload, selections, onProgress }) {
  const chosenDestinations = (payload.destinations || []).filter(d => selections.destinations[d.name]);
  const chosenChannels = (payload.channels || []).filter(c => selections.destinations[c.destinationName]);
  const chosenPolicies = (payload.policies || []).filter(p => selections.policies[p.name]);
  const chosenWorkflows = (payload.workflows || []).filter(w => selections.workflows[w.name]);
  const chosenRules = (payload.mutingRules || []).filter(r => selections.mutingRules[r.name]);

  // name -> id, built as we go and consumed by the later phases.
  const destIdByName = new Map();
  const channelIdByName = new Map();
  const policyIdByName = new Map();
  const conditionIdByName = new Map();

  let row = 0;

  // Destinations that already exist here are reused. That is the intended path for the
  // credential-holding types, which cannot be created from a bundle at all.
  const existing = await fetchDestinationsAndChannels(client, accountId).catch(() => ({ destinations: [], channels: [] }));
  const existingDestByName = new Map(
    (existing.destinations || []).map(d => [(d.name || '').trim().toLowerCase(), d])
  );

  // ---- 1. Destinations ---------------------------------------------------------
  for (const dest of chosenDestinations) {
    const idx = row++;
    onProgress(idx, { status: 'MIGRATING' });

    const preexisting = existingDestByName.get((dest.name || '').trim().toLowerCase());
    if (preexisting) {
      destIdByName.set(dest.name, preexisting.id);
      onProgress(idx, { status: 'SKIPPED', detail: 'Already exists in this account - reused' });
      continue;
    }

    if (dest.requiresManualSetup) {
      onProgress(idx, {
        status: 'MANUAL',
        error: `${dest.type} destinations hold credentials the API will not return, so this cannot be created from a bundle. Create it here with the name "${dest.name}", then re-import to link its channels.`
      });
      continue;
    }

    try {
      const created = await createTargetDestination(client, accountId, dest.name, dest.type, dest.properties);
      destIdByName.set(dest.name, created.id);
      onProgress(idx, { status: created.skipped ? 'SKIPPED' : 'SUCCESS', detail: created.skipped ? 'Matched existing destination' : 'Created' });
    } catch (e) {
      onProgress(idx, { status: e.manualSetupRequired ? 'MANUAL' : 'FAILED', error: e.message });
    }
  }

  // ---- 2. Channels -------------------------------------------------------------
  for (const chan of chosenChannels) {
    const idx = row++;
    onProgress(idx, { status: 'MIGRATING' });

    const destId = destIdByName.get(chan.destinationName);
    if (!destId) {
      onProgress(idx, {
        status: 'MANUAL',
        error: `Its destination "${chan.destinationName}" does not exist in this account yet.`
      });
      continue;
    }

    try {
      const created = await createTargetChannel(client, accountId, chan.name, chan.type, destId, chan.product, chan.properties);
      channelIdByName.set(chan.name, created.id);
      onProgress(idx, { status: created.skipped ? 'SKIPPED' : 'SUCCESS', detail: created.skipped ? 'Matched existing channel' : 'Created' });
    } catch (e) {
      onProgress(idx, { status: 'FAILED', error: e.message });
    }
  }

  // ---- 3. Policies & conditions ------------------------------------------------
  for (const policy of chosenPolicies) {
    const idx = row++;
    onProgress(idx, { status: 'MIGRATING' });

    try {
      const targetPolicy = await createTargetAlertPolicy(client, accountId, policy.name, policy.incidentPreference);
      policyIdByName.set(policy.name, targetPolicy.id);

      const existingNames = await fetchExistingConditionNames(client, accountId, targetPolicy.id);
      let created = 0;
      let reused = 0;
      const failures = [];
      const degraded = [];

      for (const cond of policy.conditions || []) {
        try {
          const result = await createTargetNrqlCondition(client, accountId, targetPolicy.id, cond, existingNames);
          if (result.skipped) reused += 1;
          else created += 1;
          if (result.id) conditionIdByName.set(cond.name, result.id);
          if (result.degradedReason) degraded.push(`${cond.name} (${result.degradedReason})`);
        } catch (e) {
          failures.push(`${cond.name}: ${e.message}`);
        }
      }

      const summary = [
        `${created} condition(s) created`,
        reused > 0 ? `${reused} reused` : null,
        targetPolicy.skipped ? 'policy reused' : 'policy created'
      ].filter(Boolean).join(', ');

      if (failures.length > 0) {
        onProgress(idx, { status: 'FAILED', error: `${summary}. ${failures.length} failed - ${failures.join(' | ')}` });
      } else if (degraded.length > 0) {
        onProgress(idx, { status: 'MANUAL', error: `${summary}, but advanced settings were reset to defaults for: ${degraded.join('; ')}. Review those conditions here.` });
      } else {
        onProgress(idx, { status: targetPolicy.skipped && created === 0 ? 'SKIPPED' : 'SUCCESS', detail: summary });
      }
    } catch (e) {
      onProgress(idx, { status: 'FAILED', error: e.message });
    }
  }

  // ---- 4. Workflows ------------------------------------------------------------
  for (const wf of chosenWorkflows) {
    const idx = row++;
    onProgress(idx, { status: 'MIGRATING' });

    try {
      const filter = wf.issuesFilter || {};
      const missingPolicies = [];

      const predicates = (filter.predicates || []).map(p => {
        if (!p.policyNames) return { attribute: p.attribute, operator: p.operator, values: p.values || [] };

        // Translate the exported policy names back into IDs created in this account.
        const values = p.policyNames.map(name => {
          const id = policyIdByName.get(name);
          if (!id) missingPolicies.push(name);
          return id;
        }).filter(Boolean);

        return { attribute: p.attribute, operator: p.operator, values: values.map(String) };
      });

      if (missingPolicies.length > 0) {
        throw new Error(
          `It filters on polic${missingPolicies.length === 1 ? 'y' : 'ies'} ${missingPolicies.join(', ')}, which ` +
          `${missingPolicies.length === 1 ? 'was' : 'were'} not imported. Select ${missingPolicies.length === 1 ? 'it' : 'them'} and re-import, ` +
          `or the workflow would never match an issue here.`
        );
      }

      const destinationConfigurations = (wf.channelRefs || [])
        .map(ref => ({
          channelId: channelIdByName.get(ref.channelName),
          notificationTriggers: ref.notificationTriggers
        }))
        .filter(dc => dc.channelId);

      const created = await createTargetWorkflow(client, accountId, {
        name: wf.name,
        workflowEnabled: wf.workflowEnabled,
        destinationsEnabled: wf.destinationsEnabled,
        mutingRulesHandling: wf.mutingRulesHandling,
        issuesFilter: { name: filter.name, type: filter.type, predicates },
        destinationConfigurations
      });

      onProgress(idx, { status: created.skipped ? 'SKIPPED' : 'SUCCESS', detail: created.skipped ? 'Matched existing workflow' : 'Created' });
    } catch (e) {
      onProgress(idx, { status: 'FAILED', error: e.message });
    }
  }

  // ---- 5. Muting rules ---------------------------------------------------------
  for (const rule of chosenRules) {
    const idx = row++;
    onProgress(idx, { status: 'MIGRATING' });

    try {
      const missing = [];

      // Rebuild the condition group with local IDs. createTargetMutingRule expects live
      // source IDs plus lookup maps, so instead we resolve names here and hand it a rule
      // whose IDs are already correct, with identity maps.
      const conditions = (rule.condition?.conditions || []).map(c => {
        if (c.policyNames) {
          const values = c.policyNames.map(n => {
            const id = policyIdByName.get(n);
            if (!id) missing.push(`policy "${n}"`);
            return id;
          }).filter(Boolean);
          return { attribute: c.attribute, operator: c.operator, values: values.map(String) };
        }

        if (c.conditionNames) {
          const values = c.conditionNames.map(n => {
            const id = conditionIdByName.get(n);
            if (!id) missing.push(`condition "${n}"`);
            return id;
          }).filter(Boolean);
          return { attribute: c.attribute, operator: c.operator, values: values.map(String) };
        }

        const values = (c.values || []).map(v =>
          String(v) === SOURCE_ACCOUNT_SENTINEL ? String(accountId) : String(v)
        );
        return { attribute: c.attribute, operator: c.operator, values };
      });

      if (missing.length > 0) {
        throw new Error(
          `It references ${[...new Set(missing)].join(', ')}, which ${missing.length === 1 ? 'was' : 'were'} not imported. ` +
          `Select ${missing.length === 1 ? 'it' : 'them'} and re-import, or the rule would mute nothing.`
        );
      }

      const created = await createTargetMutingRule(
        client,
        accountId,
        {
          name: rule.name,
          description: rule.description,
          enabled: rule.enabled,
          schedule: rule.schedule,
          condition: { operator: rule.condition?.operator || 'AND', conditions }
        },
        // IDs are already local, so remapping is a no-op.
        { policyIdMap: {}, conditionIdMap: {}, sourceAccountId: accountId, identity: true }
      );

      onProgress(idx, { status: created.skipped ? 'SKIPPED' : 'SUCCESS', detail: created.skipped ? 'Matched existing muting rule' : 'Created' });
    } catch (e) {
      onProgress(idx, { status: 'MANUAL', error: e.message });
    }
  }
}
