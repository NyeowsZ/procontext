/**
 * Antigravity Telemetry Ingest & Canonical Event Mappers.
 *
 * Maps `GetUserStatus`, `GetAvailableModels`, `GetCascadeTrajectory`,
 * `agy-fast` inner tool arguments, and legacy `usage-store.json` records
 * into immutable `global-log.db` events with cursor-based incremental capture.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import {
  CURRENT_SCHEMA_VER,
  PRODUCER_VERSION,
  appendEvents,
  closeLogDb,
  getCursor,
  openLogDb,
  sanitizeSmallData,
  shortHash8,
  truncatePrompt,
  upsertCursor
} from './log-db.mjs';
import { callLanguageServerRpc } from './telemetry.mjs';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const DEFAULT_LEGACY_STORE_PATH = join(
  homedir(),
  '.gemini',
  'config',
  'plugins',
  'token-context-meter',
  'usage-store.json'
);

/**
 * Resolves canonical `user_id` from GetUserStatus response or environment.
 */
export function resolveUserId(userStatus = null) {
  const email = (userStatus?.email || '').trim().toLowerCase();
  if (email) return email;
  const uid = (userStatus?.userId || userStatus?.id || userStatus?.accountId || '').trim();
  if (uid) return uid;
  const agyAccount = (process.env.AGY_ACCOUNT || '').trim();
  if (agyAccount) return agyAccount;
  return 'local-default';
}

/**
 * Discovers Antigravity / T3 / CLI userdata roots and assigns canonical `userdata_key`.
 */
export function discoverUserdataRoots() {
  const roots = [];
  const seenDirs = new Set();

  function addRoot(userdataKey, baseDir, convDir) {
    const resolvedConv = convDir || join(baseDir, 'conversations');
    if (seenDirs.has(resolvedConv)) return;
    if (!existsSync(resolvedConv)) return;
    seenDirs.add(resolvedConv);
    roots.push({
      userdataKey,
      userdataPath: baseDir,
      conversationsDir: resolvedConv
    });
  }

  // 1. Explicit override list (comma or semicolon separated)
  if (process.env.PROCONTEXT_USERDATA_DIRS) {
    const parts = process.env.PROCONTEXT_USERDATA_DIRS.split(/[;,]/).map(s => s.trim()).filter(Boolean);
    for (const p of parts) {
      const label = basename(p) || 'custom';
      addRoot(`custom:${label}`, p, existsSync(join(p, 'conversations')) ? join(p, 'conversations') : p);
    }
  }

  // 2. Explicit ANTIGRAVITY_APP_DATA_DIR / GEMINI_HOME
  if (process.env.ANTIGRAVITY_APP_DATA_DIR) {
    const d = process.env.ANTIGRAVITY_APP_DATA_DIR.trim();
    addRoot(`app:${basename(d) || 'antigravity'}`, d, join(d, 'conversations'));
  }
  if (process.env.GEMINI_HOME) {
    const d = process.env.GEMINI_HOME.trim();
    addRoot(`cli:${basename(d) || 'gemini'}`, d, join(d, 'conversations'));
    addRoot(`cli:${basename(d) || 'gemini'}`, d, join(d, 'antigravity', 'conversations'));
  }

  // 3. Standard Desktop 2.0 default
  const defaultBase = join(homedir(), '.gemini', 'antigravity');
  addRoot('desktop:default', defaultBase, join(defaultBase, 'conversations'));

  // 4. Multi-account / T3 userdata roots under ~/.t3/userdata/<dir>
  const t3Base = join(homedir(), '.t3', 'userdata');
  if (existsSync(t3Base)) {
    try {
      for (const entry of readdirSync(t3Base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dirPath = join(t3Base, entry.name);
        if (existsSync(join(dirPath, 'conversations'))) {
          addRoot(`t3:${entry.name}`, dirPath, join(dirPath, 'conversations'));
        } else if (existsSync(join(dirPath, 'antigravity', 'conversations'))) {
          addRoot(`t3:${entry.name}`, join(dirPath, 'antigravity'), join(dirPath, 'antigravity', 'conversations'));
        }
      }
    } catch {}
  }

  return roots;
}

export function listConversationFiles(convDir) {
  if (!convDir || !existsSync(convDir)) return [];
  try {
    return readdirSync(convDir)
      .filter(f => f.endsWith('.db') || f.endsWith('.pb'))
      .map(f => {
        try {
          return {
            id: f.replace(/\.(db|pb)$/, ''),
            mtime: statSync(join(convDir, f)).mtimeMs
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

function parseStepTimeMs(stepObj, preferEnd = false) {
  const md = stepObj?.metadata;
  if (!md) return null;
  const raw = preferEnd
    ? (md.completedAt || md.finishedGeneratingAt || md.createdAt)
    : (md.createdAt || md.startedAt || md.completedAt);
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

function extractCompactTargetLabel(name, args) {
  if (!args || typeof args !== 'object') return '(default)';
  const filePath = args.Path || args.AbsolutePath || args.TargetFile || args.path || args.file || args.cwd;
  if (typeof filePath === 'string' && filePath.trim()) {
    const clean = filePath.replace(/\\/g, '/');
    return basename(clean) || clean;
  }
  if (name === 'run_command') {
    if (typeof args.toolSummary === 'string' && args.toolSummary.trim()) {
      return args.toolSummary.trim().slice(0, 42);
    }
    if (typeof args.CommandLine === 'string' && args.CommandLine.trim()) {
      return args.CommandLine.trim().replace(/\s+/g, ' ').slice(0, 42);
    }
  }
  if (name === 'call_mcp_tool' && args.ServerName && args.ToolName) {
    return `${args.ServerName}/${args.ToolName}`;
  }
  if (typeof args.toolSummary === 'string' && args.toolSummary.trim()) {
    return args.toolSummary.trim().slice(0, 42);
  }
  if (typeof args.query === 'string' && args.query.trim()) {
    return args.query.trim().slice(0, 42);
  }
  return '(default)';
}

/**
 * Extracts structured `agy-fast` inner tool telemetry from tool arguments
 * without storing raw code bodies, targets, or stdout.
 */
export function extractAgyFastInner(name, canonicalName, argsObj) {
  const args = argsObj && typeof argsObj === 'object' ? argsObj : {};
  const idStr = `${canonicalName || ''} ${name || ''}`.toLowerCase();

  let fastTool = null;
  if (idStr.includes('batch_search')) fastTool = 'batch_search';
  else if (idStr.includes('apply_edits')) fastTool = 'apply_edits';
  else if (idStr.includes('read_slices')) fastTool = 'read_slices';
  else if (idStr.includes('quick_outline')) fastTool = 'quick_outline';
  else if (idStr.includes('run_checks')) fastTool = 'run_checks';

  if (!fastTool) return null;

  if (fastTool === 'batch_search') {
    const queries = Array.isArray(args.queries) ? args.queries : [];
    const byType = {};
    const outputModes = {};
    let multiline = 0;
    let includeBodyFalse = 0;
    let hasGlob = 0;
    let hasFileType = 0;
    let sortByMtime = 0;

    for (const q of queries) {
      if (!q || typeof q !== 'object') continue;
      const qt = String(q.type || 'unknown');
      byType[qt] = (byType[qt] || 0) + 1;
      const om = String(q.outputMode || 'content');
      outputModes[om] = (outputModes[om] || 0) + 1;
      if (q.multiline) multiline += 1;
      if (q.includeBody === false) includeBodyFalse += 1;
      if (q.glob) hasGlob += 1;
      if (q.fileType) hasFileType += 1;
      if (q.sortBy === 'mtime') sortByMtime += 1;
    }

    return {
      tool: 'batch_search',
      batch_size: queries.length,
      by_type: byType,
      output_modes: outputModes,
      multiline,
      include_body_false: includeBodyFalse,
      has_glob: hasGlob,
      has_file_type: hasFileType,
      sort_by_mtime: sortByMtime
    };
  }

  if (fastTool === 'apply_edits') {
    let edits = args.edits;
    if (typeof edits === 'string') {
      try { edits = JSON.parse(edits); } catch { edits = []; }
    }
    edits = Array.isArray(edits) ? edits : [];

    let hunkCount = 0;
    let guardedHunkCount = 0;
    let targetHunkCount = 0;
    let replaceAllCount = 0;
    let createCount = 0;
    let deleteCount = 0;
    let moveCount = 0;

    for (const ed of edits) {
      if (!ed || typeof ed !== 'object') continue;
      if (typeof ed.create === 'string') createCount += 1;
      if (ed.delete) deleteCount += 1;
      if (ed.moveTo) moveCount += 1;
      const hunks = Array.isArray(ed.hunks) ? ed.hunks : [];
      hunkCount += hunks.length;
      for (const h of hunks) {
        if (!h || typeof h !== 'object') continue;
        if (h.target !== undefined && h.target !== null) {
          targetHunkCount += 1;
        } else if (h.startLine != null || h.anchorStart != null || h.anchorEnd != null) {
          guardedHunkCount += 1;
        }
        if (h.replaceAll) replaceAllCount += 1;
      }
    }

    return {
      tool: 'apply_edits',
      file_count: edits.length,
      hunk_count: hunkCount,
      guarded_hunk_count: guardedHunkCount,
      target_hunk_count: targetHunkCount,
      replace_all_count: replaceAllCount,
      create_count: createCount,
      delete_count: deleteCount,
      move_count: moveCount,
      dry_run: Boolean(args.dryRun),
      best_effort: Boolean(args.bestEffort),
      has_verify: Boolean(args.verify)
    };
  }

  if (fastTool === 'read_slices') {
    const outlines = Array.isArray(args.outlines) ? args.outlines : [];
    const slices = Array.isArray(args.slices) ? args.slices : [];
    const lineRanges = Array.isArray(args.lineRanges) ? args.lineRanges : [];
    let rangeCount = 0;
    for (const s of slices) {
      if (Array.isArray(s?.ranges)) rangeCount += s.ranges.length;
    }
    return {
      tool: 'read_slices',
      outline_count: outlines.length,
      slice_file_count: slices.length,
      range_count: rangeCount,
      line_ranges_shorthand_count: lineRanges.length
    };
  }

  if (fastTool === 'quick_outline') {
    const paths = Array.isArray(args.paths) ? args.paths : [];
    return {
      tool: 'quick_outline',
      path_count: paths.length
    };
  }

  if (fastTool === 'run_checks') {
    const cmds = Array.isArray(args.commands) ? args.commands : [];
    return {
      tool: 'run_checks',
      command_count: cmds.length,
      output_mode: String(args.outputMode || 'compact'),
      concurrency: Number(args.concurrency || 4)
    };
  }

  return null;
}

/**
 * Maps `GetUserStatus` response (`resp.userStatus`) into an immutable `user.snapshot` event.
 */
export function mapUserSnapshot({
  userStatus,
  userId = null,
  userdataKey = 'desktop:default',
  userdataPath = null,
  tsMs = Date.now()
}) {
  const us = userStatus || {};
  const resolvedUserId = userId || resolveUserId(us);
  const email = (us.email || '').trim() || null;
  const name = (us.name || '').trim() || null;
  const planName = (us.planStatus?.planInfo?.planName || '').trim() || null;

  const extras = sanitizeSmallData(us, {
    excludeKeys: ['email', 'name']
  });

  const payload = {
    email,
    name,
    planName,
    userdata_path: userdataPath || null,
    extras
  };

  const hash8 = shortHash8(JSON.stringify({ email, name, planName, extras }));
  return {
    event_uid: `usnap:${resolvedUserId}:${userdataKey}:${hash8}`,
    schema_ver: CURRENT_SCHEMA_VER,
    producer_ver: PRODUCER_VERSION,
    kind: 'user.snapshot',
    ts_ms: tsMs,
    user_id: resolvedUserId,
    userdata_key: userdataKey,
    cascade_id: null,
    workspace: null,
    payload
  };
}

/**
 * Maps `GetAvailableModels` response (`resp.response`) into an immutable `quota.snapshot` event.
 */
export function mapQuotaSnapshot({
  modelsResponse,
  userId = 'local-default',
  userdataKey = 'desktop:default',
  tsMs = Date.now()
}) {
  const respObj = modelsResponse?.response || modelsResponse || {};
  const rawModels = respObj.models || {};

  const models = [];
  const sigEntries = [];

  for (const [modelKey, def] of Object.entries(rawModels)) {
    if (!def || typeof def !== 'object') continue;
    const qi = def.quotaInfo || null;
    const rec = {
      modelKey,
      displayName: (def.displayName || modelKey).trim(),
      model: def.model || modelKey,
      maxTokens: def.maxTokens ?? null,
      maxOutputTokens: def.maxOutputTokens ?? null,
      quotaInfo: qi ? sanitizeSmallData(qi, { maxBytes: 512 }) : null,
      extras: sanitizeSmallData(def, {
        excludeKeys: ['displayName', 'model', 'maxTokens', 'maxOutputTokens', 'quotaInfo'],
        maxBytes: 512
      })
    };
    models.push(rec);

    if (qi && (qi.remainingFraction !== undefined || qi.resetTime !== undefined)) {
      sigEntries.push([
        modelKey,
        qi.remainingFraction ?? null,
        qi.resetTime ?? null
      ]);
    }
  }

  sigEntries.sort((a, b) => a[0].localeCompare(b[0]));

  const topExtras = sanitizeSmallData(respObj, {
    excludeKeys: ['models'],
    maxBytes: 1024
  });

  const payload = {
    modelCount: models.length,
    models,
    extras: topExtras
  };

  const sigHash = shortHash8(JSON.stringify({ sigEntries, topExtras }));

  return {
    event_uid: `qsnap:${userId}:${userdataKey}:${sigHash}`,
    schema_ver: CURRENT_SCHEMA_VER,
    producer_ver: PRODUCER_VERSION,
    kind: 'quota.snapshot',
    ts_ms: tsMs,
    user_id: userId,
    userdata_key: userdataKey,
    cascade_id: null,
    workspace: null,
    payload
  };
}

function inferTrajectoryWorkspace(traj, steps) {
  const direct = traj?.workspace || traj?.workspacePath || traj?.metadata?.workspace || traj?.metadata?.workspacePath;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();

  for (const s of (steps || []).slice(0, 12)) {
    const wp = s?.metadata?.workspace || s?.userInput?.workspace || s?.metadata?.cwd;
    if (typeof wp === 'string' && wp.trim()) return wp.trim();
  }
  return null;
}

/**
 * Maps `GetCascadeTrajectory` response into `turn.usage`, `prompt.boundary`, `tool.call`,
 * and optional `convo.archive` events starting from `(fromTurnIdx, fromStepIdx)`.
 */
export function mapTrajectoryEvents({
  cascadeId,
  trajectoryResp,
  userId = 'local-default',
  userdataKey = 'desktop:default',
  workspace = null,
  fromTurnIdx = 0,
  fromStepIdx = 0,
  fullArchive = false,
  tsMsFallback = Date.now()
}) {
  const traj = trajectoryResp?.trajectory || trajectoryResp || {};
  const steps = Array.isArray(traj.steps) ? traj.steps : [];
  const rawTurns = Array.isArray(traj.generatorMetadata) ? traj.generatorMetadata : [];
  const resolvedWorkspace = workspace || inferTrajectoryWorkspace(traj, steps);

  const events = [];
  const stepToModel = new Map();

  let prevPromptTokens = 0;
  let prevTurnCompletedMs = null;
  let prevTurnModelName = null;
  let latestTurnTsMs = tsMsFallback;

  // Iterate all turns to preserve exact prevTurn/cacheStatus/isCompaction context,
  // emitting events only for turnIndex >= fromTurnIdx.
  rawTurns.forEach((turn, turnIndex) => {
    const chatModel = turn?.chatModel || {};
    const usage = chatModel.usage || {};

    const inputTokens = parseInt(usage.inputTokens || '0', 10) || 0;
    const cacheReadTokens = parseInt(usage.cacheReadTokens || '0', 10) || 0;
    const outputTokens = parseInt(usage.outputTokens || '0', 10) || 0;
    const thinkingOutputTokens = parseInt(usage.thinkingOutputTokens || '0', 10) || 0;
    const responseOutputTokens = parseInt(usage.responseOutputTokens || '0', 10) || Math.max(0, outputTokens - thinkingOutputTokens);

    const promptTokens = inputTokens + cacheReadTokens;
    const modelDisplayName = chatModel.modelDisplayName || 'Default Model';
    const responseModel = chatModel.responseModel || '';
    const modelKey = usage.model || '';
    const apiProvider = usage.apiProvider || '';

    const stepIndices = Array.isArray(turn?.stepIndices) ? turn.stepIndices : [];
    for (const sIdx of stepIndices) {
      stepToModel.set(sIdx, modelDisplayName);
    }

    const firstStepIdx = stepIndices.length ? stepIndices[0] : -1;
    const lastStepIdx = stepIndices.length ? stepIndices[stepIndices.length - 1] : -1;
    const createdAtMs = firstStepIdx >= 0 ? parseStepTimeMs(steps[firstStepIdx], false) : null;
    const completedAtMs = lastStepIdx >= 0 ? (parseStepTimeMs(steps[lastStepIdx], true) || createdAtMs) : createdAtMs;
    const gapSincePrevTurnMs = (createdAtMs && prevTurnCompletedMs)
      ? Math.max(0, createdAtMs - prevTurnCompletedMs)
      : null;

    const modelSwitched = Boolean(prevTurnModelName && prevTurnModelName !== modelDisplayName);
    let cacheStatus = 'initial';
    if (turnIndex > 0) {
      if (cacheReadTokens > 0) {
        cacheStatus = modelSwitched ? 'cross_model_hit' : 'warm_hit';
      } else {
        cacheStatus = modelSwitched ? 'model_switch_miss' : 'cold_miss';
      }
    }

    const isCompaction = prevPromptTokens > 8000 && promptTokens < prevPromptTokens * 0.7;
    const eventTsMs = completedAtMs || createdAtMs || tsMsFallback;
    if (eventTsMs) latestTurnTsMs = eventTsMs;

    if (turnIndex >= fromTurnIdx) {
      const turnExtras = sanitizeSmallData({
        turn: sanitizeSmallData(turn, { excludeKeys: ['chatModel', 'stepIndices'], maxBytes: 512 }),
        chatModel: sanitizeSmallData(chatModel, {
          excludeKeys: ['usage', 'modelDisplayName', 'responseModel'],
          maxBytes: 512
        }),
        usage: sanitizeSmallData(usage, {
          excludeKeys: ['inputTokens', 'cacheReadTokens', 'outputTokens', 'thinkingOutputTokens', 'responseOutputTokens', 'model', 'apiProvider'],
          maxBytes: 512
        })
      }, { maxBytes: 1536 });

      events.push({
        event_uid: `turn:${userdataKey}:${cascadeId}:${turnIndex}`,
        schema_ver: CURRENT_SCHEMA_VER,
        producer_ver: PRODUCER_VERSION,
        kind: 'turn.usage',
        ts_ms: eventTsMs,
        user_id: userId,
        userdata_key: userdataKey,
        cascade_id: cascadeId,
        workspace: resolvedWorkspace,
        payload: {
          turnIndex,
          stepIndices,
          createdAtMs,
          completedAtMs,
          gapSincePrevTurnMs,
          modelDisplayName,
          responseModel,
          modelKey,
          apiProvider,
          usage: {
            inputTokens,
            cacheReadTokens,
            outputTokens,
            thinkingOutputTokens,
            responseOutputTokens
          },
          cacheStatus,
          isCompaction,
          extras: turnExtras
        }
      });
    }

    prevPromptTokens = promptTokens;
    if (completedAtMs) prevTurnCompletedMs = completedAtMs;
    prevTurnModelName = modelDisplayName;
  });

  // Steps: prompt.boundary & tool.call for stepIndex >= fromStepIdx
  for (let stepIndex = Math.max(0, fromStepIdx); stepIndex < steps.length; stepIndex++) {
    const step = steps[stepIndex];
    if (!step || typeof step !== 'object') continue;
    const stepTsMs = parseStepTimeMs(step, false) || latestTurnTsMs;

    if (step.type === 'CORTEX_STEP_TYPE_USER_INPUT') {
      const rawText = step.userInput?.userResponse || '';
      const trunc = truncatePrompt(rawText, { maxWords: 10, maxChars: 100 });
      const stepExtras = sanitizeSmallData(step, {
        excludeKeys: ['userInput', 'plannerResponse', 'metadata', 'status', 'type'],
        maxBytes: 1024
      });
      const mdExtras = sanitizeSmallData(step.metadata, { maxBytes: 512 });

      events.push({
        event_uid: `prompt:${userdataKey}:${cascadeId}:${stepIndex}`,
        schema_ver: CURRENT_SCHEMA_VER,
        producer_ver: PRODUCER_VERSION,
        kind: 'prompt.boundary',
        ts_ms: stepTsMs,
        user_id: userId,
        userdata_key: userdataKey,
        cascade_id: cascadeId,
        workspace: resolvedWorkspace,
        payload: {
          stepIndex,
          ...trunc,
          source_ref: { cascadeId, stepIndex },
          status: step.status || null,
          metadata: mdExtras,
          extras: stepExtras
        }
      });
    }

    const tcs = step.plannerResponse?.toolCalls;
    if (Array.isArray(tcs) && tcs.length > 0) {
      const stepModel = stepToModel.get(stepIndex) || prevTurnModelName || 'Default Model';
      for (let callIndex = 0; callIndex < tcs.length; callIndex++) {
        const tc = tcs[callIndex];
        if (!tc || typeof tc !== 'object') continue;
        const name = tc.name || 'unknown_tool';

        let argsObj = {};
        if (typeof tc.argumentsJson === 'string' && tc.argumentsJson.trim()) {
          try { argsObj = JSON.parse(tc.argumentsJson); } catch {}
        } else if (tc.argumentsJson && typeof tc.argumentsJson === 'object') {
          argsObj = tc.argumentsJson;
        }

        let canonicalName = name;
        let effectiveArgs = argsObj;
        if (name === 'call_mcp_tool' && argsObj.ServerName && argsObj.ToolName) {
          canonicalName = `call_mcp_tool:${argsObj.ServerName}/${argsObj.ToolName}`;
          if (argsObj.Arguments && typeof argsObj.Arguments === 'object') {
            effectiveArgs = argsObj.Arguments;
          } else if (typeof argsObj.Arguments === 'string') {
            try { effectiveArgs = JSON.parse(argsObj.Arguments); } catch {}
          }
        }

        const inner = extractAgyFastInner(name, canonicalName, effectiveArgs);
        const target = extractCompactTargetLabel(name, argsObj);

        let childCascadeId = null;
        if (name === 'invoke_subagent') {
          for (let look = 1; look <= tcs.length + 2 && stepIndex + look < steps.length; look++) {
            const candStr = JSON.stringify(steps[stepIndex + look] || '');
            const m = candStr.match(UUID_RE);
            if (m && m[0] !== cascadeId) {
              childCascadeId = m[0];
              break;
            }
          }
        }

        const toolExtras = sanitizeSmallData(tc, {
          excludeKeys: ['name', 'argumentsJson', 'status', 'result', 'output', 'stdout', 'stderr'],
          maxBytes: 512
        });

        events.push({
          event_uid: `tcall:${userdataKey}:${cascadeId}:${stepIndex}:${callIndex}`,
          schema_ver: CURRENT_SCHEMA_VER,
          producer_ver: PRODUCER_VERSION,
          kind: 'tool.call',
          ts_ms: stepTsMs,
          user_id: userId,
          userdata_key: userdataKey,
          cascade_id: cascadeId,
          workspace: resolvedWorkspace,
          payload: {
            stepIndex,
            callIndex,
            name,
            canonicalName,
            modelDisplayName: stepModel,
            target,
            status: tc.status || step.status || null,
            createdAtMs: stepTsMs,
            ...(inner ? { inner } : {}),
            ...(childCascadeId ? { childCascadeId } : {}),
            extras: toolExtras
          }
        });
      }
    }
  }

  if (fullArchive) {
    const trajExtras = sanitizeSmallData(traj, {
      excludeKeys: ['steps', 'generatorMetadata'],
      maxBytes: 1024
    });
    events.push({
      event_uid: `arch:${userdataKey}:${cascadeId}:${rawTurns.length}:${steps.length}`,
      schema_ver: CURRENT_SCHEMA_VER,
      producer_ver: PRODUCER_VERSION,
      kind: 'convo.archive',
      ts_ms: Date.now(),
      user_id: userId,
      userdata_key: userdataKey,
      cascade_id: cascadeId,
      workspace: resolvedWorkspace,
      payload: {
        status: trajectoryResp?.status || traj?.status || null,
        turnCount: rawTurns.length,
        stepCount: steps.length,
        extras: trajExtras
      }
    });
  }

  return {
    events,
    turnCount: rawTurns.length,
    stepCount: steps.length,
    lastTurnIdx: rawTurns.length - 1,
    lastStepIdx: steps.length - 1,
    workspace: resolvedWorkspace
  };
}

/**
 * One-time lossless import of existing `usage-store.json` tagged `schema_ver = 0`.
 */
export function importLegacyStore(db, { storePath = DEFAULT_LEGACY_STORE_PATH, userdataKey = 'desktop:default' } = {}) {
  if (!db || !storePath || !existsSync(storePath)) {
    return { imported: 0, skipped: true };
  }

  try {
    const raw = JSON.parse(readFileSync(storePath, 'utf-8'));
    const accounts = raw?.accounts && typeof raw.accounts === 'object' ? raw.accounts : {};
    const events = [];

    for (const [accountKey, bucket] of Object.entries(accounts)) {
      if (!bucket || typeof bucket !== 'object') continue;

      if (bucket.baselineAt || bucket.baseline?.totals?.totalProcessedTokens > 0) {
        const tsMs = bucket.baselineAt ? (Date.parse(bucket.baselineAt) || Date.now()) : Date.now();
        const hash8 = shortHash8(JSON.stringify({ accountKey, baselineAt: bucket.baselineAt, baseline: bucket.baseline }));
        events.push({
          event_uid: `legacy:baseline:${accountKey}:${userdataKey}:${hash8}`,
          schema_ver: 0,
          producer_ver: PRODUCER_VERSION,
          kind: 'legacy.import',
          ts_ms: tsMs,
          user_id: accountKey,
          userdata_key: userdataKey,
          cascade_id: null,
          workspace: null,
          payload: {
            legacyType: 'baseline',
            baselineAt: bucket.baselineAt || null,
            baseline: bucket.baseline || null,
            cacheLifespanByModel: bucket.cacheLifespanByModel || {}
          }
        });
      }

      for (const snap of (bucket.snapshots || [])) {
        if (!snap || typeof snap !== 'object') continue;
        const tsMs = snap.createdAt ? (Date.parse(snap.createdAt) || Date.now()) : Date.now();
        const snapId = snap.id || shortHash8(JSON.stringify(snap));
        events.push({
          event_uid: `legacy:snap:${accountKey}:${userdataKey}:${snapId}`,
          schema_ver: 0,
          producer_ver: PRODUCER_VERSION,
          kind: 'legacy.import',
          ts_ms: tsMs,
          user_id: accountKey,
          userdata_key: userdataKey,
          cascade_id: null,
          workspace: null,
          payload: {
            legacyType: 'snapshot',
            snapshot: snap
          }
        });
      }
    }

    const res = appendEvents(db, events);
    return { imported: res.inserted, ignored: res.ignored, total: events.length };
  } catch (err) {
    return { imported: 0, error: err.message };
  }
}

/**
 * Captures `user.snapshot` and `quota.snapshot` from live RPCs.
 */
export async function captureLiveAccountAndQuotas({
  db,
  userdataKey = 'desktop:default',
  userdataPath = null,
  rpcFn = callLanguageServerRpc
} = {}) {
  if (!db) return { userId: 'local-default', inserted: 0 };

  const [userResp, modelsResp] = await Promise.all([
    rpcFn('GetUserStatus', {}).catch(() => null),
    rpcFn('GetAvailableModels', {}).catch(() => null)
  ]);

  const userStatus = userResp?.userStatus || null;
  const userId = resolveUserId(userStatus);
  const events = [];

  if (userStatus) {
    events.push(mapUserSnapshot({ userStatus, userId, userdataKey, userdataPath }));
  }
  if (modelsResp) {
    events.push(mapQuotaSnapshot({ modelsResponse: modelsResp, userId, userdataKey }));
  }

  const res = appendEvents(db, events);
  return { userId, inserted: res.inserted, ignored: res.ignored };
}

/**
 * Incrementally (or fully with `fullArchive: true`) ingests a single conversation.
 */
export async function ingestConversation({
  db,
  cascadeId,
  userId = 'local-default',
  userdataKey = 'desktop:default',
  fileMtimeMs = 0,
  fullArchive = false,
  trajectoryResp = null,
  rpcFn = callLanguageServerRpc
} = {}) {
  if (!db || !cascadeId) return { inserted: 0, ignored: 0, turnCount: 0, stepCount: 0 };

  const sourceKey = `${userdataKey}:${cascadeId}`;
  const cursor = fullArchive ? null : getCursor(db, sourceKey);
  if (cursor && fileMtimeMs > 0 && cursor.file_mtime_ms === Math.round(fileMtimeMs)) {
    return { inserted: 0, ignored: 0, skippedUnchanged: true };
  }

  const fromTurnIdx = cursor ? Math.max(0, cursor.last_turn_idx + 1) : 0;
  const fromStepIdx = cursor ? Math.max(0, cursor.last_step_idx + 1) : 0;

  const trajResp = trajectoryResp || await rpcFn('GetCascadeTrajectory', { cascade_id: cascadeId });
  const mapped = mapTrajectoryEvents({
    cascadeId,
    trajectoryResp: trajResp,
    userId,
    userdataKey,
    fromTurnIdx,
    fromStepIdx,
    fullArchive
  });

  const res = appendEvents(db, mapped.events);
  upsertCursor(db, sourceKey, {
    lastTurnIdx: mapped.lastTurnIdx,
    lastStepIdx: mapped.lastStepIdx,
    fileMtimeMs
  });

  return {
    inserted: res.inserted,
    ignored: res.ignored,
    turnCount: mapped.turnCount,
    stepCount: mapped.stepCount,
    workspace: mapped.workspace
  };
}

/**
 * One-Click Take All across discovered `userdata_key` roots.
 */
export async function takeAll({
  dbPath = null,
  db: externalDb = null,
  maxConversations = 500,
  includeLegacy = true,
  fullArchive = false,
  rpcFn = callLanguageServerRpc
} = {}) {
  const db = externalDb || await openLogDb({ dbPath });
  if (!db) return { ok: false, error: 'SQLite log unavailable' };

  try {
    const roots = discoverUserdataRoots();
    const defaultRoot = roots[0] || { userdataKey: 'desktop:default', userdataPath: null, conversationsDir: null };

    const liveSnap = await captureLiveAccountAndQuotas({
      db,
      userdataKey: defaultRoot.userdataKey,
      userdataPath: defaultRoot.userdataPath,
      rpcFn
    });
    const userId = liveSnap.userId;

    let legacyResult = null;
    if (includeLegacy) {
      legacyResult = importLegacyStore(db, { userdataKey: defaultRoot.userdataKey });
    }

    let conversationsScanned = 0;
    let totalInserted = liveSnap.inserted + (legacyResult?.imported || 0);
    let totalIgnored = (liveSnap.ignored || 0) + (legacyResult?.ignored || 0);
    let errors = 0;

    for (const root of roots) {
      const files = listConversationFiles(root.conversationsDir).slice(0, maxConversations);
      for (const f of files) {
        conversationsScanned += 1;
        try {
          const r = await ingestConversation({
            db,
            cascadeId: f.id,
            userId,
            userdataKey: root.userdataKey,
            fileMtimeMs: f.mtime,
            fullArchive,
            rpcFn
          });
          totalInserted += r.inserted || 0;
          totalIgnored += r.ignored || 0;
        } catch {
          errors += 1;
        }
      }
    }

    return {
      ok: true,
      userId,
      roots: roots.map(r => r.userdataKey),
      conversationsScanned,
      inserted: totalInserted,
      ignored: totalIgnored,
      errors,
      legacyImported: legacyResult?.imported || 0
    };
  } finally {
    if (!externalDb) closeLogDb(db);
  }
}

/**
 * One-Click Take Whole Convo for a single `cascade_id`.
 */
export async function takeConvo({
  cascadeId,
  userdataKey = 'desktop:default',
  dbPath = null,
  db: externalDb = null,
  rpcFn = callLanguageServerRpc
} = {}) {
  if (!cascadeId) throw new Error('cascadeId is required');
  const db = externalDb || await openLogDb({ dbPath });
  if (!db) return { ok: false, error: 'SQLite log unavailable' };

  try {
    const liveSnap = await captureLiveAccountAndQuotas({ db, userdataKey, rpcFn });
    const res = await ingestConversation({
      db,
      cascadeId,
      userId: liveSnap.userId,
      userdataKey,
      fullArchive: true,
      rpcFn
    });

    return {
      ok: true,
      cascadeId,
      userId: liveSnap.userId,
      userdataKey,
      inserted: liveSnap.inserted + res.inserted,
      ignored: (liveSnap.ignored || 0) + (res.ignored || 0),
      turnCount: res.turnCount,
      stepCount: res.stepCount,
      workspace: res.workspace
    };
  } finally {
    if (!externalDb) closeLogDb(db);
  }
}
