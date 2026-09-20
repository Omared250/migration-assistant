// path: nerdlets/home/alerts/runStage2Migration.js
//
// Stage 2 orchestration: policies and their conditions, then workflows, then muting rules.
//
// That order is forced by dependencies - workflows and muting rules both reference target
// policy/condition IDs that only exist once step 1 has run. The progress log is addressed
// by index, so `buildStage2TaskList` lives here too: the list order and the loop order are
// the same contract and must not drift apart.

import {
  createTargetAlertPolicy,
  fetchExistingConditionNames,
  fetchSingleConditionDetails,
  createTargetNrqlCondition,
  fetchUserTagsForEntities,
  copyConditionUserTags,
  createTargetWorkflow,
  createTargetMutingRule
} from '../utils';

/**
 * The progress rows for a Stage 2 run, in the exact order runStage2Migration processes them.
 */
export function buildStage2TaskList({ policies, workflows, mutingRules }) {
  return [
    ...policies.map(p => ({ stepName: `Policy: ${p.name}`, status: 'PENDING', error: '', detail: '' })),
    ...workflows.map(w => ({ stepName: `Workflow: ${w.name}`, status: 'PENDING', error: '', detail: '' })),
    ...mutingRules.map(r => ({ stepName: `Muting rule: ${r.name}`, status: 'PENDING', error: '', detail: '' }))
  ];
}

async function migratePolicy({ policy, sourceClient, targetClient, sourceAccountId, targetAccountId, selectedConditionIds, conditionIdMap }) {
  const targetPolicy = await createTargetAlertPolicy(targetClient, targetAccountId, policy.name, policy.incidentPreference);

  const activeConds = (policy.conditions || []).filter(c => selectedConditionIds[c.id]);
  // Read the target policy's existing conditions once, not once per condition.
  const existingNames = await fetchExistingConditionNames(targetClient, targetAccountId, targetPolicy.id);

  // One request for the whole policy's user tags, before anything is created. Creating a
  // condition drops its tags, so they are re-applied to each new condition below.
  const sourceTagsByGuid = await fetchUserTagsForEntities(sourceClient, activeConds.map(c => c.entityGuid));

  let created = 0;
  let reused = 0;
  let tagged = 0;
  const failures = [];
  const degraded = [];
  const tagNotes = [];

  for (const cond of activeConds) {
    try {
      const details = await fetchSingleConditionDetails(sourceClient, sourceAccountId, cond.id);
      const result = await createTargetNrqlCondition(targetClient, targetAccountId, targetPolicy.id, details, existingNames);

      if (result.skipped) reused += 1;
      else created += 1;
      if (result.id) conditionIdMap[cond.id] = result.id;
      if (result.degradedReason) degraded.push(`${cond.name} (${result.degradedReason})`);

      // Only newly created conditions are tagged. A reused one already exists with whatever
      // tags it has, and its guid is not returned by the name lookup.
      const userTags = sourceTagsByGuid.get(cond.entityGuid);
      if (!result.skipped && userTags) {
        const outcome = await copyConditionUserTags(targetClient, result.entityGuid, userTags);
        if (outcome?.written) tagged += outcome.written;
        else if (outcome?.error) tagNotes.push(`${cond.name}: ${outcome.error}`);
      }
    } catch (e) {
      // One bad condition must not abandon the rest of the policy.
      failures.push(`${cond.name}: ${e.message}`);
    }
  }

  const summary = [
    `${created} condition(s) created`,
    reused > 0 ? `${reused} reused` : null,
    tagged > 0 ? `${tagged} tag(s) copied` : null,
    targetPolicy.skipped ? 'policy reused' : 'policy created'
  ].filter(Boolean).join(', ');

  if (failures.length > 0) {
    return {
      targetPolicy,
      patch: {
        status: 'FAILED',
        error: `${summary}. ${failures.length} condition(s) failed - ${failures.join(' | ')}`
      }
    };
  }

  if (degraded.length > 0) {
    // Created, but advanced settings were dropped - do not report a clean success.
    return {
      targetPolicy,
      patch: {
        status: 'MANUAL',
        error: `${summary}, but advanced settings were reset to defaults for: ${degraded.join('; ')}. Review those conditions in the target account.`
      }
    };
  }

  if (tagNotes.length > 0) {
    // The conditions are correct; only their tags did not carry over. Worth flagging, because
    // a tag is often how the user found these conditions in the first place.
    return {
      targetPolicy,
      patch: {
        status: 'MANUAL',
        error: `${summary}, but tags could not be copied for: ${tagNotes.join('; ')}. Add them by hand if you filter on them.`
      }
    };
  }

  return {
    targetPolicy,
    patch: { status: targetPolicy.skipped && created === 0 ? 'SKIPPED' : 'SUCCESS', detail: summary }
  };
}

async function migrateWorkflow({ workflow, targetClient, targetAccountId, policyIdMap, mappedChannels }) {
  const sourceFilter = workflow.issuesFilter || {};

  const unmappedPolicies = [];
  const predicates = (sourceFilter.predicates || []).map(p => {
    if (p.attribute === 'labels.policyIds') {
      const values = (p.values || []).map(val => {
        const mapped = policyIdMap[val];
        if (!mapped) unmappedPolicies.push(val);
        return mapped || val;
      });
      return { ...p, values };
    }
    return p;
  });

  if (unmappedPolicies.length > 0) {
    // Keeping a source policy id here would silently produce a workflow that never matches
    // an issue in the target account.
    throw new Error(
      `It filters on source policy ID(s) ${unmappedPolicies.join(', ')} that were not migrated in this run. ` +
      `Select those policies in Stage 2 and re-run.`
    );
  }

  const destinationConfigurations = (workflow.destinationConfigurations || [])
    .map(dc => ({
      channelId: mappedChannels[dc.channelId],
      notificationTriggers: dc.notificationTriggers
    }))
    .filter(dc => dc.channelId);

  return createTargetWorkflow(targetClient, targetAccountId, {
    name: workflow.name,
    workflowEnabled: workflow.workflowEnabled,
    destinationsEnabled: workflow.destinationsEnabled,
    mutingRulesHandling: workflow.mutingRulesHandling,
    issuesFilter: {
      name: sourceFilter.name,
      type: sourceFilter.type,
      predicates
    },
    destinationConfigurations
  });
}

/**
 * @param {function} args.onProgress  (index, patch) => void, index matching buildStage2TaskList
 */
export async function runStage2Migration({
  sourceClient,
  targetClient,
  sourceAccountId,
  targetAccountId,
  policies,
  selectedConditionIds,
  workflows,
  mutingRules,
  mappedChannels,
  onProgress
}) {
  const policyIdMap = {};
  // Source condition id -> target condition id. Muting rules can reference conditions by
  // id, so this has to include conditions that were reused, not just created.
  const conditionIdMap = {};

  // 1. Policies & conditions
  for (let i = 0; i < policies.length; i++) {
    const policy = policies[i];
    onProgress(i, { status: 'MIGRATING' });

    try {
      const { targetPolicy, patch } = await migratePolicy({
        policy,
        sourceClient,
        targetClient,
        sourceAccountId,
        targetAccountId,
        selectedConditionIds,
        conditionIdMap
      });
      policyIdMap[policy.id] = targetPolicy.id;
      onProgress(i, patch);
    } catch (e) {
      onProgress(i, { status: 'FAILED', error: e.message });
    }
  }

  // 2. Workflows, rebound to the target policies and channels.
  for (let w = 0; w < workflows.length; w++) {
    const idx = policies.length + w;
    onProgress(idx, { status: 'MIGRATING' });

    try {
      const result = await migrateWorkflow({
        workflow: workflows[w],
        targetClient,
        targetAccountId,
        policyIdMap,
        mappedChannels
      });
      onProgress(idx, {
        status: result.skipped ? 'SKIPPED' : 'SUCCESS',
        detail: result.skipped ? 'Matched existing workflow in target' : 'Created in target'
      });
    } catch (e) {
      onProgress(idx, { status: 'FAILED', error: e.message });
    }
  }

  // 3. Muting rules, rebound to the target policies and conditions.
  for (let r = 0; r < mutingRules.length; r++) {
    const idx = policies.length + workflows.length + r;
    onProgress(idx, { status: 'MIGRATING' });

    try {
      const result = await createTargetMutingRule(targetClient, targetAccountId, mutingRules[r], {
        policyIdMap,
        conditionIdMap,
        sourceAccountId
      });
      onProgress(idx, {
        status: result.skipped ? 'SKIPPED' : 'SUCCESS',
        detail: result.skipped ? 'Matched existing muting rule in target' : 'Created in target'
      });
    } catch (e) {
      // A rule that cannot be remapped is reported as needing manual work rather than as a
      // hard failure: leaving it behind is a real risk the user must see.
      onProgress(idx, { status: 'MANUAL', error: e.message });
    }
  }
}
