// path: nerdlets/home/alerts/Stage1Selection.js
//
// Stage 1 picker: destinations, workflows and muting rules.
//
// The selections live in AlertsModule because the migration needs them. The only state
// owned here is which tab is showing, which nothing outside this screen cares about.

import React, { useState } from 'react';
import { canRecreateDestinationType } from '../utils';
import { SelectableList } from '../components';

/** Summarises a muting rule's filter for the selection list. */
function describeMutingRule(rule) {
  const attrs = (rule.condition?.conditions || []).map(c => c.attribute);
  const parts = [];
  if (attrs.length > 0) parts.push(`filters on ${[...new Set(attrs)].join(', ')}`);
  parts.push(rule.schedule ? 'scheduled' : 'always on');
  if (rule.enabled === false) parts.push('disabled');
  return parts.join(' · ');
}

export default function Stage1Selection({
  destinations,
  selectedDestinationIds,
  setSelectedDestinationIds,
  workflows,
  selectedWorkflowIds,
  setSelectedWorkflowIds,
  mutingRules,
  selectedMutingRuleIds,
  setSelectedMutingRuleIds,
  onBack,
  onNext
}) {
  const [tab, setTab] = useState('DESTINATIONS'); // DESTINATIONS | WORKFLOWS | MUTING

  const toggleOne = (setter) => (id) => setter(prev => ({ ...prev, [id]: !prev[id] }));
  const toggleAll = (items, setter) => (selectAll) => {
    const updated = {};
    items.forEach(i => { updated[i.id] = selectAll; });
    setter(updated);
  };

  return (
    <div className="main-card">
      <h3>Stage 1: Select Destinations, Workflows & Muting Rules</h3>
      <p className="card-desc">Choose which communication endpoints, event triggers and muting windows are migrated.</p>

      <div className="alerts-subtabs">
        <button className={`subtab-btn ${tab === 'DESTINATIONS' ? 'active' : ''}`} onClick={() => setTab('DESTINATIONS')}>
          📬 Notification Destinations ({destinations.length})
        </button>
        <button className={`subtab-btn ${tab === 'WORKFLOWS' ? 'active' : ''}`} onClick={() => setTab('WORKFLOWS')}>
          ⚡ Incident Workflows ({workflows.length})
        </button>
        <button className={`subtab-btn ${tab === 'MUTING' ? 'active' : ''}`} onClick={() => setTab('MUTING')}>
          🔇 Muting Rules ({mutingRules.length})
        </button>
      </div>

      {tab === 'DESTINATIONS' && (
        <div className="tab-pane-content">
          <SelectableList
            items={destinations}
            selectedIds={selectedDestinationIds}
            onToggle={toggleOne(setSelectedDestinationIds)}
            onToggleAll={toggleAll(destinations, setSelectedDestinationIds)}
            emptyMessage="No notification destinations found on this account."
            renderItem={(d) => (
              <>
                <strong>{d.name}</strong> <span className="checklist-guid">(Type: {d.type})</span>
                {!canRecreateDestinationType(d.type) && (
                  <span className="badge-tabs" title="NerdGraph never returns auth tokens or webhook secrets, so this destination has to exist in the target account already.">
                    Manual setup required
                  </span>
                )}
              </>
            )}
          />
        </div>
      )}

      {tab === 'WORKFLOWS' && (
        <div className="tab-pane-content">
          <SelectableList
            items={workflows}
            selectedIds={selectedWorkflowIds}
            onToggle={toggleOne(setSelectedWorkflowIds)}
            onToggleAll={toggleAll(workflows, setSelectedWorkflowIds)}
            emptyMessage="No workflows found on this account."
            renderItem={(w) => (
              <>
                <strong>{w.name}</strong> <span className="checklist-guid">(Enabled: {w.workflowEnabled ? 'True' : 'False'})</span>
              </>
            )}
          />
        </div>
      )}

      {tab === 'MUTING' && (
        <div className="tab-pane-content">
          <p className="card-desc">
            Muting rules silence alerts during known windows. If they are left behind, the target
            account will page people for windows that are deliberately quiet in the source.
            Rules are created after the policies they reference, in Stage 2.
          </p>

          <SelectableList
            items={mutingRules}
            selectedIds={selectedMutingRuleIds}
            onToggle={toggleOne(setSelectedMutingRuleIds)}
            onToggleAll={toggleAll(mutingRules, setSelectedMutingRuleIds)}
            emptyMessage="No muting rules found on this account."
            renderItem={(r) => (
              <>
                <strong>{r.name}</strong> <span className="checklist-guid">({describeMutingRule(r)})</span>
              </>
            )}
          />
        </div>
      )}

      <div className="button-group">
        <button onClick={onBack} className="pure-btn plain-btn">Back</button>
        <button onClick={onNext} className="pure-btn primary-btn">Deploy Setup & Proceed to Stage 2</button>
      </div>
    </div>
  );
}
