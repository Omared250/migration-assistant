// path: nerdlets/home/components.js
//
// Presentational pieces shared by the Dashboards and Alerts modules. Nothing here holds
// migration state or talks to NerdGraph.

import React, { useRef, useState } from 'react';
import { describeBundleSource, readBundleFile, validateBundle } from './bundle';

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
