// path: nerdlets/home/dashboards/runLiveMigration.js
//
// The original same-org dashboards migration, unchanged in behaviour and lifted out of the
// component so all three scenarios (live / export / import) sit side by side as plain
// functions rather than one branching handler.

import {
  fetchSourceDashboard,
  createTargetDashboard,
  mapEntityToDashboardInput,
  mapPageToDashboardPageInput,
  mapVariables
} from '../utils';

/**
 * @param {function} args.onProgress (index, patch) => void
 */
export async function runLiveDashboardMigration({ client, sourceAccountId, targetAccountId, selected, onProgress }) {
  for (let i = 0; i < selected.length; i++) {
    const parent = selected[i];
    onProgress(i, { status: 'MIGRATING' });

    try {
      const details = await fetchSourceDashboard(client, parent.guid);
      let input = null;

      if (details.pages && details.pages.length > 1) {
        input = mapEntityToDashboardInput(details, sourceAccountId, targetAccountId);
      } else if (parent.pagesToMigrate && parent.pagesToMigrate.length > 1) {
        // Legacy tabbed dashboard: several sibling entities named "Parent / Page". Merge
        // them into one multi-page dashboard, de-duplicating page names.
        const combinedPages = [];
        const addedPageNames = new Set();

        for (const subPage of parent.pagesToMigrate) {
          const pageDetails = await fetchSourceDashboard(client, subPage.guid);
          if (!pageDetails?.pages?.length) continue;

          for (const innerPage of pageDetails.pages) {
            let cleanName = innerPage.name;
            if (cleanName.includes(' / ')) {
              cleanName = cleanName.split(' / ').slice(1).join(' / ').trim();
            }
            if (cleanName === parent.name || cleanName.toLowerCase() === 'overview') {
              cleanName = 'Overview';
            }
            if (addedPageNames.has(cleanName.toLowerCase())) continue;

            addedPageNames.add(cleanName.toLowerCase());
            const mappedPage = mapPageToDashboardPageInput(innerPage, sourceAccountId, targetAccountId);
            if (mappedPage) {
              mappedPage.name = cleanName;
              combinedPages.push(mappedPage);
            }
          }
        }

        input = {
          name: parent.name,
          permissions: 'PUBLIC_READ_WRITE',
          pages: combinedPages,
          variables: mapVariables(details.variables || [], sourceAccountId, targetAccountId)
        };
      } else {
        input = mapEntityToDashboardInput(details, sourceAccountId, targetAccountId);
      }

      const result = await createTargetDashboard(client, targetAccountId, input);
      onProgress(i, { status: 'SUCCESS', detail: `Migrated (new GUID ${result.guid})` });
    } catch (err) {
      onProgress(i, { status: 'FAILED', error: err.message });
    }
  }
}
