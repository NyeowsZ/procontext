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
import { callLanguageServerRpc, getActiveCascadeId, getCurrentAccount, getQuotaPools } from './telemetry.mjs';
import { closeLogDb, openLogDb } from './log-db.mjs';
import {
  captureLiveAccountAndQuotas,
  importLegacyStore,
  ingestConversation,
  takeAll,
  takeConvo
} from './ingest.mjs';
import { computeGlobalAudit } from './global-check.mjs';

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
    quotaCycles: {},
    cacheLifespanByModel: {},
    convLifespan: {}
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
  if (!bucket.cacheLifespanByModel || typeof bucket.cacheLifespanByModel !== 'object') bucket.cacheLifespanByModel = {};
  if (!bucket.convLifespan || typeof bucket.convLifespan !== 'object') bucket.convLifespan = {};
  return bucket;
}

export function getPersistedAccountCacheLifespan(accountKey) {
  try {
    const store = loadStore();
    const bucket = getAccountBucket(store, accountKey);
    return bucket.cacheLifespanByModel || {};
  } catch {
    return {};
  }
}

export function updatePersistedAccountCacheLifespan(accountKey, cascadeId, convLifespanMap) {
  if (!cascadeId || !convLifespanMap || typeof convLifespanMap !== 'object') return {};
  try {
    const store = loadStore();
    const bucket = getAccountBucket(store, accountKey);
    if (!bucket.convLifespan) bucket.convLifespan = {};

    const valid = {};
    for (const [mName, b] of Object.entries(convLifespanMap)) {
      if (!b) continue;
      const warm = Number(b.warmSamples || 0);
      const cold = Number(b.coldSamples || 0);
      if (warm > 0 || cold > 0 || b.maxWarmGapMs !== null || b.minColdGapMs !== null) {
        valid[mName] = {
          maxWarmGapMs: typeof b.maxWarmGapMs === 'number' ? b.maxWarmGapMs : null,
          minColdGapMs: typeof b.minColdGapMs === 'number' ? b.minColdGapMs : null,
          warmSamples: warm,
          coldSamples: cold
        };
      }
    }

    if (Object.keys(valid).length === 0) {
      return bucket.cacheLifespanByModel || {};
    }

    bucket.convLifespan[cascadeId] = valid;

    // Recompute aggregated survival bounds across all recorded conversations
    const aggregated = {};
    for (const convMap of Object.values(bucket.convLifespan)) {
      for (const [mName, stats] of Object.entries(convMap || {})) {
        if (!aggregated[mName]) {
          aggregated[mName] = {
            maxWarmGapMs: null,
            minColdGapMs: null,
            warmSamples: 0,
            coldSamples: 0
          };
        }
        const a = aggregated[mName];
        if (stats.maxWarmGapMs !== null && stats.maxWarmGapMs !== undefined) {
          a.maxWarmGapMs = a.maxWarmGapMs === null ? stats.maxWarmGapMs : Math.max(a.maxWarmGapMs, stats.maxWarmGapMs);
        }
        if (stats.minColdGapMs !== null && stats.minColdGapMs !== undefined && stats.minColdGapMs >= 4.5 * 60 * 1000) {
          a.minColdGapMs = a.minColdGapMs === null ? stats.minColdGapMs : Math.min(a.minColdGapMs, stats.minColdGapMs);
        }
        if (a.maxWarmGapMs !== null && a.minColdGapMs !== null && a.minColdGapMs <= a.maxWarmGapMs) {
          a.minColdGapMs = null;
        }
        a.warmSamples += (stats.warmSamples || 0);
        a.coldSamples += (stats.coldSamples || 0);
      }
    }

    bucket.cacheLifespanByModel = aggregated;
    saveStore(store);
    return aggregated;
  } catch (err) {
    console.error('[GlobalStore] Failed to update persisted cache lifespan:', err.message);
    return {};
  }
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

  return { totals, byModel, trajResp: resp };
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

function computeRollingWindowFromCache(convCache, windowMs, nowMs = Date.now()) {
  const totals = emptyTotals();
  const byModel = {};
  let conversations = 0;
  for (const entry of Object.values(convCache || {})) {
    if (!entry?.totals || !entry.mtime) continue;
    if (nowMs - entry.mtime > windowMs) continue;
    conversations++;
    addTotals(totals, entry.totals);
    for (const [mName, mTot] of Object.entries(entry.byModel || {})) {
      if (!byModel[mName]) byModel[mName] = emptyTotals();
      addTotals(byModel[mName], mTot);
    }
  }
  return { conversations, totals, byModel };
}

function extractStoredPer1Rates(quotaCycles, windowType) {
  const byModel = {};
  const byPool = [];
  for (const c of Object.values(quotaCycles || {})) {
    if (!c || (c.windowType === 'weekly' ? 'weekly' : '5h') !== windowType) continue;
    const obsPct = Number(c.observedPct || 0);
    const obsTok = Number(c.observedTokens?.totalProcessedTokens || 0);
    const minObs = windowType === 'weekly' ? 0.1 : 0.5;
    if (obsPct < minObs || obsTok <= 0) continue;
    const poolPer1 = Math.round(obsTok / obsPct);
    byPool.push({ poolId: c.poolId, label: c.label || c.poolId, per1TotalTokens: poolPer1, observedPct: parseFloat(obsPct.toFixed(2)) });
    for (const [mName, mTot] of Object.entries(c.observedByModel || {})) {
      const mTok = Number(mTot?.totalProcessedTokens || 0);
      if (mTok <= 0) continue;
      const share = mTok / obsTok;
      const estPct = share * obsPct;
      if (estPct >= 0.05) {
        byModel[mName] = Math.round(mTok / estPct);
      } else if (!byModel[mName]) {
        byModel[mName] = poolPer1;
      }
    }
  }
  return { byModel, byPool };
}

function sumModelsInPool(byModelMap, poolModels) {
  const poolList = (poolModels || []).map(m => String(m).trim().toLowerCase()).filter(Boolean);
  const poolSet = new Set(poolList);
  const stripParens = (s) => s.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const poolBaseSet = new Set(poolList.map(stripParens));
  const total = emptyTotals();
  const matched = {};
  for (const [mName, mTot] of Object.entries(byModelMap || {})) {
    const ml = mName.trim().toLowerCase();
    const mlBase = stripParens(ml);
    const hit = poolSet.has(ml) || poolBaseSet.has(mlBase) || poolList.some(pm => pm.includes(mlBase) || mlBase.includes(stripParens(pm)));
    if (hit) {
      addTotals(total, mTot);
      matched[mName] = { ...mTot };
    }
  }
  return { total, byModel: matched };
}

function buildPoolCorrelation(pool, cycle, fallbackByModel = null) {
  const obsPct = Number(cycle?.observedPct || 0);
  const obsTot = cycle?.observedTokens || emptyTotals();
  const obsByModel = cycle?.observedByModel || {};

  const minObs = pool.windowType === 'weekly' ? 0.1 : 0.5;
  if (obsPct < minObs || obsTot.totalProcessedTokens <= 0) {
    // If not enough observed cycle delta yet, extract fallback models from session / current usage
    let fallbackModels = [];
    if (fallbackByModel && typeof fallbackByModel === 'object') {
      const { total: fbTotal, byModel: fbMatched } = sumModelsInPool(fallbackByModel, pool.models);
      if (fbTotal.totalProcessedTokens > 0) {
        fallbackModels = Object.entries(fbMatched).map(([mName, mTot]) => {
          const share = fbTotal.totalProcessedTokens > 0 ? (mTot.totalProcessedTokens / fbTotal.totalProcessedTokens) : 0;
          const denom = (mTot.inputTokens || 0) + (mTot.cacheReadTokens || 0);
          return {
            model: mName,
            inputTokens: mTot.inputTokens || 0,
            cacheReadTokens: mTot.cacheReadTokens || 0,
            thinkingTokens: mTot.thinkingTokens || 0,
            responseTokens: mTot.responseTokens || 0,
            totalProcessedTokens: mTot.totalProcessedTokens || 0,
            turns: mTot.totalTurns || 0,
            cacheEfficiencyPct: denom > 0 ? ((mTot.cacheReadTokens / denom) * 100).toFixed(1) : '0.0',
            sharePct: parseFloat((share * 100).toFixed(1)),
            estPctUsed: parseFloat((share * (pool.usedPct || 0)).toFixed(2)),
            per1Pct: null,
            estRemaining: null,
            estFull100: null
          };
        }).filter(m => m.totalProcessedTokens > 0)
          .sort((a, b) => b.totalProcessedTokens - a.totalProcessedTokens);
      }
    }

    return {
      hasData: false,
      observedPct: parseFloat(obsPct.toFixed(2)),
      per1Pct: null,
      estRemaining: null,
      estFull100: null,
      byModel: fallbackModels
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
      const denom = (mTot.inputTokens || 0) + (mTot.cacheReadTokens || 0);

      let modelPer1 = null;
      let modelRemaining = null;
      let modelFull100 = null;

      if (estPctUsed >= 0.05) {
        modelPer1 = {
          inputTokens: Math.round(mTot.inputTokens / estPctUsed),
          cacheReadTokens: Math.round(mTot.cacheReadTokens / estPctUsed),
          thinkingTokens: Math.round(mTot.thinkingTokens / estPctUsed),
          responseTokens: Math.round(mTot.responseTokens / estPctUsed),
          totalProcessedTokens: Math.round(mTot.totalProcessedTokens / estPctUsed),
          turns: parseFloat(((mTot.totalTurns || 0) / estPctUsed).toFixed(1))
        };

        const remPctForModel = remPct * share;
        modelRemaining = {
          inputTokens: Math.round(modelPer1.inputTokens * remPctForModel),
          cacheReadTokens: Math.round(modelPer1.cacheReadTokens * remPctForModel),
          thinkingTokens: Math.round(modelPer1.thinkingTokens * remPctForModel),
          responseTokens: Math.round(modelPer1.responseTokens * remPctForModel),
          totalProcessedTokens: Math.round(modelPer1.totalProcessedTokens * remPctForModel),
          turns: Math.round(((mTot.totalTurns || 0) / estPctUsed) * remPctForModel)
        };

        modelFull100 = {
          inputTokens: Math.round(modelPer1.inputTokens * 100 * share),
          cacheReadTokens: Math.round(modelPer1.cacheReadTokens * 100 * share),
          thinkingTokens: Math.round(modelPer1.thinkingTokens * 100 * share),
          responseTokens: Math.round(modelPer1.responseTokens * 100 * share),
          totalProcessedTokens: Math.round(modelPer1.totalProcessedTokens * 100 * share),
          turns: Math.round(((mTot.totalTurns || 0) / estPctUsed) * 100 * share)
        };
      }

      return {
        model: mName,
        inputTokens: mTot.inputTokens || 0,
        cacheReadTokens: mTot.cacheReadTokens || 0,
        thinkingTokens: mTot.thinkingTokens || 0,
        responseTokens: mTot.responseTokens || 0,
        totalProcessedTokens: mTot.totalProcessedTokens || 0,
        turns: mTot.totalTurns || 0,
        cacheEfficiencyPct: denom > 0 ? ((mTot.cacheReadTokens / denom) * 100).toFixed(1) : '0.0',
        sharePct: parseFloat((share * 100).toFixed(1)),
        estPctUsed,
        per1Pct: modelPer1,
        estRemaining: modelRemaining,
        estFull100: modelFull100
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

  // Remove deprecated Argon-only quota cycles
  for (const pid of Object.keys(accountBucket.quotaCycles || {})) {
    if (pid.includes('argon')) {
      delete accountBucket.quotaCycles[pid];
      mutated = true;
    }
  }

  for (const pool of (quotaPools || [])) {
    let existing = accountBucket.quotaCycles[pool.poolId];

    // Seed unified 5h:gemini cycle from legacy 5h:gemini-* cycles if it has no observed correlation yet
    if (pool.poolId === '5h:gemini' && (!existing || ((existing.observedPct || 0) === 0 && (existing.observedTokens?.totalProcessedTokens || 0) === 0))) {
      const legacyKeys = Object.keys(accountBucket.quotaCycles || {}).filter(
        k => k.startsWith('5h:gemini-') && (accountBucket.quotaCycles[k]?.observedPct || 0) > 0
      );
      if (legacyKeys.length > 0) {
        if (!existing) {
          existing = {
            poolId: pool.poolId,
            label: pool.label,
            windowType: pool.windowType,
            windowHours: pool.windowType === 'weekly' ? 168 : 5,
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
          accountBucket.quotaCycles[pool.poolId] = existing;
        }
        for (const lk of legacyKeys) {
          const leg = accountBucket.quotaCycles[lk];
          existing.observedPct += Number(leg.observedPct || 0);
          addTotals(existing.observedTokens, leg.observedTokens || emptyTotals());
          for (const [mName, mTot] of Object.entries(leg.observedByModel || {})) {
            if (!existing.observedByModel[mName]) existing.observedByModel[mName] = emptyTotals();
            addTotals(existing.observedByModel[mName], mTot);
          }
          delete accountBucket.quotaCycles[lk];
        }
        mutated = true;
      }
    }

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

    // Accumulate incremental quota % vs token delta for this pool's models
    // Preserve baseline until a measurable delta + token step is actually recorded so micro-increments aren't dropped
    const curUsedPct = pool.exactUsedPct != null ? pool.exactUsedPct : (pool.usedPct || 0);
    const prevUsedPct = Number(existing.lastUsedPct || 0);
    const prevResetMs = Date.parse(existing.lastResetTime || '');
    const curResetMs = Date.parse(pool.resetTime || '');
    const resetDeltaMs = (!Number.isNaN(prevResetMs) && !Number.isNaN(curResetMs))
      ? Math.abs(curResetMs - prevResetMs)
      : Infinity;
    const driftTolMs = pool.windowType === 'weekly' ? 3600000 : 300000;
    const sameWindow = (existing.lastResetTime === pool.resetTime || resetDeltaMs <= driftTolMs) &&
      curUsedPct >= prevUsedPct - 0.05;
    const pctStep = sameWindow ? Math.max(0, curUsedPct - prevUsedPct) : 0;
    const minStep = pool.windowType === 'weekly' ? 0.02 : 0.05;
    const stepByModelDiff = diffByModel(allTimeByModel, existing.lastCheckByModel);
    const poolStep = sumModelsInPool(stepByModelDiff, pool.models);

    if (pctStep >= minStep && poolStep.total.totalProcessedTokens > 0) {
      existing.observedPct = parseFloat(((existing.observedPct || 0) + pctStep).toFixed(3));
      addTotals(existing.observedTokens, poolStep.total);
      for (const [mName, mTot] of Object.entries(poolStep.byModel)) {
        if (!existing.observedByModel[mName]) existing.observedByModel[mName] = emptyTotals();
        addTotals(existing.observedByModel[mName], mTot);
      }
      existing.lastCheckByModel = cloneTotalsMap(allTimeByModel);
      existing.lastUsedPct = curUsedPct;
      existing.lastResetTime = pool.resetTime;
      mutated = true;
    } else if (!sameWindow) {
      existing.lastCheckByModel = cloneTotalsMap(allTimeByModel);
      existing.lastUsedPct = curUsedPct;
      existing.lastResetTime = pool.resetTime;
      mutated = true;
    } else if (existing.lastResetTime !== pool.resetTime) {
      existing.lastResetTime = pool.resetTime;
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

    let fetchedWithResp = [];
    const batchSize = 8;
    for (let i = 0; i < workSlice.length; i += batchSize) {
      const batch = workSlice.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(async (f) => {
        try {
          const summary = await fetchConversationSummary(f.id);
          return { id: f.id, mtime: f.mtime, ...summary };
        } catch {
          return { id: f.id, mtime: f.mtime, totals: emptyTotals(), byModel: {}, trajResp: null };
        }
      }));
      for (const r of results) {
        store.convCache[r.id] = { mtime: r.mtime, totals: r.totals, byModel: r.byModel };
        if (r.trajResp) fetchedWithResp.push(r);
        dirty = true;
      }
    }

    // Fail-open incremental append to global-log.db (zero extra trajectory RPCs)
    try {
      const logDb = await openLogDb();
      if (logDb) {
        try {
          importLegacyStore(logDb);
          await captureLiveAccountAndQuotas({ db: logDb });
          for (const r of fetchedWithResp) {
            await ingestConversation({
              db: logDb,
              cascadeId: r.id,
              userId: account.accountKey,
              userdataKey: 'desktop:default',
              fileMtimeMs: r.mtime,
              trajectoryResp: r.trajResp
            });
          }
        } finally {
          closeLogDb(logDb);
        }
      }
    } catch {}
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
    windowHours: pool.windowType === 'weekly' ? 168 : 5,
    correlation: buildPoolCorrelation(pool, accountBucket.quotaCycles[pool.poolId], currentByModel)
  }));

  const pools5h = enrichedQuotaPools.filter(p => p.windowType === '5h');
  const pools7d = enrichedQuotaPools.filter(p => p.windowType === 'weekly');

  const nowMs = Date.now();
  const rolling5h = computeRollingWindowFromCache(store.convCache, 5 * 3600 * 1000, nowMs);
  const rolling7d = computeRollingWindowFromCache(store.convCache, 7 * 24 * 3600 * 1000, nowMs);
  const stored5h = extractStoredPer1Rates(accountBucket.quotaCycles, '5h');
  const stored7d = extractStoredPer1Rates(accountBucket.quotaCycles, 'weekly');

  const summarizeWindow = (windowKey, label, windowHours, list, rolling, storedRates) => ({
    window: windowKey,
    label,
    windowHours,
    pools: list,
    primaryPool: list[0] || null,
    usedPct: list[0]?.usedPct ?? null,
    remainingPct: list[0]?.remainingPct ?? null,
    resetTime: list[0]?.resetTime ?? null,
    msUntilReset: list[0]?.msUntilReset ?? null,
    hasData: list.some(p => p.correlation?.hasData),
    rolling,
    storedRates
  });

  if (dirty) saveStore(store);

  return {
    account,
    quotaPools: enrichedQuotaPools,
    quota5h: summarizeWindow('5h', '5-Hour Rolling', 5, pools5h, rolling5h, stored5h),
    quota7d: summarizeWindow('7d', '7-Day Weekly', 168, pools7d, rolling7d, stored7d),
    updatedAt: new Date().toISOString(),
    conversationCount: convCount,
    pendingCount: remainingToScan,
    baselineAt: accountBucket.baselineAt,
    current: currentTotals,
    allTime: subtractTotals(allTimeTotals, null),
    byModel: currentByModel,
    persistedCacheLifespan: accountBucket.cacheLifespanByModel || {},
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

export async function takeAllToLog(opts = {}) {
  return await takeAll(opts);
}

export async function takeConvoToLog(cascadeId = null, opts = {}) {
  const resolvedId = cascadeId || getActiveCascadeId(null);
  if (!resolvedId) {
    throw new Error('No active conversation or cascadeId found.');
  }
  return await takeConvo({ cascadeId: resolvedId, ...opts });
}

export async function getGlobalLogAudit(opts = {}) {
  const db = await openLogDb({ readonly: true });
  if (!db) {
    return { available: false, totalEvents: 0 };
  }
  try {
    return { available: true, ...computeGlobalAudit(db, opts) };
  } finally {
    closeLogDb(db);
  }
}
