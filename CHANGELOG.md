# Changelog

All notable changes to this project are documented in this file. The format
follows Keep a Changelog; versioning is SemVer, and Git tags drive update
detection.

## [0.1.0] — 2026-11-21

### Fixed

- "Avg busy time" was wrong and is removed: upstream `time.busy`/`time.idle`
  are transition timestamps, not durations.
- TPS meter: a legacy `question.asked` no longer leaves the meter stuck on
  "waiting for permission".
- Live usage events no longer invalidate a session on the next reconcile, and
  bursts of events trigger one debounced detail download instead of one each.
- One malformed session record no longer blocks the whole session list.
- Explicit refresh/reconcile/reset commands are serialized; the TPS meter and
  idle connections are closed on shutdown; request bodies decode multi-byte
  UTF-8 correctly.
- The "Today" (`1d`) range offered by the page was rejected by the service.
- `/v1/sessions` pages share one ranking per revision (stable cursors; ties
  broken by session id); "Other" model row no longer double-counts sessions.
- A crash between an allocation and its session line can no longer leave a
  session "complete" with zero usage.
- Reset replaces persisted files before clearing live state, so a failed disk
  operation no longer reports success with memory and storage diverged.
- Top Projects groups by canonical directory rather than basename; metadata
  changes now include directory and invalidate cached snapshots.
- Top Projects tolerates snapshots from an older keepRunning service.

### Security

- `/v1/watch` rejects link-local, metadata and unspecified hosts; the SSE reader
  caps frame size, accepts CRLF and drops stalled streams.
- Store files are created owner-only (0600/0700), and existing files have
  their permissions migrated on open; HTTP request/header timeouts.

### Performance

- Snapshot payloads are serialized once and served from an LRU cache.
- Manifest rewrites are skipped when unchanged and coalesced per revision.
- Snapshot builds share one per-day token pass (~40% faster on 200k events);
  timezone caches are bounded (8 zones).
- Sync queue is a binary heap (O(log n) pop); the hidden panel stops polling
  the TPS rate.

### Added

- CI workflow for pushes to `main` and pull requests, including a guard that
  rejects tracked `docs/superpowers/` files and an explicit Bun runtime for
  the SDK guest-package check.
- Models leaderboard, searchable project filter and Top Projects ranking.
- Response-quality metrics (response/first-token latency, output tokens per
  second, error/retry/truncation and tool-error rates) and spend-pace metrics
  (cost per day, month-end forecast, anomaly days). New optional fields on
  stored usage events; existing data stays valid.
- Session outcome (`succeeded`/`failed`/`interrupted`) and
  live-stream counters (execution errors, interruptions, compactions, retries,
  permission prompts and their wait times) stored in a new `counters.jsonl`
  and surfaced as snapshot metrics and Efficiency cards. Store schema version
  2; version 1 data from earlier releases still loads.

### Changed

- Release archives include third-party MIT notices and release tags must match
  the package version.
- Shared `eventTokens` and scope helpers replace duplicated copies.
- Removed dead code: the unused `revisionTag` parameter of
  `replaceAllocation` and the never-written `'syncing'` sync state (a legacy
  stored `"syncing"` line reloads as `pending`).

## [0.1.0] — 2026-11-19

### Added

- Full-screen Analytics page: Usage Summary (Tokens/Cost/Sessions, Daily/Total,
  Bar/Line, per-model daily series with the shared 32px brush above 30
  buckets), Activity (last-12-month Monday-first grid, streaks, period
  averages), Overview cards, Efficiency cards (wall-clock session spans),
  Trends (token breakdown including cache write, prompt caching, sessions per
  day, cost per day, agent usage, activity rhythm with token values), and Top
  Sessions with host navigation.
- Compact rail panel: scope/period controls, four KPIs, daily sparkline, three
  top models, three top sessions, coverage/last-updated line, and
  `Pages → Analytics` guidance.
- Persistent read-only local aggregation service: prioritized message-history
  sync (four workers, checkpoint per session), live `session.usage.updated`
  handling as replacement totals, deletion reconciliation, capped retry
  backoff, stream-reconnect reconciliation, and an authenticated loopback HTTP
  API (`/health`, `/v1/snapshot`, `/v1/sessions`, `/v1/refresh`,
  `/v1/reconcile`, `/v1/reset`).
- Precision model: provisional session-snapshot estimates refine into
  message-time allocations; Estimated → Partial → Exact transitions follow the
  coverage state machine; residual, mismatch, and failure states stay visible.
- Numeric-only JSONL persistence (sessions/events/manifest) with truncated-tail
  recovery and stale-fingerprint invalidation; no conversation content is ever
  stored or sent to an iframe.
- Viewer-timezone aware daily/hourly aggregation with cached snapshots keyed by
  the full filter identity, including timezone.
