// path: nerdlets/home/index.js
//
// Shell only: the app header, the module picker, and the account IDs both modules share.
//
// There is one NerdGraph client, the nerdlet session. It is created here and passed down so
// utils.js stays free of framework imports. Cross-organization and cross-region migration does
// not use a second client - it cannot, because NerdGraph refuses API-key calls from a browser
// origin - it moves the data through a bundle file in two passes instead. See ScenarioPicker.

import React, { useState } from 'react';
import DashboardsModule from './DashboardsModule';
import AlertsModule from './AlertsModule';
import { createClient } from './nerdgraph';

export default function RelicShiftNerdlet() {
  const [activeModule, setActiveModule] = useState(null); // null | 'DASHBOARD' | 'ALERTS'

  // Kept at this level so switching modules does not make the user retype them. Which one is
  // used depends on the scenario: live migration uses both, export uses the source, import
  // uses the target.
  const [connection, setConnection] = useState({ sourceAccountId: '', targetAccountId: '' });

  const [client] = useState(() => createClient());

  const sharedProps = {
    client,
    connection,
    updateConnection: (patch) => setConnection(prev => ({ ...prev, ...patch })),
    onExit: () => setActiveModule(null)
  };

  return (
    <div className="relic-shift-container">
      <div className="header-banner">
        <h1 className="main-title">🔄 New Relic Migration Assistant</h1>
        <p className="sub-title">Migrate New Relic configurations across accounts, organizations and regions.</p>
      </div>

      {activeModule === null && (
        <div className="home-wrapper">
          <h2 className="home-title" style={{ fontSize: '22px', fontWeight: 'bold', color: '#1d252c', marginBottom: '32px' }}>
            Select Migration Module
          </h2>
          <div className="home-card-grid">
            <div className="module-choice-card" onClick={() => setActiveModule('DASHBOARD')}>
              <div className="choice-icon">📊</div>
              <h3>Dashboards Module</h3>
              <p>Batch migrate modern multi-page and legacy tabbed dashboards. Clean, deduplicated pages with automatic cross-account query re-routing.</p>
              <button className="choice-btn">Configure Dashboards</button>
            </div>

            <div className="module-choice-card" onClick={() => setActiveModule('ALERTS')}>
              <div className="choice-icon">🚨</div>
              <h3>Alerts &amp; Incident Systems</h3>
              <p>Migrate notification destinations, channels, alert policies, NRQL conditions, workflows and muting rules in dependency order. Automatically translates underlying policy references.</p>
              <button className="choice-btn">Configure Alerts</button>
            </div>
          </div>
        </div>
      )}

      {activeModule === 'DASHBOARD' && <DashboardsModule {...sharedProps} />}
      {activeModule === 'ALERTS' && <AlertsModule {...sharedProps} />}
    </div>
  );
}
