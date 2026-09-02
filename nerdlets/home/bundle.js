// path: nerdlets/home/bundle.js
//
// The transfer format for cross-org / cross-region migration.
//
// WHY THIS EXISTS: a nerdlet cannot reach a second organization or region. The session token
// is scoped to one org, and NerdGraph refuses API-key calls from a browser origin (it does
// not answer the CORS preflight that a custom API-Key header forces). So the data has to
// leave the browser as a file and come back in a second pass, with the user switching
// accounts in between. No credentials are involved anywhere in this path.
//
// THE CENTRAL RULE: a bundle must contain NO account-scoped IDs in any reference position.
// Policy IDs, condition IDs, channel IDs and destination IDs are meaningless in another org.
// Export replaces every reference with the referenced object's NAME; import resolves those
// names back to the IDs it creates. Anything that cannot be expressed by name cannot cross.

export const BUNDLE_FORMAT_VERSION = 1;

export const BUNDLE_KIND = {
  DASHBOARDS: 'DASHBOARDS',
  ALERTS: 'ALERTS'
};

/**
 * Stands in for the source account ID wherever one appears in a copied value (muting rule
 * conditions on `accountId`, for example). Import substitutes the real target account ID.
 */
export const SOURCE_ACCOUNT_SENTINEL = '__SOURCE_ACCOUNT_ID__';

export function createBundle({ kind, source, payload }) {
  return {
    formatVersion: BUNDLE_FORMAT_VERSION,
    kind,
    exportedAt: new Date().toISOString(),
    source,
    payload
  };
}

/**
 * Validates a parsed bundle before anything is created from it.
 *
 * Import writes to a live account, so a malformed or mismatched file must be rejected with a
 * specific reason rather than half-applied. Checks the envelope only - per-item validation
 * happens as each item is created, so one bad entry does not block the rest.
 */
export function validateBundle(parsed, expectedKind) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('That file does not contain a migration bundle.');
  }

  if (parsed.formatVersion == null) {
    throw new Error('That file is missing a formatVersion, so it is not a migration bundle produced by this app.');
  }

  if (parsed.formatVersion > BUNDLE_FORMAT_VERSION) {
    throw new Error(
      `This bundle was written by a newer version of the Migration Assistant ` +
      `(format ${parsed.formatVersion}, this app understands ${BUNDLE_FORMAT_VERSION}). Update the app in this account first.`
    );
  }

  if (!parsed.kind) {
    throw new Error('That bundle does not say what it contains.');
  }

  if (expectedKind && parsed.kind !== expectedKind) {
    const readable = { DASHBOARDS: 'dashboards', ALERTS: 'alerts' };
    throw new Error(
      `That is a ${readable[parsed.kind] || parsed.kind} bundle, but you are in the ` +
      `${readable[expectedKind] || expectedKind} module. Switch modules or pick a different file.`
    );
  }

  if (!parsed.payload || typeof parsed.payload !== 'object') {
    throw new Error('That bundle has no payload.');
  }

  return parsed;
}

/** Describes where a bundle came from, so the user can confirm before importing. */
export function describeBundleSource(bundle) {
  const s = bundle.source || {};
  const parts = [];
  if (s.accountName) parts.push(`${s.accountName} (${s.accountId})`);
  else if (s.accountId) parts.push(`account ${s.accountId}`);
  if (s.organizationName) parts.push(`org: ${s.organizationName}`);
  if (s.region) parts.push(`region: ${s.region}`);
  if (bundle.exportedAt) parts.push(`exported ${bundle.exportedAt.replace('T', ' ').replace(/\..*/, '')} UTC`);
  return parts.join(' · ');
}

function slug(text) {
  return String(text || 'export').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function bundleFilename(bundle) {
  const stamp = (bundle.exportedAt || '').replace(/[:.]/g, '-').replace(/T/, '_').replace(/Z$/, '');
  return `nr-migration-${slug(bundle.kind)}-${bundle.source?.accountId || 'account'}-${stamp}.json`;
}

/**
 * Hands the bundle to the browser as a download. Object URLs are revoked so a large bundle
 * is not pinned in memory for the life of the page.
 */
export function downloadBundle(bundle) {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = bundleFilename(bundle);
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  // Give the browser a moment to start the download before releasing the blob.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Reads and parses a bundle chosen through a file input. */
export function readBundleFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error('No file selected.'));
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => {
      try {
        resolve(JSON.parse(reader.result));
      } catch (e) {
        reject(new Error(`${file.name} is not valid JSON. (${e.message})`));
      }
    };
    reader.readAsText(file);
  });
}
