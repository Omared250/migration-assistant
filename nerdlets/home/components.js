// path: nerdlets/home/components.js
//
// Presentational pieces shared by the Dashboards and Alerts modules. Nothing here holds
// migration state or talks to NerdGraph.

import React, { useRef, useState } from 'react';
import { describeBundleSource, readBundleFile, validateBundle } from './bundle';
import { normalizeNewTags } from './utils';

/** An empty tag plan. Each module holds its own, so alerts tags never reach dashboards. */
export const emptyTagPlan = () => ({
  enabled: false,
  rows: [{ key: '', value: '' }],
  applyToAll: true,
  selectedIds: {}
});

/**
 * "Do you want to add new tags?" and, if so, which tags on which items.
 *
 * Deliberately gated behind an explicit no/yes rather than an always-visible editor: the
 * default has to be the flow that existed before, so a user who does not care about tags sees
 * one extra question and nothing else.
 *
 * This is ONLY about new tags the user is inventing now. Tags an item already carried in the
 * source are copied unconditionally by the migration itself and are not represented here.
 *
 * @param {string}   props.noun      what is being tagged, for the copy ("dashboards")
 * @param {object[]} props.items     [{ id, name }] the items this run will create
 * @param {object}   props.plan      { enabled, rows, applyToAll, selectedIds }
 */
export function TagAssignment({ noun, items = [], plan, setPlan }) {
  const { enabled, rows, applyToAll, selectedIds } = plan;
  const { tags, rejected } = normalizeNewTags(rows);

  const patch = (changes) => setPlan({ ...plan, ...changes });
  const setRow = (i, field, value) =>
    patch({ rows: rows.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)) });

  const targetCount = applyToAll ? items.length : items.filter(it => selectedIds[it.id]).length;

  return (
    <div className="filter-strategy-section">
      <h4>Add new tags to the migrated {noun}?</h4>
      <p className="field-hint">
        Tags the {noun} already have in the source account are always copied across — this is for
        tags you want to add, such as <code>migrated_from</code> or an owning team.
      </p>

      <div className="radio-group-container">
        {[[false, 'No, migrate without adding tags'], [true, 'Yes, add tags']].map(([value, text]) => (
          <label className="radio-label" key={String(value)}>
            <input
              type="radio"
              name={`addTags-${noun}`}
              checked={enabled === value}
              onChange={() => patch({ enabled: value })}
            />
            {text}
          </label>
        ))}
      </div>

      {enabled && (
        <div className="conditional-input-box">
          {rows.map((row, i) => (
            <div key={i} className="tag-grid" style={{ marginBottom: '8px' }}>
              <div className="input-wrapper">
                <label>Tag Key</label>
                <input
                  type="text"
                  className="pure-input"
                  placeholder="e.g. migrated_from"
                  value={row.key}
                  onChange={(e) => setRow(i, 'key', e.target.value)}
                />
              </div>
              <div className="input-wrapper">
                <label>Tag Value</label>
                <input
                  type="text"
                  className="pure-input"
                  placeholder="e.g. 1234567"
                  value={row.value}
                  onChange={(e) => setRow(i, 'value', e.target.value)}
                />
              </div>
            </div>
          ))}

          <div className="button-group" style={{ marginTop: 0 }}>
            <button
              className="pure-btn plain-btn small-btn"
              onClick={() => patch({ rows: [...rows, { key: '', value: '' }] })}
            >
              + Add another tag
            </button>
            {rows.length > 1 && (
              <button
                className="pure-btn plain-btn small-btn"
                onClick={() => patch({ rows: rows.slice(0, -1) })}
              >
                Remove last
              </button>
            )}
          </div>

          {rejected.length > 0 && (
            <div className="error-card" style={{ marginTop: '12px', marginBottom: 0 }}>
              <h4>⚠️ These will not be applied</h4>
              <ul className="warning-list">{rejected.map((r, i) => <li key={i}>{r}</li>)}</ul>
            </div>
          )}

          <h4 style={{ margin: '20px 0 8px 0', fontSize: '14px' }}>Apply them to</h4>
          <div className="radio-group-container">
            {[[true, `All ${items.length} migrated ${noun}`], [false, `Only ${noun} I pick`]].map(([value, text]) => (
              <label className="radio-label" key={String(value)}>
                <input
                  type="radio"
                  name={`tagScope-${noun}`}
                  checked={applyToAll === value}
                  onChange={() => patch({ applyToAll: value })}
                />
                {text}
              </label>
            ))}
          </div>

          {!applyToAll && (
            <SelectableList
              items={items}
              idOf={(it) => it.id}
              selectedIds={selectedIds}
              onToggle={(id) => patch({ selectedIds: { ...selectedIds, [id]: !selectedIds[id] } })}
              onToggleAll={(all) => {
                const updated = {};
                items.forEach(it => { updated[it.id] = all; });
                patch({ selectedIds: updated });
              }}
              emptyMessage={`No ${noun} to tag.`}
              renderItem={(it) => <strong>{it.name}</strong>}
            />
          )}

          <p className="field-hint">
            {tags.length === 0
              ? 'No complete tag entered yet — nothing will be applied.'
              : `${tags.length} tag(s) will be applied to ${targetCount} of ${items.length} ${noun}.`}
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Turns a tag plan into the two arguments every migration function takes.
 * `targets: null` means "every item", which keeps the common case free of a lookup.
 */
export function resolveTagPlan(plan, items) {
  if (!plan?.enabled) return { newTags: [], newTagTargets: null };

  const { tags } = normalizeNewTags(plan.rows);
  if (tags.length === 0) return { newTags: [], newTagTargets: null };

  if (plan.applyToAll) return { newTags: tags, newTagTargets: null };

  const targets = {};
  (items || []).forEach(it => { if (plan.selectedIds[it.id]) targets[it.id] = true; });
  return { newTags: tags, newTagTargets: targets };
}

/** Renders one status row in a migration log. */
export function StatusRow({ item }) {
  const icons = { SUCCESS: '✅', SKIPPED: '↩️', MANUAL: '⚠️', FAILED: '❌', MIGRATING: '⏳', PENDING: '⏳' };
  const badgeClass = { SUCCESS: 'success', SKIPPED: 'success', MANUAL: 'warning', FAILED: 'failed' };

  return (
    <div className={`summary-row ${item.status.toLowerCase()}`}>
      <div className="summary-meta">
        {icons[item.status] || '⏳'}
        <strong style={{ marginLeft: '8px' }}>{item.stepName}</strong>
      </div>
      <span className={`badge ${badgeClass[item.status] || 'neutral'}`}>
        {item.status === 'SUCCESS' && (item.detail || 'Done')}
        {item.status === 'SKIPPED' && (item.detail || 'Already existed - reused')}
        {item.status === 'MANUAL' && `Needs attention: ${item.error}`}
        {item.status === 'FAILED' && `Failed: ${item.error}`}
        {(item.status === 'PENDING' || item.status === 'MIGRATING') && 'In queue'}
      </span>
    </div>
  );
}

/** Top bar with the "back to home" escape hatch and the active module label. */
export function ModuleNavBar({ label, scenarioLabel, onExit, onChangeScenario }) {
  return (
    <div className="module-nav-bar">
      <button className="pure-btn plain-btn small-btn" onClick={onExit}>🏠 Back to Home</button>
      {scenarioLabel && onChangeScenario && (
        <button className="pure-btn plain-btn small-btn" onClick={onChangeScenario}>↩ Change scenario</button>
      )}
      <span className="nav-module-label">
        Active Module: <strong>{label}</strong>
        {scenarioLabel && <> · <strong>{scenarioLabel}</strong></>}
      </span>
    </div>
  );
}

function AccountInput({ label, value, onChange, placeholder, hint }) {
  return (
    <div className="grid-column">
      <h4>{label}</h4>
      <div className="input-wrapper">
        <label>Account ID</label>
        <input
          type="text"
          className="pure-input"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}

/** Source + target account IDs, for the same-org live path. */
export function AccountConfigGrid({ sourceAccountId, targetAccountId, onSourceChange, onTargetChange }) {
  return (
    <div className="inner-form-custom-grid">
      <AccountInput label="Source Configuration" value={sourceAccountId} onChange={onSourceChange} placeholder="e.g. 1234567" />
      <AccountInput label="Target Configuration" value={targetAccountId} onChange={onTargetChange} placeholder="e.g. 9876543" />
    </div>
  );
}

/** A single account ID, for an export or import pass. */
export function SingleAccountConfig({ label, hint, accountId, onChange }) {
  return (
    <div className="inner-form-custom-grid">
      <AccountInput label={label} hint={hint} value={accountId} onChange={onChange} placeholder="e.g. 1234567" />
    </div>
  );
}

/**
 * File picker for an import pass. Validates the envelope on selection so a wrong file is
 * rejected before the user gets as far as choosing what to create.
 */
export function BundleDropzone({ expectedKind, bundle, onLoad, onClear }) {
  const inputRef = useRef(null);
  const [error, setError] = useState('');

  const handleFile = async (file) => {
    setError('');
    try {
      const parsed = await readBundleFile(file);
      onLoad(validateBundle(parsed, expectedKind));
    } catch (e) {
      onClear();
      setError(e.message);
    }
  };

  return (
    <div className="conditional-input-box">
      <h4 style={{ margin: '0 0 12px 0', fontSize: '14px' }}>Bundle file</h4>

      {bundle ? (
        <div className="summary-list" style={{ marginBottom: '12px' }}>
          <div className="summary-row success">
            <div className="summary-meta">✅<strong style={{ marginLeft: '8px' }}>Bundle loaded</strong></div>
            <span className="badge success">{describeBundleSource(bundle)}</span>
          </div>
        </div>
      ) : (
        <p className="field-hint">Select the JSON file produced by the export step in the source account.</p>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
      />

      <div className="button-group" style={{ marginTop: '8px' }}>
        <button className="pure-btn plain-btn small-btn" onClick={() => inputRef.current?.click()}>
          {bundle ? 'Choose a different file' : 'Choose bundle file...'}
        </button>
        {bundle && <button className="pure-btn plain-btn small-btn" onClick={onClear}>Clear</button>}
      </div>

      {error && (
        <div className="error-card" style={{ marginTop: '12px', marginBottom: 0 }}>
          <h4>⚠️ Cannot use that file</h4>
          <p>{error}</p>
        </div>
      )}
    </div>
  );
}

/**
 * Read-only summary of what an import is about to create. Not a selection - that happens at
 * export - but the user still has to be able to see inside the file before it writes to a live
 * account.
 *
 * A bundle is untrusted input: it is a plain JSON file that can be edited or come from someone
 * else. The riskiest thing it can contain is a notification destination, because an EMAIL
 * destination carries a real address in its properties and gets wired into workflows. Those
 * addresses are shown explicitly so a bundle pointing somewhere unexpected is obvious before
 * anything is created.
 */
export function BundleSummary({ bundle }) {
  const p = bundle?.payload;
  if (!p) return null;

  const groups = [
    ['Notification destinations', (p.destinations || []).length],
    ['Notification channels', (p.channels || []).length],
    ['Alert policies', (p.policies || []).length],
    ['NRQL conditions', (p.policies || []).reduce((n, x) => n + (x.conditions || []).length, 0)],
    ['Workflows', (p.workflows || []).length],
    ['Muting rules', (p.mutingRules || []).length],
    ['Dashboards', (p.dashboards || []).length]
  ].filter(([, n]) => n > 0);

  // Email addresses a created destination would notify.
  const emailTargets = (p.destinations || [])
    .filter(d => (d.type || '').toUpperCase() === 'EMAIL')
    .map(d => ({
      name: d.name,
      addresses: (d.properties || [])
        .filter(prop => /email|address|recipient/i.test(prop.key || ''))
        .map(prop => prop.value)
        .filter(Boolean)
    }));

  return (
    <div className="conditional-input-box">
      <h4 style={{ margin: '0 0 12px 0', fontSize: '14px' }}>This bundle will create</h4>

      {groups.length === 0 ? (
        <p className="field-hint">The bundle is empty - nothing would be created.</p>
      ) : (
        <div className="summary-list">
          {groups.map(([label, n]) => (
            <div key={label} className="summary-row">
              <div className="summary-meta"><strong>{label}</strong></div>
              <span className="badge neutral">{n}</span>
            </div>
          ))}
        </div>
      )}

      {emailTargets.length > 0 && (
        <div className="warning-card" style={{ marginBottom: 0 }}>
          <h4>⚠️ Confirm these notification recipients</h4>
          <p>
            Email destinations in this bundle will be created here and can be wired into workflows.
            Check the addresses before continuing:
          </p>
          <ul className="warning-list">
            {emailTargets.map(t => (
              <li key={t.name}>
                <strong>{t.name}</strong>
                {t.addresses.length > 0 ? ` → ${t.addresses.join(', ')}` : ' (no address recorded)'}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function LoadingCard({ message }) {
  return (
    <div className="main-card loading-card" style={{ textAlign: 'center', padding: '48px 0' }}>
      <div className="custom-loader-ring"></div>
      <h3 style={{ fontSize: '20px', fontWeight: 'bold', margin: '24px 0 8px 0', color: '#1d252c' }}>
        Processing API Operations...
      </h3>
      <p className="card-desc">{message}</p>
    </div>
  );
}

export function ErrorCard({ title, message }) {
  if (!message) return null;
  return (
    <div className="error-card">
      <h4>⚠️ {title}</h4>
      <p>{message}</p>
    </div>
  );
}

/** Non-blocking notes collected during an export or import. */
export function WarningList({ title, warnings }) {
  if (!warnings || warnings.length === 0) return null;
  return (
    <div className="warning-card">
      <h4>⚠️ {title}</h4>
      <ul className="warning-list">
        {warnings.map((w, i) => <li key={i}>{w}</li>)}
      </ul>
    </div>
  );
}

/** Checklist with select-all controls. Item markup is supplied by the caller. */
export function SelectableList({ items, idOf, selectedIds, onToggle, onToggleAll, emptyMessage, renderItem }) {
  const key = idOf || ((item) => item.id);

  return (
    <>
      <div className="selection-utilities">
        <button onClick={() => onToggleAll(true)} className="pure-btn plain-btn small-btn">Select All</button>
        <button onClick={() => onToggleAll(false)} className="pure-btn plain-btn small-btn">Deselect All</button>
      </div>

      <div className="dashboard-checklist-box">
        {items.length > 0 ? (
          items.map(item => (
            <div key={key(item)} className="checkbox-item" onClick={() => onToggle(key(item))}>
              <input type="checkbox" checked={!!selectedIds[key(item)]} readOnly />
              <span className="checklist-details">{renderItem(item)}</span>
            </div>
          ))
        ) : (
          <div className="no-conditions-placeholder" style={{ padding: '24px', textAlign: 'center' }}>
            {emptyMessage}
          </div>
        )}
      </div>
    </>
  );
}
