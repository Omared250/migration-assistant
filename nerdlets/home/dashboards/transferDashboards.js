// path: nerdlets/home/dashboards/transferDashboards.js
//
// Export and import for dashboards.
//
// Dashboards are far simpler to move than alerts: a dashboard references other things only
// through `accountId`/`accountIds` inside widget queries, and nothing references a dashboard.
// So there are no names to denormalize - the only rewrite needed is the account ID, and that
// is deferred to import, where the real target account is known.
//
// The bundle therefore stores the dashboard exactly as read, plus the source account ID, and
// import runs the same mapEntityToDashboardInput() the live path uses.

import {
  fetchSourceDashboard,
  createTargetDashboard,
  mapEntityToDashboardInput,
  mapPageToDashboardPageInput,
  mapVariables,
  fetchUserTagsForEntities,
  copyUserTagsToEntity,
  resolveTagsForItem,
  mergeTagSets,
  isSelected
} from '../utils';
import { sourceGuidsFor } from './runLiveMigration';

/**
 * Reads full definitions for the selected dashboards, consolidating legacy tab groups the
 * same way the live path does.
 *
 * @param {object[]} args.newTags       [{ key, values }] the user is adding, or []
 * @param {object}   args.newTagTargets { [dashboardGuid]: true }, or null for every dashboard
 * @returns {Promise<{payload: object, warnings: string[]}>}
 */
export async function gatherDashboardsForExport({ client, selected, newTags = [], newTagTargets = null, onLog }) {
  const dashboards = [];
  const warnings = [];

  // Dashboard tags do not survive a create, so they travel in the bundle and are re-applied at
  // import. The per-item choice is resolved here, while guids still mean something - by import
  // time the only identifier left is the name.
  const tagsByGuid = await fetchUserTagsForEntities(client, selected.flatMap(sourceGuidsFor));
  const tagsFor = (parent) => resolveTagsForItem({
    preserved: sourceGuidsFor(parent).reduce((acc, g) => mergeTagSets(acc, tagsByGuid.get(g) || []), []),
    newTags,
    targets: newTagTargets,
    itemId: parent.guid
  });

  for (const parent of selected) {
    try {
      const details = await fetchSourceDashboard(client, parent.guid);
      const userTags = tagsFor(parent);

      // Legacy tabbed dashboards arrive as several sibling entities named "Parent / Page".
      // Consolidate them here so the bundle holds one dashboard, not one per tab.
      if ((!details.pages || details.pages.length <= 1) && parent.pagesToMigrate?.length > 1) {
        const pages = [];
        const seen = new Set();

        for (const subPage of parent.pagesToMigrate) {
          const pageDetails = await fetchSourceDashboard(client, subPage.guid);
          for (const innerPage of pageDetails?.pages || []) {
            let name = innerPage.name;
            if (name.includes(' / ')) name = name.split(' / ').slice(1).join(' / ').trim();
            if (name === parent.name || name.toLowerCase() === 'overview') name = 'Overview';
            if (seen.has(name.toLowerCase())) continue;
            seen.add(name.toLowerCase());
            pages.push({ ...innerPage, name });
          }
        }

        dashboards.push({
          name: parent.name,
          permissions: details.permissions || 'PUBLIC_READ_WRITE',
          pages,
          variables: details.variables || [],
          consolidatedFrom: parent.pagesToMigrate.length,
          ...(userTags.length > 0 ? { userTags } : {})
        });
        onLog({ stepName: parent.name, status: 'SUCCESS', detail: `Exported (${pages.length} pages consolidated from a legacy tab group)`, error: '' });
        continue;
      }

      dashboards.push({
        name: details.name,
        permissions: details.permissions || 'PUBLIC_READ_WRITE',
        pages: details.pages || [],
        variables: details.variables || [],
        ...(userTags.length > 0 ? { userTags } : {})
      });
      onLog({ stepName: parent.name, status: 'SUCCESS', detail: `Exported (${(details.pages || []).length} page(s))`, error: '' });
    } catch (e) {
      onLog({ stepName: parent.name, status: 'FAILED', detail: '', error: e.message });
      warnings.push(`Dashboard "${parent.name}" could not be exported: ${e.message}`);
    }
  }

  return { payload: { dashboards }, warnings };
}

export function buildDashboardImportTaskList(payload, selections) {
  return (payload.dashboards || [])
    .filter(d => isSelected(selections, d.name))
    .map(d => ({ stepName: d.name, status: 'PENDING', error: '', detail: '' }));
}

/**
 * Recreates the bundled dashboards here, rewriting queries from the source account to this
 * one. `sourceAccountId` comes from the bundle envelope.
 */
export async function applyDashboardsBundle({
  client, accountId, payload, selections, sourceAccountId, newTags = [], newTagTargets = null, onProgress
}) {
  const chosen = (payload.dashboards || []).filter(d => isSelected(selections, d.name));

  // Checked once, before anything is created. Without the source account ID there is no way to
  // know which account references to replace, and the old code responded by leaving widgets
  // pointing at the source - producing dashboards that look imported but whose widgets cannot
  // even be opened. Better to refuse the whole import.
  if (!Number.isFinite(parseInt(sourceAccountId, 10))) {
    const message =
      `This bundle does not record which account it came from (source.accountId is missing), so ` +
      `widget queries cannot be re-pointed at account ${accountId}. Re-export it with the current ` +
      `version of the app.`;
    chosen.forEach((_, i) => onProgress(i, { status: 'FAILED', error: message }));
    return;
  }

  for (let i = 0; i < chosen.length; i++) {
    const dashboard = chosen[i];
    onProgress(i, { status: 'MIGRATING' });

    try {
      // Reuse the live path's mappers so the accountId rewriting rules stay in one place.
      const input = mapEntityToDashboardInput(
        {
          name: dashboard.name,
          permissions: dashboard.permissions,
          pages: dashboard.pages,
          variables: dashboard.variables
        },
        sourceAccountId,
        accountId
      );

      const result = await createTargetDashboard(client, accountId, input);

      // Tags recorded at export, merged with anything the importer is adding now. Targeting
      // here is by name - the only identifier a bundle carries.
      const tags = resolveTagsForItem({
        preserved: dashboard.userTags,
        newTags,
        targets: newTagTargets,
        itemId: dashboard.name
      });

      let tagNote = '';
      if (tags.length > 0) {
        const outcome = await copyUserTagsToEntity(client, result.guid, tags);
        if (outcome?.written) tagNote = `, ${outcome.written} tag(s) applied`;
        else if (outcome?.error) {
          onProgress(i, {
            status: 'MANUAL',
            error: `Created (GUID ${result.guid}), but tags could not be applied: ${outcome.error}. Add them by hand if you filter on them.`
          });
          continue;
        }
      }

      onProgress(i, { status: 'SUCCESS', detail: `Created (GUID ${result.guid})${tagNote}` });
    } catch (e) {
      onProgress(i, { status: 'FAILED', error: e.message });
    }
  }
}

// Re-exported so the module can build a single page without duplicating mapper imports.
export { mapPageToDashboardPageInput, mapVariables };
