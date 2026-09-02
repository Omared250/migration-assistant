// path: nerdlets/home/alerts/NonNrqlWarning.js
//
// NerdGraph can only enumerate and create NRQL conditions. Anything else in a policy is
// left behind, so this says so before the user migrates rather than after.
//
// `report.supported === false` means detection was unavailable, NOT that the account is
// clean - that case still has to warn, just without naming names.

import React from 'react';

const MAX_LISTED = 25;

export default function NonNrqlWarning({ report, targetAccountId }) {
  const { supported, conditions } = report;

  return (
    <div className="warning-card">
      <h4>⚠️ Only NRQL conditions are migrated</h4>

      {!supported && (
        <p>
          Could not inventory this account's conditions, so this list may be incomplete. Any
          APM/browser/mobile metric or multi-location synthetics conditions in the policies below
          will <strong>not</strong> be copied — NerdGraph cannot read them. Compare condition
          counts in both accounts after migrating.
        </p>
      )}

      {supported && conditions.length === 0 && (
        <p>Checked this account: every condition found is a NRQL condition, so nothing will be left behind.</p>
      )}

      {supported && conditions.length > 0 && (
        <>
          <p>
            {conditions.length} condition(s) in this account are not NRQL conditions
            (APM/browser/mobile metric or multi-location synthetics). NerdGraph provides no way to
            read them, so they will <strong>not</strong> be copied. Recreate them by hand in
            account {targetAccountId}:
          </p>
          <ul className="warning-list">
            {conditions.slice(0, MAX_LISTED).map(c => (
              <li key={c.guid}>
                {c.name}
                {c.policyId && <span className="checklist-guid"> (source policy {c.policyId})</span>}
              </li>
            ))}
          </ul>
          {conditions.length > MAX_LISTED && (
            <p>...and {conditions.length - MAX_LISTED} more.</p>
          )}
        </>
      )}
    </div>
  );
}
