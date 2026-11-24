/**
 * Strictly Append-Only Global SQLite WAL Log (`global-log.db`).
 *
 * Uses built-in `node:sqlite` (Node >= 22.5, zero external dependencies).
 * Fail-open: gracefully no-ops if `node:sqlite` is unavailable or disk is locked.
 *
 * Invariants:
 * - `events` is strictly append-only (enforced by SQLite BEFORE UPDATE / DELETE triggers).
 * - Mutable operational watermarks live separately in `ingest_cursors`.
 * - Schema changes are additive-only (`schema_migrations`, `VIRTUAL` generated columns).
 * - Readers normalize `payload_json` by `schema_ver` without rewriting past rows.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const PRODUCER_VERSION = '1.1.0';
export const CURRENT_SCHEMA_VER = 1;
export const DEFAULT_LOG_DB_PATH = join(
  homedir(),
  '.gemini',
  'config',
  'plugins',
  'token-context-meter',
  'global-log.db'
);

let sqliteModulePromise = null;

async function loadSqlite() {
  if (!sqliteModulePromise) {
    sqliteModulePromise = import('node:sqlite').catch(() => null);
  }
  return await sqliteModulePromise;
}

export function resolveLogDbPath(explicitPath = null) {
  if (explicitPath && typeof explicitPath === 'string') return explicitPath;
  if (process.env.PROCONTEXT_LOG_DB && process.env.PROCONTEXT_LOG_DB.trim()) {
    return process.env.PROCONTEXT_LOG_DB.trim();
  }
  return DEFAULT_LOG_DB_PATH;
}

export function shortHash8(input) {
  return createHash('sha256').update(String(input ?? '')).digest('hex').slice(0, 8);
}

export function shortHash16(input) {
  return createHash('sha256').update(String(input ?? '')).digest('hex').slice(0, 16);
}

const SECRET_KEY_NAMES = new Set([
  'csrftoken',
  'csrf_token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'idtoken',
  'id_token',
  'sessiontoken',
  'session_token',
  'authtoken',
  'auth_token',
  'cookie',
  'cookies',
  'setcookie',
  'secret',
  'clientsecret',
  'client_secret',
  'apikey',
  'api_key',
  'authorization',
  'password',
  'privatekey',
  'private_key'
]);

const SECRET_VALUE_RE = /\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{12,})\b/g;

function isSecretKey(key) {
  if (!key) return false;
  const lower = String(key).toLowerCase();
  if (SECRET_KEY_NAMES.has(lower)) return true;
  if (lower.includes('password') || lower.includes('secret') || lower.includes('apikey') || lower.includes('api_key')) {
    return true;
  }
  if (lower.includes('csrf') || lower.includes('authorization') || lower.includes('cookie')) {
    return true;
  }
  return false;
}

export function maskSecretStrings(text) {
  return String(text ?? '').replace(SECRET_VALUE_RE, '[REDACTED]');
}

/**
 * Truncates prompt text to 5-10 words max (hard char cap <= 100),
 * masks token-shaped secrets, and computes deterministic length + sha256 metadata.
 */
export function truncatePrompt(rawText, { maxWords = 10, maxChars = 100 } = {}) {
  const normalized = String(rawText ?? '').trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return {
      prompt_preview: '',
      prompt_words: 0,
      prompt_chars: 0,
      prompt_sha256: shortHash16('')
    };
  }

  const words = normalized.split(' ').filter(Boolean);
  const masked = maskSecretStrings(normalized);
  const maskedWords = masked.split(' ').filter(Boolean);

  let preview = maskedWords.slice(0, maxWords).join(' ');
  const wasWordTruncated = maskedWords.length > maxWords;

  if (preview.length > maxChars) {
    preview = preview.slice(0, Math.max(1, maxChars - 1)).trimEnd() + '…';
  } else if (wasWordTruncated) {
    if (preview.length + 1 <= maxChars) {
      preview += '…';
    } else {
      preview = preview.slice(0, Math.max(1, maxChars - 1)).trimEnd() + '…';
    }
  }

  return {
    prompt_preview: preview,
    prompt_words: words.length,
    prompt_chars: normalized.length,
    prompt_sha256: shortHash16(normalized)
  };
}

/**
 * Recursively preserves small scalars/objects (`extras`) up to `maxBytes`
 * while stripping auth secrets and summarizing large strings/blobs.
 */
export function sanitizeSmallData(value, opts = {}) {
  const {
    excludeKeys = null,
    maxBytes = 2048,
    maxStringBytes = 256,
    maxArrayItems = 32,
    maxDepth = 5
  } = opts;

  const extraExclude = excludeKeys instanceof Set
    ? excludeKeys
    : new Set(Array.isArray(excludeKeys) ? excludeKeys.map(k => String(k).toLowerCase()) : []);

  function walk(val, depth) {
    if (val === null || val === undefined) return val === null ? null : undefined;
    const t = typeof val;
    if (t === 'boolean') return val;
    if (t === 'number') return Number.isFinite(val) ? val : null;
    if (t === 'bigint') return val.toString();
    if (t === 'string') {
      const masked = maskSecretStrings(val);
      const byteLen = Buffer.byteLength(masked, 'utf8');
      if (byteLen > maxStringBytes) {
        return { _omitted: true, bytes: byteLen, count: 1 };
      }
      return masked;
    }
    if (t !== 'object') return undefined;

    if (depth >= maxDepth) {
      const approx = safeJsonSize(val);
      return {
        _omitted: true,
        bytes: approx,
        count: Array.isArray(val) ? val.length : Object.keys(val).length
      };
    }

    if (Array.isArray(val)) {
      if (val.length > maxArrayItems) {
        return { _omitted: true, bytes: safeJsonSize(val), count: val.length };
      }
      const outArr = [];
      for (const item of val) {
        const cleaned = walk(item, depth + 1);
        if (cleaned !== undefined) outArr.push(cleaned);
      }
      return outArr;
    }

    const outObj = {};
    for (const [k, v] of Object.entries(val)) {
      if (isSecretKey(k) || extraExclude.has(k.toLowerCase())) continue;
      if (k === 'rawBytes' || k === 'base64' || k === 'imageData' || k === 'binary') {
        outObj[k] = { _omitted: true, bytes: safeJsonSize(v), count: 1 };
        continue;
      }
      const cleaned = walk(v, depth + 1);
      if (cleaned !== undefined) {
        outObj[k] = cleaned;
      }
    }
    return outObj;
  }

  let result = walk(value, 0);
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    let encoded = JSON.stringify(result);
    if (Buffer.byteLength(encoded, 'utf8') > maxBytes) {
      // Trim largest keys until within budget
      const entries = Object.entries(result)
        .map(([k, v]) => [k, v, safeJsonSize(v)])
        .sort((a, b) => b[2] - a[2]);
      const trimmed = { ...result };
      let omittedCount = 0;
      let omittedBytes = 0;
      for (const [k, , sz] of entries) {
        if (Buffer.byteLength(JSON.stringify(trimmed), 'utf8') <= maxBytes) break;
        delete trimmed[k];
        omittedCount += 1;
        omittedBytes += sz;
      }
      if (omittedCount > 0) {
        trimmed._truncated = { _omitted: true, bytes: omittedBytes, count: omittedCount };
      }
      result = trimmed;
    }
  }
  return result;
}

function safeJsonSize(val) {
  try {
    return Buffer.byteLength(JSON.stringify(val) || '', 'utf8');
  } catch {
    return 0;
  }
}

const MIGRATIONS = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          seq           INTEGER PRIMARY KEY AUTOINCREMENT,
          event_uid     TEXT NOT NULL UNIQUE,
          schema_ver    INTEGER NOT NULL,
          producer_ver  TEXT NOT NULL,
          kind          TEXT NOT NULL,
          ts_ms         INTEGER NOT NULL,
          user_id       TEXT,
          userdata_key  TEXT,
          cascade_id    TEXT,
          workspace     TEXT,
          payload_json  TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_events_ts       ON events(ts_ms);
        CREATE INDEX IF NOT EXISTS idx_events_user_ts  ON events(user_id, userdata_key, ts_ms);
        CREATE INDEX IF NOT EXISTS idx_events_cascade  ON events(cascade_id, seq);
        CREATE INDEX IF NOT EXISTS idx_events_kind_ts  ON events(kind, ts_ms);

        CREATE TRIGGER IF NOT EXISTS trg_events_no_update
          BEFORE UPDATE ON events
          BEGIN SELECT RAISE(ABORT, 'events table is append-only'); END;

        CREATE TRIGGER IF NOT EXISTS trg_events_no_delete
          BEFORE DELETE ON events
          BEGIN SELECT RAISE(ABORT, 'events table is append-only'); END;

        CREATE TABLE IF NOT EXISTS ingest_cursors (
          source_key      TEXT PRIMARY KEY,
          last_turn_idx   INTEGER NOT NULL DEFAULT -1,
          last_step_idx   INTEGER NOT NULL DEFAULT -1,
          file_mtime_ms   INTEGER NOT NULL DEFAULT 0,
          updated_at_ms   INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS schema_migrations (
          version     INTEGER PRIMARY KEY,
          applied_at  INTEGER NOT NULL
        );
      `);
    }
  },
  {
    version: 2,
    up(db) {
      // Additive virtual generated column over payload_json (zero storage overhead, zero rewrite)
      const cols = db.prepare(`PRAGMA table_info(events)`).all();
      const hasModelCol = cols.some(c => c.name === 'model');
      if (!hasModelCol) {
        db.exec(`
          ALTER TABLE events ADD COLUMN model TEXT
            GENERATED ALWAYS AS (json_extract(payload_json, '$.modelDisplayName')) VIRTUAL;
        `);
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_events_model ON events(model);`);
    }
  }
];

function applyMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      applied_at  INTEGER NOT NULL
    );
  `);
  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all();
  const applied = new Set(appliedRows.map(r => Number(r.version)));

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(m.version, Date.now());
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch {}
      throw err;
    }
  }
}

/**
 * Opens `global-log.db` with WAL pragmas and runs additive migrations (when writable).
 * Returns null in fail-open mode if `node:sqlite` is unavailable or DB open fails.
 */
export async function openLogDb({ dbPath = null, readonly = false } = {}) {
  const sqlite = await loadSqlite();
  if (!sqlite?.DatabaseSync) return null;

  const resolvedPath = resolveLogDbPath(dbPath);
  if (readonly && !existsSync(resolvedPath)) {
    return null;
  }

  try {
    if (!readonly) {
      mkdirSync(dirname(resolvedPath), { recursive: true });
    }
    const db = readonly
      ? new sqlite.DatabaseSync(resolvedPath, { readOnly: true })
      : new sqlite.DatabaseSync(resolvedPath);
    db.exec('PRAGMA busy_timeout = 1000;');
    if (!readonly) {
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA wal_autocheckpoint = 1000;
      `);
      applyMigrations(db);
    }
    return db;
  } catch (err) {
    console.error('[LogDB] Failed to open global-log.db:', err.message);
    return null;
  }
}

export function closeLogDb(db) {
  if (!db) return;
  try {
    db.close();
  } catch {}
}

/**
 * Appends immutable events using INSERT OR IGNORE (idempotent on `event_uid`).
 */
export function appendEvents(db, events) {
  if (!db || !Array.isArray(events) || events.length === 0) {
    return { inserted: 0, ignored: 0, total: 0, skipped: !db };
  }

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO events (
      event_uid, schema_ver, producer_ver, kind, ts_ms,
      user_id, userdata_key, cascade_id, workspace, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  let ignored = 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const ev of events) {
      if (!ev || !ev.event_uid || !ev.kind) continue;
      const schemaVer = Number.isInteger(ev.schema_ver) ? ev.schema_ver : CURRENT_SCHEMA_VER;
      const producerVer = String(ev.producer_ver || PRODUCER_VERSION);
      const tsMs = Number.isFinite(Number(ev.ts_ms)) ? Math.round(Number(ev.ts_ms)) : Date.now();
      const payloadJson = typeof ev.payload_json === 'string'
        ? ev.payload_json
        : JSON.stringify(ev.payload ?? {});

      const res = stmt.run(
        String(ev.event_uid),
        schemaVer,
        producerVer,
        String(ev.kind),
        tsMs,
        ev.user_id ?? null,
        ev.userdata_key ?? null,
        ev.cascade_id ?? null,
        ev.workspace ?? null,
        payloadJson
      );
      if (Number(res.changes) > 0) inserted += 1;
      else ignored += 1;
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    console.error('[LogDB] appendEvents failed:', err.message);
    return { inserted: 0, ignored: 0, total: events.length, error: err.message };
  }

  return { inserted, ignored, total: events.length };
}

export function getCursor(db, sourceKey) {
  if (!db || !sourceKey) return null;
  try {
    const row = db.prepare(
      'SELECT source_key, last_turn_idx, last_step_idx, file_mtime_ms, updated_at_ms FROM ingest_cursors WHERE source_key = ?'
    ).get(String(sourceKey));
    return row || null;
  } catch {
    return null;
  }
}

export function upsertCursor(db, sourceKey, { lastTurnIdx = -1, lastStepIdx = -1, fileMtimeMs = 0 } = {}) {
  if (!db || !sourceKey) return false;
  try {
    db.prepare(`
      INSERT INTO ingest_cursors (source_key, last_turn_idx, last_step_idx, file_mtime_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_key) DO UPDATE SET
        last_turn_idx = MAX(ingest_cursors.last_turn_idx, excluded.last_turn_idx),
        last_step_idx = MAX(ingest_cursors.last_step_idx, excluded.last_step_idx),
        file_mtime_ms = MAX(ingest_cursors.file_mtime_ms, excluded.file_mtime_ms),
        updated_at_ms = excluded.updated_at_ms
    `).run(
      String(sourceKey),
      Math.trunc(lastTurnIdx),
      Math.trunc(lastStepIdx),
      Math.round(fileMtimeMs || 0),
      Date.now()
    );
    return true;
  } catch (err) {
    console.error('[LogDB] upsertCursor failed:', err.message);
    return false;
  }
}

function normalizeV0(kind, payload) {
  // schema_ver = 0: legacy.import from usage-store.json
  return {
    ...payload,
    isLegacy: true
  };
}

function normalizeV1(kind, payload) {
  if (kind === 'turn.usage') {
    const u = payload.usage || {};
    const inputTokens = Number(u.inputTokens || 0);
    const cacheReadTokens = Number(u.cacheReadTokens || 0);
    const outputTokens = Number(u.outputTokens || 0);
    const thinkingOutputTokens = Number(u.thinkingOutputTokens || 0);
    const responseOutputTokens = Number(u.responseOutputTokens || 0) || Math.max(0, outputTokens - thinkingOutputTokens);
    return {
      ...payload,
      usage: {
        ...u,
        inputTokens,
        cacheReadTokens,
        outputTokens,
        thinkingOutputTokens,
        responseOutputTokens,
        totalProcessedTokens: inputTokens + cacheReadTokens + outputTokens
      }
    };
  }
  return payload;
}

/**
 * Versioned payload normalizer dispatching on `schema_ver`.
 */
export function normalizeEvent(row) {
  let parsed = {};
  try {
    parsed = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : (row.payload_json || {});
  } catch {
    parsed = { _corruptPayload: true };
  }

  const schemaVer = Number(row.schema_ver ?? 1);
  let payload = parsed;
  if (schemaVer === 0) {
    payload = normalizeV0(row.kind, parsed);
  } else if (schemaVer === 1) {
    payload = normalizeV1(row.kind, parsed);
  } else {
    payload = normalizeV1(row.kind, parsed);
  }

  return {
    seq: Number(row.seq),
    eventUid: row.event_uid,
    schemaVer,
    producerVer: row.producer_ver,
    kind: row.kind,
    tsMs: Number(row.ts_ms),
    userId: row.user_id || null,
    userdataKey: row.userdata_key || null,
    cascadeId: row.cascade_id || null,
    workspace: row.workspace || null,
    payload
  };
}

export function readEvents(db, filters = {}) {
  if (!db) return [];
  const clauses = [];
  const params = [];

  if (filters.sinceTsMs != null) {
    clauses.push('ts_ms >= ?');
    params.push(Math.round(Number(filters.sinceTsMs)));
  }
  if (filters.untilTsMs != null) {
    clauses.push('ts_ms <= ?');
    params.push(Math.round(Number(filters.untilTsMs)));
  }
  if (filters.maxSeq != null) {
    clauses.push('seq <= ?');
    params.push(Math.round(Number(filters.maxSeq)));
  }
  if (filters.minSeq != null) {
    clauses.push('seq > ?');
    params.push(Math.round(Number(filters.minSeq)));
  }
  if (filters.userId) {
    clauses.push('user_id = ?');
    params.push(String(filters.userId));
  }
  if (filters.userdataKey) {
    clauses.push('userdata_key = ?');
    params.push(String(filters.userdataKey));
  }
  if (filters.kind) {
    clauses.push('kind = ?');
    params.push(String(filters.kind));
  }
  if (Array.isArray(filters.kinds) && filters.kinds.length) {
    clauses.push(`kind IN (${filters.kinds.map(() => '?').join(',')})`);
    params.push(...filters.kinds.map(String));
  }
  if (filters.cascadeId) {
    clauses.push('cascade_id = ?');
    params.push(String(filters.cascadeId));
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const order = filters.desc ? 'DESC' : 'ASC';
  const limitSql = filters.limit ? `LIMIT ${Math.max(1, Math.trunc(Number(filters.limit)))}` : '';

  const rows = db.prepare(`
    SELECT seq, event_uid, schema_ver, producer_ver, kind, ts_ms,
           user_id, userdata_key, cascade_id, workspace, payload_json
    FROM events
    ${where}
    ORDER BY seq ${order}
    ${limitSql}
  `).all(...params);

  return rows.map(normalizeEvent);
}

/**
 * Verifies immutability triggers, schema migrations, and prefix checksum (`seq <= maxSeq`).
 */
export function verifyLogDb(db, { maxSeq = null } = {}) {
  if (!db) {
    return { ok: false, error: 'Database unavailable' };
  }

  const triggers = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'events'`
  ).all().map(r => r.name);

  const hasNoUpdate = triggers.includes('trg_events_no_update');
  const hasNoDelete = triggers.includes('trg_events_no_delete');

  const migrations = db.prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version ASC').all();
  const totalCountRow = db.prepare('SELECT COUNT(*) AS cnt, COALESCE(MAX(seq), 0) AS maxSeq FROM events').get();

  const effectiveSeq = maxSeq != null ? Math.min(Number(maxSeq), Number(totalCountRow.maxSeq)) : Number(totalCountRow.maxSeq);
  const rows = db.prepare(`
    SELECT seq, event_uid, schema_ver, kind, ts_ms, payload_json
    FROM events
    WHERE seq <= ?
    ORDER BY seq ASC
  `).all(effectiveSeq);

  const hash = createHash('sha256');
  for (const r of rows) {
    hash.update(`${r.seq}|${r.event_uid}|${r.schema_ver}|${r.kind}|${r.ts_ms}|${r.payload_json}\n`);
  }

  return {
    ok: hasNoUpdate && hasNoDelete && migrations.length >= 1,
    triggers: {
      trg_events_no_update: hasNoUpdate,
      trg_events_no_delete: hasNoDelete
    },
    migrations: migrations.map(m => ({ version: Number(m.version), appliedAt: Number(m.applied_at) })),
    totalEvents: Number(totalCountRow.cnt),
    maxSeq: Number(totalCountRow.maxSeq),
    prefixSeq: effectiveSeq,
    prefixEvents: rows.length,
    prefixChecksumSha256: hash.digest('hex')
  };
}
