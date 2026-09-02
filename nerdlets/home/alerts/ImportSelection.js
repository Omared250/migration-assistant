// path: nerdlets/home/alerts/ImportSelection.js
//
// Shows what an alerts bundle contains and lets the user choose what to create.
//
// Selection is keyed by NAME, not ID, because a bundle carries no IDs from the source
// account. That is also why the dependency warnings below matter: a workflow selected without
// the policies it filters on cannot be created, and this screen is the last place to catch it.

import React from 'react';
import { SelectableList } from '../components';
import { describeBundleSource } from '../bundle';

export default function ImportSelection({
  bundle,
  selections,
  setSelections,
  onBack,
  onImport
}) {
  const { destinations = [], channels = [], policies = [], workflows = [], mutingRules = [] } = bundle.payload;

  const toggle = (group) => (name) =>
    setSelections(prev => ({ ...prev, [group]: { ...prev[group], [name]: !prev[group][name] } }));

  const toggleAll = (group, items) => (all) => {
    const updated = {};
    items.forEach(i => { updated[i.name] = all; });
    setSelections(prev => ({ ...prev, [group]: updated }));
  };

  // A workflow's policy references and a muting rule's are only satisfiable if those
  // policies are also being created in this pass.
  const selectedPolicyNames = new Set(policies.filter(p => selections.policies[p.name]).map(p => p.name));

  const unmetWorkflowDeps = workflows
    .filter(w => selections.workflows[w.name])
    .map(w => {
      const needed = (w.issuesFilter?.predicates || []).flatMap(p => p.policyNames || []);
      const missing = needed.filter(n => !selectedPolicyNames.has(n));
      return missing.length ? { name: w.name, missing } : null;
    })
    .filter(Boolean);

  const unmetRuleDeps = mutingRules
    .filter(r => selections.mutingRules[r.name])
    .map(r => {
      const needed = (r.condition?.conditions || []).flatMap(c => c.policyNames || []);
      const missing = needed.filter(n => !selectedPolicyNames.has(n));
      return missing.length ? { name: r.name, missing } : null;
    })
    .filter(Boolean);

  const channelsFor = (destName) => channels.filter(c => c.destinationName === destName).length;

  return (
    <div className="main-card">
      <h3>3. Select What to Create</h3>
      <p className="card-desc">From {describeBundleSource(bundle)}</p>

      {(unmetWorkflowDeps.length > 0 || unmetRuleDeps.length > 0) && (
        <div className="warning-card">
          <h4>⚠️ Missing dependencies</h4>
          <p>These items reference policies that are not selected. They will fail rather than be created pointing at nothing:</p>
          <ul className="warning-list">
            {unmetWorkflowDeps.map(w => (
              <li key={`w-${w.name}`}>Workflow <strong>{w.name}</strong> needs {w.missing.join(', ')}</li>
            ))}
            {unmetRuleDeps.map(r => (
              <li key={`r-${r.name}`}>Muting rule <strong>{r.name}</strong> needs {r.missing.join(', ')}</li>
            ))}
          </ul>
        </div>
      )}

      <h4 className="group-heading">Destinations &amp; their channels ({destinations.length})</h4>
      <SelectableList
        items={destinations}
        idOf={(d) => d.name}
        selectedIds={selections.destinations}
        onToggle={toggle('destinations')}
        onToggleAll={toggleAll('destinations', destinations)}
        emptyMessage="The bundle contains no notification destinations."
        renderItem={(d) => (
          <>
            <strong>{d.name}</strong> <span className="checklist-guid">(Type: {d.type}, {channelsFor(d.name)} channel(s))</span>
            {d.requiresManualSetup && (
              <span className="badge-tabs" title="Credentials cannot be read from the API, so this must already exist here with the same name.">
                Must already exist here
              </span>
            )}
          </>
        )}
      />

      <h4 className="group-heading">Alert policies ({policies.length})</h4>
      <SelectableList
        items={policies}
        idOf={(p) => p.name}
        selectedIds={selections.policies}
        onToggle={toggle('policies')}
        onToggleAll={toggleAll('policies', policies)}
        emptyMessage="The bundle contains no alert policies."
        renderItem={(p) => (
          <>
            <strong>{p.name}</strong> <span className="checklist-guid">({(p.conditions || []).length} condition(s))</span>
          </>
        )}
      />

      <h4 className="group-heading">Workflows ({workflows.length})</h4>
      <SelectableList
        items={workflows}
        idOf={(w) => w.name}
        selectedIds={selections.workflows}
        onToggle={toggle('workflows')}
        onToggleAll={toggleAll('workflows', workflows)}
        emptyMessage="The bundle contains no workflows."
        renderItem={(w) => (
          <>
            <strong>{w.name}</strong>
            <span className="checklist-guid">({(w.channelRefs || []).length} channel(s))</span>
          </>
        )}
      />

      <h4 className="group-heading">Muting rules ({mutingRules.length})</h4>
      <SelectableList
        items={mutingRules}
        idOf={(r) => r.name}
        selectedIds={selections.mutingRules}
        onToggle={toggle('mutingRules')}
        onToggleAll={toggleAll('mutingRules', mutingRules)}
        emptyMessage="The bundle contains no muting rules."
        renderItem={(r) => (
          <>
            <strong>{r.name}</strong>
            <span className="checklist-guid">({r.schedule ? 'scheduled' : 'always on'}{r.enabled === false ? ', disabled' : ''})</span>
          </>
        )}
      />

      <div className="button-group">
        <button onClick={onBack} className="pure-btn plain-btn">Back</button>
        <button onClick={onImport} className="pure-btn primary-btn">Create Selected Items</button>
      </div>
    </div>
  );
}
