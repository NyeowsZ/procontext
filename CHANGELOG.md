# Changelog (Append-Only)

> **Policy:** This changelog is **strictly append-only** in chronological order.
> Past release sections must never be edited, reordered, or deleted — new releases are always appended to the end of this file.

---

## [1.0.0] - 2026-11-24
### Added
- Rebranded plugin display identity to **Procontext** with fork attribution to `BlueNebula-Dev/token-context-meter`.
- **Coding HUD** (default), **Simple**, and **Full** display modes with `2×2` sparkline KPI grid and 4-cell coding stat strip.
- Cross-chat **Cache TTL** survival bounds learner (`warmSamples`, `coldSamples`, `maxWarmGapMs`, `minColdGapMs`).
- **5-Hour & Weekly Quota Pool** grouping (`GetAvailableModels`), empirical per-1% token burn correlation, and runway estimates.
- Per-account separated `usage-store.json` with manual snapshots, baseline reset, and JSON export/import.
- 3-level **Tool Calls** tree, **Context Compaction** checkpoints, **Subagents** inspection, and paginated `By Prompt` / `By Step` ledger.
- MCP stdio server (`mcp/server.mjs`) exposing `get_token_context`, `get_quota_status`, and `get_turn_history`.

---

## [1.0.1] - 2026-11-25
### Changed
- Unified Quotas, Global Models, Snapshots, and drill-down views into `.cat-list` / `.cat-row` SPA sub-pages.
- Defaulted telemetry items to compacted format and streamlined single-pill Cache TTL + Quota Pool rows.
- Removed automatic reset snapshot creation on quota cycle `resetTime` drift (`4e4a97f`).
- Updated `README.md` and live UI screenshots (`fbb90ca`).

---

## [1.1.0] - 2026-11-25
### Added
- **Strictly Append-Only Global SQLite WAL Log (`global-log.db`)** via built-in `node:sqlite` (`sidecars/meter/log-db.mjs`):
  - Enforces immutability with `trg_events_no_update` and `trg_events_no_delete` SQLite triggers (`ABORT` on `UPDATE`/`DELETE`).
  - Idempotent `event_uid` (`INSERT OR IGNORE`), separate mutable `ingest_cursors` watermarks, additive `schema_migrations` (including `VIRTUAL` generated `model` column), and `schema_ver` normalizers (`v0`, `v1`).
  - `sanitizeSmallData` (retains small RPC `extras` up to 2 KB while stripping auth secrets and summarizing large blobs) and `truncatePrompt` (5–10 words / `<= 100` chars with token redaction).
- **Antigravity Ingest & Capture Workflows** (`sidecars/meter/ingest.mjs`):
  - Multi-root `userdata_key` discovery (`desktop:default`, `t3:<dir>`, `cli:<dir>`, `PROCONTEXT_USERDATA_DIRS`) and canonical `user_id` attribution.
  - Mappers for `user.snapshot`, `quota.snapshot`, `turn.usage` (with exact turn timestamps), `prompt.boundary`, `tool.call` (with `agy-fast` inner telemetry & subagent links), `convo.archive`, and `legacy.import` (`schema_ver = 0`).
  - Cursor-based incremental capture, `takeAll`, and `takeConvo`.
- **Read-Only Audit Engine & CLI** (`sidecars/meter/global-check.mjs`, `package.json`):
  - `npm run global:take` and `npm run global:check` (`--json`, `--web`, `--verify`, `--cap-5h`, `--user`, `--userdata`, `--seq`).
  - Computes 5-hour rolling usage, 5-hour negative cap overage, 7-day daily/model/workspace buckets, per-user/userdata splits, `agy-fast` inner stats, and `seq <= N` prefix checksums.
- **Sidecar & MCP Integration**:
  - Wired incremental log appending into `global-store.mjs`, added `/api/global/audit` and `/api/global/take` in `main.mjs`, and added **Take All** / **Take Convo** buttons in the Global tab.
  - Added `get_global_audit` and `capture_global_log` tools to `mcp/server.mjs`.
  - Added `test/global-log.test.mjs` (`npm test`).


---

## [1.1.1] - 2026-11-25
### Added
- Merged live **v1.0.2** telemetry & HUD improvements into the **v1.1.0** append-only log release:
  - Dual Yellow/Red **Context Flags** (`compactAlarmK` / `compactCritK`) with inline popovers, bar ticks, and sparkline threshold lines.
  - Switchable **5h / 7d Quota** HUD card (`hudQuotaSwitchBtn`) backed by `quota5h` and `quota7d` rolling window summaries, `storedRates`, and rolling-share fallback.
  - Finer `exactUsedPct` tracking, quota-cycle drift tolerance, fuzzy pool-model matching, legacy `5h:gemini-*` cycle consolidation, and deprecation cleanup of Argon-only cycles.
  - Rolling 5h/7d consumption summary line in MCP `get_quota_status` and 30-second HUD sync refresh.
