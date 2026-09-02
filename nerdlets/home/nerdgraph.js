// path: nerdlets/home/nerdgraph.js
//
// The NerdGraph transport, plus shared error formatting and pagination.
//
// There is exactly one transport: the nerdlet session. An earlier version also had an
// API-key transport for reaching another organization or region directly. That can never
// work from a browser - NerdGraph does not answer the CORS preflight that a custom API-Key
// header forces, so the request is blocked before it is sent. Cross-org and cross-region
// migration goes through a bundle file instead (see bundle.js), which needs no credentials.
//
// `client` is still threaded through utils.js rather than importing nr1 there directly. It
// keeps the API layer free of framework imports and leaves one seam to change if New Relic
// ever exposes a cross-region transport.

import { NerdGraphQuery, NerdGraphMutation } from 'nr1';

/**
 * The Alerts API reports a bare `message: "Validation Error"` and puts the actual reason in
 * `extensions`, under a key that varies by error class. Pull the detail out, and fall back
 * to dumping the whole extensions object rather than hiding it - a message with no reason
 * is not actionable.
 */
function extractErrorDetail(e) {
  const ext = e?.extensions;
  if (!ext || typeof ext !== 'object') return null;

  const parts = [];

  // Alerts: extensions.validationErrors = [{ name, reason }]
  if (Array.isArray(ext.validationErrors) && ext.validationErrors.length > 0) {
    parts.push(
      ext.validationErrors
        .map(v => [v.name, v.reason || v.message].filter(Boolean).join(' '))
        .join('; ')
    );
  }

  // Some resolvers use fields = [{ field, message }] or a plain reason/detail string.
  if (Array.isArray(ext.fields) && ext.fields.length > 0) {
    parts.push(ext.fields.map(f => `${f.field}: ${f.message}`).join('; '));
  }
  [ext.reason, ext.detail, ext.details, ext.description].forEach(v => {
    if (typeof v === 'string' && v) parts.push(v);
  });

  if (Array.isArray(ext.argumentPath) && ext.argumentPath.length > 0) {
    parts.push(`argument: ${ext.argumentPath.join('.')}`);
  }

  if (parts.length === 0) {
    // Last resort: never swallow the payload. Strip the noisy bits Apollo adds.
    const { code, classification, errorClass, ...rest } = ext;
    const dump = Object.keys(rest).length > 0 ? JSON.stringify(rest) : null;
    return [errorClass || classification || code, dump].filter(Boolean).join(' ') || null;
  }

  return parts.join(' | ');
}

/**
 * Flattens the many shapes NerdGraph / Apollo can report an error in into one readable
 * string. Without this the UI shows "[object Object]" or "undefined".
 */
export function formatGraphQLErrors(errorLike) {
  const list = Array.isArray(errorLike) ? errorLike : [errorLike];

  const render = (e) => {
    if (!e) return null;
    if (typeof e === 'string') return e;

    const base = e.message || e.description || 'GraphQL error';
    const detail = extractErrorDetail(e);
    const path = Array.isArray(e.path) ? ` (at ${e.path.join('.')})` : '';

    return `${base}${detail ? `: ${detail}` : ''}${path}`;
  };

  const messages = list.map(render).filter(Boolean);

  // Apollo wraps network errors; surface the inner GraphQL errors when present.
  const nested = list
    .filter(e => e && typeof e === 'object')
    .flatMap(e => e.graphQLErrors || e.networkError?.result?.errors || []);
  if (nested.length > 0) {
    messages.push(...nested.map(render).filter(Boolean));
  }

  return [...new Set(messages)].join(' | ') || 'Unknown GraphQL error';
}

/**
 * Hygiene for the failure logging below. Mutation variables carry alerting config, not
 * credentials - but a bundle is user-supplied data, so this guards against anything
 * secret-shaped that slipped into one reaching the console.
 */
const SECRET_KEY_PATTERN = /(api[-_]?key|secret|token|password|credential|auth)/i;

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEY_PATTERN.test(k) ? '[redacted]' : redactSecrets(v)])
    );
  }
  if (typeof value === 'string' && /^NR[A-Z]{2}-/.test(value)) return '[redacted]';
  return value;
}

/**
 * NO_CACHE matters: the migration writes to an account and then re-reads it for the
 * idempotency checks. With the default cache-first policy those re-reads return stale data,
 * which causes duplicate policies and conditions.
 */
export function createClient() {
  return {
    kind: 'session',

    async query(query, variables = {}, options = {}) {
      const response = await NerdGraphQuery.query({
        query,
        variables,
        fetchPolicyType: NerdGraphQuery.FETCH_POLICY_TYPE?.NO_CACHE
      });

      if (response.error) {
        throw new Error(formatGraphQLErrors(response.error));
      }

      if (response.errors && response.errors.length > 0) {
        // Interface/union selections on the Alerts + AiNotifications schemas frequently
        // return partial data plus per-field resolver errors. When the caller can work with
        // partial data, keep it instead of throwing the whole page away.
        const hasUsableData = response.data && Object.keys(response.data).length > 0;
        if (options.tolerateFieldErrors !== true || !hasUsableData) {
          throw new Error(formatGraphQLErrors(response.errors));
        }
        console.warn('Partial GraphQL result tolerated:', formatGraphQLErrors(response.errors));
      }

      return response.data;
    },

    async mutate(mutation, variables = {}, label = 'mutation') {
      const response = await NerdGraphMutation.mutate({ mutation, variables });

      const fail = (errorLike) => {
        // Log the payload alongside the raw error. When the API returns a terse
        // "Validation Error" this is the only way to see which field it rejected.
        console.error(`NerdGraph ${label} failed.`, {
          variables: redactSecrets(variables),
          raw: errorLike
        });
        throw new Error(formatGraphQLErrors(errorLike));
      };

      if (response.error) fail(response.error);
      if (response.errors && response.errors.length > 0) fail(response.errors);
      if (!response.data) fail('Mutation returned no data.');

      return response.data;
    }
  };
}

/**
 * Walks a cursor-paginated NerdGraph collection to completion.
 *
 * Every alerts/notifications/workflows search in NerdGraph is paginated and defaults to a
 * single page, so without this only the first page was ever migrated (and the idempotency
 * checks missed existing items beyond page 1, creating duplicates).
 */
export async function collectAllPages(fetchPage, { limit = 50 } = {}) {
  const all = [];
  let cursor = null;
  let pages = 0;

  do {
    const { items, nextCursor } = await fetchPage(cursor);
    all.push(...(items || []));
    cursor = nextCursor || null;
    pages += 1;
    if (pages >= limit) {
      console.warn(`Pagination stopped after ${limit} pages as a safety guard; results may be truncated.`);
      break;
    }
  } while (cursor);

  return all;
}
