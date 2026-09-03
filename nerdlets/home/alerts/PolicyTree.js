// path: nerdlets/home/alerts/PolicyTree.js
//
// The policy/condition checklist, shared by the live Stage 2 picker and the export picker.
//
// Ticking a policy ticks all of its conditions; ticking a condition implies its policy, since
// a condition cannot exist without one. Non-NRQL conditions are shown greyed out rather than
// hidden - a policy that looks complete but silently drops half its conditions is worse than
// one that says so.

import React from 'react';

export default function PolicyTree({
  policies,
  selectedPolicyIds,
  setSelectedPolicyIds,
  selectedConditionIds,
  setSelectedConditionIds,
  nonNrqlReport,
  verb = 'migrated'
}) {
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
    nonNrqlReport?.supported
      ? nonNrqlReport.conditions.filter(c => String(c.policyId) === String(policyId))
      : [];

  return (
    <>
      <div className="selection-utilities">
        <button onClick={() => toggleAll(true)} className="pure-btn plain-btn small-btn">Select All</button>
        <button onClick={() => toggleAll(false)} className="pure-btn plain-btn small-btn">Deselect All</button>
      </div>

      <div className="alerts-tree-box">
        {policies.length === 0 && (
          <div className="no-conditions-placeholder" style={{ padding: '24px', textAlign: 'center' }}>
            No alert policies found on this account.
          </div>
        )}

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
                    {skipped.length > 0 ? ` It does contain non-NRQL conditions, which cannot be ${verb}.` : ''}
                  </div>
                )}

                {hasNrql && skipped.map(c => (
                  <div key={c.guid} className="condition-node-row skipped-condition">
                    <input type="checkbox" checked={false} disabled readOnly />
                    <span className="condition-node-title">
                      🚫 {c.name} <span className="guid-sub">(not a NRQL condition - will not be {verb})</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
