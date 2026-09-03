// path: nerdlets/home/alerts/Stage2Selection.js
//
// Stage 2 picker: the policy/condition tree, preceded by the Stage 1 result log and the
// warning about conditions that cannot be migrated. Holds no state.

import React from 'react';
import { StatusRow } from '../components';
import NonNrqlWarning from './NonNrqlWarning';
import PolicyTree from './PolicyTree';

export default function Stage2Selection({
  policies,
  selectedPolicyIds,
  setSelectedPolicyIds,
  selectedConditionIds,
  setSelectedConditionIds,
  notifyProgress,
  nonNrqlReport,
  targetAccountId,
  onBack,
  onMigrate
}) {
  return (
    <div className="main-card">
      <h3>Stage 2: Select Policies & Alert Conditions to Migrate</h3>
      <p className="card-desc">Review and check exactly which Alert Policies and nested NRQL alert conditions are copied. Baseline conditions are recreated as baseline; static as static.</p>

      {notifyProgress.length > 0 && (
        <div style={{ marginBottom: '24px' }}>
          <h4 style={{ fontSize: '14px', margin: '0 0 8px 0' }}>Stage 1 result: notification destinations & channels</h4>
          <div className="summary-list">
            {notifyProgress.map((item, index) => <StatusRow key={index} item={item} />)}
          </div>
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

      <div className="button-group">
        <button onClick={onBack} className="pure-btn plain-btn">Back to Stage 1</button>
        <button onClick={onMigrate} className="pure-btn primary-btn">Migrate Selected Alerts System</button>
      </div>
    </div>
  );
}
