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
  mapVariables,
  fetchUserTagsForEntities,
  copyUserTagsToEntity,
  resolveTagsForItem,
  mergeTagSets
} from '../utils';

/**
 * Every source entity a dashboard was built from.
 *
 * A legacy tab group is several sibling entities that become ONE dashboard, so its tags are the
 * union of the siblings' - dropping the tags on merged pages would lose them silently.
 */
export function sourceGuidsFor(parent) {
  const guids = [parent.guid];
  (parent.pagesToMigrate || []).forEach(p => p.guid && guids.push(p.guid));
  return [...new Set(guids.filter(Boolean))];
}

/**
 * @param {object[]} args.newTags       [{ key, values }] the user is adding in this run, or []
 * @param {object}   args.newTagTargets { [dashboardGuid]: true }, or null for every dashboard
 * @param {function} args.onProgress    (index, patch) => void
 */
export async function runLiveDashboardMigration({
  client, sourceAccountId, targetAccountId, selected, newTags = [], newTagTargets = null, onProgress
}) {
  // Source tags for everything being migrated, in as few requests as possible. Creating a
  // dashboard does not carry its tags over - DashboardInput has no tag field - so they are
  // re-applied to each new dashboard below.
  const tagsByGuid = await fetchUserTagsForEntities(client, selected.flatMap(sourceGuidsFor));

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

      const preserved = sourceGuidsFor(parent).reduce(
        (acc, guid) => mergeTagSets(acc, tagsByGuid.get(guid) || []), []
      );
      const tags = resolveTagsForItem({ preserved, newTags, targets: newTagTargets, itemId: parent.guid });

      let tagNote = '';
      if (tags.length > 0) {
        const outcome = await copyUserTagsToEntity(client, result.guid, tags);
        if (outcome?.written) tagNote = `, ${outcome.written} tag(s) applied`;
        else if (outcome?.error) {
          // The dashboard is correct; only its tags did not land. Not a failed migration.
          onProgress(i, {
            status: 'MANUAL',
            error: `Migrated (new GUID ${result.guid}), but tags could not be applied: ${outcome.error}. Add them by hand if you filter on them.`
          });
          continue;
        }
      }

      onProgress(i, { status: 'SUCCESS', detail: `Migrated (new GUID ${result.guid})${tagNote}` });
    } catch (err) {
      onProgress(i, { status: 'FAILED', error: err.message });
    }
  }
}
