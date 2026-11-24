# Global Append-Only Session & Telemetry Log Plan (Procontext)

> **Scope:** Upgrade **Procontext** (`token-context-meter`) with a lightweight, zero-daemon, strictly append-only global SQLite WAL log (`global-log.db`) so past history never shifts ("1% of past is always 1% of past"), schemas evolve cleanly without invalidating old records, `user_id` / `userdata_key` keep accounts distinct, all small Antigravity RPC fields (`extras`) are preserved, and `npm run global:check` audits 5-hour / 7-day usage and tool statistics.

---

## 1. Why Upgrade from `usage-store.json`

Currently, `sidecars/meter/global-store.mjs` rewrites a mutable JSON file (`usage-store.json`):
- `convCache[cascadeId]` stores one `{ mtime, totals, byModel }` aggregate per conversation (`computeAllTimeFromCache` sums whole conversations without per-turn timestamps for true rolling 5-hour / 7-day windows).
- `evaluateQuotaCycles` mutates `quotaCycles` in place, and `getCurrentAccount` / `getQuotaPools` in `sidecars/meter/telemetry.mjs` drop unused small fields from Antigravity's `LanguageServerService` responses.

Switching to an **append-only SQLite WAL log** fixes all of these with negligible write overhead (<1 ms per append) and **zero background processes when Antigravity closes**:
1. **Turn-level timestamps (`createdAtMs` / `completedAtMs`)** make 5-hour and 7-day rolling math exact.
2. **All small unused response fields (`extras`)** are preserved verbatim so 5h/7d wiring changes can be applied retroactively to past data.
3. **Raw facts in DB, caps/rules at read time:** 5-hour negative caps and token weights live in query-time config for `global:check`, never baked into immutable rows.
4. **Fail-open:** Uses built-in `node:sqlite` (`DatabaseSync`, zero native/external npm dependencies on Node `>= 22.5`) and gracefully no-ops on errors or older Node runtimes.

---

## 2. Storage Engine & Schema (`global-log.db`)

- **Path:** `~/.gemini/config/plugins/token-context-meter/global-log.db` (overridable via `PROCONTEXT_LOG_DB`).
- **SQLite Pragmas on Open:**
  ```sql
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 1000;
  PRAGMA wal_autocheckpoint = 1000;
  ```

```sql
-- 1. Strictly append-only event log (source of truth)
CREATE TABLE IF NOT EXISTS events (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT, -- immutable global order (1% past == seq <= N)
  event_uid     TEXT NOT NULL UNIQUE,              -- idempotent key prevents duplicate re-ingests
  schema_ver    INTEGER NOT NULL,                  -- payload version (1, 2, ...)
  producer_ver  TEXT NOT NULL,                     -- plugin version (e.g. "1.0.2")
  kind          TEXT NOT NULL,                     -- 'user.snapshot' | 'quota.snapshot' | 'turn.usage' | 'prompt.boundary' | 'tool.call' | 'convo.archive' | 'legacy.import'
  ts_ms         INTEGER NOT NULL,
  user_id       TEXT,                              -- canonical account/user ID (email / userStatus ID)
  userdata_key  TEXT,                              -- profile/userdata root (e.g. 'desktop:default', 't3:<dir>', 'cli')
  cascade_id    TEXT,                              -- conversation / cascade UUID
  workspace     TEXT,
  payload_json  TEXT NOT NULL                      -- self-describing versioned JSON + small 'extras'
);

CREATE INDEX IF NOT EXISTS idx_events_ts       ON events(ts_ms);
CREATE INDEX IF NOT EXISTS idx_events_user_ts  ON events(user_id, userdata_key, ts_ms);
CREATE INDEX IF NOT EXISTS idx_events_cascade  ON events(cascade_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_kind_ts  ON events(kind, ts_ms);

-- Enforce append-only invariant at the DB level
CREATE TRIGGER IF NOT EXISTS trg_events_no_update
  BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events table is append-only'); END;

CREATE TRIGGER IF NOT EXISTS trg_events_no_delete
  BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events table is append-only'); END;

-- 2. Mutable operational watermarks (kept separate from immutable events)
CREATE TABLE IF NOT EXISTS ingest_cursors (
  source_key      TEXT PRIMARY KEY,                -- e.g. '<userdata_key>:<cascade_id>'
  last_turn_idx   INTEGER NOT NULL DEFAULT -1,
  last_step_idx   INTEGER NOT NULL DEFAULT -1,
  file_mtime_ms   INTEGER NOT NULL DEFAULT 0,
  updated_at_ms   INTEGER NOT NULL
);

-- 3. Additive schema migration tracking
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  INTEGER NOT NULL
);
```

### Versioning & Malleability Without Invalidating Old Data
- **Envelope stability:** Physical columns stay minimal and fixed.
- **Versioned payload normalizers:** Readers dispatch on `schema_ver` (`normalizeV1`, `normalizeV2`, …) so newer versions read old rows cleanly without touching stored records.
- **Additive-only migrations:** Future updates only add tables, indexes, nullable columns, or **SQLite `VIRTUAL` generated columns** over `payload_json` (zero storage overhead, zero rewrite of past rows):
  ```sql
  ALTER TABLE events ADD COLUMN model TEXT
    GENERATED ALWAYS AS (json_extract(payload_json, '$.modelDisplayName')) VIRTUAL;
  CREATE INDEX IF NOT EXISTS idx_events_model ON events(model);
  ```

---

## 3. `user_id` / `userdata_key` Attribution & Canonical `event_uid`

Sessions and quotas can span multiple accounts, userdata roots, or surfaces (Desktop 2.0, CLI, IDE, ACP under `~/.t3/userdata/...`, `GEMINI_HOME`, `ANTIGRAVITY_APP_DATA_DIR`).

- **`user_id`:** Canonical account/user identifier (e.g. `userStatus.email.toLowerCase()`, provider user ID, or `AGY_ACCOUNT` / label).
- **`userdata_key`:** Canonical userdata source identifier (e.g. `desktop:default`, `t3:<account-dir>`, `cli:<gemini_home>`), plus small `userdata_path` in `payload_json`.
- **Canonical `cascade_id` & `event_uid`** (idempotent via `INSERT OR IGNORE`):
  - `user.snapshot`: `usnap:<user_id>:<userdata_key>:<hash8>`
  - `quota.snapshot`: `qsnap:<user_id>:<userdata_key>:<hash8>`
  - `turn.usage`: `turn:<userdata_key>:<cascade_id>:<turnIndex>`
  - `prompt.boundary`: `prompt:<userdata_key>:<cascade_id>:<stepIndex>`
  - `tool.call`: `tcall:<userdata_key>:<cascade_id>:<stepIndex>:<callIndex>` (or `mcp:<userdata_key>:<cascade_id_or_pid>:<ts_ms>:<callSeq>` for live MCP capture)
  - `convo.archive`: `arch:<userdata_key>:<cascade_id>:<turnCount>:<stepCount>`

---

## 4. Exact Antigravity (`LanguageServerService`) Data Map

### Small-Field Sanitizer (`sanitizeSmallData`) + Prompt Truncation
- **Prompt truncation (5–10 words max):** Normalize whitespace and cap at `maxWords = 10` (hard char guard `<= 100` chars), masking any token-shaped string (`sk-...`, `ghp_...`, `AIza...`, `Bearer ...`). Store alongside `prompt_words`, `prompt_chars`, `prompt_sha256` (16 hex chars), and `source_ref` (`{ cascadeId, stepIndex }`).
- **Keep all small "unused" response fields (`extras`):** Recursively keep all booleans, numbers, nulls, and short strings (`<= 256` bytes) in `extras` (row budget `<= 2 KB`), excluding only auth secrets (`csrfToken`, `accessToken`, `refreshToken`, `cookie`, `secret`, `apiKey`, `authorization`) and huge blobs (long `content`, code bodies, tool stdout, base64/media -> summarized as `{ _omitted: true, bytes, count }`).

### Event Kinds & Captured Fields

1. **`user.snapshot`** ← `GetUserStatus` (`resp.userStatus`)
   - `email`, `name`, `planName`, plus **all remaining small scalars/objects** from `resp.userStatus` / `planStatus` / `planInfo` / credits / tier flags in `extras`. Emitted when fingerprint changes or on explicit capture.

2. **`quota.snapshot`** ← `GetAvailableModels` (`resp.response`)
   - Per model: `modelKey`, `displayName`, `model`, `maxTokens`, `maxOutputTokens`, `quotaInfo` (`remainingFraction`, `resetTime`, plus any extra `quotaInfo` keys), and small model capability/tag flags in `extras`.
   - Top-level `resp.response` small fields in `extras`. Emitted when any `remainingFraction` / `resetTime` / model quota signature changes or on explicit capture.

3. **`turn.usage`** ← `GetCascadeTrajectory` (`trajectory.generatorMetadata[i]` + linked `steps[]` timestamps)
   - `turnIndex`, `stepIndices`, `createdAtMs`, `completedAtMs`, `gapSincePrevTurnMs`
   - `modelDisplayName`, `responseModel`, `modelKey`, `apiProvider`
   - `usage`: `inputTokens`, `cacheReadTokens`, `outputTokens`, `thinkingOutputTokens`, `responseOutputTokens`, plus **any unused small fields** on `turn` / `chatModel` / `usage` in `extras`
   - `cacheStatus` (`initial | warm_hit | cross_model_hit | cold_miss | model_switch_miss`), `isCompaction`

4. **`prompt.boundary`** ← `GetCascadeTrajectory` (`steps[i]` where `type === 'CORTEX_STEP_TYPE_USER_INPUT'`)
   - `stepIndex`, `prompt_preview` (5–10 words max), `prompt_words`, `prompt_chars`, `prompt_sha256`
   - `step.status`, `step.metadata` small fields (`createdAt`, `source`, etc.), and small `extras` from `step` (excluding full `userResponse` and media blobs).

5. **`tool.call`** ← `GetCascadeTrajectory` (`steps[i].plannerResponse.toolCalls[j]`) *(plus optional live `agy-fast` MCP capture)*
   - `stepIndex`, `callIndex`, `name`, `canonicalName` (e.g. `call_mcp_tool:agy-fast-nyeowsz_fast/batch_search`), `modelDisplayName`, `target` label, `status`, `createdAtMs`.
   - **`agy-fast` Inner Telemetry (`inner`):**
     - `batch_search`: `batch_size`, `by_type` (`symbol`, `def`, `refs`, `text`, `regex`, `glob`, `fuzzy`, `git`), `output_modes` (`content`, `files_with_matches`, `count`), `multiline`, `include_body_false`, `has_glob`, `has_file_type`, `sort_by_mtime`.
     - `apply_edits`: `file_count`, `hunk_count`, `guarded_hunk_count`, `target_hunk_count`, `replace_all_count`, `create_count`, `delete_count`, `move_count`, `dry_run`, `best_effort`, `has_verify`.
     - `read_slices`: `outline_count`, `slice_file_count`, `range_count`, `line_ranges_shorthand_count`.
     - `quick_outline`: `path_count`.
     - `run_checks`: `command_count`, `output_mode`, `concurrency`.
   - **Subagent links:** `childCascadeId` when `name === 'invoke_subagent'`.
   - **Excluded:** Raw `argumentsJson` code/content bodies, large file writes, and tool stdout.

6. **`convo.archive` / `legacy.import`**
   - `convo.archive`: Explicit marker when "One-Click Take Whole Convo" runs (`cascade_id`, `status`, `turnCount`, `stepCount`, small top-level `trajectory` `extras`).
   - `legacy.import`: One-time lossless import of existing `usage-store.json` baselines/snapshots tagged `schema_ver = 0`.

---

## 5. Capture Workflows & `npm run global:check`

### Incremental & One-Click Capture
- **Incremental auto-append:** Uses `ingest_cursors` (`last_turn_idx`, `last_step_idx`) so only newly completed turns/steps/quota changes are appended (`INSERT OR IGNORE`).
- **One-Click Take All (`npm run global:take -- --all` or Sidecar button):** Scans conversations across discovered `userdata_key`s, calling `GetUserStatus`, `GetAvailableModels`, and `GetCascadeTrajectory` to append all unseen rows.
- **One-Click Take Whole Convo (`npm run global:take -- --session <cascade_id>` or Sidecar button):** Captures every `turn.usage`, `prompt.boundary`, `tool.call` (with `agy-fast` inner stats), subagent link, and `convo.archive` for that chat.

### `npm run global:check` (Read-Only Audit & Web Check)
Reads `global-log.db` (never mutates `events`):
- **Per-`user_id` / Per-`userdata_key` + Overall Splits:** Clearly separates accounts and profiles.
- **5-Hour Window & 5-Hour Negative:** Sums exact `turn.usage` rows in `[now - 5h, now]` + correlates against `quota.snapshot` (`remainingFraction`, `resetTime`, burn/1%, configurable `--cap-5h` budget).
- **7-Day Window:** Exact daily turn-timestamp buckets across users, models, and workspaces.
- **`agy-fast` Inner Statistics:** Breakdown of `batch_search` inner types (`symbol` vs `regex` vs `text` vs `def` vs `refs` vs `glob` vs `fuzzy` vs `git`), `apply_edits` guarded vs target hunks, batch sizes, and corruption rates.
- **Output Modes:** Terminal summary (default), `--json`, `--web` (static self-contained `.html` report or Procontext sidecar view), and `--verify` (checks triggers, migrations, and `seq <= N` prefix checksums).

---

## 6. Planned File Layout (Procontext)

| File | Responsibility |
| :--- | :--- |
| `sidecars/meter/log-db.mjs` | Lazy `node:sqlite` WAL DB, migrations, immutability triggers, `sanitizeSmallData` + 5–10 word truncator, `appendEvents`, versioned `normalizeEvent` readers |
| `sidecars/meter/ingest.mjs` | Maps `GetUserStatus`, `GetAvailableModels`, `GetCascadeTrajectory` + `agy-fast` inner tool-call extractor + `userdata_key` resolver + cursor-based incremental & one-click `takeAll` / `takeConvo` |
| `sidecars/meter/global-check.mjs` | Read-only 5h / 5h-negative / 7d / per-user / inner-tool stats engine + CLI (`global:take`, `global:check`) + `--json` / `--web` / `--verify` |
| `sidecars/meter/global-store.mjs`, `main.mjs`, `mcp/server.mjs` | Wire `log-db.mjs` + `ingest.mjs` into Procontext's global API, MCP tools, and sidecar one-click triggers |
| `test/global-log.test.mjs` | Tests for immutability triggers, frozen `schema_ver=1` fixtures, `user_id`/`userdata_key` separation, `extras` small-field retention, 5–10 word truncation, `agy-fast` inner stats, and exact turn-timestamp 5h/7d math |
