// path: nerdlets/home/access.js
//
// Account reachability checks.
//
// This replaced a credentials module that stored User API keys for cross-org access. That
// approach cannot work from a browser (NerdGraph refuses the CORS preflight), so the keys,
// the vault storage, and the key validation are all gone - and with them the entire
// credential-handling surface. Cross-org migration uses a bundle file instead.
//
// What remains is the check that the session can actually see an account, which the live
// (same-org, same-region) path needs before it writes anything.

/**
 * Asks the session what it can see for one account.
 *
 * Queries the account directly rather than scanning `actor.accounts`. The old list check
 * could only report "not in your list", which is indistinguishable from a typo, a permission
 * gap, a different org, and a different region. A direct lookup plus the org name lets the
 * caller say which.
 *
 * @returns {Promise<{reachable, accountId, accountName, organizationId, organizationName, error}>}
 */
export async function probeAccount(client, accountId) {
  const id = parseInt(accountId, 10);
  if (!Number.isFinite(id)) {
    return { reachable: false, accountId, error: 'Account ID must be numeric.' };
  }

  const query = `
    query Probe($accountId: Int!) {
      actor {
        organization {
          id
          name
        }
        account(id: $accountId) {
          id
          name
        }
      }
    }
  `;

  try {
    // tolerateFieldErrors: `organization` is not resolvable for every user or role, but the
    // account lookup alone answers the reachability question.
    const data = await client.query(query, { accountId: id }, { tolerateFieldErrors: true });
    const account = data?.actor?.account;
    const org = data?.actor?.organization;

    if (!account?.id) {
      return {
        reachable: false,
        accountId: id,
        error:
          `Account ${id} is not visible to this session. Check the ID, or - if it belongs to a ` +
          `different organization or region - use the export/import scenario instead.`
      };
    }

    return {
      reachable: true,
      accountId: account.id,
      accountName: account.name,
      organizationId: org?.id || null,
      organizationName: org?.name || null
    };
  } catch (e) {
    return { reachable: false, accountId: id, error: e.message };
  }
}

/**
 * Re-checks both accounts immediately before a live migration writes anything.
 *
 * Cheap insurance: a role can change between opening the screen and pressing migrate.
 * Failing here costs one query; failing halfway costs a half-migrated policy.
 */
export async function verifyMigrationAccess({ client, sourceAccountId, targetAccountId }) {
  const source = await probeAccount(client, sourceAccountId);
  if (!source.reachable) {
    throw new Error(`Source account ${sourceAccountId}: ${source.error}`);
  }

  const target = await probeAccount(client, targetAccountId);
  if (!target.reachable) {
    throw new Error(`Target account ${targetAccountId}: ${target.error}`);
  }

  return { source, target };
}

/** Confirms the single account an export or import pass will touch. */
export async function verifySingleAccount(client, accountId) {
  const probe = await probeAccount(client, accountId);
  if (!probe.reachable) {
    throw new Error(`Account ${accountId}: ${probe.error}`);
  }
  return probe;
}
