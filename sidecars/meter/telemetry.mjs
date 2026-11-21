/**
 * Exact Local Telemetry Engine for Token & Context Meter.
 *
 * Connects directly to Antigravity Desktop's language_server RPC endpoint.
 * Zero client-side token estimation; queries server-side generator metadata
 * and live model configurations.
 */

import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { getPersistedAccountCacheLifespan, updatePersistedAccountCacheLifespan } from './global-store.mjs';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function extractToolTargetLabel(name, argsJson) {
  let args = {};
  if (typeof argsJson === 'string' && argsJson.trim()) {
    try { args = JSON.parse(argsJson); } catch {}
  } else if (argsJson && typeof argsJson === 'object') {
    args = argsJson;
  }

  const filePath = args.Path || args.AbsolutePath || args.TargetFile || args.path || args.file;
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
  if (name === 'invoke_subagent') {
    const t = args.TypeName || 'subagent';
    return args.Role ? `${t}: ${args.Role}` : t;
  }
  if (name === 'ask_question' && Array.isArray(args.questions) && args.questions[0]?.question) {
    return String(args.questions[0].question).trim().slice(0, 42);
  }
  if (typeof args.query === 'string' && args.query.trim()) {
    return args.query.trim().slice(0, 42);
  }
  for (const val of Object.values(args)) {
    if (typeof val === 'string' && val.trim()) {
      return val.trim().replace(/\s+/g, ' ').slice(0, 42);
    }
  }
  return '(default)';
}

function buildToolCallsSummary(entries) {
  const toolMap = new Map();
  let totalCalls = 0;

  for (const entry of entries) {
    totalCalls += 1;
    let rec = toolMap.get(entry.name);
    if (!rec) {
      rec = { name: entry.name, count: 0, targets: new Map() };
      toolMap.set(entry.name, rec);
    }
    rec.count += 1;
    rec.targets.set(entry.target, (rec.targets.get(entry.target) || 0) + 1);
  }

  const tools = Array.from(toolMap.values())
    .map(r => ({
      name: r.name,
      count: r.count,
      targets: Array.from(r.targets.entries())
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return { totalCalls, tools };
}

function resolveModelLimitsFor(models, displayName, modelKey, responseModel) {
  let maxContextTokens = 1048576;
  let maxOutputTokens = 65536;
  let resolvedName = displayName || 'Default Model';

  for (const [key, modelDef] of Object.entries(models || {})) {
    if (modelDef.displayName === displayName ||
        (modelKey && modelDef.model === modelKey) ||
        (responseModel && (key === responseModel || key.includes(responseModel)))) {
      maxContextTokens = modelDef.maxTokens || maxContextTokens;
      maxOutputTokens = modelDef.maxOutputTokens || maxOutputTokens;
      resolvedName = modelDef.displayName || resolvedName;
      break;
    }
  }
  return { maxContextTokens, maxOutputTokens, displayName: resolvedName };
}

// Cache for model definitions
let cachedModels = null;
let modelsCacheExpiry = 0;

// Cache for current logged-in account
let cachedAccount = null;
let accountCacheExpiry = 0;

// Cache for language server credentials
let cachedCredentials = null;
let credentialsCacheExpiry = 0;

/**
 * Discovers active language_server credentials from ~/.gemini/antigravity/daemon/hub_*.json
 */
function discoverDaemonCredentials() {
  try {
    const daemonDir = join(homedir(), '.gemini', 'antigravity', 'daemon');
    if (!existsSync(daemonDir)) return null;

    const files = readdirSync(daemonDir)
      .filter(f => f.startsWith('hub_') && f.endsWith('.json'))
      .map(f => {
        try {
          return { name: f, mtime: statSync(join(daemonDir, f)).mtimeMs };
        } catch {
          return { name: f, mtime: 0 };
        }
      })
      .sort((a, b) => b.mtime - a.mtime);

    for (const f of files.slice(0, 5)) {
      try {
        const content = JSON.parse(readFileSync(join(daemonDir, f.name), 'utf-8'));
        if (content.httpPort && content.csrfToken) {
          let isAlive = false;
          try {
            process.kill(content.pid, 0);
            isAlive = true;
          } catch {
            isAlive = false;
          }
          if (isAlive) {
            return {
              address: `127.0.0.1:${content.httpPort}`,
              csrfToken: content.csrfToken
            };
          }
        }
      } catch {}
    }
  } catch {}
  return null;
}

/**
 * Discovers the active language_server address and CSRF token.
 * Checks environment variables first -> daemon metadata files -> running process flags.
 */
export function getLanguageServerCredentials() {
  const now = Date.now();
  if (cachedCredentials && now < credentialsCacheExpiry) {
    return cachedCredentials;
  }

  let addr = process.env.ANTIGRAVITY_LS_ADDRESS || '';
  let csrf = process.env.ANTIGRAVITY_CSRF_TOKEN || '';

  if (addr && csrf) {
    const creds = { address: addr, csrfToken: csrf };
    cachedCredentials = creds;
    credentialsCacheExpiry = now + 15000;
    return creds;
  }

  // 1. Try reading the active daemon hub json file directly
  const daemonCreds = discoverDaemonCredentials();
  if (daemonCreds) {
    cachedCredentials = daemonCreds;
    credentialsCacheExpiry = now + 15000;
    return daemonCreds;
  }

  // 2. Fallback: Discover from running process command line flags
  try {
    const isWindows = process.platform === 'win32';
    let output = '';

    if (isWindows) {
      const psScript = 'Get-CimInstance Win32_Process | Where-Object { $_.Name -like "*language_server*" } | Select-Object -ExpandProperty CommandLine';
      output = execFileSync('powershell.exe', ['-NoProfile', '-Command', psScript], {
        encoding: 'utf-8',
        timeout: 4000
      });
    } else {
      output = execFileSync('ps', ['aux'], {
        encoding: 'utf-8',
        timeout: 3000
      });
    }

    if (!csrf) {
      const csrfMatch = output.match(/--(?:csrf_token|csrf-token)[=\s]([a-f0-9-]+)/i);
      if (csrfMatch) csrf = csrfMatch[1];
    }

    if (!addr) {
      const portMatch = output.match(/--(?:port|https_server_port)[=\s](\d+)/i) ||
                        output.match(/host_bridge_url=https?:\/\/[^:]+:(\d+)/i);
      if (portMatch) {
        addr = `127.0.0.1:${portMatch[1]}`;
      }
    }
  } catch (err) {
    // Process inspection failed, fallback to standard defaults
  }

  // Safe defaults if still unresolved
  if (!addr) addr = '127.0.0.1:51267';
  if (!csrf) csrf = process.env.ANTIGRAVITY_CSRF_TOKEN || '';

  const creds = { address: addr, csrfToken: csrf };
  cachedCredentials = creds;
  credentialsCacheExpiry = now + 15000;
  return creds;
}

/**
 * Discovers the active conversation ID / cascadeId.
 * Checks override -> environment -> conversations directory (*.db / *.pb).
 */
export function getActiveCascadeId(preferredId = null) {
  if (preferredId && typeof preferredId === 'string' && preferredId.trim()) {
    return preferredId.trim();
  }

  if (process.env.ANTIGRAVITY_CONVERSATION_ID) {
    return process.env.ANTIGRAVITY_CONVERSATION_ID.trim();
  }

  try {
    const convDir = join(homedir(), '.gemini', 'antigravity', 'conversations');
    if (existsSync(convDir)) {
      const files = readdirSync(convDir)
        .filter(f => f.endsWith('.db') || f.endsWith('.pb'))
        .map(f => {
          try {
            return { name: f, mtime: statSync(join(convDir, f)).mtimeMs };
          } catch {
            return { name: f, mtime: 0 };
          }
        })
        .sort((a, b) => b.mtime - a.mtime);

      if (files.length > 0) {
        return files[0].name.replace(/\.(db|pb)$/, '');
      }
    }
  } catch (err) {
    console.error('Failed to resolve active cascadeId from conversations dir:', err);
  }

  return null;
}

/**
 * Performs an RPC call to LanguageServerService using Connect protocol over HTTP.
 */
export function callLanguageServerRpc(method, body = {}) {
  const { address, csrfToken } = getLanguageServerCredentials();
  let [host, portStr] = address.split(':');
  const port = parseInt(portStr || '51267', 10);
  if (!host || host === 'localhost') {
    host = '127.0.0.1';
  }
  const postData = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = http.request({
      host,
      port,
      path: `/exa.language_server_pb.LanguageServerService/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-codeium-csrf-token': csrfToken,
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data || '{}');
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`RPC ${method} returned HTTP ${res.statusCode}: ${json.message || data}`));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error(`RPC unmarshal failed: ${e.message}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`RPC ${method} connection error to ${host}:${port}: ${err.message}`));
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`RPC ${method} timed out (10s)`));
    });
    req.write(postData);
    req.end();
  });
}

/**
 * Fetches available models and their token limits with caching.
 */
export async function getModelLimits(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedModels && now < modelsCacheExpiry) {
    return cachedModels;
  }

  try {
    const resp = await callLanguageServerRpc('GetAvailableModels', {});
    const models = resp.response?.models || {};
    cachedModels = models;
    modelsCacheExpiry = now + 30000; // Cache for 30 seconds
    return models;
  } catch (err) {
    if (cachedModels) return cachedModels;
    return {};
  }
}

/**
 * Fetches the currently logged-in Antigravity account from GetUserStatus.
 */
export async function getCurrentAccount() {
  const now = Date.now();
  if (cachedAccount && now < accountCacheExpiry) {
    return cachedAccount;
  }

  try {
    const resp = await callLanguageServerRpc('GetUserStatus', {});
    const us = resp.userStatus || {};
    const email = (us.email || '').trim();
    const name = (us.name || '').trim();
    const planName = (us.planStatus?.planInfo?.planName || '').trim();
    const accountKey = email ? email.toLowerCase() : 'local-default';
    cachedAccount = {
      accountKey,
      email: email || 'Local Account',
      name: name || email || 'Local User',
      planName: planName || 'Standard'
    };
    accountCacheExpiry = now + 60000;
    return cachedAccount;
  } catch {
    return cachedAccount || {
      accountKey: 'local-default',
      email: 'Local Account',
      name: 'Local User',
      planName: 'Standard'
    };
  }
}

/**
 * Groups available models into their live quota pools (5-hour vs Weekly windows)
 * using quotaInfo.remainingFraction and quotaInfo.resetTime from GetAvailableModels.
 */
export async function getQuotaPools(forceRefresh = false) {
  const models = await getModelLimits(forceRefresh);
  const nowMs = Date.now();
  const buckets = new Map();

  for (const [key, def] of Object.entries(models || {})) {
    const qi = def?.quotaInfo;
    if (!qi || qi.remainingFraction === undefined || !qi.resetTime) continue;
    const displayName = (def.displayName || key).trim();
    const resetMs = Date.parse(qi.resetTime);
    if (Number.isNaN(resetMs)) continue;

    const hoursUntilReset = (resetMs - nowMs) / 3600000;
    const windowType = hoursUntilReset > 8 ? 'weekly' : '5h';

    // Determine family key so pools stay stable even when resetTime advances
    const lower = `${key} ${displayName}`.toLowerCase();
    let family = 'other';
    let familyLabel = 'Other Models';
    if (lower.includes('claude') || lower.includes('gpt')) {
      family = 'claude-gpt';
      familyLabel = 'Claude / GPT';
    } else if (lower.includes('argon')) {
      family = 'gemini-argon';
      familyLabel = 'Gemini Argon';
    } else if (lower.includes('gemini') || lower.includes('neon') || lower.includes('hydrogen') || lower.includes('flash')) {
      family = 'gemini-flash-neon';
      familyLabel = 'Gemini Flash / Neon';
    }

    const poolId = `${windowType}:${family}`;
    let bucket = buckets.get(poolId);
    if (!bucket) {
      bucket = {
        poolId,
        label: familyLabel,
        windowType,
        remainingFraction: Number(qi.remainingFraction),
        resetTime: qi.resetTime,
        resetMs,
        models: []
      };
      buckets.set(poolId, bucket);
    } else {
      // Keep the tightest remainingFraction in the bucket
      bucket.remainingFraction = Math.min(bucket.remainingFraction, Number(qi.remainingFraction));
    }
    if (!bucket.models.includes(displayName)) {
      bucket.models.push(displayName);
    }
  }

  return Array.from(buckets.values())
    .map(b => {
      const remFrac = Math.min(1, Math.max(0, b.remainingFraction));
      const remainingPct = parseFloat((remFrac * 100).toFixed(1));
      const usedPct = parseFloat(((1 - remFrac) * 100).toFixed(1));
      return {
        poolId: b.poolId,
        label: b.label,
        windowType: b.windowType,
        remainingFraction: remFrac,
        remainingPct,
        usedPct,
        resetTime: b.resetTime,
        msUntilReset: Math.max(0, b.resetMs - nowMs),
        models: b.models
      };
    })
    .sort((a, b) => {
      if (a.windowType !== b.windowType) return a.windowType === '5h' ? -1 : 1;
      return b.usedPct - a.usedPct || a.label.localeCompare(b.label);
    });
}

/**
 * Returns a compact, readable model label suitable for narrow table columns.
 */
export function getCompactModelName(displayName, responseModel, modelKey) {
  if (displayName) {
    let name = displayName.trim();
    if (name.startsWith('Gemini ')) name = name.replace(/^Gemini\s+/, '');
    if (name.startsWith('Claude ')) name = name.replace(/^Claude\s+/, '');
    return name;
  }
  if (responseModel) return responseModel;
  if (modelKey) return modelKey.replace('MODEL_PLACEHOLDER_', '');
  return 'Unknown';
}

/**
 * Main telemetry aggregator: Fetches exact server-side token usage
 * and live context window consumption for the active conversation.
 */
export async function getConversationTokenTelemetry(requestedCascadeId = null) {
  const cascadeId = getActiveCascadeId(requestedCascadeId);
  if (!cascadeId) {
    throw new Error('No active conversation or cascadeId found.');
  }

  // Fetch complete trajectory, models, and active account in parallel
  const [trajResp, modelsResp, account] = await Promise.all([
    callLanguageServerRpc('GetCascadeTrajectory', { cascade_id: cascadeId }),
    getModelLimits().catch(() => ({})),
    getCurrentAccount().catch(() => ({ accountKey: 'local-default', email: 'Local Account', name: 'Local User', planName: 'Standard' }))
  ]);

  const traj = trajResp.trajectory || {};
  const steps = traj.steps || [];
  const rawTurns = traj.generatorMetadata || [];
  const models = modelsResp.response?.models || modelsResp || {};

  // 1. Identify user input boundaries from trajectory steps
  const userPrompts = [];
  steps.forEach((s, idx) => {
    if (s.type === 'CORTEX_STEP_TYPE_USER_INPUT') {
      const text = s.userInput?.userResponse || '';
      userPrompts.push({
        promptNumber: userPrompts.length + 1,
        stepIndex: idx,
        userPromptPreview: text.trim().replace(/\s+/g, ' ').slice(0, 90)
      });
    }
  });

  // Fallback if no user input found
  if (userPrompts.length === 0) {
    userPrompts.push({
      promptNumber: 1,
      stepIndex: 0,
      userPromptPreview: 'Conversation Root'
    });
  }

  const promptGroups = userPrompts.map(p => ({
    promptNumber: p.promptNumber,
    userStepIndex: p.stepIndex,
    userPromptPreview: p.userPromptPreview,
    turns: []
  }));

  let cumulativeInputTokens = 0;
  let cumulativeCacheReadTokens = 0;
  let cumulativeOutputTokens = 0;
  let cumulativeThinkingTokens = 0;
  let cumulativeResponseTokens = 0;

  const turns = [];
  const compactions = [];
  const sessionModelsSet = new Set();
  let prevPromptTokens = 0;
  let prevTurnCompletedMs = null;
  let prevTurnModelName = null;
  let prevTurnModelShort = null;

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

  rawTurns.forEach((turn, idx) => {
    const chatModel = turn.chatModel || {};
    const usage = chatModel.usage || {};

    const inputTokens = parseInt(usage.inputTokens || '0', 10);
    const cacheReadTokens = parseInt(usage.cacheReadTokens || '0', 10);
    const outputTokens = parseInt(usage.outputTokens || '0', 10);
    const thinkingTokens = parseInt(usage.thinkingOutputTokens || '0', 10);
    const responseTokens = parseInt(usage.responseOutputTokens || '0', 10);

    const promptTokens = inputTokens + cacheReadTokens;
    const totalTurnTokens = promptTokens + outputTokens;

    const modelDisplayName = chatModel.modelDisplayName || 'Default Model';
    const responseModel = chatModel.responseModel || '';
    const modelKey = usage.model || '';
    const modelId = responseModel || modelKey || modelDisplayName;
    const modelShortName = getCompactModelName(modelDisplayName, responseModel, modelKey);
    const apiProvider = usage.apiProvider || '';

    const sIndices = turn.stepIndices || [];
    const firstStepIdx = sIndices.length ? sIndices[0] : -1;
    const lastStepIdx = sIndices.length ? sIndices[sIndices.length - 1] : -1;
    const createdAtMs = firstStepIdx >= 0 ? parseStepTimeMs(steps[firstStepIdx], false) : null;
    const completedAtMs = lastStepIdx >= 0 ? (parseStepTimeMs(steps[lastStepIdx], true) || createdAtMs) : createdAtMs;
    const gapSincePrevTurnMs = (createdAtMs && prevTurnCompletedMs)
      ? Math.max(0, createdAtMs - prevTurnCompletedMs)
      : null;

    const modelSwitched = Boolean(prevTurnModelName && prevTurnModelName !== modelDisplayName);
    let cacheStatus = 'initial';
    if (idx > 0) {
      if (cacheReadTokens > 0) {
        cacheStatus = modelSwitched ? 'cross_model_hit' : 'warm_hit';
      } else {
        cacheStatus = modelSwitched ? 'model_switch_miss' : 'cold_miss';
      }
    }

    if (modelDisplayName && modelDisplayName !== 'Default Model') {
      sessionModelsSet.add(modelDisplayName);
    }

    // Detect context compaction
    if (prevPromptTokens > 8000 && promptTokens < prevPromptTokens * 0.7) {
      compactions.push({
        turnIndex: idx + 1,
        stepIndices: sIndices,
        tokensBefore: prevPromptTokens,
        tokensAfter: promptTokens,
        tokensSaved: prevPromptTokens - promptTokens
      });
    }
    prevPromptTokens = promptTokens;

    cumulativeInputTokens += inputTokens;
    cumulativeCacheReadTokens += cacheReadTokens;
    cumulativeOutputTokens += outputTokens;
    cumulativeThinkingTokens += thinkingTokens;
    cumulativeResponseTokens += responseTokens;

    const turnItem = {
      turnNumber: idx + 1,
      stepIndices: sIndices,
      modelId,
      modelDisplayName,
      modelShortName,
      prevModelShortName: prevTurnModelShort,
      apiProvider,
      responseModel,
      modelKey,
      inputTokens,
      cacheReadTokens,
      outputTokens,
      thinkingTokens,
      responseTokens,
      promptTokens,
      totalTurnTokens,
      cacheEfficiencyPct: promptTokens > 0 ? ((cacheReadTokens / promptTokens) * 100).toFixed(1) : '0.0',
      createdAtMs,
      completedAtMs,
      gapSincePrevTurnMs,
      cacheStatus
    };
    turns.push(turnItem);

    if (completedAtMs) prevTurnCompletedMs = completedAtMs;
    prevTurnModelName = modelDisplayName;
    prevTurnModelShort = modelShortName;

    // Assign turn to corresponding user prompt group
    const firstStep = sIndices.length ? sIndices[0] : 0;
    let targetPromptIdx = 0;
    for (let i = 0; i < userPrompts.length; i++) {
      if (firstStep >= userPrompts[i].stepIndex) {
        targetPromptIdx = i;
      } else {
        break;
      }
    }
    const assignedPromptNumber = promptGroups[targetPromptIdx].promptNumber;
    turnItem.promptNumber = assignedPromptNumber;
    promptGroups[targetPromptIdx].turns.push(turnItem);
  });

  const latestTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  const sessionModels = Array.from(sessionModelsSet);
  const isMultiModel = sessionModels.length > 1;

  // Resolve active model and context limits
  let activeModelDisplayName = latestTurn?.modelDisplayName || 'Gemini 3.8 Flash (High)';
  let maxContextTokens = 1048576; // 1M tokens default
  let maxOutputTokens = 65536;

  for (const [key, modelDef] of Object.entries(models)) {
    if (modelDef.displayName === activeModelDisplayName ||
        (latestTurn?.modelKey && modelDef.model === latestTurn.modelKey) ||
        (latestTurn?.responseModel && (key === latestTurn.responseModel || key.includes(latestTurn.responseModel)))) {
      maxContextTokens = modelDef.maxTokens || maxContextTokens;
      maxOutputTokens = modelDef.maxOutputTokens || maxOutputTokens;
      activeModelDisplayName = modelDef.displayName || activeModelDisplayName;
      break;
    }
  }

  // 2. Build grouped prompts array for "By Prompt" view (with chat-to-chat cache lifespan stats)
  let prevPromptEndedMs = null;
  let prevPromptLastModelName = null;
  let prevPromptLastModelShort = null;

  // Burst-resistant survival boundary tracker (only same-model prompt-to-prompt gaps >= 30s)
  const MIN_NON_BURST_MS = 30 * 1000;
  function makeLifespanBucket() {
    return {
      maxWarmGapMs: null,
      minColdGapMs: null,
      warmSamples: 0,
      coldSamples: 0
    };
  }
  const overallLifespan = makeLifespanBucket();
  const lifespanByModel = {};

  function recordLifespanSample(bucket, gapMs, isWarm) {
    if (gapMs == null || gapMs < MIN_NON_BURST_MS) return;
    if (isWarm) {
      bucket.warmSamples += 1;
      if (bucket.maxWarmGapMs === null || gapMs > bucket.maxWarmGapMs) {
        bucket.maxWarmGapMs = gapMs;
      }
    } else {
      bucket.coldSamples += 1;
      if (bucket.minColdGapMs === null || gapMs < bucket.minColdGapMs) {
        bucket.minColdGapMs = gapMs;
      }
    }
  }

  function finalizeLifespan(bucket, isPersisted = false) {
    const sampleCount = (bucket?.warmSamples || 0) + (bucket?.coldSamples || 0);
    const hasWarm = bucket?.maxWarmGapMs !== null && bucket?.maxWarmGapMs !== undefined;
    const hasCold = bucket?.minColdGapMs !== null && bucket?.minColdGapMs !== undefined;
    let status = 'no_data';
    let estimatedTtlMs = null;
    if (hasWarm && hasCold && bucket.minColdGapMs > bucket.maxWarmGapMs) {
      status = 'bracketed';
      estimatedTtlMs = Math.round((bucket.maxWarmGapMs + bucket.minColdGapMs) / 2);
    } else if (hasWarm) {
      status = 'lower_bound';
      estimatedTtlMs = bucket.maxWarmGapMs;
    } else if (hasCold) {
      status = 'upper_bound';
      estimatedTtlMs = bucket.minColdGapMs;
    }
    return {
      status,
      sampleCount,
      warmSamples: bucket?.warmSamples || 0,
      coldSamples: bucket?.coldSamples || 0,
      maxWarmGapMs: bucket?.maxWarmGapMs ?? null,
      minColdGapMs: bucket?.minColdGapMs ?? null,
      estimatedTtlMs,
      isPersisted: Boolean(isPersisted || bucket?.isPersisted)
    };
  }

  const prompts = promptGroups.map((pg, pgIdx) => {
    const pTurns = pg.turns;
    let sumInput = 0, sumCache = 0, sumThinking = 0, sumOutput = 0;
    const modelsUsedSet = [];
    const modelShortSet = [];

    pTurns.forEach(t => {
      sumInput += t.inputTokens;
      sumCache += t.cacheReadTokens;
      sumThinking += t.thinkingTokens;
      sumOutput += t.outputTokens;
      if (t.modelDisplayName && !modelsUsedSet.includes(t.modelDisplayName)) {
        modelsUsedSet.push(t.modelDisplayName);
      }
      if (t.modelShortName && !modelShortSet.includes(t.modelShortName)) {
        modelShortSet.push(t.modelShortName);
      }
    });

    const firstTurn = pTurns[0] || null;
    const lastTurn = pTurns[pTurns.length - 1] || null;
    const endingContext = lastTurn ? lastTurn.totalTurnTokens : (latestTurn ? latestTurn.totalTurnTokens : 0);
    const endingContextPct = maxContextTokens > 0 ? ((endingContext / maxContextTokens) * 100).toFixed(2) : '0.0';
    const totalPromptTokens = sumInput + sumCache;

    const minStep = pTurns.length && firstTurn.stepIndices?.length ? firstTurn.stepIndices[0] : pg.userStepIndex;
    const maxStep = pTurns.length && lastTurn?.stepIndices?.length ? lastTurn.stepIndices[lastTurn.stepIndices.length - 1] : minStep;

    const startedAtMs = firstTurn?.createdAtMs || parseStepTimeMs(steps[pg.userStepIndex], false);
    const endedAtMs = lastTurn?.completedAtMs || startedAtMs;
    const gapSincePrevPromptMs = (pgIdx > 0 && startedAtMs && prevPromptEndedMs)
      ? Math.max(0, startedAtMs - prevPromptEndedMs)
      : null;

    const firstModelName = firstTurn?.modelDisplayName || null;
    const firstModelShort = firstTurn?.modelShortName || null;
    const promptModelSwitched = Boolean(prevPromptLastModelName && firstModelName && prevPromptLastModelName !== firstModelName);
    const firstTurnHadCache = Boolean(firstTurn && firstTurn.cacheReadTokens > 0);

    let promptCacheStatus = 'initial';
    if (pgIdx > 0 && firstTurn) {
      if (firstTurnHadCache) {
        promptCacheStatus = promptModelSwitched ? 'cross_model_hit' : 'warm_hit';
      } else {
        promptCacheStatus = promptModelSwitched ? 'model_switch_miss' : 'cold_miss';
      }

      // Record chat-to-chat survival boundary ONLY for same-model gaps >= 30s (ignores short bursts & tool loops)
      if (!promptModelSwitched && gapSincePrevPromptMs !== null && firstModelName) {
        recordLifespanSample(overallLifespan, gapSincePrevPromptMs, firstTurnHadCache);
        if (!lifespanByModel[firstModelName]) lifespanByModel[firstModelName] = makeLifespanBucket();
        recordLifespanSample(lifespanByModel[firstModelName], gapSincePrevPromptMs, firstTurnHadCache);
      }
    }

    const prevShortSnapshot = prevPromptLastModelShort;
    if (endedAtMs) prevPromptEndedMs = endedAtMs;
    if (lastTurn?.modelDisplayName) {
      prevPromptLastModelName = lastTurn.modelDisplayName;
      prevPromptLastModelShort = lastTurn.modelShortName;
    }

    return {
      promptNumber: pg.promptNumber,
      userPromptPreview: pg.userPromptPreview,
      llmCallsCount: pTurns.length,
      modelsUsed: modelsUsedSet.length ? modelsUsedSet : ['Unknown'],
      modelsUsedShort: modelShortSet.length ? modelShortSet : ['Unknown'],
      modelsRoutingPath: modelShortSet.length ? modelShortSet.join(' → ') : 'Unknown',
      newInput: sumInput,
      cacheRead: sumCache,
      thinking: sumThinking,
      output: sumOutput,
      totalTokens: sumInput + sumCache + sumOutput,
      cacheEfficiencyPct: totalPromptTokens > 0 ? ((sumCache / totalPromptTokens) * 100).toFixed(1) : '0.0',
      endingContext,
      endingContextPct,
      stepRange: pTurns.length ? `${minStep} → ${maxStep}` : `Step ${pg.userStepIndex}`,
      startedAtMs,
      endedAtMs,
      gapSincePrevPromptMs,
      promptCacheStatus,
      cachedModelShort: firstModelShort,
      prevPromptModelShort: prevShortSnapshot
    };
  });

  // Persist current chat's raw survival observations to global store and retrieve cross-chat bounds
  const updatedPersisted = updatePersistedAccountCacheLifespan(account.accountKey, cascadeId, lifespanByModel);

  const finalizedLifespanByModel = {};
  // 1. Seed with cross-chat persisted bounds
  for (const [mName, pBucket] of Object.entries(updatedPersisted || {})) {
    finalizedLifespanByModel[mName] = finalizeLifespan(pBucket, true);
  }
  // 2. Merge with current session bounds
  for (const [mName, b] of Object.entries(lifespanByModel)) {
    const pBucket = updatedPersisted?.[mName];
    if (pBucket) {
      const merged = {
        maxWarmGapMs: pBucket.maxWarmGapMs !== null && b.maxWarmGapMs !== null
          ? Math.max(pBucket.maxWarmGapMs, b.maxWarmGapMs)
          : (pBucket.maxWarmGapMs ?? b.maxWarmGapMs),
        minColdGapMs: pBucket.minColdGapMs !== null && b.minColdGapMs !== null
          ? Math.min(pBucket.minColdGapMs, b.minColdGapMs)
          : (pBucket.minColdGapMs ?? b.minColdGapMs),
        warmSamples: Math.max(pBucket.warmSamples || 0, b.warmSamples || 0),
        coldSamples: Math.max(pBucket.coldSamples || 0, b.coldSamples || 0),
        isPersisted: true
      };
      finalizedLifespanByModel[mName] = finalizeLifespan(merged, true);
    } else {
      finalizedLifespanByModel[mName] = finalizeLifespan(b, false);
    }
  }

  // 3. For overall lifespan: use session if it has samples; otherwise fallback to active model's learned bounds
  let finalizedOverall = finalizeLifespan(overallLifespan, false);
  if (finalizedOverall.sampleCount === 0) {
    const warmModel = latestTurn?.modelDisplayName || activeModelDisplayName;
    if (finalizedLifespanByModel[warmModel] && finalizedLifespanByModel[warmModel].sampleCount > 0) {
      finalizedOverall = { ...finalizedLifespanByModel[warmModel] };
    }
  }

  const cacheLifespan = {
    overall: finalizedOverall,
    byModel: finalizedLifespanByModel,
    lastChatCompletedAtMs: latestTurn?.completedAtMs || null,
    warmModelDisplayName: latestTurn?.modelDisplayName || activeModelDisplayName,
    warmModelShortName: latestTurn?.modelShortName || getCompactModelName(activeModelDisplayName),
    lastTurnHadCache: Boolean(latestTurn && latestTurn.cacheReadTokens > 0),
    minSampleGapMs: MIN_NON_BURST_MS
  };

  // Active Context calculation
  const activeContextTokens = latestTurn ? latestTurn.totalTurnTokens : 0;
  const contextConsumptionPct = maxContextTokens > 0 ? ((activeContextTokens / maxContextTokens) * 100) : 0;
  const remainingTokens = Math.max(0, maxContextTokens - activeContextTokens);
  const remainingPct = Math.max(0, 100 - contextConsumptionPct);

  // Health threshold status
  let healthStatus = 'optimal';
  if (contextConsumptionPct >= 80) {
    healthStatus = 'critical';
  } else if (contextConsumptionPct >= 50) {
    healthStatus = 'moderate';
  }

  // 3. Map step indices -> modelDisplayName & collect 3-level tool call stats + subagents
  const stepToModel = new Map();
  for (const t of turns) {
    for (const sIdx of (t.stepIndices || [])) {
      stepToModel.set(sIdx, t.modelDisplayName);
    }
  }

  const allToolEntries = [];
  const toolEntriesByModel = new Map();
  const discoveredSubagents = [];
  const seenSubIds = new Set();

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const tcs = s.plannerResponse?.toolCalls || [];
    if (!Array.isArray(tcs) || !tcs.length) continue;
    const stepModel = stepToModel.get(i) || activeModelDisplayName;

    for (let tIdx = 0; tIdx < tcs.length; tIdx++) {
      const tc = tcs[tIdx];
      const name = tc?.name || 'unknown_tool';
      const target = extractToolTargetLabel(name, tc?.argumentsJson);
      const entry = { name, target, stepIndex: i, model: stepModel };
      allToolEntries.push(entry);

      let mList = toolEntriesByModel.get(stepModel);
      if (!mList) {
        mList = [];
        toolEntriesByModel.set(stepModel, mList);
      }
      mList.push(entry);

      if (name === 'invoke_subagent') {
        let args = {};
        try { args = JSON.parse(tc.argumentsJson || '{}'); } catch {}
        let subId = null;
        for (let look = 1; look <= tcs.length + 2 && i + look < steps.length; look++) {
          const cand = steps[i + look];
          const str = JSON.stringify(cand || '');
          const m = str.match(UUID_RE);
          if (m && m[0] !== cascadeId) {
            subId = m[0];
            break;
          }
        }
        const dedupKey = subId || `step-${i}-${tIdx}`;
        if (!seenSubIds.has(dedupKey)) {
          seenSubIds.add(dedupKey);
          discoveredSubagents.push({
            conversationId: subId,
            typeName: args.TypeName || 'subagent',
            role: args.Role || args.TypeName || 'Subagent',
            requestedModel: args.Model || 'inherit',
            stepIndex: i
          });
        }
      }
    }
  }

  const toolCallsByModel = {};
  for (const [mName, entries] of toolEntriesByModel.entries()) {
    toolCallsByModel[mName] = buildToolCallsSummary(entries);
  }
  const toolCalls = {
    ...buildToolCallsSummary(allToolEntries),
    byModel: toolCallsByModel
  };

  // 4. Build per-model stats breakdown for the Per-Model dropdown
  const modelStats = {};
  for (const t of turns) {
    const key = t.modelDisplayName || 'Default Model';
    let ms = modelStats[key];
    if (!ms) {
      const lim = resolveModelLimitsFor(models, key, t.modelKey, t.responseModel);
      ms = {
        displayName: key,
        shortName: t.modelShortName,
        maxContextTokens: lim.maxContextTokens,
        maxOutputTokens: lim.maxOutputTokens,
        turnsCount: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        responseTokens: 0,
        totalProcessedTokens: 0,
        cacheEfficiencyPct: '0.0',
        latestTurn: null
      };
      modelStats[key] = ms;
    }
    ms.turnsCount += 1;
    ms.inputTokens += t.inputTokens;
    ms.cacheReadTokens += t.cacheReadTokens;
    ms.outputTokens += t.outputTokens;
    ms.thinkingTokens += t.thinkingTokens;
    ms.responseTokens += t.responseTokens;
    ms.totalProcessedTokens += t.inputTokens + t.cacheReadTokens + t.outputTokens;
    ms.latestTurn = t;
  }
  for (const ms of Object.values(modelStats)) {
    const denom = ms.inputTokens + ms.cacheReadTokens;
    ms.cacheEfficiencyPct = denom > 0 ? ((ms.cacheReadTokens / denom) * 100).toFixed(1) : '0.0';
  }

  // 5. Enrich discovered subagents with quick live token stats (non-recursive)
  const subagents = await Promise.all(discoveredSubagents.map(async (sub) => {
    if (!sub.conversationId) return { ...sub, activeTokens: 0, totalTurns: 0, totalProcessedTokens: 0, modelDisplayName: sub.requestedModel, status: 'unknown' };
    try {
      const subTraj = await callLanguageServerRpc('GetCascadeTrajectory', { cascade_id: sub.conversationId });
      const subTurns = subTraj.trajectory?.generatorMetadata || [];
      let totalProc = 0;
      let latestAct = 0;
      let latestMod = sub.requestedModel;
      for (const st of subTurns) {
        const u = st.chatModel?.usage || {};
        const inp = parseInt(u.inputTokens || '0', 10);
        const cac = parseInt(u.cacheReadTokens || '0', 10);
        const out = parseInt(u.outputTokens || '0', 10);
        totalProc += inp + cac + out;
        latestAct = inp + cac + out;
        if (st.chatModel?.modelDisplayName) latestMod = st.chatModel.modelDisplayName;
      }
      const status = subTraj.status || (subTurns.length > 0 ? 'active' : 'starting');
      return {
        ...sub,
        activeTokens: latestAct,
        totalTurns: subTurns.length,
        totalProcessedTokens: totalProc,
        modelDisplayName: latestMod,
        status
      };
    } catch {
      return { ...sub, activeTokens: 0, totalTurns: 0, totalProcessedTokens: 0, modelDisplayName: sub.requestedModel, status: 'unavailable' };
    }
  }));

  return {
    cascadeId,
    timestamp: new Date().toISOString(),
    account,
    healthStatus,
    sessionModels,
    isMultiModel,
    sessionModelsSummary: isMultiModel
      ? `${sessionModels.length} models used: ${sessionModels.join(', ')}`
      : `Single model (${sessionModels[0] || activeModelDisplayName})`,
    activeModel: {
      displayName: activeModelDisplayName,
      shortName: getCompactModelName(activeModelDisplayName, latestTurn?.responseModel, latestTurn?.modelKey),
      maxContextTokens,
      maxOutputTokens
    },
    modelStats,
    toolCalls,
    subagents,
    cacheLifespan,
    liveContext: {
      activeTokens: activeContextTokens,
      maxLimit: maxContextTokens,
      consumptionPct: parseFloat(contextConsumptionPct.toFixed(2)),
      remainingTokens,
      remainingPct: parseFloat(remainingPct.toFixed(2)),
      compactionCount: compactions.length,
      compactions
    },
    latestTurn: latestTurn ? {
      turnNumber: latestTurn.turnNumber,
      stepIndices: latestTurn.stepIndices,
      modelId: latestTurn.modelId,
      modelDisplayName: latestTurn.modelDisplayName,
      modelShortName: latestTurn.modelShortName,
      inputTokens: latestTurn.inputTokens,
      cacheReadTokens: latestTurn.cacheReadTokens,
      outputTokens: latestTurn.outputTokens,
      thinkingTokens: latestTurn.thinkingTokens,
      responseTokens: latestTurn.responseTokens,
      promptTokens: latestTurn.promptTokens,
      cacheEfficiencyPct: latestTurn.cacheEfficiencyPct
    } : null,
    cumulative: {
      totalTurns: turns.length,
      totalPrompts: prompts.length,
      inputTokens: cumulativeInputTokens,
      cacheReadTokens: cumulativeCacheReadTokens,
      outputTokens: cumulativeOutputTokens,
      thinkingTokens: cumulativeThinkingTokens,
      responseTokens: cumulativeResponseTokens,
      totalProcessedTokens: cumulativeInputTokens + cumulativeCacheReadTokens + cumulativeOutputTokens,
      overallCacheSavingsPct: (cumulativeInputTokens + cumulativeCacheReadTokens) > 0 ?
        (((cumulativeCacheReadTokens) / (cumulativeInputTokens + cumulativeCacheReadTokens)) * 100).toFixed(1) : '0.0'
    },
    prompts,
    recentPrompts: prompts.slice(-15).reverse(),
    turns,
    recentTurns: turns.slice(-15).reverse()
  };
}
