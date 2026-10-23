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
  mergeTagSets,
  inspectDashboardWidgets,
  countSingleAccountProps,
  buildProvenanceTags,
  ACCOUNT_ID_MODE
} from '../utils';

/**
 * Turns the widget inspection into a sentence for the progress row, or '' when there is
 * nothing to say. Shared by the live and import paths so both report it identically.
 */
/**
 * In ADD mode, widgets whose account reference has no multi-account form. They are re-pointed
 * to the target like REPLACE mode would, so saying nothing would leave the user believing the
 * whole dashboard queries both accounts.
 */
export function describeSingleAccountWidgets(hits, accountIdMode) {
  if (accountIdMode !== ACCOUNT_ID_MODE.ADD || hits.length === 0) return '';

  const where = [...new Set(hits.map(h => h.page))].join(', ');
  return (
    `${hits.length} widget(s) use a custom visualization that accepts only ONE account, so they ` +
    `point at the target account alone rather than both (page: ${where}).`
  );
}

export function describeWidgetIssues(report) {
  const notes = [];

  if (report.inaccessible.length > 0) {
    const where = [...new Set(report.inaccessible.map(w => w.page))].join(', ');
    notes.push(
      `${report.inaccessible.length} of ${report.total} widget(s) could not be copied because ` +
      `New Relic would not return their configuration - you do not have access to what they query ` +
      `(page: ${where}). Recreate them by hand; everything else on those pages came across.`
    );
  }

  if (report.customViz.length > 0) {
    const kinds = [...new Set(report.customViz.map(w => w.vizId))].join(', ');
    notes.push(
      `${report.customViz.length} widget(s) use a custom visualization (${kinds}). They are copied, ` +
      `but will only render if that nerdpack is also deployed in the target account.`
    );
  }

  return notes.join(' ');
}

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
 * @param {string}   args.accountIdMode REPLACE (swap the source account) or ADD (query both)
 * @param {function} args.onProgress    (index, patch) => void
 */
export async function runLiveDashboardMigration({
  client, sourceAccountId, targetAccountId, selected, newTags = [], newTagTargets = null,
  accountIdMode = ACCOUNT_ID_MODE.REPLACE, onProgress
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

      if (!parent.isOrphan) {
        // The dashboard's own entity holds every one of its pages, so copying it is enough -
        // and is the only way to keep page names and order exactly as they are.
        //
        // This used to be gated on `details.pages.length > 1`, which sent every SINGLE-page
        // dashboard down the merge path below and renamed its page to "Overview". Verified
        // against five accounts: in all 30 dashboards the parent entity's page list is
        // complete, so there is nothing to merge.
        input = mapEntityToDashboardInput(details, sourceAccountId, targetAccountId, { accountIdMode });
      } else if (parent.pagesToMigrate && parent.pagesToMigrate.length > 1) {
        // No parent entity at all - the dashboard exists only as "Parent / Page" entities.
        // Merge them into one multi-page dashboard, de-duplicating page names.
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
            const mappedPage = mapPageToDashboardPageInput(innerPage, sourceAccountId, targetAccountId, { accountIdMode });
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
        input = mapEntityToDashboardInput(details, sourceAccountId, targetAccountId, { accountIdMode });
      }

      // Checked before the create so a dashboard made entirely of unreadable widgets fails with
      // the reason rather than quietly arriving empty.
      const widgetReport = inspectDashboardWidgets({ pages: input.pages });
      const sourceReport = inspectDashboardWidgets(details);
      if (sourceReport.total > 0 && sourceReport.copyable === 0) {
        throw new Error(
          `Every one of its ${sourceReport.total} widget(s) is inaccessible - New Relic returned no ` +
          `configuration for any of them, so there is nothing to copy. This usually means the ` +
          `dashboard queries accounts you do not have access to.`
        );
      }

      const result = await createTargetDashboard(client, targetAccountId, input);

      const preserved = sourceGuidsFor(parent).reduce(
        (acc, guid) => mergeTagSets(acc, tagsByGuid.get(guid) || []), []
      );

      // Provenance goes on last so it wins over a copied or user-entered tag of the same name -
      // it records a fact about this migration, not a preference.
      const tags = mergeTagSets(
        resolveTagsForItem({ preserved, newTags, targets: newTagTargets, itemId: parent.guid }),
        buildProvenanceTags({ sourceAccountId, sourceGuid: parent.guid })
      );

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

      // Widgets that could not be copied make this a partial success, not a clean one - the
      // dashboard exists but is missing panels, and that has to be visible.
      const widgetNote = [
        describeWidgetIssues(sourceReport),
        describeSingleAccountWidgets(countSingleAccountProps(details), accountIdMode)
      ].filter(Boolean).join(' ');

      if (widgetNote) {
        onProgress(i, {
          status: 'MANUAL',
          error: `Migrated (new GUID ${result.guid})${tagNote}, with ${widgetReport.total} of ${sourceReport.total} widget(s) copied. ${widgetNote}`
        });
        continue;
      }

      onProgress(i, { status: 'SUCCESS', detail: `Migrated (new GUID ${result.guid})${tagNote}` });
    } catch (err) {
      onProgress(i, { status: 'FAILED', error: err.message });
    }
  }
}
