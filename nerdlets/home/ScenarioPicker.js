// path: nerdlets/home/ScenarioPicker.js
//
// Asks up front which migration scenario the user is in, because the answer changes what is
// technically possible - not just what is convenient.
//
// A nerdlet's session is scoped to one organization and one region. Within that boundary it
// can read the source and write the target in a single pass. Across it, it cannot: NerdGraph
// refuses API-key calls from a browser origin, so there is no way to reach the second account
// at all. That case has to move the data through a file, in two passes.
//
// Putting the choice first means the cross-boundary case is a different (working) flow rather
// than a live migration that fails partway with a CORS error.

import React from 'react';

export const SCENARIO = {
  LIVE: 'LIVE',
  EXPORT: 'EXPORT',
  IMPORT: 'IMPORT'
};

function ScenarioCard({ icon, title, blurb, detail, badge, onClick }) {
  return (
    <div className="scenario-card" onClick={onClick}>
      <div className="scenario-head">
        <span className="scenario-icon">{icon}</span>
        <h4>{title}</h4>
        {badge && <span className="badge-tabs">{badge}</span>}
      </div>
      <p>{blurb}</p>
      {detail && <p className="field-hint">{detail}</p>}
    </div>
  );
}

export default function ScenarioPicker({ moduleLabel, onSelect }) {
  return (
    <div className="main-card">
      <h3>1. Where are the two accounts?</h3>
      <p className="card-desc">
        This determines how {moduleLabel} can be moved. A New Relic user belongs to one organization,
        and each region is a separate endpoint, so an account outside the organization or region you
        are signed into cannot be reached from this page at all.
      </p>

      <div className="scenario-grid">
        <ScenarioCard
          icon="⚡"
          title="Same organization, same region"
          badge="One pass"
          blurb="Both accounts are sub-accounts of the organization you are signed into, in this region. Pick a source and a target and migrate directly."
          detail="Nothing extra required - no file, no API key."
          onClick={() => onSelect(SCENARIO.LIVE)}
        />

        <ScenarioCard
          icon="📤"
          title="Different organization or region — export"
          badge="Pass 1 of 2"
          blurb="You are signed into the SOURCE account. Select what to move and download a bundle file."
          detail="Then sign in to the target account and run the import step there."
          onClick={() => onSelect(SCENARIO.EXPORT)}
        />

        <ScenarioCard
          icon="📥"
          title="Different organization or region — import"
          badge="Pass 2 of 2"
          blurb="You are signed into the TARGET account and have a bundle file from the export step. Upload it and choose what to create."
          detail="References are matched by name, since IDs are not shared across organizations."
          onClick={() => onSelect(SCENARIO.IMPORT)}
        />
      </div>

      <div className="warning-card" style={{ marginTop: '24px', marginBottom: 0 }}>
        <h4>ℹ️ Why two passes across an organization or region</h4>
        <p>
          NerdGraph accepts API keys from servers, not from browsers — it does not answer the CORS
          preflight a browser must send, so this app cannot call another organization's or region's
          endpoint even with a valid key. Moving the data as a file avoids credentials entirely: each
          pass only ever touches the account you are already signed into.
        </p>
      </div>
    </div>
  );
}
