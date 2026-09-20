// path: nerdlets/home/alerts/ExportSelection.js
//
// Picks what goes into an alerts bundle. Four tabs, one per kind of thing.
//
// Selection happens HERE rather than at import, because export is the pass where the user is
// looking at the account they know. By import time they are in a different organization
// staring at names out of a file, with no way to tell which ones matter.
//
// Cross-tab dependencies are surfaced live: a workflow is only reproducible if the policies it
// filters on and the channels it routes to are also in the bundle. Rather than block the
// selection, the warning names what is missing, since a deliberately partial export is a
// legitimate thing to want.

import React, { useState } from 'react';
import { canRecreateDestinationType } from '../utils';
import { SelectableList } from '../components';
import PolicyTree from './PolicyTree';
import NonNrqlWarning from './NonNrqlWarning';

function describeMutingRule(rule) {
  const attrs = (rule.condition?.conditions || []).map(c => c.attribute);
  const parts = [];
  if (attrs.length > 0) parts.push(`filters on ${[...new Set(attrs)].join(', ')}`);
  parts.push(rule.schedule ? 'scheduled' : 'always on');
  if (rule.enabled === false) parts.push('disabled');
  return parts.join(' · ');
}

export default function ExportSelection({
  inventory,
  selections,
  setSelections,
  accountId,
  filterNotice,
  tagSection,
  onBack,
  onExport
}) {
  const [tab, setTab] = useState('POLICIES');
  const { destinations = [], channels = [], policies = [], workflows = [], mutingRules = [], nonNrqlReport } = inventory;

  const setGroup = (group) => (updater) =>
    setSelections(prev => ({ ...prev, [group]: typeof updater === 'function' ? updater(prev[group]) : updater }));

  const toggleOne = (group) => (id) =>
    setSelections(prev => ({ ...prev, [group]: { ...prev[group], [id]: !prev[group][id] } }));

  const toggleAll = (group, items) => (all) => {
    const updated = {};
    items.forEach(i => { updated[i.id] = all; });
    setSelections(prev => ({ ...prev, [group]: updated }));
  };

  const count = (group, items) => items.filter(i => selections[group][i.id]).length;

  // ---- dependency warnings -----------------------------------------------------
  const selectedPolicyIds = new Set(policies.filter(p => selections.policies[p.id]).map(p => String(p.id)));
  const selectedChannelNames = new Set(
    channels.filter(c => selections.destinations[c.destinationId]).map(c => c.name)
  );
  const channelNameById = new Map(channels.map(c => [String(c.id), c.name]));

  const workflowGaps = workflows
    .filter(w => selections.workflows[w.id])
    .map(w => {
      const missingPolicies = (w.issuesFilter?.predicates || [])
        .filter(p => p.attribute === 'labels.policyIds')
        .flatMap(p => (p.values || []).map(String))
        .filter(id => !selectedPolicyIds.has(id))
        .map(id => policies.find(p => String(p.id) === id)?.name || `policy ${id}`);

      const missingChannels = (w.destinationConfigurations || [])
        .map(dc => channelNameById.get(String(dc.channelId)))
        .filter(name => name && !selectedChannelNames.has(name));

      const missing = [...new Set([...missingPolicies, ...missingChannels])];
      return missing.length ? { name: w.name, missing } : null;
    })
    .filter(Boolean);

  const ruleGaps = mutingRules
    .filter(r => selections.mutingRules[r.id])
    .map(r => {
      const missing = (r.condition?.conditions || [])
        .filter(c => c.attribute === 'policyId')
        .flatMap(c => (c.values || []).map(String))
        .filter(id => !selectedPolicyIds.has(id))
        .map(id => policies.find(p => String(p.id) === id)?.name || `policy ${id}`);
      return missing.length ? { name: r.name, missing: [...new Set(missing)] } : null;
    })
    .filter(Boolean);

  const totalSelected =
    count('destinations', destinations) + count('policies', policies) +
    count('workflows', workflows) + count('mutingRules', mutingRules);

  const channelsIncluded = channels.filter(c => selections.destinations[c.destinationId]).length;

  const TABS = [
    ['POLICIES', `🛡️ Policies (${count('policies', policies)}/${policies.length})`],
    ['DESTINATIONS', `📬 Destinations (${count('destinations', destinations)}/${destinations.length})`],
    ['WORKFLOWS', `⚡ Workflows (${count('workflows', workflows)}/${workflows.length})`],
    ['MUTING', `🔇 Muting Rules (${count('mutingRules', mutingRules)}/${mutingRules.length})`]
  ];

  return (
    <div className="main-card">
      <h3>3. Select What to Export</h3>
      <p className="card-desc">
        Everything checked here is read from account {accountId} and written into the bundle file.
        Nothing is modified. Selected: <strong>{totalSelected}</strong> item(s)
        {channelsIncluded > 0 && <> plus <strong>{channelsIncluded}</strong> channel(s) belonging to the selected destinations</>}.
      </p>

      {filterNotice && (
        <div className="warning-card">
          <h4>ℹ️ The policy list is a filtered subset</h4>
          <p>{filterNotice}</p>
        </div>
      )}

      {(workflowGaps.length > 0 || ruleGaps.length > 0) && (
        <div className="warning-card">
          <h4>⚠️ Incomplete dependencies</h4>
          <p>
            These are selected but reference things that are not. They will export, and fail on import
            unless you add what they need or create it by hand in the target account:
          </p>
          <ul className="warning-list">
            {workflowGaps.map(w => (
              <li key={`w-${w.name}`}>Workflow <strong>{w.name}</strong> needs {w.missing.join(', ')}</li>
            ))}
            {ruleGaps.map(r => (
              <li key={`r-${r.name}`}>Muting rule <strong>{r.name}</strong> needs {r.missing.join(', ')}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="alerts-subtabs">
        {TABS.map(([key, label]) => (
          <button key={key} className={`subtab-btn ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'POLICIES' && (
        <div className="tab-pane-content">
          <NonNrqlWarning report={nonNrqlReport} targetAccountId="the target account" />
          <PolicyTree
            policies={policies}
            selectedPolicyIds={selections.policies}
            setSelectedPolicyIds={setGroup('policies')}
            selectedConditionIds={selections.conditions}
            setSelectedConditionIds={setGroup('conditions')}
            nonNrqlReport={nonNrqlReport}
            verb="exported"
          />
        </div>
      )}

      {tab === 'DESTINATIONS' && (
        <div className="tab-pane-content">
          <p className="card-desc">
            A destination's channels travel with it, so there is no separate channel list. Types that
            hold credentials export by name only - the API never returns their auth tokens.
          </p>
          <SelectableList
            items={destinations}
            selectedIds={selections.destinations}
            onToggle={toggleOne('destinations')}
            onToggleAll={toggleAll('destinations', destinations)}
            emptyMessage="No notification destinations found on this account."
            renderItem={(d) => {
              const owned = channels.filter(c => String(c.destinationId) === String(d.id)).length;
              return (
                <>
                  <strong>{d.name}</strong>
                  <span className="checklist-guid">(Type: {d.type}, {owned} channel(s))</span>
                  {!canRecreateDestinationType(d.type) && (
                    <span className="badge-tabs" title="The API never returns auth tokens or webhook secrets, so this must be created by hand in the target account with the same name.">
                      Name only
                    </span>
                  )}
                </>
              );
            }}
          />
        </div>
      )}

      {tab === 'WORKFLOWS' && (
        <div className="tab-pane-content">
          <SelectableList
            items={workflows}
            selectedIds={selections.workflows}
            onToggle={toggleOne('workflows')}
            onToggleAll={toggleAll('workflows', workflows)}
            emptyMessage="No workflows found on this account."
            renderItem={(w) => (
              <>
                <strong>{w.name}</strong>
                <span className="checklist-guid">
                  ({(w.destinationConfigurations || []).length} channel(s), {w.workflowEnabled ? 'enabled' : 'disabled'})
                </span>
              </>
            )}
          />
        </div>
      )}

      {tab === 'MUTING' && (
        <div className="tab-pane-content">
          <p className="card-desc">
            Muting rules silence alerts during known windows. Leaving them behind means the target
            account pages people for windows that are deliberately quiet in the source.
          </p>
          <SelectableList
            items={mutingRules}
            selectedIds={selections.mutingRules}
            onToggle={toggleOne('mutingRules')}
            onToggleAll={toggleAll('mutingRules', mutingRules)}
            emptyMessage="No muting rules found on this account."
            renderItem={(r) => (
              <>
                <strong>{r.name}</strong> <span className="checklist-guid">({describeMutingRule(r)})</span>
              </>
            )}
          />
        </div>
      )}

      {tagSection}

      <div className="button-group">
        <button onClick={onBack} className="pure-btn plain-btn">Back</button>
        <button onClick={onExport} className="pure-btn primary-btn" disabled={totalSelected === 0}>
          Export Selected &amp; Download Bundle
        </button>
      </div>
    </div>
  );
}
