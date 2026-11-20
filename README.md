# CMS Visualization Data Validator (PactumJS)

A **read-only**, [PactumJS](https://pactumjs.github.io/introduction/welcome.html) driven API tool that answers one question for a given CMS alert:

> For each Visualization tab and each party role (creditor / debtor), does the data actually exist in the Gold Lakehouse — or is it empty, failed, or blocked upstream?

It executes the **same backend queries the CMS Visualization tab needs**, classifies the result per view-role, and produces a console board plus JSON/Markdown artifacts with per-query drill-down (endpoint, SQL, HTTP status, row count, latency, raw error).

> **Read-only guarantee.** The tool never writes to any repository, GitHub, database, case, or Lakehouse table. Its only requests are `POST /v1/auth/login`, authenticated `GET`s to the CMS, and read-only `POST /query` / `POST /execute_sql` on the Lakehouse. It does not automate the CMS UI or mutate case data.

---

## Why

The Visualization tab is slow to populate (up to ~3 minutes, driven by Jupyter/Voila notebooks running several Spark SQL queries). Investigators cannot tell "still loading" from "this data will never arrive". This tool tells you precisely which views have data, which are empty, which fail and at which query, and how long each query takes.

---

## Installation

```bash
cd cms-visualization-validator
npm install
cp .env.example .env       # then fill in CMS_USERNAME / CMS_PASSWORD and confirm URLs
```

Requires Node.js 18+.

### Configuration (`.env`)

| Variable | Meaning | Default |
| --- | --- | --- |
| `CMS_BASE_URL` | CMS **backend** API (not the SPA on :5175) | `http://10.10.80.18:3090` |
| `LAKEHOUSE_BASE_URL` | Gold Lakehouse API | `http://10.10.80.19:8282` |
| `CMS_USERNAME` / `CMS_PASSWORD` | test account (staging/test only) | — |
| `TENANT_ID` | tenant | `DEFAULT` |
| `GRANULARITY` | `day` \| `month` \| `year` | `month` |
| `ROLES` | `creditor,debtor` | both |
| `REQUEST_TIMEOUT_MS` | per-request timeout (kept above the CMS's 30 s) | `35000` |
| `CONCURRENCY` | parallel checks (max 8) | `4` |
| `TIME_RANGE` | Transaction Network `timeRange` (CMS mode) | `30d` |
| `FROM_DATE` / `TO_DATE` | history / benford window | last 90 days |

`.env` is git-ignored; never commit credentials. The tool never prints the password or the full JWT — only `sub` / `jti` / expiry.

---

## Desktop UI (Electron)

Launch the graphical app:

```bash
npm start        # or: npm run ui
```

Preview the interface with synthetic data (no network required):

```bash
npm run demo
```

The window has a single control bar:

| Field | Purpose |
| --- | --- |
| **Alert ID** | The alert to inspect |
| **E2E id (optional)** | Pin the end-to-end id if Alert Navigator cannot supply it |
| **Max wait / query (s)** | Per-query timeout (default 35 s). Raise this if Counterparty / Alert History time out. |
| **Concurrency** | Parallel checks (default 2). Lower is gentler on the shared Spark engine. |
| **Granularity** | `day` / `month` / `year` |
| **Mode** | `cms` (faithful) / `raw` (diagnostic) / `both` |
| **Tenant** | Defaults to `DEFAULT` |
| **Roles** | Creditor and/or Debtor |
| **Retry failed once** | Off by default. When on, retries a transient 5xx/timeout once (shown as `x2` on the query). |
| **Run validation** | Executes the run |
| **Save JSON / Save MD** | After a run, export the report to a file of your choice |

What you see:

- **Summary chips** — `available / empty / failed / blocked` counts and the resolved end-to-end id.
- **A bootstrap banner** — green if the alert resolved, red if it could not.
- **9 cards, color-coded by worst status.** Network Analysis shows all six sub-checks (Transaction / Account / Counterparty × Creditor / Debtor).
- **Per-row `Queries ▾`** — expands every query the check ran (id, label, mode, HTTP status, rows, time, error, and `x2` when retried).
- **Per-query `Response ▾`** — expands the request parameters, the **SQL** (raw/both mode), and the raw JSON response.
- **Copy** — copies a query's SQL + response block to the clipboard.
- **Test connection** — verifies CMS login plus Lakehouse `/health` and `/tables`.
- **Save JSON / Save MD** — writes the current run to a file (standard save dialog).

Colours follow the status model: **Green = AVAILABLE, Yellow = EMPTY, Red = FAILED, Grey = BLOCKED.**

> Credentials and the JWT live only in the Electron main process. The renderer is sandboxed (`contextIsolation`, `nodeIntegration: false`) and talks to the engine through a narrow preload bridge; it never receives the password or token.

## Data Verify (raw → expected vs CMS → actual)

Beyond data *availability*, the tool can **verify correctness**: fetch the raw Lakehouse rows,
recompute the values with the CMS's own formulas, fetch the CMS endpoint JSON, and compare
per field / per view / per role.

```bash
node src/cli.js verify --alert 796                 # per-view PASS/FAIL table
node src/cli.js verify --alert 796 --dry-run       # plan only, no network
node src/cli.js verify --alert 796 --verbose --tolerance 0.01
npm run verify -- --alert 796
```

- **Statuses:** `VERIFIED` (all required fields pass), `MISMATCH` (a required field differs),
  `NOT_COMPARABLE` (no oracle: raw or CMS side unavailable), `BLOCKED` (missing role id / e2e).
- **Comparison rules:** counts/strings exact; money & percent tolerance 0.01; dates 1000 ms;
  `null` and `"no data found"` normalised to empty.
- **Formulas are taken from the CMS source (dev), not fitted:**
  `summary.totalTransactions` counts only `pacs.008.001.10` event rows
  (`transaction-lakehouse.service.ts:255`); volume sums all events; percentages use the
  pacs.008 count as denominator (`:277-278`); `statistics.totalRules` counts weighted rules
  excluding `EFRuP` (`alerts-lakehouse.service.ts:175-176,204-211`); Account Network edges are
  one per held account (`account-lakehouse.service.ts:308-339`); Conditions `totalConditions` is a
  real check that sums per-account condition rows + entity-level rows exactly as the CMS does
  (`condition-lakehouse.service.ts`), not a distinct union. A difference after a faithful
  query is reported as a real finding (expected/actual/delta), never forced green.
- **Alert History is time-pinned:** one `now` is used for both raw and CMS; if a period
  boundary is crossed, both are retried together.
- **Not comparable by design:** Profile Overview has no independent raw oracle (referenceId is
  server-side), so it is informational; Q-TH3 baseline and Q-CP4 fallback are optional only when
  the CMS itself has no baseline. `summary.durationDays` / `avgTransactionsPerDay` stay
  informational because they derive from the request window (start/end), not raw rows.
- Artifacts: `reports/verify-<runId>.json` and `.md`.

In the desktop app, use the **Availability / Data Verify** switcher at the top. Data Verify shows
each view-role with a field table (`Field · API data · After calculation · CMS value · Delta · PASS/FAIL`),
colour-coded green/red/grey, with a **Tolerance** input and JSON/Markdown export. The **API data**
column shows the raw inputs used (e.g. event counts, request window), **After calculation** shows the
value our oracle derives from them, and **CMS value** is what the CMS endpoint returned.

## Commands

```bash
# Desktop UI
npm start                       # same as: npm run ui
# Offline sanity check — no network. Verifies the plan and every SQL builder.
node src/cli.js validate --alert 12345 --dry-run

# Show the query catalogue (30 labels / 31 statements) and the 15 role-view checks.
node src/cli.js registry

# Preflight: login, Lakehouse /health, /tables vs expected tables.
node src/cli.js health

# Diagnostics
node src/cli.js login
node src/cli.js tables
node src/cli.js query --sql "SELECT count(*) AS n FROM transaction_detail WHERE tenant_id='DEFAULT'" --limit 1

# Run the validation
node src/cli.js validate --alert 796
node src/cli.js validate --alert 796 --mode raw --verbose
node src/cli.js validate --alert 796 --mode both --store-full
```

### Validate options

| Option | Purpose |
| --- | --- |
| `--alert <id>` | Alert id (required) |
| `--tenant`, `--granularity`, `--roles` | Override defaults |
| `--mode cms\|raw\|both` | Execution strategy (see below) |
| `--e2e <id>` | Pin the end-to-end id instead of deriving it |
| `--from`, `--to`, `--time-range` | Time windows |
| `--verbose` | Print every query row in the console |
| `--store-full` | Include full SQL and response bodies in artifacts |
| `--no-color` | Disable ANSI colour |
| `--dry-run` | Registry/plan check, no network |

Exit code: `0` no failures · `1` at least one FAILED check · `2` bootstrap failed / cannot run.

---

## Execution modes

- **`cms` (default, faithful)** — calls the same endpoints the tabs call (`/api/v1/lakehouse/*` for React tabs, `/api/v1/jupyter/proxy/*` for notebooks). This is the truest reflection of what the CMS would render.
- **`raw` (diagnostic)** — executes every labelled query directly against the Lakehouse (`POST /execute_sql`, and `/query` for Transaction Details) for per-query isolation, timings and SQL. Bootstrap ids still come from the CMS entity-metadata endpoint because `P1`/`P2` are Postgres lookups not reachable from the Lakehouse.
- **`both`** — CMS headline statuses plus raw per-query drill-down attached to each result.

---

## What it models

The 7 CMS sub-tabs expand to **9 data views** and **15 role-view checks**:

| View | Roles | Queries |
| --- | --- | --- |
| Alert Navigator | 1 | Q-NAV |
| Transaction Details | 1 | Q-TD |
| Transaction History | creditor, debtor | Q-TH1..3, Q-BF |
| Transaction Network | creditor, debtor | Q-TN1..6 |
| Account Network | creditor, debtor | Q-A1, Q-A2 |
| Counterparty Network | creditor, debtor | Q-CP1..4 |
| Alert History | creditor, debtor | Q-AH1, Q-AH2, Q-AH3 (count + page) |
| Conditions | 1 | Q-C1..C4 (dynamic: `5 + 2A`) |
| Profile Overview | creditor, debtor | Q-PROF-C / Q-PROF-D (via P1/P2) |

Full SQL for all **30 labels / 31 statements** lives in [`src/queries/raw.js`](src/queries/raw.js).

### Status model

| Status | Colour | Meaning |
| --- | --- | --- |
| `AVAILABLE` | Green | required queries succeeded and the view is non-empty |
| `EMPTY` | Yellow | queries succeeded but the view renders empty (`200` with zeros counts as EMPTY, never available) |
| `FAILED` | Red | a required query/endpoint failed (4xx/5xx/timeout) |
| `BLOCKED` | Grey | an upstream id is missing (e.g. null debtor id), or `endToEndId` unresolved |

A card with two roles shows each role independently; the card header status is the worst of its rows (`Red > Yellow > Green > Grey`). Missing role parameters are **BLOCKED (Grey)**, not failures.

---

## Output

Each run prints a status board and writes two artifacts to `reports/`:

- `run-<id>.json` — machine-readable: statuses, timings, resolved ids, per-query rows (SQL/request/response included with `--store-full`).
- `run-<id>.md` — human-readable report suitable for a ticket.

Credentials/tokens are always redacted.

---

## Architecture

```
src/
  cli.js                     command-line entry (validate/registry/health/tables/login/query)
  config.js                  env-driven configuration
  lib/                       Pactum HTTP client, SQL helpers, id helpers, pool, redaction
  core/                      auth, registry, status engine, executor, raw-executor, report
  queries/                   full raw SQL catalogue + CMS endpoint client
electron/
  main.js                    Electron main process (owns credentials + engine IPC)
  preload.js                 sandboxed bridge exposed to the renderer
  payload.js                 serialisable, redacted result for the UI
  renderer/
    index.html               window layout
    styles.css               dark theme + status colours
    renderer.js              board rendering, dropdowns, response viewer
tests/
  unit/                      offline unit tests (sql, registry, status engine)
  pactum/                    live Pactum connectivity tests (opt-in)
```

Run tests:

```bash
npm test                 # offline unit suite (31 tests)
RUN_INTEGRATION=1 npm run test:pactum   # live smoke tests against the configured environment
```

---

## Notes from the live environment (verified during setup)

These are real observations, not assumptions, and the tool handles them:

1. **CMS backend port** is `3090` in this environment and login/`/v1/auth/me` work there.
2. **Lakehouse `/tables`** returns `{ "available_tables": [...] }` (30 tables) — parser handles this shape; all 13 expected tables are present.
3. **Entity ids already carry `TAZAMA_EID`** in `entity-metadata` responses, and account ids carry an `MSISDN...` tail. Raw mode makes the suffix idempotent and strips `MSISDN` before edge lookups.
4. **`alert_navigator_header` lacks `block_or_override_status`** in this deployment (a `dev`-branch column). Raw Q-NAV automatically retries without it; CMS-mode Q-NAV is unaffected.
5. **Upstream slowness is real**: on a sample alert, Counterparty Network exceeded the 35 s per-request timeout in CMS mode while most other views returned. The tool reports that as a `FAILED`/`UPSTREAM_TIMEOUT` check, not a crash.

### Why Alert History (or Counterparty) can show FAILED under load

The CMS backend caps its internal Gold-Lakehouse call (around 30 s). When the validator runs many checks in parallel against the one shared Spark engine, individual queries slow from ~7 s (when run alone) to 30 s+, so a query can cross that server-side ceiling. The symptom is an HTTP 500 whose body says `Failed to fetch ...` (a wrapped downstream timeout) — **not** an empty data set and **not** a bug in the query or parameters. The CMS UI usually avoids this because it runs one notebook/tab's worth of queries at a time, so each finishes quickly.

Mitigations, all available in the UI:

- **Concurrency** (default **2**) — fewer simultaneous Spark queries means less contention. Lower is safer.
- **Max wait / query** — raise it if a query is simply slow; note the server may still return 500 at its own limit.
- **Retry failed once** (default on) — retries a transient 5xx/timeout once. A warm second attempt often succeeds.
- **raw mode** — calls the Lakehouse directly with no CMS 30 s wrapper, so the client timeout governs.

Verified during setup: the same alert-history call took ~7 s alone but 26–35 s under a full parallel run, and succeeded on a lower-concurrency second run.

The command-line equivalents are `--concurrency <n>` and `--retry`.

---

## Limitations (by design, v1)

- **Profile Overview in raw mode** falls back to the CMS endpoint: `Q-PROF-C/D` need a Lakehouse-side `referenceId` that is resolved from Postgres inside the CMS and is not exposed to clients. CMS mode always uses the endpoint.
- **P1/P2** Postgres lookups are borrowed via CMS `entity-metadata`; they are not issued directly.
- **Notebook render probe** (`{source:'voila-notebook', status:'ready'}`, `HEAD` preflight) is **not** implemented. The tool measures *data availability*, not *render success*; the two are distinct signals.
- **No retries by default** — a retry would mask flakiness. Re-run a failed check explicitly.
- Conditions is the only view whose query count is unbounded (`5 + 2A`, where `A` is the number of distinct accounts across both parties).

---

## Safety

This project was built from a read-only analysis of the CMS repository and the Lakehouse OpenAPI spec. It performs **no** Git operations and makes **no** application-data mutations. It is a tester, not a fixer — if a view is empty or failing, it reports exactly where, and stops.
