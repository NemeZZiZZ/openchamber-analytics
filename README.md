# OpenChamber Analytics

A standalone OpenChamber analytics extension: a full-screen statistics page and
a compact right-rail panel, backed by a local read-only aggregation service
that pages through OpenCode sessions and stores numeric usage allocations.

- [Installation](#installation)
- [Permissions](#permissions)
- [What you get](#what-you-get)
- [Precision and coverage](#precision-and-coverage)
- [Timezones](#timezones)
- [Privacy and data retention](#privacy-and-data-retention)
- [Known limitations](#known-limitations)
- [Development](#development)
- [Service commands](#service-commands)
- [Releases](#releases)

## Installation

**Local folder:** in OpenChamber open Settings → Extensions and install the
absolute path of this repository folder (e.g. `/Users/you/Repository/openchamber-analytics`).
Built bundles (`panel/main.js`, `panel/main.css`, `page/main.js`,
`page/main.css`, `service/main.js`) are committed, so no build step runs at
install time.

**From Git:** install the repository URL in the same dialog; releases are
tagged `v*` and SemVer bumps drive update detection.

Requirements: OpenChamber `>=2.7.0` (the read-only OpenCode service role was
introduced in 2.7.0).

## Permissions

Installing the extension asks for:

- **`sessions` capability** — host-facing session metadata (list, open) used by
  Top Sessions navigation and the current-directory context.
- **Service with `provides: ["opencode"]`** — grants the local service a
  read-only transport to the selected OpenCode server and implies the OpenCode
  grant. The service reads only the allowlisted GET routes
  (`/api/project`, `/api/session`, `/api/session/active`,
  `/api/session/<id>`, `/api/session/<id>/message`, `/api/event`).
- **`keepRunning` service** — stays resident so live usage events and bounded
  backfill keep progressing while OpenChamber runs. Pause/stop the service in
  Settings at any time; resuming continues from persisted checkpoints without a
  full backfill.

No conversation, transcript, or write capability is requested.

## What you get

**Full page (Pages → Analytics)**

The project selector switches between all projects, the current project, and
any known project; it becomes searchable when the project list is large. The
selected project and period apply to every section.

1. Usage Summary — Tokens/Cost/Sessions tabs, Daily/Total views, Bar/Line
   toggle, previous-period deltas with an approximate marker until both
   compared periods are exact, per-model daily series (top five plus Other),
   and a horizontally scrolling full-range daily chart that opens at the most
   recent end once there are more than 30 buckets.
2. Activity — longest streak, averages per active day/week, period total, and
   the independent last-12-month Monday-first grid (initially scrolled to the
   most recent end).
3. Overview — tokens/cost/sessions cards with sparklines and deltas, cache hit
   rate, active days, current streak.
4. Efficiency — cost per million tokens, cost/tokens per session, reasoning
   share, and average/median/longest **session span** (wall-clock
   `updated − created`; may include idle time), plus response quality derived
   from assistant message timing: median/p95 response time, time to first
   token, output tokens per second, error/retry/truncation rates and tool-call
   error rate. A spend-pace card shows cost per day, a linear month-end
   forecast and statistically unusual days (median + 3·MAD). Session outcome
   cards show the failed/interrupted share of finished sessions, and
   stream-counter cards surface execution
   errors, compactions and average permission wait. Quality cards appear once
   detailed sync has stored timing facts (sessions synced by an older version
   fill in after their next change or a Reset).
5. Trends — token breakdown (input, output, reasoning, cache read, **cache
   write**), prompt caching (uncached input + cache read), sessions per day,
   cost per day, agent usage ranked by tokens, and the 7×24 activity rhythm
   with token values in every tooltip. Daily charts above 30 buckets share the
   brush.
6. Models — a per-model leaderboard with Tokens/Cost/Steps ranking, variant
   labels, share tracks, and a toggle for low-share models.
7. Top Projects — up to ten projects ranked by cost then tokens, with session
   counts and last activity; shown only in the All Projects scope. Projects
   are grouped by canonical directory, not by their display basename.
8. Top Sessions — ten rows ranked by cost then tokens, aligned columns, project
   basename, host navigation on click/Enter (a failed navigation keeps rows and
   explains itself).

**Rail panel** — scope/period selects, Tokens/Cost/Sessions/Active days KPIs,
a daily sparkline, three top models, three top sessions, coverage and
last-updated, and `Pages → Analytics` guidance (the host offers no public API
for a panel to open its own full page, so there is intentionally no such
button).

Keyboard support: chart tooltips respond to focus and Escape, the Trends brush
handles are `role="slider"` with Arrow/Page/Home/End steps, and Top Session rows
activate with Enter/Space.

## Precision and coverage

The service normalizes OpenCode data into numeric allocation events:

- A session whose message history has not been fetched yet shows as one
  **provisional snapshot event** at the session's last update. Daily/model
  placement is approximate and clearly marked.
- Once history is fetched, assistant messages allocate usage at their own
  message timestamps (multi-day sessions split across days; per-model detail
  preserved). Differences against the session snapshot become a **residual**
  event; a mismatch (message sums exceeding snapshot totals, or inconsistent
  timestamps) falls back to the provisional snapshot instead of mixing
  incompatible totals. Failed fetches keep the provisional data — failures are
  never turned into zeros.
- Snapshot precision is a state machine: **Exact** (relevant sessions all
  complete without residual), **Estimated** (nothing detailed yet), or
  **Partial** (some detailed data, some pending/failed/mismatch/residual). The
  indicator in the header/panel always shows which applies; the coverage
  tooltip breaks down complete/pending/failed/mismatched/residual counts.
- Deltas prefix `~` unless both compared periods are exact; `new` appears only
  over an exact zero previous period; All time never shows a delta.

## Timezones

Daily and hourly aggregations use the **viewing browser's IANA timezone**, not
the server's. Every snapshot request carries the timezone; invalid values fall
back to UTC (surfaced in coverage details). Cached snapshots are keyed by the
full filter identity — scope, directory, range, surface, and timezone — so two
viewers in different zones never share day buckets.

## Privacy and data retention

- Only numeric aggregates and minimal metadata (session IDs/titles/directories,
  model/agent IDs, timestamps, usage numbers) are persisted in the service data
  directory. Message text and tool payloads are stripped immediately during
  sync and never stored or transported to an iframe.
- The service listens only on `127.0.0.1`, authenticates every request
  (including `/health`) with the host-provided token, and never exposes the
  OpenCode URL or token to the browser.
- The OpenCode Stats route and provider quota data are **not** available to
  extensions; the extension does not pretend otherwise.
- Clearing data: `POST /v1/reset` (or remove the service data directory)
  deletes everything; the next sync starts fresh.

## Known limitations

- Provider/model catalogs, logos, and reasoning metadata are not available
  through the public API; the extension ships a small local label map and falls
  back to raw IDs.
- No reliable upstream OpenCode instance identifier is exposed: after a
  runtime switch the service reconciles fully rather than assuming continuous
  history. Use Reset for explicit recovery.
- Subagent/parent sessions are counted as the server reports them; no roll-up
  is assumed (avoiding double-counting).
- Scope "This project" matches the exact session directory; worktrees and
  subdirectories count as separate projects.
- Provisional (not yet synced) usage is attributed to the session's current
  model at its last update time, so charts can shift when detail arrives.
- Cost is the OpenCode-recorded value (0 for free or subscription models), so
  cost-per-million can understate the real price.
- Stream counters (execution errors, compactions, permission waits) are
  recorded only while the service is running; the history starts when the
  counters file first appears and has gaps while the service is down.
- Session outcome metrics come from runtime metadata; sessions
  synced before schema v2 report no outcome until their next change or a
  Reset.
- Snapshots are rebuilt from all stored events on every revision; very large
  histories (hundreds of thousands of events) take ~100–250 ms per request.
- The host currently offers no public API for a panel to open its full-screen
  Pages entry; the footer is guidance only.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest
npm run build       # esbuild: panel/page IIFE + Node service (committed)
npm run check:build # HTML/bundle hygiene
npm run check:guest # openchamber-guest-check (from @openchamber/sdk, via bun)
```

Source layout: `src/shared` (contracts, formatting, host bridge, surface
controller), `src/service` (reader, sync engine, store, aggregation, HTTP
API), `src/ui` (chart primitives, controls), `src/page` + `src/panel`
(surfaces). Only `src/service/opencode.ts` may import `@opencode/client`; only
the service reads service/OpenCode environment values.

## Service commands

All routes require the service bearer token and are loopback-only.

```text
GET  /health
GET  /v1/snapshot?scope=all|project&directory=…&range=1d|7d|30d|90d|all&surface=page|panel&timeZone=…
GET  /v1/sessions?…&cursor=…&limit=…        # paginated Top Sessions
GET  /v1/rate                               # current TPS/waiting snapshot
POST /v1/refresh                            # re-scan the session list now
POST /v1/reconcile                          # confirm deletions, invalidate changed sessions
POST /v1/reset                              # stop sync → clear store → fresh bootstrap
POST /v1/watch                              # select the OpenChamber event origin/session
```

Change/progress notifications (`analytics:changed`, `analytics:progress`) are
compact hints; every newly mounted surface fetches the current snapshot.

## Releases

CI (`.github/workflows/release.yml`) runs a clean install, typecheck, lint,
tests, build, output checks, guest check, and verifies the committed bundles
match a clean rebuild before packaging a tag artifact with third-party notices.
The tag must exactly match `package.json` (for example, `v0.1.0`). Release a
new version by bumping `version` in `package.json` and `package-lock.json`,
updating `CHANGELOG.md`, and pushing the matching `v*` tag.

## Verification

Run the same checks CI runs on pushes to `main` and on pull requests:

```sh
npm run typecheck && npm run lint && npm test
npm run build && npm run check:build && npm run check:guest
```

CI also rejects tracked files under `docs/superpowers/`; internal planning
artifacts must stay outside the public repository.

The historical real-host verification report (`docs/verification.md`) is not
included in the public release tree.
