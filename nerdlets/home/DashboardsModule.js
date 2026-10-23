// path: nerdlets/home/DashboardsModule.js
//
// Owns the dashboards flow and all of its state, in three scenarios:
//
//   LIVE    same org + region: read source, write target, one pass (unchanged behaviour)
//   EXPORT  signed into the source: read and download a bundle
//   IMPORT  signed into the target: upload a bundle and create from it
//
// LIVE deliberately has no connection-test step - it behaves exactly as it always did, with
// access verified at the moment of migration.

import React, { useState } from 'react';
import {
  discoverDashboards, isSelected, ACCOUNT_ID_MODE,
  fetchProvenanceIndex, annotateAlreadyMigrated
} from './utils';
import {
  ModuleNavBar, AccountConfigGrid, SingleAccountConfig, BundleDropzone,
  BundleSummary, LoadingCard, ErrorCard, WarningList, SelectableList, StatusRow,
  TagAssignment, emptyTagPlan, resolveTagPlan
} from './components';
import { useMountedGuard } from './hooks';
import { verifyMigrationAccess, verifySingleAccount } from './access';
import ScenarioPicker, { SCENARIO } from './ScenarioPicker';
import { createBundle, downloadBundle, BUNDLE_KIND } from './bundle';
import {
  gatherDashboardsForExport,
  applyDashboardsBundle,
  buildDashboardImportTaskList
} from './dashboards/transferDashboards';
import { runLiveDashboardMigration } from './dashboards/runLiveMigration';

const SCENARIO_LABEL = {
  [SCENARIO.LIVE]: 'Same org & region',
  [SCENARIO.EXPORT]: 'Export (pass 1 of 2)',
  [SCENARIO.IMPORT]: 'Import (pass 2 of 2)'
};

// step 0 = setup, 1 = selection, 2 = working, 3 = summary
export default function DashboardsModule({ client, connection, updateConnection, onExit }) {
  const guard = useMountedGuard();

  const [scenario, setScenario] = useState(null);
  const [step, setStep] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');

  const [filterType, setFilterType] = useState('ALL');
  const [keyword, setKeyword] = useState('');
  const [tagKey, setTagKey] = useState('');
  const [tagValue, setTagValue] = useState('');

  const [discovered, setDiscovered] = useState([]);
  const [selectedGuids, setSelectedGuids] = useState({});
  const [progress, setProgress] = useState([]);
  const [warnings, setWarnings] = useState([]);

  const [bundle, setBundle] = useState(null);
  const [selectedNames, setSelectedNames] = useState({});
  // The bundle's dashboards after the already-migrated check, so the list can badge them.
  const [bundleDashboards, setBundleDashboards] = useState([]);

  // New tags the user is adding in this run. Owned by this module, so nothing entered here can
  // reach the alerts migration. Tags a dashboard already had are copied unconditionally and are
  // not part of this.
  const [tagPlan, setTagPlan] = useState(emptyTagPlan());

  // What happens to the source account id inside widget queries. REPLACE is the default and the
  // original behaviour; ADD keeps the source and adds the target so widgets query both.
  const [accountIdMode, setAccountIdMode] = useState(ACCOUNT_ID_MODE.REPLACE);

  const { sourceAccountId, targetAccountId } = connection;
  const isImport = scenario === SCENARIO.IMPORT;

  /** The dashboards this run will create, as the tag picker's item list. */
  const taggableItems = isImport
    ? bundleDashboards.filter(d => isSelected(selectedNames, d.name)).map(d => ({ id: d.name, name: d.name }))
    : discovered.filter(d => selectedGuids[d.guid]).map(d => ({ id: d.guid, name: d.name }));

  const resetToSetup = () => {
    setStep(0);
    setErrorMsg('');
    setDiscovered([]);
    setSelectedGuids({});
    setProgress([]);
    setWarnings([]);
    setSelectedNames({});
    setBundleDashboards([]);
  };

  const chooseScenario = (choice) => {
    setScenario(choice);
    resetToSetup();
    setBundle(null);
    setTagPlan(emptyTagPlan());
  };

  const updateProgress = (i, patch) => {
    guard(() => setProgress(prev => prev.map((row, idx) => (idx === i ? { ...row, ...patch } : row))));
  };

  const validateFilters = () => {
    if (filterType === 'TAG' && (!tagKey.trim() || !tagValue.trim())) {
      alert('Validation Error: Both Tag Key and Tag Value are required.');
      return false;
    }
    if (filterType === 'KEYWORD' && !keyword.trim()) {
      alert('Validation Error: A Keyword is required.');
      return false;
    }
    return true;
  };

  /** LIVE + EXPORT: find dashboards in the account we are reading. */
  const handleDiscover = async () => {
    const isLive = scenario === SCENARIO.LIVE;

    if (!sourceAccountId || (isLive && !targetAccountId)) {
      alert(isLive ? 'Both Source and Target Account IDs are required.' : 'An Account ID is required.');
      return;
    }
    if (!validateFilters()) return;

    setStep(2);
    setErrorMsg('');
    try {
      if (isLive) {
        await verifyMigrationAccess({ client, sourceAccountId, targetAccountId });
      } else {
        await verifySingleAccount(client, sourceAccountId);
      }

      // discoverDashboards throws a precise reason when nothing matches - it is the only place
      // that knows how many dashboards were scanned and which tags the account actually uses.
      const list = await discoverDashboards(client, sourceAccountId, { type: filterType, keyword, tagKey, tagValue });

      // Only meaningful when a target account is known, which is the live path. Export has no
      // target yet, so there is nothing to compare against.
      let annotated = list;
      if (isLive) {
        const index = await fetchProvenanceIndex(client, targetAccountId);
        annotated = annotateAlreadyMigrated(list, index, { sourceAccountId });
      }

      // Already-migrated dashboards start UNTICKED. Migrating one again is legitimate - a
      // second copy in the other account-ID mode, for instance - so they are listed and
      // explained rather than hidden or refused.
      const selection = {};
      annotated.forEach(item => { selection[item.guid] = !item.alreadyMigrated; });

      guard(() => {
        setDiscovered(annotated);
        setSelectedGuids(selection);
        setStep(1);
      });
    } catch (err) {
      guard(() => {
        setErrorMsg(err.message);
        setStep(0);
      });
    }
  };

  const handleLiveMigrate = async () => {
    const selected = discovered.filter(d => selectedGuids[d.guid]);
    if (selected.length === 0) {
      alert('Select at least one dashboard to migrate.');
      return;
    }

    setStep(2);
    setErrorMsg('');
    setProgress(selected.map(d => ({ stepName: d.name, status: 'PENDING', error: '', detail: '' })));

    await runLiveDashboardMigration({
      client, sourceAccountId, targetAccountId, selected,
      ...resolveTagPlan(tagPlan, taggableItems),
      accountIdMode,
      onProgress: updateProgress
    });

    guard(() => setStep(3));
  };

  const handleExport = async () => {
    const selected = discovered.filter(d => selectedGuids[d.guid]);
    if (selected.length === 0) {
      alert('Select at least one dashboard to export.');
      return;
    }

    setStep(2);
    setErrorMsg('');
    setProgress([]);

    const log = [];
    try {
      const probe = await verifySingleAccount(client, sourceAccountId);
      const { payload, warnings: notes } = await gatherDashboardsForExport({
        client,
        selected,
        ...resolveTagPlan(tagPlan, taggableItems),
        onLog: (row) => {
          log.push(row);
          guard(() => setProgress([...log]));
        }
      });

      if (payload.dashboards.length === 0) throw new Error('Nothing could be exported - every dashboard failed to read.');

      downloadBundle(createBundle({
        kind: BUNDLE_KIND.DASHBOARDS,
        source: {
          accountId: probe.accountId,
          accountName: probe.accountName,
          organizationName: probe.organizationName
        },
        payload
      }));

      guard(() => {
        setWarnings(notes);
        setStep(3);
      });
    } catch (e) {
      guard(() => {
        setErrorMsg(e.message);
        setStep(0);
      });
    }
  };

  /** IMPORT: the dropzone already validated the envelope; pick what to create. */
  const handleReviewBundle = async () => {
    if (!targetAccountId) {
      alert('An Account ID is required.');
      return;
    }
    if (!bundle) {
      alert('Choose a bundle file first.');
      return;
    }

    setStep(2);
    setErrorMsg('');
    try {
      await verifySingleAccount(client, targetAccountId);

      // Matched on source account + name here: the bundle carries no source GUIDs.
      const index = await fetchProvenanceIndex(client, targetAccountId);
      const annotated = annotateAlreadyMigrated(
        bundle.payload.dashboards || [], index, { sourceAccountId: bundle.source?.accountId }
      );

      const names = {};
      annotated.forEach(d => { names[d.name] = !d.alreadyMigrated; });

      guard(() => {
        setBundleDashboards(annotated);
        setSelectedNames(names);
        setStep(1);
      });
    } catch (e) {
      guard(() => {
        setErrorMsg(e.message);
        setStep(0);
      });
    }
  };

  const handleImport = async () => {
    const chosen = bundleDashboards.filter(d => isSelected(selectedNames, d.name));
    if (chosen.length === 0) {
      alert('Select at least one dashboard to import.');
      return;
    }

    setStep(2);
    setErrorMsg('');
    setProgress(buildDashboardImportTaskList(bundle.payload, selectedNames));

    await applyDashboardsBundle({
      client,
      accountId: targetAccountId,
      payload: bundle.payload,
      selections: selectedNames,
      sourceAccountId: bundle.source?.accountId,
      ...resolveTagPlan(tagPlan, taggableItems),
      accountIdMode,
      onProgress: updateProgress
    });

    guard(() => setStep(3));
  };

  const toggleGuid = (guid) => setSelectedGuids(prev => ({ ...prev, [guid]: !prev[guid] }));
  const toggleAllGuids = (all) => {
    const updated = {};
    discovered.forEach(d => { updated[d.guid] = all; });
    setSelectedGuids(updated);
  };
  const toggleName = (name) => setSelectedNames(prev => ({ ...prev, [name]: !prev[name] }));
  const toggleAllNames = (all) => {
    const updated = {};
    bundleDashboards.forEach(d => { updated[d.name] = all; });
    setSelectedNames(updated);
  };

  if (!scenario) {
    return (
      <div className="layout-body-wrapper">
        <ModuleNavBar label="Dashboards" onExit={onExit} />
        <ScenarioPicker moduleLabel="dashboards" onSelect={chooseScenario} />
      </div>
    );
  }

  /**
   * Shown wherever widget queries actually get rewritten - the live migration and the import
   * pass. Export does not appear here because it stores dashboards exactly as read; the choice
   * belongs to whoever imports the bundle.
   */
  /** The listed dashboards the target account already holds a copy of. */
  const alreadyMigratedList = (isImport ? bundleDashboards : discovered).filter(d => d.alreadyMigrated);

  const alreadyMigratedNotice = alreadyMigratedList.length > 0 && (
    <div className="warning-card">
      <h4>ℹ️ {alreadyMigratedList.length} dashboard(s) look like they were migrated already</h4>
      <p>
        Account {targetAccountId} already holds a dashboard this tool created from each of these,
        according to the <code>migrated_from_*</code> tags it writes. They are{' '}
        <strong>unticked</strong> — tick one again only if you want a second copy.
      </p>
      <ul className="warning-list">
        {alreadyMigratedList.map(d => (
          <li key={d.guid || d.name}>
            <strong>{d.name}</strong>
            {/* The copy in the target can have been renamed since, so name it when it differs -
                otherwise the user has nothing to go and look at. */}
            {d.alreadyMigrated.name && d.alreadyMigrated.name.trim() !== (d.name || '').trim() && (
              <> → now called <strong>{d.alreadyMigrated.name}</strong> there</>
            )}
            {d.alreadyMigrated.at && <> · migrated {d.alreadyMigrated.at}</>}
            {d.alreadyMigrated.matchedBy === 'name' && <> · matched by name, not by ID</>}
          </li>
        ))}
      </ul>
    </div>
  );

  /** Badge for a dashboard the target already holds. */
  const migratedBadge = (d) => d.alreadyMigrated && (
    <span className="badge-tabs">
      Already migrated{d.alreadyMigrated.at ? ` — ${d.alreadyMigrated.at}` : ''}
      {d.alreadyMigrated.matchedBy === 'name' ? ' (matched by name)' : ''}
    </span>
  );

  const accountModeSection = (
    <div className="filter-strategy-section">
      <h4>Account IDs in widget queries</h4>
      <div className="radio-group-container">
        {[
          [ACCOUNT_ID_MODE.REPLACE, `Point queries at the target account only`],
          [ACCOUNT_ID_MODE.ADD, `Query both accounts (keep the source, add the target)`]
        ].map(([value, text]) => (
          <label className="radio-label" key={value}>
            <input
              type="radio"
              name="accountIdMode"
              value={value}
              checked={accountIdMode === value}
              onChange={() => setAccountIdMode(value)}
            />
            {text}
          </label>
        ))}
      </div>

      {accountIdMode === ACCOUNT_ID_MODE.REPLACE ? (
        <p className="field-hint">
          The source account ID is swapped for the target's wherever it appears in a widget query.
          Any other account a widget already queried is left alone.
        </p>
      ) : (
        <div className="warning-card" style={{ marginBottom: 0 }}>
          <h4>⚠️ Both accounts must be queryable from the target</h4>
          <p>
            The source account ID is kept and the target's added, so each widget queries both. This
            only works where the account you are migrating into has access to the source account —
            which is <strong>never the case across different organizations</strong>. In that
            situation the widgets will load the target's data and error on the source's.
          </p>
        </div>
      )}
    </div>
  );

  const filterSection = (
    <div className="filter-strategy-section">
      <h4>Discovery Strategy</h4>
      <div className="radio-group-container">
        {[['ALL', 'All Dashboards'], ['KEYWORD', 'Filter by Keyword'], ['TAG', 'Filter by Tag Key/Value']].map(([value, text]) => (
          <label className="radio-label" key={value}>
            <input
              type="radio"
              name="filterType"
              value={value}
              checked={filterType === value}
              onChange={() => { setFilterType(value); setKeyword(''); setTagKey(''); setTagValue(''); }}
            />
            {text}
          </label>
        ))}
      </div>

      {filterType === 'KEYWORD' && (
        <div className="conditional-input-box">
          <div className="input-wrapper">
            <label>Keyword</label>
            <input type="text" className="pure-input" placeholder="e.g. Production, Billings, Web" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
          </div>
        </div>
      )}

      {filterType === 'TAG' && (
        <div className="conditional-input-box tag-grid">
          <div className="input-wrapper">
            <label>Tag Key</label>
            <input type="text" className="pure-input" placeholder="e.g. env" value={tagKey} onChange={(e) => setTagKey(e.target.value)} />
          </div>
          <div className="input-wrapper">
            <label>Tag Value</label>
            <input type="text" className="pure-input" placeholder="e.g. production" value={tagValue} onChange={(e) => setTagValue(e.target.value)} />
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="layout-body-wrapper">
      <ModuleNavBar
        label="Dashboards"
        scenarioLabel={SCENARIO_LABEL[scenario]}
        onExit={onExit}
        onChangeScenario={() => chooseScenario(null)}
      />
      <ErrorCard title="Discovery Error" message={errorMsg} />

      {step === 0 && scenario === SCENARIO.LIVE && (
        <div className="main-card">
          <h3>2. Source & Target Accounts</h3>
          <p className="card-desc">Both accounts must be in the organization and region you are signed into.</p>
          <AccountConfigGrid
            sourceAccountId={sourceAccountId}
            targetAccountId={targetAccountId}
            onSourceChange={(v) => updateConnection({ sourceAccountId: v })}
            onTargetChange={(v) => updateConnection({ targetAccountId: v })}
          />
          {filterSection}
          {accountModeSection}
          <div className="button-group">
            <button onClick={handleDiscover} className="pure-btn primary-btn">Search &amp; Fetch Dashboards</button>
          </div>
        </div>
      )}

      {step === 0 && scenario === SCENARIO.EXPORT && (
        <div className="main-card">
          <h3>2. Export from this account</h3>
          <p className="card-desc">Reads the dashboards you select and downloads them as a bundle file. Nothing is written.</p>
          <SingleAccountConfig
            label="Source account (the one you are signed into)"
            hint="Dashboards are read from here."
            accountId={sourceAccountId}
            onChange={(v) => updateConnection({ sourceAccountId: v })}
          />
          {filterSection}
          <div className="button-group">
            <button onClick={handleDiscover} className="pure-btn primary-btn">Search &amp; Fetch Dashboards</button>
          </div>
        </div>
      )}

      {step === 0 && isImport && (
        <div className="main-card">
          <h3>2. Import into this account</h3>
          <p className="card-desc">Creates dashboards here from a bundle exported in the source account. Widget queries are re-pointed to this account automatically.</p>
          <SingleAccountConfig
            label="Target account (the one you are signed into)"
            hint="Dashboards are created here."
            accountId={targetAccountId}
            onChange={(v) => updateConnection({ targetAccountId: v })}
          />
          <BundleDropzone
            expectedKind={BUNDLE_KIND.DASHBOARDS}
            bundle={bundle}
            onLoad={setBundle}
            onClear={() => setBundle(null)}
          />
          {bundle && <BundleSummary bundle={bundle} />}
          <div className="button-group">
            <button onClick={handleReviewBundle} className="pure-btn primary-btn" disabled={!bundle}>Review Bundle Contents</button>
          </div>
        </div>
      )}

      {step === 1 && !isImport && (
        <div className="main-card">
          <h3>3. Select Dashboards</h3>
          <p className="card-desc">
            Found <strong>{discovered.length}</strong> parent dashboard(s).
            {scenario === SCENARIO.EXPORT ? ' Checked items go into the bundle.' : ' Checked items are migrated.'}
          </p>
          {alreadyMigratedNotice}
          <SelectableList
            items={discovered}
            idOf={(d) => d.guid}
            selectedIds={selectedGuids}
            onToggle={toggleGuid}
            onToggleAll={toggleAllGuids}
            emptyMessage="No dashboards found."
            renderItem={(db) => (
              <>
                <strong>{db.name}</strong>
                {/* The count is page ENTITIES grouped under this dashboard. They are pages of
                    it, not separate dashboards, and all of them travel with it. Only an
                    orphan (no parent entity) actually has to be reassembled from them. */}
                {db.isOrphan
                  ? <span className="badge-tabs">Rebuilt from {db.pagesToMigrate.length} page entities</span>
                  : db.pageCount > 1 && <span className="badge-tabs">{db.pageCount - 1} page(s)</span>}
                {/* Without this, a keyword hit on a page name looks like a bug: the dashboard's
                    own name does not contain what was searched for. */}
                {db.matchedOnPage && (
                  <span className="badge-tabs">matched page: {db.matchedOnPage}</span>
                )}
                {migratedBadge(db)}
              </>
            )}
          />
          <TagAssignment noun="dashboards" items={taggableItems} plan={tagPlan} setPlan={setTagPlan} />
          <div className="button-group">
            <button onClick={resetToSetup} className="pure-btn plain-btn">Back</button>
            <button onClick={scenario === SCENARIO.LIVE ? handleLiveMigrate : handleExport} className="pure-btn primary-btn">
              {scenario === SCENARIO.LIVE ? 'Migrate Selected Dashboards' : 'Export Selected & Download Bundle'}
            </button>
          </div>
        </div>
      )}

      {step === 1 && isImport && (
        <div className="main-card">
          <h3>3. Select Dashboards to Create</h3>
          <p className="card-desc">
            The bundle holds <strong>{(bundle.payload.dashboards || []).length}</strong> dashboard(s) from account {bundle.source?.accountId}.
          </p>
          {alreadyMigratedNotice}
          <SelectableList
            items={bundleDashboards}
            idOf={(d) => d.name}
            selectedIds={selectedNames}
            onToggle={toggleName}
            onToggleAll={toggleAllNames}
            emptyMessage="The bundle contains no dashboards."
            renderItem={(d) => (
              <>
                <strong>{d.name}</strong> <span className="checklist-guid">({(d.pages || []).length} page(s))</span>
                {d.consolidatedFrom > 1 && <span className="badge-tabs">Consolidated from {d.consolidatedFrom} tabs</span>}
                {migratedBadge(d)}
              </>
            )}
          />
          {accountModeSection}
          <TagAssignment noun="dashboards" items={taggableItems} plan={tagPlan} setPlan={setTagPlan} />
          <div className="button-group">
            <button onClick={resetToSetup} className="pure-btn plain-btn">Back</button>
            <button onClick={handleImport} className="pure-btn primary-btn">Create Selected Dashboards</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <LoadingCard
          message={
            scenario === SCENARIO.EXPORT
              ? 'Reading dashboard definitions and building the bundle.'
              : 'Querying configurations and rebuilding dashboards in the target account.'
          }
        />
      )}

      {step === 3 && (
        <div className="main-card">
          <h3>4. {scenario === SCENARIO.EXPORT ? 'Export Complete' : 'Migration Complete'}</h3>
          <p className="card-desc">
            {scenario === SCENARIO.EXPORT
              ? 'The bundle has been downloaded. Sign in to the target account, open this module there, and choose the import scenario.'
              : 'Status for each dashboard:'}
          </p>

          <WarningList title="Notes" warnings={warnings} />

          <div className="summary-list">
            {progress.map((item, i) => <StatusRow key={i} item={item} />)}
          </div>

          <div className="button-group" style={{ justifyContent: 'center', gap: '16px' }}>
            <button onClick={resetToSetup} className="pure-btn plain-btn">Start Over</button>
            <button onClick={onExit} className="pure-btn primary-btn">Go to Home Screen</button>
          </div>
        </div>
      )}
    </div>
  );
}
