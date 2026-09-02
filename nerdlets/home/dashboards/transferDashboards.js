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
  mapVariables
} from '../utils';

/**
 * Reads full definitions for the selected dashboards, consolidating legacy tab groups the
 * same way the live path does.
 *
 * @returns {Promise<{payload: object, warnings: string[]}>}
 */
export async function gatherDashboardsForExport({ client, selected, onLog }) {
  const dashboards = [];
  const warnings = [];

  for (const parent of selected) {
    try {
      const details = await fetchSourceDashboard(client, parent.guid);

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
          consolidatedFrom: parent.pagesToMigrate.length
        });
        onLog({ stepName: parent.name, status: 'SUCCESS', detail: `Exported (${pages.length} pages consolidated from a legacy tab group)`, error: '' });
        continue;
      }

      dashboards.push({
        name: details.name,
        permissions: details.permissions || 'PUBLIC_READ_WRITE',
        pages: details.pages || [],
        variables: details.variables || []
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
    .filter(d => selections[d.name])
    .map(d => ({ stepName: d.name, status: 'PENDING', error: '', detail: '' }));
}

/**
 * Recreates the bundled dashboards here, rewriting queries from the source account to this
 * one. `sourceAccountId` comes from the bundle envelope.
 */
export async function applyDashboardsBundle({ client, accountId, payload, selections, sourceAccountId, onProgress }) {
  const chosen = (payload.dashboards || []).filter(d => selections[d.name]);

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
      onProgress(i, { status: 'SUCCESS', detail: `Created (GUID ${result.guid})` });
    } catch (e) {
      onProgress(i, { status: 'FAILED', error: e.message });
    }
  }
}

// Re-exported so the module can build a single page without duplicating mapper imports.
export { mapPageToDashboardPageInput, mapVariables };
