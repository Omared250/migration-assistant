// path: nerdlets/home/alerts/runStage1Migration.js
//
// Stage 1 orchestration: create the notification destinations and channels in the target
// account, then discover the policies and conditions that Stage 2 will offer.
//
// Deliberately free of React. It reports progress through the `onLog` callback and returns
// plain data, so the ordering rules encoded here can be reasoned about (and tested)
// without mounting a component.

import {
  fetchDestinationsAndChannels,
  fetchSingleDestinationDetails,
  createTargetDestination,
  fetchSingleChannelDetails,
  createTargetChannel,
  discoverAlertPolicies,
  fetchPolicyConditionsList,
  discoverNonNrqlConditions
} from '../utils';

/**
 * @param {object}   args
 * @param {object}   args.sourceClient        NerdGraph client for the source account
 * @param {object}   args.targetClient        NerdGraph client for the target account
 * @param {string}   args.sourceAccountId
 * @param {string}   args.targetAccountId
 * @param {object[]} args.destinations          all destinations discovered in the source
 * @param {object}   args.selectedDestinationIds  { [id]: boolean }
 * @param {object[]} args.selectedWorkflows     workflows the user ticked in Stage 1
 * @param {function} args.onLog                 called with each status row as it happens
 * @returns {Promise<{mappedChannels: object, policies: object[], nonNrqlReport: object}>}
 */
export async function runStage1Migration({
  sourceClient,
  targetClient,
  sourceAccountId,
  targetAccountId,
  destinations,
  selectedDestinationIds,
  selectedWorkflows,
  onLog
}) {
  const targetDestMap = {};
  const mappedChannels = {};

  const { channels } = await fetchDestinationsAndChannels(sourceClient, sourceAccountId);

  // A workflow can only be recreated if the channels it routes to exist in the target.
  // Pull in the destinations behind those channels even when the user did not tick them,
  // otherwise Stage 2 fails with "no channel in target account".
  const channelIdsNeededByWorkflows = new Set();
  selectedWorkflows.forEach(w => {
    (w.destinationConfigurations || []).forEach(dc => {
      if (dc.channelId) channelIdsNeededByWorkflows.add(String(dc.channelId));
    });
  });

  const neededDestIds = new Set(
    destinations.filter(d => selectedDestinationIds[d.id]).map(d => String(d.id))
  );
  const channelsNeeded = channels.filter(
    c => selectedDestinationIds[c.destinationId] || channelIdsNeededByWorkflows.has(String(c.id))
  );
  channelsNeeded.forEach(c => c.destinationId && neededDestIds.add(String(c.destinationId)));

  const destsToProcess = destinations.filter(d => neededDestIds.has(String(d.id)));

  // 1. Destinations
  for (const dest of destsToProcess) {
    const label = `Destination: ${dest.name} (${dest.type})`;
    try {
      const destDetails = await fetchSingleDestinationDetails(sourceClient, sourceAccountId, dest.id);
      const targetDest = await createTargetDestination(
        targetClient,
        targetAccountId,
        destDetails.name,
        destDetails.type,
        destDetails.properties
      );
      targetDestMap[dest.id] = targetDest.id;
      onLog({
        stepName: label,
        status: targetDest.skipped ? 'SKIPPED' : 'SUCCESS',
        detail: targetDest.skipped ? 'Matched existing destination in target' : 'Created in target',
        error: ''
      });
    } catch (e) {
      // A destination holding unreadable credentials is an expected outcome, not a crash -
      // surface it as an actionable warning and keep going.
      onLog({
        stepName: label,
        status: e.manualSetupRequired ? 'MANUAL' : 'FAILED',
        error: e.message,
        detail: ''
      });
    }
  }

  // 2. Channels
  for (const chan of channelsNeeded) {
    const label = `Channel: ${chan.name}`;
    const targetDestId = targetDestMap[chan.destinationId];

    if (!targetDestId) {
      onLog({
        stepName: label,
        status: 'MANUAL',
        error: `Its destination is not available in account ${targetAccountId} yet.`,
        detail: ''
      });
      continue;
    }

    try {
      const chanDetails = await fetchSingleChannelDetails(sourceClient, sourceAccountId, chan.id);
      const targetChannel = await createTargetChannel(
        targetClient,
        targetAccountId,
        chanDetails.name,
        chanDetails.type,
        targetDestId,
        chanDetails.product,
        chanDetails.properties
      );
      mappedChannels[chan.id] = targetChannel.id;
      onLog({
        stepName: label,
        status: targetChannel.skipped ? 'SKIPPED' : 'SUCCESS',
        detail: targetChannel.skipped ? 'Matched existing channel in target' : 'Created in target',
        error: ''
      });
    } catch (e) {
      onLog({ stepName: label, status: 'FAILED', error: e.message, detail: '' });
    }
  }

  // 3. Discover policies & conditions for the Stage 2 checklist.
  const discovered = await discoverAlertPolicies(sourceClient, sourceAccountId, { type: 'ALL' });
  const policies = [];

  for (const p of discovered) {
    let conditions = [];
    try {
      conditions = await fetchPolicyConditionsList(sourceClient, sourceAccountId, p.id);
    } catch (e) {
      console.warn(`Could not list conditions for policy ${p.name}: ${e.message}`);
    }
    policies.push({ ...p, conditions });
  }

  // Identify conditions this tool cannot migrate, so Stage 2 can say so up front rather
  // than reporting a clean success on a half-copied policy.
  const allNrqlIds = policies.flatMap(p => (p.conditions || []).map(c => c.id));
  const nonNrqlReport = await discoverNonNrqlConditions(sourceClient, sourceAccountId, allNrqlIds);

  return { mappedChannels, policies, nonNrqlReport };
}
