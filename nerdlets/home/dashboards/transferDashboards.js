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
  isSelected,
  inspectDashboardWidgets,
  countSingleAccountProps,
  buildProvenanceTags,
  ACCOUNT_ID_MODE
} from '../utils';
import { sourceGuidsFor, describeWidgetIssues, describeSingleAccountWidgets } from './runLiveMigration';

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

      // Only when there is no parent entity at all does the dashboard have to be rebuilt from
      // its "Parent / Page" entities. Whenever a parent exists its own page list is complete,
      // so it is exported as-is - see the note in runLiveMigration.
      if (parent.isOrphan && parent.pagesToMigrate?.length > 1) {
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

      // Flagged at export as well as import: the widgets are unreadable in THIS account, so
      // this is where the user can still do something about it.
      const report = inspectDashboardWidgets(details);
      const note = describeWidgetIssues(report);
      if (note) {
        warnings.push(`Dashboard "${parent.name}": ${note}`);
        onLog({
          stepName: parent.name, status: 'MANUAL', detail: '',
          error: `Exported ${(details.pages || []).length} page(s), but ${report.inaccessible.length} widget(s) could not be read. ${note}`
        });
      } else {
        onLog({ stepName: parent.name, status: 'SUCCESS', detail: `Exported (${(details.pages || []).length} page(s))`, error: '' });
      }
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
  client, accountId, payload, selections, sourceAccountId, newTags = [], newTagTargets = null,
  accountIdMode = ACCOUNT_ID_MODE.REPLACE, onProgress
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
      const bundleReport = inspectDashboardWidgets(dashboard);
      if (bundleReport.total > 0 && bundleReport.copyable === 0) {
        throw new Error(
          `Every one of its ${bundleReport.total} widget(s) was recorded as inaccessible when the ` +
          `bundle was exported, so there is nothing to create. Re-export it from an account that ` +
          `can read those widgets.`
        );
      }

      // Reuse the live path's mappers so the accountId rewriting rules stay in one place.
      const input = mapEntityToDashboardInput(
        {
          name: dashboard.name,
          permissions: dashboard.permissions,
          pages: dashboard.pages,
          variables: dashboard.variables
        },
        sourceAccountId,
        accountId,
        { accountIdMode }
      );

      const result = await createTargetDashboard(client, accountId, input);

      // Tags recorded at export, merged with anything the importer is adding now. Targeting
      // here is by name - the only identifier a bundle carries.
      // No source GUID here by design - the bundle carries none - so provenance records the
      // source account and the date only.
      const tags = mergeTagSets(
        resolveTagsForItem({
          preserved: dashboard.userTags,
          newTags,
          targets: newTagTargets,
          itemId: dashboard.name
        }),
        buildProvenanceTags({ sourceAccountId })
      );

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

      // The bundle stores pages exactly as read, so an inaccessible widget recorded at export
      // is still in here - dropped by the mapper above, and reported the same way.
      const widgetNote = [
        describeWidgetIssues(bundleReport),
        describeSingleAccountWidgets(countSingleAccountProps(dashboard), accountIdMode)
      ].filter(Boolean).join(' ');

      if (widgetNote) {
        onProgress(i, {
          status: 'MANUAL',
          error: `Created (GUID ${result.guid})${tagNote}, with ${bundleReport.copyable} of ${bundleReport.total} widget(s). ${widgetNote}`
        });
        continue;
      }

      onProgress(i, { status: 'SUCCESS', detail: `Created (GUID ${result.guid})${tagNote}` });
    } catch (e) {
      onProgress(i, { status: 'FAILED', error: e.message });
    }
  }
}

// Re-exported so the module can build a single page without duplicating mapper imports.
export { mapPageToDashboardPageInput, mapVariables };
