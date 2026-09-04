// path: nerdlets/home/AlertsModule.js
//
// Owns the alerts flow and all of its state, in three scenarios:
//
//   LIVE    same org + region: read source, write target, two stages (unchanged behaviour)
//   EXPORT  signed into the source: read everything and download a bundle
//   IMPORT  signed into the target: upload a bundle and create from it
//
// The LIVE path keeps its two stages because creation order is forced by dependencies:
//   Stage 1  destinations -> channels          (a workflow needs a target channel id)
//   Stage 2  policies + conditions -> workflows -> muting rules
// IMPORT applies the same chain in one pass, since the bundle already holds everything.

import React, { useState } from 'react';
import { fetchDestinationsAndChannels, discoverWorkflows, discoverMutingRules } from './utils';
import {
  StatusRow, ModuleNavBar, AccountConfigGrid, SingleAccountConfig, BundleDropzone,
  BundleSummary, LoadingCard, ErrorCard, WarningList
} from './components';
import { useMountedGuard } from './hooks';
import { verifyMigrationAccess, verifySingleAccount } from './access';
import ScenarioPicker, { SCENARIO } from './ScenarioPicker';
import { createBundle, downloadBundle, BUNDLE_KIND } from './bundle';
import { runStage1Migration } from './alerts/runStage1Migration';
import { runStage2Migration, buildStage2TaskList } from './alerts/runStage2Migration';
import Stage1Selection from './alerts/Stage1Selection';
import Stage2Selection from './alerts/Stage2Selection';
import ExportSelection from './alerts/ExportSelection';
import { discoverAlertsInventory, gatherAlertsForExport } from './alerts/exportAlerts';
import { applyAlertsBundle, buildImportTaskList } from './alerts/importAlerts';

const EMPTY_NON_NRQL_REPORT = { supported: false, conditions: [] };

const SCENARIO_LABEL = {
  [SCENARIO.LIVE]: 'Same org & region',
  [SCENARIO.EXPORT]: 'Export (pass 1 of 2)',
  [SCENARIO.IMPORT]: 'Import (pass 2 of 2)'
};

const selectAllById = (items) => items.reduce((acc, i) => ({ ...acc, [i.id]: true }), {});
const selectAllByName = (items) => (items || []).reduce((acc, i) => ({ ...acc, [i.name]: true }), {});

// LIVE:   0 setup, 1 stage1 select, 2 stage2 select, 3 working, 4 summary
// EXPORT: 0 setup, 2 select what to export, 3 working, 4 summary
// IMPORT: 0 setup, 3 working, 4 summary  (the whole bundle is applied; selection was at export)
export default function AlertsModule({ client, connection, updateConnection, onExit }) {
  const guard = useMountedGuard();

  const [scenario, setScenario] = useState(null);
  const [step, setStep] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');

  const [destinations, setDestinations] = useState([]);
  const [selectedDestinationIds, setSelectedDestinationIds] = useState({});
  const [workflows, setWorkflows] = useState([]);
  const [selectedWorkflowIds, setSelectedWorkflowIds] = useState({});
  const [mutingRules, setMutingRules] = useState([]);
  const [selectedMutingRuleIds, setSelectedMutingRuleIds] = useState({});
  const [policies, setPolicies] = useState([]);
  const [selectedPolicyIds, setSelectedPolicyIds] = useState({});
  const [selectedConditionIds, setSelectedConditionIds] = useState({});

  const [mappedChannels, setMappedChannels] = useState({});
  const [nonNrqlReport, setNonNrqlReport] = useState(EMPTY_NON_NRQL_REPORT);

  const [notifyProgress, setNotifyProgress] = useState([]);
  const [alertProgress, setAlertProgress] = useState([]);
  const [warnings, setWarnings] = useState([]);

  const [bundle, setBundle] = useState(null);
  // Export inventory (cheap lists) plus what the user ticked. Keyed by source ID, since export
  // runs in the account that owns them.
  const [inventory, setInventory] = useState(null);
  const [exportSelections, setExportSelections] = useState({
    destinations: {}, policies: {}, conditions: {}, workflows: {}, mutingRules: {}
  });

  const { sourceAccountId, targetAccountId } = connection;
  const isImport = scenario === SCENARIO.IMPORT;

  const resetToSetup = () => {
    setStep(0);
    setErrorMsg('');
    setDestinations([]);
    setSelectedDestinationIds({});
    setWorkflows([]);
    setSelectedWorkflowIds({});
    setMutingRules([]);
    setSelectedMutingRuleIds({});
    setPolicies([]);
    setSelectedPolicyIds({});
    setSelectedConditionIds({});
    setMappedChannels({});
    setNonNrqlReport(EMPTY_NON_NRQL_REPORT);
    setNotifyProgress([]);
    setAlertProgress([]);
    setWarnings([]);
    setInventory(null);
    setExportSelections({ destinations: {}, policies: {}, conditions: {}, workflows: {}, mutingRules: {} });
  };

  const chooseScenario = (choice) => {
    setScenario(choice);
    resetToSetup();
    setBundle(null);
  };

  const updateAlertLog = (idx, patch) => {
    guard(() => setAlertProgress(prev => prev.map((row, i) => (i === idx ? { ...row, ...patch } : row))));
  };

  /*************************************************************
   * LIVE
   *************************************************************/
  const handleLiveDiscover = async () => {
    if (!sourceAccountId || !targetAccountId) {
      alert('Both Source and Target Account IDs are required.');
      return;
    }
    setStep(3);
    setErrorMsg('');

    try {
      await verifyMigrationAccess({ client, sourceAccountId, targetAccountId });

      const { destinations: dests } = await fetchDestinationsAndChannels(client, sourceAccountId);
      const wfs = await discoverWorkflows(client, sourceAccountId);

      // Non-fatal: an account may have none, and a read failure here should not block
      // the rest of the migration.
      let rules = [];
      try {
        rules = await discoverMutingRules(client, sourceAccountId);
      } catch (e) {
        console.warn(`Could not read muting rules: ${e.message}`);
      }

      guard(() => {
        setDestinations(dests);
        setSelectedDestinationIds(selectAllById(dests));
        setWorkflows(wfs);
        setSelectedWorkflowIds(selectAllById(wfs));
        setMutingRules(rules);
        setSelectedMutingRuleIds(selectAllById(rules));
        setStep(1);
      });
    } catch (err) {
      guard(() => {
        setErrorMsg(err.message);
        setStep(0);
      });
    }
  };

  const handleLiveStage1 = async () => {
    setStep(3);
    setErrorMsg('');
    setNotifyProgress([]);

    const log = [];
    try {
      const result = await runStage1Migration({
        sourceClient: client,
        targetClient: client,
        sourceAccountId,
        targetAccountId,
        destinations,
        selectedDestinationIds,
        selectedWorkflows: workflows.filter(w => selectedWorkflowIds[w.id]),
        onLog: (entry) => {
          log.push(entry);
          guard(() => setNotifyProgress([...log]));
        }
      });

      const allConditions = result.policies.flatMap(p => p.conditions || []);

      guard(() => {
        setMappedChannels(result.mappedChannels);
        setPolicies(result.policies);
        setSelectedPolicyIds(selectAllById(result.policies));
        setSelectedConditionIds(selectAllById(allConditions));
        setNonNrqlReport(result.nonNrqlReport);
        setStep(2);
      });
    } catch (e) {
      guard(() => {
        setErrorMsg(e.message);
        setStep(1);
      });
    }
  };

  const handleLiveStage2 = async () => {
    const chosenPolicies = policies.filter(p => selectedPolicyIds[p.id]);
    const chosenWorkflows = workflows.filter(w => selectedWorkflowIds[w.id]);
    const chosenRules = mutingRules.filter(r => selectedMutingRuleIds[r.id]);

    setStep(3);
    setErrorMsg('');
    setAlertProgress(buildStage2TaskList({
      policies: chosenPolicies, workflows: chosenWorkflows, mutingRules: chosenRules
    }));

    await runStage2Migration({
      sourceClient: client,
      targetClient: client,
      sourceAccountId,
      targetAccountId,
      policies: chosenPolicies,
      selectedConditionIds,
      workflows: chosenWorkflows,
      mutingRules: chosenRules,
      mappedChannels,
      onProgress: updateAlertLog
    });

    guard(() => setStep(4));
  };

  /*************************************************************
   * EXPORT
   *************************************************************/
  /** STEP 0 -> 2: list what is exportable so the user can choose. */
  const handleExportDiscover = async () => {
    if (!sourceAccountId) {
      alert('An Account ID is required.');
      return;
    }
    setStep(3);
    setErrorMsg('');

    try {
      await verifySingleAccount(client, sourceAccountId);
      const inv = await discoverAlertsInventory({ client, accountId: sourceAccountId });

      guard(() => {
        setInventory(inv);
        setExportSelections({
          destinations: selectAllById(inv.destinations),
          policies: selectAllById(inv.policies),
          conditions: selectAllById(inv.policies.flatMap(p => p.conditions || [])),
          workflows: selectAllById(inv.workflows),
          mutingRules: selectAllById(inv.mutingRules)
        });
        setStep(2);
      });
    } catch (e) {
      guard(() => {
        setErrorMsg(e.message);
        setStep(0);
      });
    }
  };

  /** STEP 2 -> 4: read details for the ticked items and download the bundle. */
  const handleExport = async () => {
    setStep(3);
    setErrorMsg('');
    setAlertProgress([]);

    const log = [];
    try {
      const probe = await verifySingleAccount(client, sourceAccountId);
      const { payload, warnings: notes } = await gatherAlertsForExport({
        client,
        accountId: sourceAccountId,
        inventory,
        selections: exportSelections,
        onLog: (row) => {
          log.push(row);
          guard(() => setAlertProgress([...log]));
        }
      });

      const total =
        payload.destinations.length + payload.policies.length +
        payload.workflows.length + payload.mutingRules.length;
      if (total === 0) throw new Error('Nothing was exported - see the log above.');

      downloadBundle(createBundle({
        kind: BUNDLE_KIND.ALERTS,
        source: {
          accountId: probe.accountId,
          accountName: probe.accountName,
          organizationName: probe.organizationName
        },
        payload
      }));

      guard(() => {
        setWarnings(notes);
        setStep(4);
      });
    } catch (e) {
      guard(() => {
        setErrorMsg(e.message);
        setStep(2);
      });
    }
  };

  /*************************************************************
   * IMPORT - applies the whole bundle; what to move was chosen at export.
   *************************************************************/
  const handleImport = async () => {
    if (!targetAccountId) {
      alert('An Account ID is required.');
      return;
    }
    if (!bundle) {
      alert('Choose a bundle file first.');
      return;
    }

    setStep(3);
    setErrorMsg('');

    try {
      await verifySingleAccount(client, targetAccountId);
      guard(() => setAlertProgress(buildImportTaskList(bundle.payload)));

      await applyAlertsBundle({
        client,
        accountId: targetAccountId,
        payload: bundle.payload,
        onProgress: updateAlertLog
      });

      guard(() => setStep(4));
    } catch (e) {
      guard(() => {
        setErrorMsg(e.message);
        setStep(0);
      });
    }
  };

  if (!scenario) {
    return (
      <div className="layout-body-wrapper">
        <ModuleNavBar label="Alerts & Workflows" onExit={onExit} />
        <ScenarioPicker moduleLabel="alerting configuration" onSelect={chooseScenario} />
      </div>
    );
  }

  return (
    <div className="layout-body-wrapper">
      <ModuleNavBar
        label="Alerts & Workflows"
        scenarioLabel={SCENARIO_LABEL[scenario]}
        onExit={onExit}
        onChangeScenario={() => chooseScenario(null)}
      />
      <ErrorCard title="Migration System Error" message={errorMsg} />

      {step === 0 && scenario === SCENARIO.LIVE && (
        <div className="main-card">
          <h3>2. Source &amp; Target Accounts</h3>
          <p className="card-desc">
            Both accounts must be in the organization and region you are signed into. Notification
            setup is migrated first, then policies, workflows and muting rules.
          </p>
          <AccountConfigGrid
            sourceAccountId={sourceAccountId}
            targetAccountId={targetAccountId}
            onSourceChange={(v) => updateConnection({ sourceAccountId: v })}
            onTargetChange={(v) => updateConnection({ targetAccountId: v })}
          />
          <div className="button-group">
            <button onClick={handleLiveDiscover} className="pure-btn primary-btn">Proceed to Stage 1</button>
          </div>
        </div>
      )}

      {step === 0 && scenario === SCENARIO.EXPORT && (
        <div className="main-card">
          <h3>2. Export from this account</h3>
          <p className="card-desc">
            Lists this account's destinations, policies, conditions, workflows and muting rules so you can
            pick what goes into the bundle. Nothing is written. References are recorded by name, because
            IDs are not shared across organizations.
          </p>
          <SingleAccountConfig
            label="Source account (the one you are signed into)"
            hint="Alerting configuration is read from here."
            accountId={sourceAccountId}
            onChange={(v) => updateConnection({ sourceAccountId: v })}
          />
          <div className="warning-card">
            <h4>ℹ️ What cannot cross an organization boundary</h4>
            <p>
              Destinations that hold credentials (Slack, PagerDuty, webhooks, Jira) are exported by name
              only — the API never returns their auth tokens. Create those by hand in the target account
              with the same names before importing, and the import will link channels to them.
            </p>
          </div>
          <div className="button-group">
            <button onClick={handleExportDiscover} className="pure-btn primary-btn">Continue: Choose What to Export</button>
          </div>
        </div>
      )}

      {step === 0 && isImport && (
        <div className="main-card">
          <h3>2. Import into this account</h3>
          <p className="card-desc">
            Creates everything in the bundle here. What to migrate was chosen during export, so there is
            nothing further to pick - matching items already in this account are reused, not duplicated.
          </p>
          <SingleAccountConfig
            label="Target account (the one you are signed into)"
            hint="Configuration is created here."
            accountId={targetAccountId}
            onChange={(v) => updateConnection({ targetAccountId: v })}
          />
          <BundleDropzone
            expectedKind={BUNDLE_KIND.ALERTS}
            bundle={bundle}
            onLoad={setBundle}
            onClear={() => setBundle(null)}
          />
          {bundle && <BundleSummary bundle={bundle} />}
          <div className="button-group">
            <button onClick={handleImport} className="pure-btn primary-btn" disabled={!bundle}>Create Everything in This Bundle</button>
          </div>
        </div>
      )}

      {step === 1 && scenario === SCENARIO.LIVE && (
        <Stage1Selection
          destinations={destinations}
          selectedDestinationIds={selectedDestinationIds}
          setSelectedDestinationIds={setSelectedDestinationIds}
          workflows={workflows}
          selectedWorkflowIds={selectedWorkflowIds}
          setSelectedWorkflowIds={setSelectedWorkflowIds}
          mutingRules={mutingRules}
          selectedMutingRuleIds={selectedMutingRuleIds}
          setSelectedMutingRuleIds={setSelectedMutingRuleIds}
          onBack={resetToSetup}
          onNext={handleLiveStage1}
        />
      )}


      {step === 2 && scenario === SCENARIO.EXPORT && inventory && (
        <ExportSelection
          inventory={inventory}
          selections={exportSelections}
          setSelections={setExportSelections}
          accountId={sourceAccountId}
          onBack={resetToSetup}
          onExport={handleExport}
        />
      )}

      {step === 2 && scenario === SCENARIO.LIVE && (
        <Stage2Selection
          policies={policies}
          selectedPolicyIds={selectedPolicyIds}
          setSelectedPolicyIds={setSelectedPolicyIds}
          selectedConditionIds={selectedConditionIds}
          setSelectedConditionIds={setSelectedConditionIds}
          notifyProgress={notifyProgress}
          nonNrqlReport={nonNrqlReport}
          targetAccountId={targetAccountId}
          onBack={() => setStep(1)}
          onMigrate={handleLiveStage2}
        />
      )}

      {step === 3 && (
        <LoadingCard
          message={
            scenario === SCENARIO.EXPORT
              ? 'Reading the selected configuration and resolving references to names.'
              : 'Establishing destinations, compiling channels, deploying policies, and rebuilding workflows and muting rules.'
          }
        />
      )}

      {step === 4 && (
        <div className="main-card">
          <h3>{scenario === SCENARIO.EXPORT ? '3. Export Complete' : '3. Process Complete'}</h3>
          <p className="card-desc">
            {scenario === SCENARIO.EXPORT
              ? 'The bundle has been downloaded. Sign in to the target account, open this module there, and choose the import scenario.'
              : 'Review the status for each stage:'}
          </p>

          <WarningList title="Items needing attention in the target account" warnings={warnings} />

          {notifyProgress.length > 0 && (
            <>
              <h4 className="group-heading">Destinations &amp; channels</h4>
              <div className="summary-list">
                {notifyProgress.map((item, i) => <StatusRow key={i} item={item} />)}
              </div>
            </>
          )}

          {alertProgress.length > 0 && (
            <>
              <h4 className="group-heading">
                {scenario === SCENARIO.EXPORT ? 'Exported items' : 'Policies, conditions, workflows & muting rules'}
              </h4>
              <div className="summary-list">
                {alertProgress.map((item, i) => <StatusRow key={i} item={item} />)}
              </div>
            </>
          )}

          <div className="button-group" style={{ justifyContent: 'center', gap: '16px' }}>
            <button onClick={resetToSetup} className="pure-btn plain-btn">Start Over</button>
            <button onClick={onExit} className="pure-btn primary-btn">Go to Home Screen</button>
          </div>
        </div>
      )}
    </div>
  );
}
