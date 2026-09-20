# New Relic Migration Assistant

A New Relic nerdpack that copies **dashboards** and **alerting configuration** from one account to another — within an organization, or across organizations and regions.

It is idempotent: matching items in the target are reused, not duplicated, so a failed run can be re-run safely.

---

## Adding this app to your New Relic account

This is a **nerdpack** — a custom app you deploy into your own New Relic account. It is not on the public catalogue, so you build and publish it yourself. Takes about ten minutes.

### What you need

- **Node.js 10 or newer** (18+ recommended).
- **The New Relic One CLI (`nr1`).** Get it from New Relic itself: **[one.newrelic.com](https://one.newrelic.com)** → **+ Integrations & Agents** → **Build your own app**. That page gives you the installer for your OS. (Don't install it from public npm — the package is served by New Relic.)
- **A User API key** for the account you're deploying into: **Administration → API keys → Create a key → User**. It must start with `NRAK-`.
- **Permission to manage apps** in that account — the *Nerdpack manager* role, or admin. Without it, `nerdpack:publish` fails.

### 1. Create a CLI profile

```bash
nr1 profiles:add --name my-account --region us --api-key NRAK-YOUR-KEY
```

Use `--region eu` if your account is in the EU data centre. Verify with `nr1 profiles:list`.

### 2. Clone and install

```bash
git clone <this-repo-url> && cd migration-assistant
npm install
```

### 3. Generate your own nerdpack UUID — required

The UUID committed in `package.json` belongs to the account this app was developed in. **It will not work for you.** Replace it with one bound to your account:

```bash
nr1 nerdpack:uuid -gf
```

Skipping this is the most common reason publishing fails.

### 4. Try it before publishing (optional)

```bash
nr1 nerdpack:serve
```

Open `https://one.newrelic.com/?nerdpacks=local` — or `https://one.eu.newrelic.com/?nerdpacks=local` for EU — and launch **New Relic Migration Assistant**. Nothing is uploaded; the app runs from your machine. Accept the `localhost` certificate warning if your browser shows one.

### 5. Publish it

```bash
nr1 nerdpack:publish
nr1 nerdpack:deploy
nr1 subscription:set
```

- `publish` uploads the built version to your account.
- `deploy` tags that version to the `STABLE` channel.
- `subscription:set` subscribes the account so the launcher appears.

Find it under **Apps** in the New Relic navigation, as **New Relic Migration Assistant**.

### 6. Make it available to other sub-accounts

A subscription is per-account. To use the app from another sub-account, subscribe that account too — either in the UI (**Apps → Manage your apps → your app → subscribe the accounts you want**) or from the CLI with a profile whose key belongs to that account:

```bash
nr1 subscription:set --profile other-account
```

You only need it subscribed in the account you'll *run* it from. It reads and writes other accounts through the API, not by being installed in them.

### If you migrate across regions

Nerdpacks are **region-scoped**: an app published in the US is not visible in the EU. To run it in both, publish it twice — and because a UUID is bound to one region, generate a second one for the EU deployment:

```bash
nr1 profiles:add --name my-eu-account --region eu --api-key NRAK-YOUR-EU-KEY
nr1 nerdpack:uuid -gf --profile my-eu-account
nr1 nerdpack:publish --profile my-eu-account
nr1 nerdpack:deploy --profile my-eu-account
nr1 subscription:set --profile my-eu-account
```

Since `package.json` holds one UUID at a time, keep the two on separate git branches (one per region) rather than editing the file back and forth.

> For **local testing** you can skip all of this: a single `nr1 nerdpack:serve` works against both regions at once, because the bundle is served from your machine and the region comes from whichever New Relic page loads it.

### Access the app needs at runtime

The app uses your own New Relic session — it never asks for or stores an API key. Whoever runs it needs:

- **read** access to the source account (dashboards, alert policies, notification destinations),
- **write** access to the target account (create dashboards, policies, conditions, workflows, muting rules).

If either is missing, the app says which account and why before it changes anything.

---

## Choosing a scenario

Every module asks this first, because the answer changes what is technically possible:

| Scenario | When | Passes |
|---|---|---|
| **Same organization, same region** | Both accounts are sub-accounts of the org you're signed into | One — direct migration |
| **Different org or region — Export** | You're signed into the **source** | 1 of 2 — download a bundle |
| **Different org or region — Import** | You're signed into the **target** | 2 of 2 — upload that bundle |

### Why cross-org/region needs two passes

A New Relic user identity belongs to **one organization** — the same email in two orgs is two separate user records. The nerdlet's session token therefore cannot reach an account outside the org you're signed into. Each region is also a separate API endpoint.

The workaround — a User API key for the other side — **does not work from a browser**. A custom `API-Key` header forces a CORS preflight, and NerdGraph does not answer it for browser origins; API keys there are for server-to-server use. This is not a bug in the app and cannot be fixed in it.

So the data moves as a **JSON bundle file** instead. Each pass only ever touches the account you're already signed into, which also means no credentials are involved anywhere.

---

## Dashboards

### What you can do

1. **Discover** by *all dashboards*, *keyword in the name*, or *tag key/value*.
2. **Migrate live** (same org + region) — read source, create in target, one pass.
3. **Export / Import** (cross org or region) — download selected dashboards, then create them in the target.

### What it changes, and what it doesn't

The **only** thing rewritten is the account reference inside widget queries — `accountId` and `accountIds` anywhere in a widget's `rawConfiguration`, swapped in place from the source account to the target.

Deliberately left alone:

- **NRQL query text** — untouched.
- **Dashboard permissions** — copied as-is. A `PRIVATE` dashboard stays `PRIVATE`; nothing is made more permissive.
- **Variables** — copied, including their `accountIds`.
- **Widgets querying a third account** — preserved. Only the source account is substituted.

### Legacy tabbed dashboards

Older dashboards exist as several sibling entities named `Parent / Page`. These are detected, grouped, and consolidated into a single multi-page dashboard with de-duplicated page names. The selection list badges them as *Legacy tab group*.

### Not migrated

- **Dashboard tags** — not copied.

---

## Alerts & Incident Systems

### What you can do

1. **Migrate live** (same org + region), in two stages.
2. **Export** — pick what to include, download a bundle.
3. **Import** — apply a whole bundle.

Covers: **notification destinations**, **channels**, **alert policies**, **NRQL conditions** (static and baseline), **workflows**, and **muting rules**.

### Choosing what to discover

Live migration and export both offer three strategies:

| Strategy | What it matches |
|---|---|
| **All policies & conditions** | Everything in the account |
| **Condition keyword** | Conditions whose **name** contains your text |
| **Condition tag** | Conditions carrying a tag key/value you assigned |

The two filters match **conditions**, not policy names. The policy each match belongs to is found automatically and created (or reused) in the target so the conditions have somewhere to live — but it arrives carrying **only the matching conditions**, not the policy's other ones. The selection screen says so explicitly.

A filtered run also reports any matching condition it cannot recreate, rather than quietly listing fewer results than the filter found.

**Condition tags are re-applied after migration.** Creating a condition does not carry its tags over — the API accepts no tag input — so the tool copies the source condition's user tags onto the new one. Without that, a tag-driven migration would produce untagged conditions and the same filter would match nothing in the target. Only your own tags are copied; New Relic's internal metadata tags are left alone. If tagging fails (usually a permissions gap) the condition is still created, and the row is flagged rather than reported as a clean success.

### Selecting what to move

**Export** shows four tabs — Policies (with per-condition checkboxes), Destinations, Workflows, Muting Rules — with live dependency warnings if you select a workflow without the policies it filters on.

Channels are **not** selected separately: they belong to a destination and travel with it.

**Import applies the entire bundle.** There is no second selection step, by design — at export you're looking at an account you know; at import you're in a different org reading names out of a file. Choosing there would be guesswork.

### Creation order (why there are two stages)

Dependencies force it:

```
destinations → channels → policies + conditions → workflows → muting rules
```

A workflow needs target channel IDs *and* target policy IDs. A muting rule needs target policy and condition IDs. Nothing here is arbitrary — don't reorder it.

### How cross-org references survive

IDs are meaningless in another organization, so export replaces every reference with the **name** of what it points at, and import resolves those names against what it just created:

| Source field | In the bundle |
|---|---|
| `channel.destinationId` | `destinationName` |
| workflow `channelId` | `channelName` |
| workflow `labels.policyIds` | policy names |
| muting rule `policyId` / `conditionId` | policy / condition names |
| muting rule `accountId` | a placeholder, substituted with the target account |

If a referenced item isn't in the bundle, the workflow or rule **fails with the missing name** rather than being created pointing at nothing.

### Destinations that need authentication

**Only `EMAIL` and `MOBILE_PUSH` destinations can be created by this tool.**

NerdGraph never returns a destination's credentials — auth tokens, webhook secrets, API keys. They're write-only by design. So for Slack, PagerDuty, webhooks, Jira, ServiceNow and similar, the tool can read the *name and type* but not what makes them work. Creating one from that would produce a destination that accepts the mutation and then silently drops every notification — worse than not creating it.

Instead:

1. Those destinations are flagged **"Name only"** / **"Manual setup required"** before you migrate.
2. Create them **by hand in the target account, using the exact same name**.
3. Re-run the migration or import. The tool matches by name, reuses your destination, and links its channels.

### Conditions that are not migrated

**Only NRQL conditions can be migrated** — static and baseline. APM / browser / mobile metric conditions and multi-location synthetics conditions cannot be, because NerdGraph provides no way to *enumerate* them; the alerts API only exposes a search for NRQL conditions.

The tool detects them anyway, via the entity platform, and lists them by name so you know exactly what to recreate by hand. If that detection is unavailable it says so rather than implying the account is clean.

Multi-location synthetics conditions have a second problem: they reference monitor entities that don't exist in the target until the monitors themselves are migrated which is in plan to be cover in next app versions. Synthetics migration is not implemented yet.

### Other alerts limitations

- **Policies themselves cannot be searched by tag.** `policiesSearch` offers no tag criteria, so tag filtering runs against **condition** entities and derives the policies from the matches.
- **Muting rules targeting specific entities** (`entity.guid`, `targetId`) cannot cross an org boundary — there's no equivalent entity on the other side. They're reported, not silently dropped.
- **Muting rule schedules without a time zone** are refused; guessing one would shift the window.
- A condition whose advanced settings are rejected is retried with core fields only, and reported as **needs attention** rather than a clean success, naming what was reset.

---

## Reading the results

| | Meaning |
|---|---|
| ✅ **Success** | Created in the target |
| ↩️ **Skipped** | Already existed with the same name — reused, not duplicated |
| ⚠️ **Needs attention** | Partially done, or requires manual work. **Read these** |
| ❌ **Failed** | Not created; the message says why |

A failure never aborts the run — every other item still processes, and the summary always shows.

---

## Cross-region walkthrough

1. Sign into the **source** account. Open the module → **Different organization or region — Export**.
2. Enter the source account ID → **Continue: Choose What to Export**.
3. Tick what you want. Resolve any dependency warnings. → **Export Selected & Download Bundle**.
4. Note anything flagged *Name only* — create those destinations by hand in the target now.
5. Sign into the **target** account (separate login; different org). Open the same module → **Import**.
6. Enter the target account ID, choose the bundle file → **Create Everything in This Bundle**.
7. Review the summary. Re-import after fixing anything flagged ⚠️ — reruns are safe.

> Validate the whole path without a second region first: export from one sub-account and import into a sibling in the same org. That exercises every step except the region switch.

---

## Project layout

```
nerdlets/home/
  index.js              shell: header, module picker, shared account IDs
  ScenarioPicker.js     the same-org / export / import fork
  nerdgraph.js          NerdGraph transport, error formatting, pagination
  utils.js              all NerdGraph operations (takes a client as first arg)
  bundle.js             transfer format, validation, download/read
  access.js             account reachability checks
  components.js         shared presentational pieces
  hooks.js              useMountedGuard
  DashboardsModule.js   dashboards state + flow
  AlertsModule.js       alerts state + flow
  dashboards/           live migration, export/import
  alerts/               stage runners, export/import, selection screens
```

`utils.js` imports no framework code — every function takes a `client` as its first argument, which keeps the API layer independent of the UI.

---

## Known constraints summary

| Constraint | Reason |
|---|---|
| Cross-org/region needs two passes | Session is org-scoped; NerdGraph rejects browser API-key calls (CORS) |
| Only EMAIL / MOBILE_PUSH destinations created | The API never returns credentials for the others |
| Only NRQL conditions migrated | No API to enumerate other condition types |
| Tag filtering matches conditions, not policies | `policiesSearch` has no tag criteria; condition entities do carry tags |
| A filtered run copies only the matched conditions | Its policy is created so they have a parent, but its other conditions are not included |
| Synthetics monitors not migrated | Not implemented yet |
