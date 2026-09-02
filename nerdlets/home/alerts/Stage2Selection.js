// path: nerdlets/home/alerts/Stage2Selection.js
//
// Stage 2 picker: the policy/condition tree, preceded by the Stage 1 result log and the
// warning about conditions that cannot be migrated. Holds no state.

import React from 'react';
import { StatusRow } from '../components';
import NonNrqlWarning from './NonNrqlWarning';

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
  // Ticking a policy ticks all of its conditions; ticking a condition implies its policy.
  const togglePolicy = (policy) => {
    const next = !selectedPolicyIds[policy.id];
    setSelectedPolicyIds(prev => ({ ...prev, [policy.id]: next }));
    setSelectedConditionIds(prev => {
      const updated = { ...prev };
      (policy.conditions || []).forEach(c => { updated[c.id] = next; });
      return updated;
    });
  };

  const toggleCondition = (condition, policyId) => {
    const next = !selectedConditionIds[condition.id];
    setSelectedConditionIds(prev => ({ ...prev, [condition.id]: next }));
    if (next) setSelectedPolicyIds(prev => ({ ...prev, [policyId]: true }));
  };

  const toggleAll = (selectAll) => {
    const updatedP = {};
    const updatedC = {};
    policies.forEach(p => {
      updatedP[p.id] = selectAll;
      (p.conditions || []).forEach(c => { updatedC[c.id] = selectAll; });
    });
    setSelectedPolicyIds(updatedP);
    setSelectedConditionIds(updatedC);
  };

  const nonNrqlForPolicy = (policyId) =>
    nonNrqlReport.supported
      ? nonNrqlReport.conditions.filter(c => String(c.policyId) === String(policyId))
      : [];

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

      <div className="selection-utilities">
        <button onClick={() => toggleAll(true)} className="pure-btn plain-btn small-btn">Select All</button>
        <button onClick={() => toggleAll(false)} className="pure-btn plain-btn small-btn">Deselect All</button>
      </div>

      <div className="alerts-tree-box">
        {policies.map((p) => {
          const skipped = nonNrqlForPolicy(p.id);
          const hasNrql = p.conditions && p.conditions.length > 0;

          return (
            <div key={p.id} className="policy-tree-node">
              <div className="policy-header-row" onClick={() => togglePolicy(p)}>
                <input type="checkbox" checked={!!selectedPolicyIds[p.id]} readOnly />
                <span className="policy-node-title">🛡️ Policy: <strong>{p.name}</strong> <span className="guid-sub">(ID: {p.id})</span></span>
              </div>

              <div className="conditions-list-wrapper">
                {hasNrql ? (
                  p.conditions.map((c) => (
                    <div key={c.id} className="condition-node-row" onClick={() => toggleCondition(c, p.id)}>
                      <input type="checkbox" checked={!!selectedConditionIds[c.id]} readOnly />
                      <span className="condition-node-title">🔹 {c.name}</span>
                    </div>
                  ))
                ) : (
                  <div className="no-conditions-placeholder">
                    No NRQL conditions found under this policy.
                    {skipped.length > 0 ? ' It does contain non-NRQL conditions, which cannot be migrated.' : ''}
                  </div>
                )}

                {hasNrql && skipped.map(c => (
                  <div key={c.guid} className="condition-node-row skipped-condition">
                    <input type="checkbox" checked={false} disabled readOnly />
                    <span className="condition-node-title">
                      🚫 {c.name} <span className="guid-sub">(not a NRQL condition - will not be migrated)</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="button-group">
        <button onClick={onBack} className="pure-btn plain-btn">Back to Stage 1</button>
        <button onClick={onMigrate} className="pure-btn primary-btn">Migrate Selected Alerts System</button>
      </div>
    </div>
  );
}
