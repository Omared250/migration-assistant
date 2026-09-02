// path: nerdlets/home/utils.js
//
// NerdGraph operations for both migration modules.
//
// Every function that talks to the API takes a `client` as its first argument (see
// nerdgraph.js). That is what makes cross-org and cross-region migration work: the caller
// decides whether a given account is reached through the nerdlet session or through a User
// API key against a regional endpoint, and nothing in here needs to know which.
//
// Convention: `client` first, then the account id, then everything else.

import { collectAllPages } from './nerdgraph';

/*************************************************************
 * DASHBOARDS MIGRATION MODULE (PHASE 1) - UNTOUCHED
 *************************************************************/

export async function discoverDashboards(client, accountId, criteria) {
  const queryStr = `type = 'DASHBOARD' AND accountId = ${accountId}`;
  
  const query = `
    query DiscoverDashboards($queryStr: String!) {
      actor {
        entitySearch(query: $queryStr) {
          results {
            entities {
              __typename
              guid
              name
              accountId
              tags {
                key
                values
              }
            }
          }
        }
      }
    }
  `;
  
  const data = await client.query(query, { queryStr });
  let entities = data?.actor?.entitySearch?.results?.entities || [];
  
  entities = entities.filter(e => {
    const typeName = (e.__typename || '').toLowerCase();
    return !typeName.includes('page');
  });
  
  if (criteria.type === 'KEYWORD' && criteria.keyword) {
    const kw = criteria.keyword.trim().toLowerCase();
    entities = entities.filter(e => e.name.toLowerCase().includes(kw));
  }
  
  if (criteria.type === 'TAG' && criteria.tagKey && criteria.tagValue) {
    const targetKey = criteria.tagKey.trim().toLowerCase();
    const targetVal = criteria.tagValue.trim().toLowerCase();
    
    entities = entities.filter(entity => {
      return (entity.tags || []).some(tag => {
        const isKeyMatch = tag.key.toLowerCase() === targetKey;
        const hasValueMatch = (tag.values || []).some(val => val.toLowerCase() === targetVal);
        return isKeyMatch && hasValueMatch;
      });
    });
  }

  const groupedParents = {};
  
  entities.forEach(item => {
    const name = (item.name || '').trim();
    let parentName = name;
    let pageName = 'Overview';
    
    if (name.includes(' / ')) {
      const parts = name.split(' / ');
      parentName = parts[0].trim();
      pageName = parts.slice(1).join(' / ').trim();
    }
    
    if (!groupedParents[parentName]) {
      groupedParents[parentName] = {
        name: parentName,
        guid: parentName === name ? item.guid : null,
        accountId: item.accountId,
        pagesToMigrate: []
      };
    }
    
    groupedParents[parentName].pagesToMigrate.push({
      pageName: pageName,
      guid: item.guid
    });
    
    if (parentName === name) {
      groupedParents[parentName].guid = item.guid;
    }
  });

  return Object.values(groupedParents).map(p => {
    if (!p.guid && p.pagesToMigrate.length > 0) {
      p.guid = p.pagesToMigrate[0].guid;
    }
    return p;
  });
}

export async function fetchSourceDashboard(client, guid) {
  const query = `
    query GetSourceDashboard($guid: EntityGuid!) {
      actor {
        entity(guid: $guid) {
          ... on DashboardEntity {
            name
            permissions
            pages {
              name
              widgets {
                visualization { id }
                title
                layout { row width height column }
                rawConfiguration
              }
            }
            variables {
              name
              title
              type
              isMultiSelection
              replacementStrategy
              defaultValues {
                value {
                  string
                }
              }
              items {
                title
                value
              }
              nrqlQuery {
                accountIds
                query
              }
            }
          }
        }
      }
    }
  `;
  const data = await client.query(query, { guid });
  return data?.actor?.entity;
}

export async function createTargetDashboard(client, accountId, dashboardInput) {
  const mutation = `
    mutation CreateTargetDashboard($accountId: Int!, $dashboard: DashboardInput!) {
      dashboardCreate(accountId: $accountId, dashboard: $dashboard) {
        entityResult {
          guid
          name
        }
        errors {
          description
        }
      }
    }
  `;
  const variables = {
    accountId: parseInt(accountId),
    dashboard: dashboardInput
  };

  // Routed through the client rather than NerdGraphMutation directly: this is the only
  // dashboards write, so it is what makes cross-org dashboard migration possible.
  const data = await client.mutate(mutation, variables, `create dashboard "${dashboardInput?.name}"`);

  const errors = data?.dashboardCreate?.errors;
  if (errors && errors.length > 0) {
    throw new Error(errors.map(e => e.description).join(', '));
  }
  
  return data?.dashboardCreate?.entityResult;
}

function cleanAccountIdsRecursively(obj, srcAccId, tgtAccId) {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => cleanAccountIdsRecursively(item, srcAccId, tgtAccId));
  }

  const cleanObj = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'accountIds' && Array.isArray(value)) {
      let updatedIds = value
        .map(id => parseInt(id))
        .filter(id => id !== srcAccId);
      
      if (!updatedIds.includes(tgtAccId)) {
        updatedIds.push(tgtAccId);
      }
      
      cleanObj[key] = updatedIds;
    } else if (key === 'accountId') {
      const parsedId = parseInt(value);
      if (parsedId === srcAccId) {
        cleanObj[key] = tgtAccId;
      } else {
        cleanObj[key] = value;
      }
    } else {
      cleanObj[key] = cleanAccountIdsRecursively(value, srcAccId, tgtAccId);
    }
  }
  return cleanObj;
}

export function mapVariables(variablesList, sourceAccountId, targetAccountId) {
  const srcAccId = parseInt(sourceAccountId);
  const tgtAccId = parseInt(targetAccountId);

  return (variablesList || []).map(variable => {
    const cleanVar = {
      name: variable.name,
      title: variable.title || "",
      type: variable.type || "TEXT",
      isMultiSelection: !!variable.isMultiSelection,
      replacementStrategy: variable.replacementStrategy || "STRING",
    };

    if (variable.defaultValues) {
      cleanVar.defaultValues = variable.defaultValues.map(item => ({
        value: {
          string: item.value?.string || ""
        }
      }));
    }

    if (variable.items) {
      cleanVar.items = variable.items.map(item => ({
        title: item.title || "",
        value: item.value || ""
      }));
    }

    if (variable.nrqlQuery) {
      let cleanAccountIds = [tgtAccId];
      if (variable.nrqlQuery.accountIds && variable.nrqlQuery.accountIds.length > 0) {
        cleanAccountIds = variable.nrqlQuery.accountIds
          .map(id => parseInt(id))
          .filter(id => id !== srcAccId);
        if (!cleanAccountIds.includes(tgtAccId)) {
          cleanAccountIds.push(tgtAccId);
        }
      }
      
      cleanVar.nrqlQuery = {
        accountIds: cleanAccountIds,
        query: variable.nrqlQuery.query || ""
      };
    }

    return cleanVar;
  });
}

export function mapPageToDashboardPageInput(page, sourceAccountId, targetAccountId) {
  if (!page) return null;

  const srcAccId = parseInt(sourceAccountId);
  const tgtAccId = parseInt(targetAccountId);

  return {
    name: page.name,
    widgets: (page.widgets || []).map(widget => {
      const cleanRawConfig = cleanAccountIdsRecursively(widget.rawConfiguration || {}, srcAccId, tgtAccId);

      const cleanWidget = {
        title: widget.title || "",
        rawConfiguration: cleanRawConfig
      };
      
      if (widget.visualization?.id) {
        cleanWidget.visualization = { id: widget.visualization.id };
      }

      if (widget.layout) {
        cleanWidget.layout = {
          row: parseInt(widget.layout.row) || 1,
          column: parseInt(widget.layout.column) || 1,
          height: parseInt(widget.layout.height) || 1,
          width: parseInt(widget.layout.width) || 1
        };
      }

      return cleanWidget;
    })
  };
}

export function mapEntityToDashboardInput(entity, sourceAccountId, targetAccountId) {
  if (!entity) return null;

  return {
    name: entity.name, 
    permissions: entity.permissions || "PUBLIC_READ_WRITE",
    pages: (entity.pages || []).map(page => mapPageToDashboardPageInput(page, sourceAccountId, targetAccountId)),
    variables: mapVariables(entity.variables, sourceAccountId, targetAccountId)
  };
}

/*************************************************************
 * ALERTS MIGRATION MODULE (PHASE 2)
 *
 * Design notes / why this differs from the previous version:
 *
 * - policyId is `ID` in the NerdGraph Alerts schema, not `String`. Declaring the
 *   variable as `String!` makes GraphQL reject the document at validation time, so
 *   *every* condition read and write failed before it reached the resolver.
 * - `valueFunction` no longer exists on the static-condition input; sending it is a
 *   hard validation error.
 * - `signal.aggregationDelay` and `signal.aggregationTimer` are mutually exclusive and
 *   tied to `aggregationMethod`. Unconditionally sending a delay breaks any source
 *   condition that uses EVENT_TIMER.
 * - Baseline conditions cannot be created with the static mutation. They are now routed
 *   to `alertsNrqlConditionBaselineCreate`.
 * - Notification destinations hold credentials that NerdGraph will never return
 *   (auth tokens, webhook secrets). Those types cannot be recreated programmatically,
 *   so they are reported as "needs manual setup" instead of being silently faked.
 *************************************************************/

/** Destination types whose full configuration is readable, so we can safely recreate them. */
const RECREATABLE_DESTINATION_TYPES = new Set(['EMAIL', 'MOBILE_PUSH']);

/**
 * Destination types that carry secrets NerdGraph will not return (auth blocks, tokens,
 * webhook URLs with embedded keys). These must be created by hand in the target account.
 */
export function canRecreateDestinationType(type) {
  return RECREATABLE_DESTINATION_TYPES.has((type || '').toUpperCase());
}

/*************************************************************
 * POLICIES
 *************************************************************/

/**
 * Discovers alert policies from the source account (all pages).
 */
export async function discoverAlertPolicies(client, accountId, criteria) {
  if (criteria && criteria.type === 'TAG') {
    throw new Error("New Relic Alert Policies do not natively support tagging schemas. Please use 'Migrate All' or 'Filter by Keyword' to discover policies.");
  }

  const query = `
    query GetPolicies($accountId: Int!, $cursor: String) {
      actor {
        account(id: $accountId) {
          alerts {
            policiesSearch(cursor: $cursor) {
              nextCursor
              policies {
                id
                name
                incidentPreference
              }
            }
          }
        }
      }
    }
  `;

  let policies = await collectAllPages(async (cursor) => {
    const data = await client.query(query, { accountId: parseInt(accountId), cursor });
    const page = data?.actor?.account?.alerts?.policiesSearch;
    return { items: page?.policies || [], nextCursor: page?.nextCursor };
  });

  if (criteria && criteria.type === 'KEYWORD' && criteria.keyword) {
    const kw = criteria.keyword.trim().toLowerCase();
    policies = policies.filter(p => (p.name || '').toLowerCase().includes(kw));
  }

  return policies;
}

/**
 * Fetch the condition list for a policy (all pages).
 * `__typename` is selected so the migration can tell static from baseline conditions.
 */
export async function fetchPolicyConditionsList(client, accountId, policyId) {
  const query = `
    query GetConditionsList($accountId: Int!, $policyId: ID!, $cursor: String) {
      actor {
        account(id: $accountId) {
          alerts {
            nrqlConditionsSearch(searchCriteria: { policyId: $policyId }, cursor: $cursor) {
              nextCursor
              nrqlConditions {
                __typename
                id
                name
                enabled
              }
            }
          }
        }
      }
    }
  `;

  return collectAllPages(async (cursor) => {
    const data = await client.query(query, {
      accountId: parseInt(accountId),
      policyId: String(policyId),
      cursor
    });
    const page = data?.actor?.account?.alerts?.nrqlConditionsSearch;
    return { items: page?.nrqlConditions || [], nextCursor: page?.nextCursor };
  });
}

/**
 * Detailed condition fetcher.
 *
 * Tier 1 asks for everything we can copy. Tier 2 drops the fields most likely to be
 * missing on an older schema and records what had to be defaulted, so a partial copy
 * is still reported honestly instead of looking like a clean success.
 */
export async function fetchSingleConditionDetails(client, accountId, conditionId) {
  const accountIdInt = parseInt(accountId);

  const fullQuery = `
    query GetFullCondition($accountId: Int!, $id: ID!) {
      actor {
        account(id: $accountId) {
          alerts {
            nrqlCondition(id: $id) {
              __typename
              id
              name
              enabled
              description
              runbookUrl
              violationTimeLimitSeconds
              nrql {
                query
              }
              signal {
                aggregationWindow
                aggregationMethod
                aggregationDelay
                aggregationTimer
                evaluationDelay
                fillOption
                fillValue
                slideBy
              }
              terms {
                threshold
                thresholdOccurrences
                thresholdDuration
                operator
                priority
              }
              expiration {
                closeViolationsOnExpiration
                expirationDuration
                openViolationOnExpiration
              }
              ... on AlertsNrqlBaselineCondition {
                baselineDirection
              }
            }
          }
        }
      }
    }
  `;

  const coreQuery = `
    query GetCoreCondition($accountId: Int!, $id: ID!) {
      actor {
        account(id: $accountId) {
          alerts {
            nrqlCondition(id: $id) {
              __typename
              id
              name
              enabled
              description
              nrql {
                query
              }
              terms {
                threshold
                thresholdOccurrences
                thresholdDuration
                operator
                priority
              }
            }
          }
        }
      }
    }
  `;

  try {
    const data = await client.query(
      fullQuery,
      { accountId: accountIdInt, id: String(conditionId) },
      { tolerateFieldErrors: true }
    );
    const cond = data?.actor?.account?.alerts?.nrqlCondition;
    if (cond) {
      return { ...cond, migrationNotes: [] };
    }
    throw new Error('Detailed condition query returned no condition.');
  } catch (e) {
    console.warn(
      `Detailed condition query failed for condition ${conditionId}: ${e.message}. Retrying with the core field set.`
    );

    const fallbackData = await client.query(coreQuery, { accountId: accountIdInt, id: String(conditionId) });
    const rawCond = fallbackData?.actor?.account?.alerts?.nrqlCondition;
    if (!rawCond) {
      throw new Error(`Condition ${conditionId} not found or inaccessible in the source account. (${e.message})`);
    }

    return {
      ...rawCond,
      violationTimeLimitSeconds: 86400,
      signal: {
        aggregationWindow: 60,
        aggregationMethod: 'EVENT_FLOW',
        aggregationDelay: 120
      },
      migrationNotes: [
        'Advanced settings (signal timing, expiration, runbook URL) could not be read from the source and were set to New Relic defaults.'
      ]
    };
  }
}

/**
 * IDEMPOTENT: Creates or reuses a target Alert Policy by matching its name.
 */
export async function createTargetAlertPolicy(client, accountId, name, incidentPreference) {
  const checkQuery = `
    query FindPolicy($accountId: Int!, $cursor: String) {
      actor {
        account(id: $accountId) {
          alerts {
            policiesSearch(cursor: $cursor) {
              nextCursor
              policies {
                id
                name
              }
            }
          }
        }
      }
    }
  `;

  const existingPolicies = await collectAllPages(async (cursor) => {
    const data = await client.query(checkQuery, { accountId: parseInt(accountId), cursor });
    const page = data?.actor?.account?.alerts?.policiesSearch;
    return { items: page?.policies || [], nextCursor: page?.nextCursor };
  });

  const wanted = (name || '').trim().toLowerCase();
  const match = existingPolicies.find(p => (p.name || '').trim().toLowerCase() === wanted);
  if (match) {
    return { id: match.id, name: match.name, skipped: true };
  }

  const mutation = `
    mutation CreatePolicy($accountId: Int!, $policy: AlertsPolicyInput!) {
      alertsPolicyCreate(accountId: $accountId, policy: $policy) {
        id
        name
      }
    }
  `;

  const data = await client.mutate(mutation, {
    accountId: parseInt(accountId),
    policy: {
      name,
      // incidentPreference is non-null in the schema; a null from the source would
      // otherwise fail validation with an unhelpful message.
      incidentPreference: incidentPreference || 'PER_POLICY'
    }
  });

  const created = data?.alertsPolicyCreate;
  if (!created?.id) {
    throw new Error(`Policy "${name}" could not be created (no policy returned).`);
  }
  return created;
}

/*************************************************************
 * CONDITIONS
 *************************************************************/

/**
 * Existing conditions under a target policy, fetched once per policy rather than once
 * per condition. Returns a Map of lowercased name -> target condition id.
 *
 * The id matters: muting rules can reference a condition by id, so a condition that was
 * already present (and therefore skipped) still has to contribute to the id map.
 */
export async function fetchExistingConditionNames(client, accountId, policyId) {
  const conditions = await fetchPolicyConditionsList(client, accountId, policyId);
  return new Map(conditions.map(c => [(c.name || '').trim().toLowerCase(), c.id]));
}

/**
 * `aggregationDelay` is only valid for CADENCE / EVENT_FLOW, and `aggregationTimer`
 * only for EVENT_TIMER. Sending the wrong one is rejected by the API.
 */
function buildSignalInput(signal, { minimal = false } = {}) {
  if (!signal) return undefined;

  const method = signal.aggregationMethod || 'EVENT_FLOW';
  const out = { aggregationMethod: method };

  if (signal.aggregationWindow != null) {
    out.aggregationWindow = parseInt(signal.aggregationWindow, 10);
  }

  if (method === 'EVENT_TIMER') {
    out.aggregationTimer = signal.aggregationTimer != null ? parseInt(signal.aggregationTimer, 10) : 60;
  } else {
    out.aggregationDelay = signal.aggregationDelay != null ? parseInt(signal.aggregationDelay, 10) : 120;
  }

  // The retry pass keeps only the three fields every NRQL condition accepts.
  if (minimal) return out;

  if (signal.evaluationDelay != null) out.evaluationDelay = parseInt(signal.evaluationDelay, 10);

  // slideBy is only valid when it divides the aggregation window.
  if (signal.slideBy != null) {
    const slideBy = parseInt(signal.slideBy, 10);
    if (slideBy > 0 && (!out.aggregationWindow || out.aggregationWindow % slideBy === 0)) {
      out.slideBy = slideBy;
    }
  }

  if (['NONE', 'LAST_VALUE', 'STATIC'].includes(signal.fillOption)) {
    out.fillOption = signal.fillOption;
    // fillValue is only meaningful (and only accepted) with the STATIC fill option.
    if (signal.fillOption === 'STATIC') {
      out.fillValue = signal.fillValue != null ? parseFloat(signal.fillValue) : 0;
    }
  }

  return out;
}

/**
 * The API rejects the "loss of signal" flags unless a duration accompanies them, and
 * rejects a duration of 0. Send the block only when it is internally consistent.
 */
function buildExpirationInput(expiration) {
  if (!expiration) return undefined;

  const duration = expiration.expirationDuration != null
    ? parseInt(expiration.expirationDuration, 10)
    : null;
  const closeOnExpiration = !!expiration.closeViolationsOnExpiration;
  const openOnExpiration = !!expiration.openViolationOnExpiration;

  if (!duration || duration <= 0) {
    // No usable duration: the flags are meaningless on their own, so omit the block
    // entirely and let the target condition use the account default.
    return undefined;
  }

  return {
    expirationDuration: duration,
    closeViolationsOnExpiration: closeOnExpiration,
    openViolationOnExpiration: openOnExpiration
  };
}

function buildTermsInput(terms, { baseline = false } = {}) {
  const cleaned = (terms || []).map(t => {
    const term = {
      threshold: parseFloat(t.threshold),
      thresholdOccurrences: t.thresholdOccurrences || 'ALL',
      thresholdDuration: parseInt(t.thresholdDuration, 10) || 300,
      priority: t.priority || 'CRITICAL'
    };

    // ABOVE_OR_BELOW only exists for baseline conditions.
    if (!baseline && t.operator === 'ABOVE_OR_BELOW') {
      term.operator = 'ABOVE';
    } else {
      term.operator = t.operator || 'ABOVE';
    }

    if (!Number.isFinite(term.threshold)) {
      throw new Error(`Term has a non-numeric threshold (${t.threshold}) and cannot be migrated.`);
    }

    return term;
  });

  if (cleaned.length === 0) {
    throw new Error('Condition has no thresholds/terms to migrate.');
  }

  return cleaned;
}

const STATIC_CONDITION_MUTATION = `
  mutation CreateStaticCondition($accountId: Int!, $policyId: ID!, $condition: AlertsNrqlConditionStaticInput!) {
    alertsNrqlConditionStaticCreate(accountId: $accountId, policyId: $policyId, condition: $condition) {
      id
      name
    }
  }
`;

const BASELINE_CONDITION_MUTATION = `
  mutation CreateBaselineCondition($accountId: Int!, $policyId: ID!, $condition: AlertsNrqlConditionBaselineInput!) {
    alertsNrqlConditionBaselineCreate(accountId: $accountId, policyId: $policyId, condition: $condition) {
      id
      name
    }
  }
`;

/**
 * IDEMPOTENT: Creates a NRQL condition under a target policy, routing static and
 * baseline conditions to their own mutations.
 *
 * `existingNames` is an optional pre-fetched Set of lowercased condition names; pass it
 * to avoid re-querying the target policy for every single condition.
 */
export async function createTargetNrqlCondition(client, accountId, policyId, condition, existingNames = null) {
  const names = existingNames || (await fetchExistingConditionNames(client, accountId, policyId));
  const wanted = (condition.name || '').trim().toLowerCase();

  if (names.has(wanted)) {
    return { id: names.get(wanted) || null, name: condition.name, skipped: true };
  }

  if (!condition?.nrql?.query) {
    throw new Error(`Condition "${condition.name}" has no NRQL query and cannot be migrated.`);
  }

  const typeName = condition.__typename || 'AlertsNrqlStaticCondition';
  const isBaseline = typeName === 'AlertsNrqlBaselineCondition';

  if (!isBaseline && typeName !== 'AlertsNrqlStaticCondition') {
    // Outlier and any future condition kinds have no create mutation we can map to.
    throw new Error(
      `Condition "${condition.name}" is of type ${typeName}, which this tool cannot recreate. Copy it manually.`
    );
  }

  const mutation = isBaseline ? BASELINE_CONDITION_MUTATION : STATIC_CONDITION_MUTATION;
  const payloadKey = isBaseline ? 'alertsNrqlConditionBaselineCreate' : 'alertsNrqlConditionStaticCreate';

  // violationTimeLimitSeconds is range-checked by the API (5 minutes to 30 days).
  const rawLimit = parseInt(condition.violationTimeLimitSeconds, 10);
  const violationTimeLimitSeconds = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 300), 2592000)
    : 259200;

  const buildInput = ({ minimal }) => {
    const input = {
      name: condition.name,
      enabled: condition.enabled !== false,
      nrql: { query: condition.nrql.query },
      terms: buildTermsInput(condition.terms, { baseline: isBaseline }),
      violationTimeLimitSeconds
    };

    if (isBaseline) {
      input.baselineDirection = condition.baselineDirection || 'UPPER_ONLY';
    }

    const signal = buildSignalInput(condition.signal, { minimal });
    if (signal) input.signal = signal;

    if (minimal) return input;

    // Optional extras. Each is omitted when absent rather than sent as an empty value,
    // because the API validates them even when they carry no information.
    if (condition.description) input.description = condition.description;
    if (condition.runbookUrl) input.runbookUrl = condition.runbookUrl;

    const expiration = buildExpirationInput(condition.expiration);
    if (expiration) input.expiration = expiration;

    return input;
  };

  const submit = async (input, label) => {
    const data = await client.mutate(
      mutation,
      { accountId: parseInt(accountId), policyId: String(policyId), condition: input },
      label
    );
    const created = data?.[payloadKey];
    if (!created?.id) {
      throw new Error(`Condition "${condition.name}" was not created (no condition returned).`);
    }
    return created;
  };

  let created;
  let degradedReason = null;

  try {
    created = await submit(buildInput({ minimal: false }), `create condition "${condition.name}"`);
  } catch (e) {
    // One rejected advanced setting should not cost us the whole condition. Retry with
    // only the fields every NRQL condition accepts, and report what was dropped.
    console.warn(`Full-fidelity create failed for "${condition.name}" (${e.message}). Retrying with core fields only.`);
    try {
      created = await submit(buildInput({ minimal: true }), `create condition "${condition.name}" (core fields)`);
      degradedReason = e.message;
    } catch (retryError) {
      // Surface the original error: it describes the real problem, while the retry
      // error is usually the same thing reported against a smaller payload.
      throw new Error(`${e.message}${retryError.message !== e.message ? ` (retry also failed: ${retryError.message})` : ''}`);
    }
  }

  names.set(wanted, created.id);
  return { ...created, degradedReason };
}

/*************************************************************
 * NOTIFICATION DESTINATIONS & CHANNELS
 *************************************************************/

/**
 * Queries all Notifications Destinations and Channels (all pages).
 */
export async function fetchDestinationsAndChannels(client, accountId) {
  const accountIdInt = parseInt(accountId);

  const destQuery = `
    query GetDestinations($accountId: Int!, $cursor: String) {
      actor {
        account(id: $accountId) {
          aiNotifications {
            destinations(cursor: $cursor) {
              nextCursor
              entities {
                id
                name
                type
              }
            }
          }
        }
      }
    }
  `;

  const chanQuery = `
    query GetChannels($accountId: Int!, $cursor: String) {
      actor {
        account(id: $accountId) {
          aiNotifications {
            channels(cursor: $cursor) {
              nextCursor
              entities {
                id
                name
                type
                destinationId
                product
              }
            }
          }
        }
      }
    }
  `;

  const destinations = await collectAllPages(async (cursor) => {
    const data = await client.query(destQuery, { accountId: accountIdInt, cursor }, { tolerateFieldErrors: true });
    const page = data?.actor?.account?.aiNotifications?.destinations;
    return { items: page?.entities || [], nextCursor: page?.nextCursor };
  });

  const channels = await collectAllPages(async (cursor) => {
    const data = await client.query(chanQuery, { accountId: accountIdInt, cursor }, { tolerateFieldErrors: true });
    const page = data?.actor?.account?.aiNotifications?.channels;
    return { items: page?.entities || [], nextCursor: page?.nextCursor };
  });

  return { destinations, channels };
}

export async function fetchSingleDestinationDetails(client, accountId, destinationId) {
  const query = `
    query GetDestDetail($accountId: Int!, $id: ID!) {
      actor {
        account(id: $accountId) {
          aiNotifications {
            destinations(filters: { id: $id }) {
              entities {
                id
                name
                type
                properties {
                  key
                  value
                  label
                  displayValue
                }
              }
            }
          }
        }
      }
    }
  `;

  const data = await client.query(
    query,
    { accountId: parseInt(accountId), id: String(destinationId) },
    { tolerateFieldErrors: true }
  );
  const dest = data?.actor?.account?.aiNotifications?.destinations?.entities?.[0];
  if (!dest) {
    throw new Error(`Destination ${destinationId} not found in the source account.`);
  }
  return dest;
}

export async function fetchSingleChannelDetails(client, accountId, channelId) {
  const query = `
    query GetChanDetail($accountId: Int!, $id: ID!) {
      actor {
        account(id: $accountId) {
          aiNotifications {
            channels(filters: { id: $id }) {
              entities {
                id
                name
                type
                destinationId
                product
                properties {
                  key
                  value
                  label
                  displayValue
                }
              }
            }
          }
        }
      }
    }
  `;

  const data = await client.query(
    query,
    { accountId: parseInt(accountId), id: String(channelId) },
    { tolerateFieldErrors: true }
  );
  const chan = data?.actor?.account?.aiNotifications?.channels?.entities?.[0];
  if (!chan) {
    throw new Error(`Channel ${channelId} not found in the source account.`);
  }
  return chan;
}

/**
 * The aiNotifications mutations report failures in a typed union rather than as
 * top-level GraphQL errors, so it has to be unwrapped explicitly.
 */
const AI_NOTIFICATIONS_ERROR_FRAGMENT = `
  error {
    __typename
    ... on AiNotificationsResponseError {
      description
      details
      type
    }
    ... on AiNotificationsDataValidationError {
      details
      fields {
        field
        message
      }
    }
    ... on AiNotificationsConstraintsError {
      constraints {
        name
        dependencies
      }
    }
    ... on AiNotificationsSuggestionError {
      description
      details
      type
    }
  }
`;

function describeAiNotificationsError(error) {
  if (!error) return null;

  if (Array.isArray(error.fields) && error.fields.length > 0) {
    return error.fields.map(f => `${f.field}: ${f.message}`).join('; ');
  }
  if (Array.isArray(error.constraints) && error.constraints.length > 0) {
    return `Missing required configuration: ${error.constraints.map(c => c.name).join(', ')}`;
  }
  return [error.description, error.details, error.type].filter(Boolean).join(' - ') || error.__typename || 'Unknown notification error';
}

function propertiesToInput(properties) {
  return (properties || []).map(p => ({
    key: p.key,
    value: p.value == null ? '' : String(p.value),
    ...(p.label ? { label: p.label } : {}),
    ...(p.displayValue ? { displayValue: p.displayValue } : {})
  }));
}

/**
 * IDEMPOTENT: creates a notification destination in the target account.
 *
 * Destination types that hold credentials (WEBHOOK, SLACK, PAGERDUTY_*, JIRA, ...) are
 * refused rather than created empty: NerdGraph never returns their auth block, so a
 * "successful" create would produce a destination that silently drops every notification.
 */
export async function createTargetDestination(client, accountId, name, type, properties) {
  const accountIdInt = parseInt(accountId);

  const existing = await collectAllPages(async (cursor) => {
    const query = `
      query FindDest($accountId: Int!, $cursor: String) {
        actor {
          account(id: $accountId) {
            aiNotifications {
              destinations(cursor: $cursor) {
                nextCursor
                entities {
                  id
                  name
                  type
                }
              }
            }
          }
        }
      }
    `;
    const data = await client.query(query, { accountId: accountIdInt, cursor }, { tolerateFieldErrors: true });
    const page = data?.actor?.account?.aiNotifications?.destinations;
    return { items: page?.entities || [], nextCursor: page?.nextCursor };
  });

  const wanted = (name || '').trim().toLowerCase();
  const match = existing.find(d => (d.name || '').trim().toLowerCase() === wanted && d.type === type);
  if (match) {
    return { id: match.id, name: match.name, type: match.type, skipped: true };
  }

  if (!canRecreateDestinationType(type)) {
    const err = new Error(
      `Destination "${name}" (${type}) stores credentials that the NerdGraph API will not return. ` +
      `Create it once by hand in account ${accountId} using the same name, then re-run this migration and it will be reused.`
    );
    err.manualSetupRequired = true;
    throw err;
  }

  const mutation = `
    mutation CreateDestination($accountId: Int!, $destination: AiNotificationsDestinationInput!) {
      aiNotificationsCreateDestination(accountId: $accountId, destination: $destination) {
        destination {
          id
          name
          type
        }
        ${AI_NOTIFICATIONS_ERROR_FRAGMENT}
      }
    }
  `;

  const data = await client.mutate(mutation, {
    accountId: accountIdInt,
    destination: {
      name,
      type,
      properties: propertiesToInput(properties)
    }
  });

  const payload = data?.aiNotificationsCreateDestination;
  if (payload?.error) {
    throw new Error(`Destination "${name}": ${describeAiNotificationsError(payload.error)}`);
  }
  if (!payload?.destination?.id) {
    throw new Error(`Destination "${name}" was not created (no destination returned).`);
  }

  return payload.destination;
}

/**
 * IDEMPOTENT: creates a notification channel bound to a target destination.
 * Matched on name + destination, because channel names are only unique per destination.
 */
export async function createTargetChannel(client, accountId, name, type, destinationId, product, properties) {
  const accountIdInt = parseInt(accountId);

  const existing = await collectAllPages(async (cursor) => {
    const query = `
      query FindChan($accountId: Int!, $cursor: String) {
        actor {
          account(id: $accountId) {
            aiNotifications {
              channels(cursor: $cursor) {
                nextCursor
                entities {
                  id
                  name
                  type
                  destinationId
                }
              }
            }
          }
        }
      }
    `;
    const data = await client.query(query, { accountId: accountIdInt, cursor }, { tolerateFieldErrors: true });
    const page = data?.actor?.account?.aiNotifications?.channels;
    return { items: page?.entities || [], nextCursor: page?.nextCursor };
  });

  const wanted = (name || '').trim().toLowerCase();
  const match = existing.find(
    c => (c.name || '').trim().toLowerCase() === wanted && String(c.destinationId) === String(destinationId)
  );
  if (match) {
    return { id: match.id, name: match.name, skipped: true };
  }

  const mutation = `
    mutation CreateChannel($accountId: Int!, $channel: AiNotificationsChannelInput!) {
      aiNotificationsCreateChannel(accountId: $accountId, channel: $channel) {
        channel {
          id
          name
        }
        ${AI_NOTIFICATIONS_ERROR_FRAGMENT}
      }
    }
  `;

  const data = await client.mutate(mutation, {
    accountId: accountIdInt,
    channel: {
      name,
      type,
      destinationId: String(destinationId),
      product: product || 'IINT',
      properties: propertiesToInput(properties)
    }
  });

  const payload = data?.aiNotificationsCreateChannel;
  if (payload?.error) {
    throw new Error(`Channel "${name}": ${describeAiNotificationsError(payload.error)}`);
  }
  if (!payload?.channel?.id) {
    throw new Error(`Channel "${name}" was not created (no channel returned).`);
  }

  return payload.channel;
}

/*************************************************************
 * WORKFLOWS
 *************************************************************/

/**
 * Discovers workflows in an account (all pages).
 */
export async function discoverWorkflows(client, accountId) {
  const query = `
    query GetWorkflows($accountId: Int!, $cursor: String) {
      actor {
        account(id: $accountId) {
          aiWorkflows {
            workflows(cursor: $cursor) {
              nextCursor
              entities {
                id
                name
                workflowEnabled
                destinationsEnabled
                mutingRulesHandling
                issuesFilter {
                  name
                  type
                  predicates {
                    attribute
                    operator
                    values
                  }
                }
                destinationConfigurations {
                  channelId
                  notificationTriggers
                }
              }
            }
          }
        }
      }
    }
  `;

  return collectAllPages(async (cursor) => {
    const data = await client.query(query, { accountId: parseInt(accountId), cursor }, { tolerateFieldErrors: true });
    const page = data?.actor?.account?.aiWorkflows?.workflows;
    return { items: page?.entities || [], nextCursor: page?.nextCursor };
  });
}

/**
 * IDEMPOTENT: Creates a target Workflow, skipping duplicates by name.
 *
 * `workflow` is the source workflow plus already-remapped predicates and destination
 * configurations. Enabled state, muting-rule handling and the issues-filter type are
 * carried over from the source instead of being hardcoded.
 */
export async function createTargetWorkflow(client, accountId, workflow) {
  const { name, issuesFilter, destinationConfigurations } = workflow;

  const existingWfs = await discoverWorkflows(client, accountId);
  const wanted = (name || '').trim().toLowerCase();
  const match = existingWfs.find(w => (w.name || '').trim().toLowerCase() === wanted);
  if (match) {
    return { id: match.id, name: match.name, skipped: true };
  }

  const configs = (destinationConfigurations || []).filter(dc => dc.channelId);
  if (configs.length === 0) {
    throw new Error(
      `Workflow "${name}" has no notification channel that exists in the target account. ` +
      `Migrate or manually create its destination first, then re-run.`
    );
  }

  const mutation = `
    mutation CreateWorkflow($accountId: Int!, $workflow: AiWorkflowsCreateWorkflowInput!) {
      aiWorkflowsCreateWorkflow(accountId: $accountId, createWorkflowData: $workflow) {
        workflow {
          id
          name
        }
        errors {
          description
          type
        }
      }
    }
  `;

  const data = await client.mutate(mutation, {
    accountId: parseInt(accountId),
    workflow: {
      name,
      workflowEnabled: workflow.workflowEnabled !== false,
      destinationsEnabled: workflow.destinationsEnabled !== false,
      mutingRulesHandling: workflow.mutingRulesHandling || 'NOTIFY_ALL_ISSUES',
      issuesFilter: {
        name: issuesFilter?.name || `${name} filter`,
        type: issuesFilter?.type || 'FILTER',
        predicates: (issuesFilter?.predicates || []).map(p => ({
          attribute: p.attribute,
          operator: p.operator,
          values: (p.values || []).map(String)
        }))
      },
      destinationConfigurations: configs.map(dc => ({
        channelId: String(dc.channelId),
        notificationTriggers: dc.notificationTriggers && dc.notificationTriggers.length > 0
          ? dc.notificationTriggers
          : ['ACTIVATED', 'CLOSED']
      }))
    }
  });

  const payload = data?.aiWorkflowsCreateWorkflow;
  if (payload?.errors && payload.errors.length > 0) {
    throw new Error(payload.errors.map(e => e.description || e.type).join('; '));
  }
  if (!payload?.workflow?.id) {
    throw new Error(`Workflow "${name}" was not created (no workflow returned).`);
  }

  return payload.workflow;
}

/*************************************************************
 * MUTING RULES
 *
 * Muting rules are the quietest failure mode in a cross-account migration: if they are
 * left behind, the target account starts paging people for windows that were
 * deliberately silenced in the source. If they are copied verbatim, they are worse than
 * useless, because their conditions reference source policy/condition/account IDs and so
 * match nothing at all in the target.
 *************************************************************/

/** Attributes whose values are account-scoped IDs and must be remapped. */
const MUTING_ATTR_ACCOUNT = 'accountId';
const MUTING_ATTR_POLICY = 'policyId';
const MUTING_ATTR_CONDITION = 'conditionId';

/**
 * Attributes that point at a specific entity in the source account. There is no
 * cross-account equivalent, so a rule using one cannot be faithfully recreated.
 */
const MUTING_ATTR_UNMAPPABLE = new Set(['entity.guid', 'entityGuid', 'targetId']);

export async function discoverMutingRules(client, accountId) {
  const query = `
    query GetMutingRules($accountId: Int!) {
      actor {
        account(id: $accountId) {
          alerts {
            mutingRules {
              id
              name
              description
              enabled
              condition {
                operator
                conditions {
                  attribute
                  operator
                  values
                }
              }
              schedule {
                startTime
                endTime
                timeZone
                repeat
                weeklyRepeatDays
                repeatCount
                endRepeat
              }
            }
          }
        }
      }
    }
  `;

  const data = await client.query(query, { accountId: parseInt(accountId) }, { tolerateFieldErrors: true });
  return data?.actor?.account?.alerts?.mutingRules || [];
}

/**
 * Rebuilds a muting rule's condition group against the target account, remapping the
 * ID-bearing attributes. Throws when a referenced policy or condition was not migrated:
 * a rule that silently mutes nothing is worse than a visible failure.
 */
function remapMutingRuleConditions(rule, { policyIdMap, conditionIdMap, sourceAccountId, targetAccountId, identity }) {
  const group = rule.condition;
  if (!group || !Array.isArray(group.conditions) || group.conditions.length === 0) {
    throw new Error('Rule has no conditions to migrate.');
  }

  // The bundle importer resolves names to local IDs itself, so its conditions already carry
  // IDs valid in this account. Remapping them again would fail every lookup.
  if (identity) {
    return {
      operator: group.operator || 'AND',
      conditions: group.conditions.map(c => ({
        attribute: c.attribute,
        operator: c.operator,
        values: (c.values || []).map(String)
      }))
    };
  }

  const unresolved = [];

  const conditions = group.conditions.map(c => {
    const attribute = c.attribute;
    const values = (c.values || []).map(String);

    if (MUTING_ATTR_UNMAPPABLE.has(attribute)) {
      throw new Error(
        `It targets specific source entities via "${attribute}", which has no equivalent in account ${targetAccountId}. Recreate this rule by hand.`
      );
    }

    let mapped = values;

    if (attribute === MUTING_ATTR_ACCOUNT) {
      mapped = values.map(v => (String(v) === String(sourceAccountId) ? String(targetAccountId) : v));
    } else if (attribute === MUTING_ATTR_POLICY) {
      mapped = values.map(v => {
        const target = policyIdMap[v];
        if (!target) unresolved.push(`policy ${v}`);
        return target ? String(target) : v;
      });
    } else if (attribute === MUTING_ATTR_CONDITION) {
      mapped = values.map(v => {
        const target = conditionIdMap[v];
        if (!target) unresolved.push(`condition ${v}`);
        return target ? String(target) : v;
      });
    }

    return { attribute, operator: c.operator, values: mapped };
  });

  if (unresolved.length > 0) {
    throw new Error(
      `It references ${[...new Set(unresolved)].join(', ')}, which were not migrated in this run. ` +
      `Include them in Stage 2 and re-run, or the rule would mute nothing.`
    );
  }

  return { operator: group.operator || 'AND', conditions };
}

/**
 * Schedules have interdependent fields the API validates: repeatCount and endRepeat are
 * mutually exclusive, weeklyRepeatDays only applies to WEEKLY, and nextStartTime /
 * nextEndTime are read-only and must never be echoed back.
 */
function buildMutingScheduleInput(schedule) {
  if (!schedule) return undefined;

  const out = {};
  if (schedule.startTime) out.startTime = schedule.startTime;
  if (schedule.endTime) out.endTime = schedule.endTime;
  if (schedule.timeZone) out.timeZone = schedule.timeZone;

  if (schedule.repeat) {
    out.repeat = schedule.repeat;

    if (schedule.repeat === 'WEEKLY' && Array.isArray(schedule.weeklyRepeatDays) && schedule.weeklyRepeatDays.length > 0) {
      out.weeklyRepeatDays = schedule.weeklyRepeatDays;
    }

    // Prefer endRepeat when both are somehow present; sending both is rejected.
    if (schedule.endRepeat) {
      out.endRepeat = schedule.endRepeat;
    } else if (schedule.repeatCount != null) {
      out.repeatCount = parseInt(schedule.repeatCount, 10);
    }
  }

  if (Object.keys(out).length === 0) return undefined;

  // A schedule without a timeZone is rejected, and guessing one would shift the window.
  if (!out.timeZone) {
    throw new Error('Its schedule has no time zone, which the API requires. Recreate this rule by hand.');
  }

  return out;
}

/**
 * IDEMPOTENT: creates a muting rule in the target account, skipping duplicates by name.
 */
export async function createTargetMutingRule(client, accountId, rule, maps) {
  const existing = await discoverMutingRules(client, accountId);
  const wanted = (rule.name || '').trim().toLowerCase();
  const match = existing.find(r => (r.name || '').trim().toLowerCase() === wanted);
  if (match) {
    return { id: match.id, name: match.name, skipped: true };
  }

  const condition = remapMutingRuleConditions(rule, { ...maps, targetAccountId: accountId });
  const schedule = buildMutingScheduleInput(rule.schedule);

  const ruleInput = {
    name: rule.name,
    enabled: rule.enabled !== false,
    condition
  };
  if (rule.description) ruleInput.description = rule.description;
  if (schedule) ruleInput.schedule = schedule;

  const mutation = `
    mutation CreateMutingRule($accountId: Int!, $rule: AlertsMutingRuleInput!) {
      alertsMutingRuleCreate(accountId: $accountId, rule: $rule) {
        id
        name
      }
    }
  `;

  const data = await client.mutate(
    mutation,
    { accountId: parseInt(accountId), rule: ruleInput },
    `create muting rule "${rule.name}"`
  );

  const created = data?.alertsMutingRuleCreate;
  if (!created?.id) {
    throw new Error(`Muting rule "${rule.name}" was not created (no rule returned).`);
  }
  return created;
}

/*************************************************************
 * NON-NRQL CONDITION DETECTION
 *
 * NerdGraph only exposes a *search* for NRQL conditions. APM/browser/mobile metric
 * conditions and multi-location synthetics conditions cannot be enumerated through the
 * alerts namespace at all, so they cannot be migrated - and previously they were not
 * even mentioned, so a policy containing them reported a clean success while arriving in
 * the target account half empty.
 *
 * Alert conditions are, however, entities. Enumerating the account's condition entities
 * and subtracting the NRQL condition ids yields exactly the set that will be left
 * behind. If that entity query is unavailable the caller degrades to a blanket warning
 * rather than claiming completeness.
 *************************************************************/

/**
 * Decodes the numeric condition id out of a condition entity GUID.
 * GUID format is base64 of `accountId|DOMAIN|TYPE|internalId`.
 */
function conditionIdFromEntityGuid(guid) {
  try {
    const parts = atob(guid).split('|');
    return parts[3] || null;
  } catch (e) {
    return null;
  }
}

/**
 * Best-effort inventory of conditions that this tool cannot migrate.
 *
 * Returns { supported, conditions: [{ guid, name, conditionId, policyId }] }.
 * `supported: false` means the entity search could not be used, NOT that the account is
 * clean - callers must keep warning the user in that case.
 */
export async function discoverNonNrqlConditions(client, accountId, knownNrqlConditionIds) {
  const queryStr = `domain = 'AIOPS' AND type = 'CONDITION' AND accountId = ${parseInt(accountId)}`;

  const query = `
    query ConditionEntities($queryStr: String!, $cursor: String) {
      actor {
        entitySearch(query: $queryStr) {
          results(cursor: $cursor) {
            nextCursor
            entities {
              guid
              name
              tags {
                key
                values
              }
            }
          }
        }
      }
    }
  `;

  let entities;
  try {
    entities = await collectAllPages(async (cursor) => {
      const data = await client.query(query, { queryStr, cursor }, { tolerateFieldErrors: true });
      const page = data?.actor?.entitySearch?.results;
      return { items: page?.entities || [], nextCursor: page?.nextCursor };
    });
  } catch (e) {
    console.warn(`Condition entity inventory unavailable: ${e.message}`);
    return { supported: false, conditions: [] };
  }

  // An account with alert policies always has condition entities. Zero results means the
  // entity type or domain differs from what this query assumes, not that nothing exists.
  if (entities.length === 0) {
    return { supported: false, conditions: [] };
  }

  const nrqlIds = new Set((knownNrqlConditionIds || []).map(String));

  const conditions = entities
    .map(e => {
      const conditionId = conditionIdFromEntityGuid(e.guid);
      const policyIdTag = (e.tags || []).find(t => t.key === 'policyId');
      return {
        guid: e.guid,
        name: e.name,
        conditionId,
        policyId: policyIdTag?.values?.[0] || null
      };
    })
    .filter(c => c.conditionId && !nrqlIds.has(String(c.conditionId)));

  return { supported: true, conditions };
}
