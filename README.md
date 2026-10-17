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

> **Only import bundles you produced yourself.** A bundle is plain JSON that defines alert conditions, NRQL queries and notification recipients, and importing it creates them in your account using *your* permissions. The import screen lists what will be created — including every email address a notification destination would reach — so review it before confirming. Treat a bundle from someone else the way you'd treat any file you're about to execute.

---

## Dashboards

### What you can do

1. **Discover** by *all dashboards*, *keyword*, or *tag key/value*.
2. **Migrate live** (same org + region) — read source, create in target, one pass.
3. **Export / Import** (cross org or region) — download selected dashboards, then create them in the target.

### Discovery returns everything

All three options return **every** matching dashboard in the account. Discovery follows New Relic's `entitySearch` cursor to the end — the API caps a single response at 200 entities, and because each dashboard publishes one entity per page as well as itself, an account can hold far more entities than dashboards.

### How the keyword filter matches

| | |
|---|---|
| **Where it looks** | The dashboard's name, and the names of its pages/tabs |
| **Multiple words** | Every word must be present (AND), all on the same name |
| **Matching** | Case-insensitive substring; word order is irrelevant |
| **Not searched** | Widget titles, NRQL, descriptions, tags |

So `Boomi logs` finds `Boomi_Audit_Logs_NonProd_Dashboard` — the words don't have to be adjacent or in order. `non prod` finds `BTP_NonProd_Dashboard`.

When a dashboard matches through one of its pages rather than its own name, the selection list says which page — otherwise a result whose title doesn't contain your search text looks like a bug.

### How the tag filter matches

Key and value must both match exactly, case-insensitively. Evaluated against **every tag on the dashboard and on its page entities**, so it covers both:

- **Tags New Relic sets when a dashboard is created** — `permissions`, `createdBy`, `accountId`, `trustedAccountId`, `isDashboardPage`, `parentId`
- **Tags you add yourself** — any key/value

A tag that sits only on a page still returns the whole dashboard. If nothing matches, the error lists the tag keys the account actually uses (and, for a key that exists, the values in use) rather than just reporting no results.

Alert **policies** can't be searched by tag — see the alerts section.

### What it changes, and what it doesn't

The **only** thing rewritten is the account reference inside widget queries — `accountId` and `accountIds` anywhere in a widget's `rawConfiguration`, swapped in place from the source account to the target.

Deliberately left alone:

- **NRQL query text** — untouched.
- **Dashboard permissions** — copied as-is. A `PRIVATE` dashboard stays `PRIVATE`; nothing is made more permissive.
- **Variables** — copied, including their `accountIds`.
- **Widgets querying a third account** — preserved. Only the source account is substituted.

### Pages are never treated as separate dashboards

A dashboard appears in New Relic's entity list as itself **plus one entity per page**, named `Parent / Page`. Those page entities are a second view of the same dashboard, not dashboards of their own, so they're grouped back onto their parent. A migrated dashboard always arrives with all of its pages, with page names and order unchanged.

Grouping uses the data rather than guessing from the name: a name is only read as `Parent / Page` when a dashboard by that parent name actually exists. That matters for a dashboard whose own title contains `" / "` — for example `Digital_integration_APIM_Non_PROD / ODP PR`, which keeps its full title instead of being filed under a truncated parent that doesn't exist.

**Legacy tabbed dashboards** — older accounts have dashboards that exist only as several sibling `Parent / Tab` entities with no parent. When two or more siblings share a prefix like that, they're consolidated into one multi-page dashboard with de-duplicated page names, badged *Rebuilt from N page entities*.

### Widgets that can't be copied

A widget whose configuration New Relic refuses to return comes back marked `viz.inaccessible` with no queries or settings attached — normally because you lack access to the account it queries. There's nothing in it to copy.

Those widgets are **skipped**, and the row is reported as ⚠️ naming the count and the page. Previously the whole dashboard failed: one such widget fails its entire page, so the other widgets on it were lost too. A dashboard where *every* widget is inaccessible is refused with that reason rather than arriving empty.

Widgets drawn by a **custom nerdpack visualization** are copied but only render where that nerdpack is also deployed — flagged in the same note.

### Tags

A dashboard's tags **are** copied to the migrated copy — always, with nothing to opt into. Creating a dashboard doesn't carry tags over (`DashboardInput` has no tag field), so the tool re-applies them afterwards. For a legacy tab group, the tags of every sibling entity that was merged are unioned onto the single resulting dashboard.

Only *your* tags are copied. New Relic's own metadata tags are left alone.

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

## Adding your own tags during a migration

Separate from tag copying, every migration asks one question before it runs:

> **Add new tags to the migrated dashboards / conditions?**  → *No* / *Yes*

**No** is the default and behaves exactly as the tool did before. **Yes** opens a tag editor (key/value rows) and a choice of where they land: **all** the items in this run, or **only the ones you pick**.

- Each module keeps its own tags — tags entered in the alerts migration never reach dashboards, or the other way round.
- **Dashboards and NRQL conditions only.** Channels and muting rules aren't entities and have no GUID to tag; policies, workflows and destinations are out of scope by design.
- A new tag **overrides** a copied one with the same key, rather than leaving the item with both values.
- Narrowing to a subset never strips tags: an item you didn't pick still keeps the tags it had in the source.
- Available in **all three scenarios**. For export/import the choice is resolved at export and recorded in the bundle, and the person importing can add more on top.
- If tagging fails (usually a permissions gap) the dashboard or condition is still created and the row is flagged ⚠️ rather than reported as a clean success.

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
| Inaccessible widgets are skipped, not copied | The API returns no configuration for them; sending one fails its whole page |
| Custom-visualization widgets may not render in the target | They need their nerdpack deployed there too |
| Dashboard owner / `createdBy` cannot be preserved | `DashboardInput` accepts no owner field; the creator is whoever runs the migration |
| Synthetics monitors not migrated | Not implemented yet |
