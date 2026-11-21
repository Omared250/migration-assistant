// path: nerdlets/home/alerts/Stage2Selection.js
//
// Step 1 picker: the policy/condition tree, preceded by the warning about conditions that
// cannot be migrated. Holds no state.
//
// This is the FIRST thing the user picks, because the keyword/tag filter applies to conditions -
// asking about destinations first made the filter look like it had applied to them too. Nothing
// is created at this point; the supporting items are chosen on the next step.

import React from 'react';
import NonNrqlWarning from './NonNrqlWarning';
import PolicyTree from './PolicyTree';

export default function Stage2Selection({
  policies,
  selectedPolicyIds,
  setSelectedPolicyIds,
  selectedConditionIds,
  setSelectedConditionIds,
  nonNrqlReport,
  targetAccountId,
  filterNotice,
  tagSection,
  onBack,
  onMigrate
}) {
  return (
    <div className="main-card">
      <h3>Step 1: Select Policies &amp; Alert Conditions</h3>
      <p className="card-desc">Review and check exactly which Alert Policies and nested NRQL alert conditions are copied. Baseline conditions are recreated as baseline; static as static. Nothing is written yet — the notification setup is chosen next.</p>

      {filterNotice && (
        <div className="warning-card">
          <h4>ℹ️ This is a filtered subset</h4>
          <p>{filterNotice}</p>
        </div>
      )}


      <NonNrqlWarning report={nonNrqlReport} targetAccountId={targetAccountId} />

      <PolicyTree
        policies={policies}
        selectedPolicyIds={selectedPolicyIds}
        setSelectedPolicyIds={setSelectedPolicyIds}
        selectedConditionIds={selectedConditionIds}
        setSelectedConditionIds={setSelectedConditionIds}
        nonNrqlReport={nonNrqlReport}
      />

      {tagSection}

      <div className="button-group">
        <button onClick={onBack} className="pure-btn plain-btn">Back</button>
        <button onClick={onMigrate} className="pure-btn primary-btn">Next: Destinations, Workflows &amp; Muting Rules</button>
      </div>
    </div>
  );
}
