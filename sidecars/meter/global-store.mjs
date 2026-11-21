/**
 * Global Usage Store, Account Separation & Quota-Cycle Auto-Snapshots.
 *
 * - Separates baselines, snapshots, and quota cycles per logged-in Antigravity account
 * - Scans ~/.gemini/antigravity/conversations (*.db / *.pb) with mtime caching
 * - Tracks 5-hour & Weekly quota pools from GetAvailableModels
 * - Auto-snapshots whenever a quota pool reaches 100% used (or completes a 100% reset cycle),
 *   capturing exact token & per-model consumption from that 100% to the next 100%
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { callLanguageServerRpc, getCurrentAccount, getQuotaPools } from './telemetry.mjs';

const STORE_PATH = join(homedir(), '.gemini', 'config', 'plugins', 'token-context-meter', 'usage-store.json');
const CONV_DIR = join(homedir(), '.gemini', 'antigravity', 'conversations');

function emptyTotals() {
  return {
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    responseTokens: 0,
    totalProcessedTokens: 0,
    totalTurns: 0,
    toolCalls: 0
  };
}

function addTotals(target, delta) {
  target.inputTokens += delta.inputTokens || 0;
  target.cacheReadTokens += delta.cacheReadTokens || 0;
  target.outputTokens += delta.outputTokens || 0;
  target.thinkingTokens += delta.thinkingTokens || 0;
  target.responseTokens += delta.responseTokens || 0;
  target.totalProcessedTokens += delta.totalProcessedTokens || 0;
  target.totalTurns += delta.totalTurns || 0;
  target.toolCalls += delta.toolCalls || 0;
}

function subtractTotals(all, base) {
  const res = emptyTotals();
  res.inputTokens = Math.max(0, (all?.inputTokens || 0) - (base?.inputTokens || 0));
  res.cacheReadTokens = Math.max(0, (all?.cacheReadTokens || 0) - (base?.cacheReadTokens || 0));
  res.outputTokens = Math.max(0, (all?.outputTokens || 0) - (base?.outputTokens || 0));
  res.thinkingTokens = Math.max(0, (all?.thinkingTokens || 0) - (base?.thinkingTokens || 0));
  res.responseTokens = Math.max(0, (all?.responseTokens || 0) - (base?.responseTokens || 0));
  res.totalProcessedTokens = res.inputTokens + res.cacheReadTokens + res.outputTokens;
  res.totalTurns = Math.max(0, (all?.totalTurns || 0) - (base?.totalTurns || 0));
  res.toolCalls = Math.max(0, (all?.toolCalls || 0) - (base?.toolCalls || 0));
  const denom = res.inputTokens + res.cacheReadTokens;
  res.cacheEfficiencyPct = denom > 0 ? ((res.cacheReadTokens / denom) * 100).toFixed(1) : '0.0';
  return res;
}

function diffByModel(allByModel, baseByModel) {
  const out = {};
  const keys = new Set([
    ...Object.keys(allByModel || {}),
    ...Object.keys(baseByModel || {})
  ]);
  for (const mName of keys) {
    const d = subtractTotals(allByModel?.[mName] || emptyTotals(), baseByModel?.[mName]);
    if (d.totalProcessedTokens > 0 || d.totalTurns > 0) {
      out[mName] = d;
    }
  }
  return out;
}

function cloneTotalsMap(map) {
  const copy = {};
  for (const [k, v] of Object.entries(map || {})) {
    copy[k] = { ...v };
  }
  return copy;
}

function emptyAccountBucket() {
  return {
    baselineAt: null,
    baseline: { totals: emptyTotals(), byModel: {} },
    snapshots: [],
    quotaCycles: {}
  };
}

function loadStore() {
  try {
    if (existsSync(STORE_PATH)) {
      const parsed = JSON.parse(readFileSync(STORE_PATH, 'utf-8'));
      const store = {
        version: 2,
        convCache: parsed.convCache || {},
        accounts: parsed.accounts && typeof parsed.accounts === 'object' ? parsed.accounts : {}
      };
      // Migrate legacy v1 top-level baseline/snapshots if present
      if ((parsed.snapshots?.length || parsed.baselineAt) && !store.accounts._legacyMigrated) {
        store._legacyPending = {
          baselineAt: parsed.baselineAt || null,
          baseline: parsed.baseline || { totals: emptyTotals(), byModel: {} },
          snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : [],
          quotaCycles: {}
        };
      }
      return store;
    }
  } catch {}
  return {
    version: 2,
    convCache: {},
    accounts: {}
  };
}

function getAccountBucket(store, accountKey) {
  const key = accountKey || 'local-default';
  if (!store.accounts[key]) {
    if (store._legacyPending) {
      store.accounts[key] = store._legacyPending;
      delete store._legacyPending;
    } else {
      store.accounts[key] = emptyAccountBucket();
    }
  }
  const bucket = store.accounts[key];
  if (!bucket.baseline) bucket.baseline = { totals: emptyTotals(), byModel: {} };
  if (!Array.isArray(bucket.snapshots)) bucket.snapshots = [];
  if (!bucket.quotaCycles || typeof bucket.quotaCycles !== 'object') bucket.quotaCycles = {};
  return bucket;
}

function saveStore(store) {
  try {
    const toWrite = {
      version: 2,
      convCache: store.convCache || {},
      accounts: store.accounts || {}
    };
    mkdirSync(dirname(STORE_PATH), { recursive: true });
    writeFileSync(STORE_PATH, JSON.stringify(toWrite, null, 2), 'utf-8');
  } catch (err) {
    console.error('[GlobalStore] Failed to write usage store:', err.message);
  }
}

async function fetchConversationSummary(cascadeId) {
  const resp = await callLanguageServerRpc('GetCascadeTrajectory', { cascade_id: cascadeId });
  const traj = resp.trajectory || {};
  const rawTurns = traj.generatorMetadata || [];
  const steps = traj.steps || [];

  const totals = emptyTotals();
  const byModel = {};

  for (const turn of rawTurns) {
    const cm = turn.chatModel || {};
    const u = cm.usage || {};
    const input = parseInt(u.inputTokens || '0', 10);
    const cache = parseInt(u.cacheReadTokens || '0', 10);
    const output = parseInt(u.outputTokens || '0', 10);
    const thinking = parseInt(u.thinkingOutputTokens || '0', 10);
    const response = parseInt(u.responseOutputTokens || '0', 10) || Math.max(0, output - thinking);
    const modelName = cm.modelDisplayName || 'Default Model';

    const delta = {
      inputTokens: input,
      cacheReadTokens: cache,
      outputTokens: output,
      thinkingTokens: thinking,
      responseTokens: response,
      totalProcessedTokens: input + cache + output,
      totalTurns: 1,
      toolCalls: 0
    };
    addTotals(totals, delta);
    if (!byModel[modelName]) byModel[modelName] = emptyTotals();
    addTotals(byModel[modelName], delta);
  }

  let toolCallsCount = 0;
  for (const s of steps) {
    const tcs = s.plannerResponse?.toolCalls;
    if (Array.isArray(tcs)) toolCallsCount += tcs.length;
  }
  totals.toolCalls = toolCallsCount;

  return { totals, byModel };
}

function formatAutoDateName(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function computeAllTimeFromCache(convCache) {
  const allTimeTotals = emptyTotals();
  const allTimeByModel = {};
  for (const entry of Object.values(convCache || {})) {
    if (!entry?.totals) continue;
    addTotals(allTimeTotals, entry.totals);
    for (const [mName, mTot] of Object.entries(entry.byModel || {})) {
      if (!allTimeByModel[mName]) allTimeByModel[mName] = emptyTotals();
      addTotals(allTimeByModel[mName], mTot);
    }
  }
  return { allTimeTotals, allTimeByModel };
}

function sumModelsInPool(byModelMap, poolModels) {
  const poolSet = new Set((poolModels || []).map(m => m.toLowerCase()));
  const total = emptyTotals();
  const matched = {};
  for (const [mName, mTot] of Object.entries(byModelMap || {})) {
    if (poolSet.has(mName.toLowerCase())) {
      addTotals(total, mTot);
      matched[mName] = { ...mTot };
    }
  }
  return { total, byModel: matched };
}

function buildPoolCorrelation(pool, cycle) {
  const obsPct = Number(cycle?.observedPct || 0);
  const obsTot = cycle?.observedTokens || emptyTotals();
  const obsByModel = cycle?.observedByModel || {};

  if (obsPct < 0.5 || obsTot.totalProcessedTokens <= 0) {
    return {
      hasData: false,
      observedPct: parseFloat(obsPct.toFixed(2)),
      per1Pct: null,
      estRemaining: null,
      estFull100: null,
      byModel: []
    };
  }

  const per1 = {
    inputTokens: Math.round(obsTot.inputTokens / obsPct),
    cacheReadTokens: Math.round(obsTot.cacheReadTokens / obsPct),
    thinkingTokens: Math.round(obsTot.thinkingTokens / obsPct),
    responseTokens: Math.round(obsTot.responseTokens / obsPct),
    totalProcessedTokens: Math.round(obsTot.totalProcessedTokens / obsPct),
    turns: parseFloat((obsTot.totalTurns / obsPct).toFixed(1))
  };

  const remPct = Math.max(0, Number(pool.remainingPct || 0));
  const estRemaining = {
    inputTokens: Math.round(per1.inputTokens * remPct),
    cacheReadTokens: Math.round(per1.cacheReadTokens * remPct),
    thinkingTokens: Math.round(per1.thinkingTokens * remPct),
    responseTokens: Math.round(per1.responseTokens * remPct),
    totalProcessedTokens: Math.round(per1.totalProcessedTokens * remPct),
    turns: Math.round((obsTot.totalTurns / obsPct) * remPct)
  };

  const estFull100 = {
    inputTokens: per1.inputTokens * 100,
    cacheReadTokens: per1.cacheReadTokens * 100,
    thinkingTokens: per1.thinkingTokens * 100,
    responseTokens: per1.responseTokens * 100,
    totalProcessedTokens: per1.totalProcessedTokens * 100,
    turns: Math.round((obsTot.totalTurns / obsPct) * 100)
  };

  const byModel = Object.entries(obsByModel)
    .map(([mName, mTot]) => {
      const share = obsTot.totalProcessedTokens > 0 ? (mTot.totalProcessedTokens / obsTot.totalProcessedTokens) : 0;
      const estPctUsed = parseFloat((share * obsPct).toFixed(2));
      return {
        model: mName,
        inputTokens: mTot.inputTokens || 0,
        cacheReadTokens: mTot.cacheReadTokens || 0,
        thinkingTokens: mTot.thinkingTokens || 0,
        responseTokens: mTot.responseTokens || 0,
        totalProcessedTokens: mTot.totalProcessedTokens || 0,
        turns: mTot.totalTurns || 0,
        sharePct: parseFloat((share * 100).toFixed(1)),
        estPctUsed
      };
    })
    .filter(m => m.totalProcessedTokens > 0)
    .sort((a, b) => b.totalProcessedTokens - a.totalProcessedTokens);

  return {
    hasData: true,
    observedPct: parseFloat(obsPct.toFixed(1)),
    per1Pct: per1,
    estRemaining,
    estFull100,
    byModel
  };
}

/**
 * Checks each quota pool (5h / Weekly) for:
 * 1) Incremental quota % vs token consumption correlation (tokens per 1% + remaining runway estimates)
 * 2) 100% exhaustion or 100% reset cycle transitions -> automatic snapshot
 */
function evaluateQuotaCycles(accountBucket, quotaPools, allTimeTotals, allTimeByModel, conversationCount) {
  let mutated = false;
  const nowIso = new Date().toISOString();

  for (const pool of (quotaPools || [])) {
    const existing = accountBucket.quotaCycles[pool.poolId];
    if (!existing) {
      accountBucket.quotaCycles[pool.poolId] = {
        poolId: pool.poolId,
        label: pool.label,
        windowType: pool.windowType,
        lastResetTime: pool.resetTime,
        lastUsedPct: pool.usedPct,
        cycleStartAt: nowIso,
        cycleStartTotals: { ...allTimeTotals },
        cycleStartByModel: cloneTotalsMap(allTimeByModel),
        lastCheckByModel: cloneTotalsMap(allTimeByModel),
        observedPct: 0,
        observedTokens: emptyTotals(),
        observedByModel: {},
        autoSnapshottedForResetTime: null
      };
      mutated = true;
      continue;
    }

    if (!existing.observedTokens) existing.observedTokens = emptyTotals();
    if (!existing.observedByModel) existing.observedByModel = {};
    if (!existing.lastCheckByModel) existing.lastCheckByModel = cloneTotalsMap(allTimeByModel);

    // Accumulate incremental quota % vs token delta for this pool's models (when same window & quota moved up)
    const sameWindow = existing.lastResetTime === pool.resetTime;
    const pctStep = sameWindow ? (pool.usedPct - (existing.lastUsedPct || 0)) : 0;
    const stepByModelDiff = diffByModel(allTimeByModel, existing.lastCheckByModel);
    const poolStep = sumModelsInPool(stepByModelDiff, pool.models);

    if (pctStep > 0.05 && poolStep.total.totalProcessedTokens > 0) {
      existing.observedPct = (existing.observedPct || 0) + pctStep;
      addTotals(existing.observedTokens, poolStep.total);
      for (const [mName, mTot] of Object.entries(poolStep.byModel)) {
        if (!existing.observedByModel[mName]) existing.observedByModel[mName] = emptyTotals();
        addTotals(existing.observedByModel[mName], mTot);
      }
      existing.lastCheckByModel = cloneTotalsMap(allTimeByModel);
      mutated = true;
    } else if (!sameWindow) {
      existing.lastCheckByModel = cloneTotalsMap(allTimeByModel);
      mutated = true;
    }

    const hit100Used = pool.usedPct >= 99.5 && existing.autoSnapshottedForResetTime !== pool.resetTime;
    const cycleReset = existing.lastResetTime && existing.lastResetTime !== pool.resetTime && existing.autoSnapshottedForResetTime !== existing.lastResetTime;
    const cycleDeltaTotals = subtractTotals(allTimeTotals, existing.cycleStartTotals);
    const cycleDeltaByModel = diffByModel(allTimeByModel, existing.cycleStartByModel);
    const hadActivity = cycleDeltaTotals.totalProcessedTokens > 0 || (existing.lastUsedPct || 0) >= 5;

    if (hit100Used || (cycleReset && hadActivity)) {
      const tag = hit100Used ? 'Auto 100%' : 'Auto Reset';
      const winLabel = pool.windowType === 'weekly' ? 'Weekly' : '5h';
      const snap = {
        id: `auto_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        auto: true,
        poolId: pool.poolId,
        poolLabel: pool.label,
        windowType: pool.windowType,
        name: `[${tag}] ${pool.label} (${winLabel}) · ${formatAutoDateName()}`,
        createdAt: nowIso,
        cycleStartAt: existing.cycleStartAt || nowIso,
        cycleEndAt: nowIso,
        conversationCount,
        totals: cycleDeltaTotals.totalProcessedTokens > 0
          ? cycleDeltaTotals
          : subtractTotals(allTimeTotals, accountBucket.baseline?.totals),
        byModel: Object.keys(cycleDeltaByModel).length
          ? cycleDeltaByModel
          : diffByModel(allTimeByModel, accountBucket.baseline?.byModel)
      };

      accountBucket.snapshots.unshift(snap);
      if (accountBucket.snapshots.length > 120) {
        accountBucket.snapshots = accountBucket.snapshots.slice(0, 120);
      }

      // Advance cycle baseline for the next 100% -> 100% period
      existing.cycleStartAt = nowIso;
      existing.cycleStartTotals = { ...allTimeTotals };
      existing.cycleStartByModel = cloneTotalsMap(allTimeByModel);
      existing.autoSnapshottedForResetTime = hit100Used ? pool.resetTime : existing.lastResetTime;
      mutated = true;
    }

    if (existing.lastResetTime !== pool.resetTime || existing.lastUsedPct !== pool.usedPct) {
      existing.lastResetTime = pool.resetTime;
      existing.lastUsedPct = pool.usedPct;
      mutated = true;
    }
  }

  return mutated;
}

/**
 * Scans local Antigravity conversations (progressively cached by file mtime),
 * separates data by current logged-in account, evaluates 5h/Weekly quota cycles,
 * and returns global usage + quota pools + snapshots.
 */
export async function getGlobalUsage() {
  const [account, quotaPools] = await Promise.all([
    getCurrentAccount(),
    getQuotaPools()
  ]);

  const store = loadStore();
  const accountBucket = getAccountBucket(store, account.accountKey);
  let dirty = false;
  const activeIds = new Set();
  let remainingToScan = 0;

  if (existsSync(CONV_DIR)) {
    const files = readdirSync(CONV_DIR)
      .filter(f => f.endsWith('.db') || f.endsWith('.pb'))
      .map(f => {
        try {
          return { id: f.replace(/\.(db|pb)$/, ''), mtime: statSync(join(CONV_DIR, f)).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);

    const toFetch = [];
    for (const f of files) {
      activeIds.add(f.id);
      const cached = store.convCache[f.id];
      if (!cached || cached.mtime !== f.mtime) {
        toFetch.push(f);
      }
    }

    const MAX_PER_CALL = 24;
    const workSlice = toFetch.slice(0, MAX_PER_CALL);
    remainingToScan = Math.max(0, toFetch.length - workSlice.length);

    const batchSize = 8;
    for (let i = 0; i < workSlice.length; i += batchSize) {
      const batch = workSlice.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(async (f) => {
        try {
          const summary = await fetchConversationSummary(f.id);
          return { id: f.id, mtime: f.mtime, ...summary };
        } catch {
          return { id: f.id, mtime: f.mtime, totals: emptyTotals(), byModel: {} };
        }
      }));
      for (const r of results) {
        store.convCache[r.id] = { mtime: r.mtime, totals: r.totals, byModel: r.byModel };
        dirty = true;
      }
    }
  }

  const { allTimeTotals, allTimeByModel } = computeAllTimeFromCache(store.convCache);
  const convCount = activeIds.size || Object.keys(store.convCache).length;

  // Evaluate 5h / Weekly quota cycles for auto-snapshotting at 100%
  if (remainingToScan === 0) {
    const cycleMutated = evaluateQuotaCycles(accountBucket, quotaPools, allTimeTotals, allTimeByModel, convCount);
    if (cycleMutated) dirty = true;
  }

  const currentTotals = subtractTotals(allTimeTotals, accountBucket.baseline?.totals);
  const currentByModel = diffByModel(allTimeByModel, accountBucket.baseline?.byModel);

  // Attach per-1% token correlation & remaining runway estimates to each quota pool
  const enrichedQuotaPools = (quotaPools || []).map(pool => ({
    ...pool,
    correlation: buildPoolCorrelation(pool, accountBucket.quotaCycles[pool.poolId])
  }));

  if (dirty) saveStore(store);

  return {
    account,
    quotaPools: enrichedQuotaPools,
    updatedAt: new Date().toISOString(),
    conversationCount: convCount,
    pendingCount: remainingToScan,
    baselineAt: accountBucket.baselineAt,
    current: currentTotals,
    allTime: subtractTotals(allTimeTotals, null),
    byModel: currentByModel,
    snapshots: accountBucket.snapshots
  };
}

export async function saveGlobalSnapshot(customName = '') {
  const usage = await getGlobalUsage();
  const store = loadStore();
  const accountBucket = getAccountBucket(store, usage.account.accountKey);
  const cleanName = typeof customName === 'string' && customName.trim()
    ? customName.trim().slice(0, 64)
    : formatAutoDateName();

  const snap = {
    id: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    auto: false,
    name: cleanName,
    createdAt: new Date().toISOString(),
    conversationCount: usage.conversationCount,
    totals: usage.current,
    byModel: usage.byModel
  };

  accountBucket.snapshots.unshift(snap);
  if (accountBucket.snapshots.length > 120) accountBucket.snapshots = accountBucket.snapshots.slice(0, 120);
  saveStore(store);

  return { snapshot: snap, snapshots: accountBucket.snapshots };
}

export async function resetGlobalUsage() {
  const usage = await getGlobalUsage();
  const store = loadStore();
  const accountBucket = getAccountBucket(store, usage.account.accountKey);
  const { allTimeTotals, allTimeByModel } = computeAllTimeFromCache(store.convCache);

  accountBucket.baseline = { totals: allTimeTotals, byModel: allTimeByModel };
  accountBucket.baselineAt = new Date().toISOString();
  saveStore(store);

  return await getGlobalUsage();
}

export async function deleteGlobalSnapshot(id) {
  const account = await getCurrentAccount();
  const store = loadStore();
  const accountBucket = getAccountBucket(store, account.accountKey);
  accountBucket.snapshots = accountBucket.snapshots.filter(s => s.id !== id);
  saveStore(store);
  return { snapshots: accountBucket.snapshots };
}

export async function importGlobalData(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid JSON payload');
  }
  const account = await getCurrentAccount();
  const store = loadStore();
  const accountBucket = getAccountBucket(store, account.accountKey);

  const incoming = Array.isArray(payload.snapshots)
    ? payload.snapshots
    : (payload.totals ? [{
        id: `snap_imp_${Date.now()}`,
        auto: Boolean(payload.auto),
        name: payload.name || `Imported ${formatAutoDateName()}`,
        createdAt: payload.createdAt || new Date().toISOString(),
        conversationCount: payload.conversationCount || 0,
        totals: payload.totals,
        byModel: payload.byModel || {}
      }] : []);

  const existingIds = new Set(accountBucket.snapshots.map(s => s.id));
  let added = 0;
  for (const s of incoming) {
    if (!s || typeof s !== 'object' || !s.totals) continue;
    const id = s.id && !existingIds.has(s.id) ? s.id : `snap_imp_${Date.now()}_${added}`;
    existingIds.add(id);
    accountBucket.snapshots.unshift({
      id,
      auto: Boolean(s.auto),
      poolLabel: s.poolLabel || undefined,
      windowType: s.windowType || undefined,
      name: String(s.name || formatAutoDateName()).slice(0, 64),
      createdAt: s.createdAt || new Date().toISOString(),
      conversationCount: Number(s.conversationCount) || 0,
      totals: s.totals,
      byModel: s.byModel || {}
    });
    added += 1;
  }

  if (accountBucket.snapshots.length > 120) accountBucket.snapshots = accountBucket.snapshots.slice(0, 120);
  saveStore(store);
  return { importedCount: added, snapshots: accountBucket.snapshots };
}
