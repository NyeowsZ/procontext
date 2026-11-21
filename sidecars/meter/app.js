/**
 * Token & Context Meter - Dynamic Telemetry Controller
 * Supports Session, Agents, and Global tabs, Per-Model filtering,
 * 3-level Tool Calls drill-down, click-to-compact, and persistent preferences.
 */

(function () {
  const urlParams = new URLSearchParams(window.location.search);
  const rootConversationId = urlParams.get('conversationId') || '';
  const token = urlParams.get('token') || '';

  // Theme sync: follow the Antigravity host background (dark by default)
  function syncScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #131417)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const theme = lum < 0.5 ? 'dark' : 'light';
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
  }
  syncScheme();
  new MutationObserver(syncScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  // Runtime state
  let currentTelemetry = null;
  let mainSubagents = [];
  let globalUsageData = null;
  let activeTab = 'session'; // 'session' | 'agents' | 'global'
  let selectedModel = 'all';
  let inspectedAgent = null; // { conversationId, role } or null
  let activeView = localStorage.getItem('token_meter_view') || 'prompt';

  // Tool Calls 3-level drill-down state
  let toolTreeExpanded = false;
  let compactionTreeExpanded = false;
  const expandedToolNames = new Set();
  const expandedSnapshotIds = new Set();
  const expandedQuotaPoolIds = new Set();
  const expandedQuotaModelNames = new Set();

  // Telemetry item compaction: default mode + per-item overrides
  // Default to Coding HUD ('hud') whenever the plugin is opened
  let viewMode = 'hud';
  let simpleMode = false;
  const SIMPLE_TELEMETRY_LIMIT = 5;
  let compactAlarmK = parseFloat(localStorage.getItem('token_meter_compact_alarm_k') ?? '250');
  if (!isFinite(compactAlarmK) || compactAlarmK < 0) compactAlarmK = 250;
  // Default all telemetry items to compacted on load
  let defaultItemsCompact = true;
  let itemCompactOverrides = new Set();
  function saveCompacted() {
    try {
      localStorage.setItem('token_meter_items_default_compact', String(defaultItemsCompact));
    } catch {}
  }
  function itemKey(kind, num) {
    return `${currentTelemetry?.cascadeId || 'active'}:${kind}:${num}`;
  }
  function isItemCompact(key) {
    const baseCompact = simpleMode || defaultItemsCompact;
    return baseCompact ? !itemCompactOverrides.has(key) : itemCompactOverrides.has(key);
  }

  // Persisted UI preferences: visible sections, compacted sections, telemetry fields
  const DEFAULT_SECTIONS = { windowUtil: true, quotas: true, activeTurn: true, genOutput: true, sessionTotals: true, telemetry: true };
  const DEFAULT_SECTION_COMPACT = { windowUtil: false, quotas: false, activeTurn: false, genOutput: false, sessionTotals: false, telemetry: false };
  const DEFAULT_TELEMETRY_FIELDS = { model: true, chat: true, calls: true, cache: true, quota5h: true, quotaWeekly: true };

  function loadJsonPref(key, defaults) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || 'null');
      return parsed && typeof parsed === 'object' ? { ...defaults, ...parsed } : { ...defaults };
    } catch {
      return { ...defaults };
    }
  }
  function saveJsonPref(key, obj) {
    try {
      localStorage.setItem(key, JSON.stringify(obj));
    } catch {}
  }

  const sectionVisibility = loadJsonPref('token_meter_sections', DEFAULT_SECTIONS);
  const sectionCompact = loadJsonPref('token_meter_section_compact', DEFAULT_SECTION_COMPACT);
  const telemetryFields = loadJsonPref('token_meter_telemetry_fields', DEFAULT_TELEMETRY_FIELDS);

  const POLL_MS = 2500;

  // DOM Elements - Header & Nav
  const refreshBtn = document.getElementById('refreshBtn');
  const copyMarkdownBtn = document.getElementById('copyMarkdownBtn');
  const cascadeIdBadge = document.getElementById('cascadeIdBadge');
  const headerMenuBtn = document.getElementById('headerMenuBtn');
  const headerMenu = document.getElementById('headerMenu');
  const viewModeQuickBtn = document.getElementById('viewModeQuickBtn');
  const codingHudPane = document.getElementById('codingHudPane');

  const tabSessionBtn = document.getElementById('tabSessionBtn');
  const tabAgentsBtn = document.getElementById('tabAgentsBtn');
  const tabGlobalBtn = document.getElementById('tabGlobalBtn');
  const agentsCountBadge = document.getElementById('agentsCountBadge');
  const modelFilterSelect = document.getElementById('modelFilterSelect');

  const tabSession = document.getElementById('tabSession');
  const tabAgents = document.getElementById('tabAgents');
  const tabGlobal = document.getElementById('tabGlobal');

  const agentInspectBanner = document.getElementById('agentInspectBanner');
  const agentInspectLabel = document.getElementById('agentInspectLabel');
  const backToMainBtn = document.getElementById('backToMainBtn');

  // DOM Elements - Session Tab
  const telemetryMenuBtn = document.getElementById('telemetryMenuBtn');
  const telemetryMenu = document.getElementById('telemetryMenu');
  const telemetryHeaderToggle = document.getElementById('telemetryHeaderToggle');
  const compactAllBtn = document.getElementById('compactAllBtn');
  const telemetryCompactVal = document.getElementById('telemetryCompactVal');
  const viewPromptBtn = document.getElementById('viewPromptBtn');
  const viewStepBtn = document.getElementById('viewStepBtn');
  const telemetryList = document.getElementById('telemetryList');
  const telemetryPagination = document.getElementById('telemetryPagination');
  const telemetryPaginationInfo = document.getElementById('telemetryPaginationInfo');
  const telemetryPaginationPages = document.getElementById('telemetryPaginationPages');
  const telemetryPagePrev = document.getElementById('telemetryPagePrev');
  const telemetryPageNext = document.getElementById('telemetryPageNext');

  const contextPctValue = document.getElementById('contextPctValue');
  const healthBadge = document.getElementById('healthBadge');
  const windowCompactAlarmBtn = document.getElementById('windowCompactAlarmBtn');
  const windowCompactAlarmInlineInput = document.getElementById('windowCompactAlarmInlineInput');
  const hudCompactAlarmBtn = document.getElementById('hudCompactAlarmBtn');
  const hudCompactAlarmInlineInput = document.getElementById('hudCompactAlarmInlineInput');
  const compactAlarmKInput = document.getElementById('compactAlarmKInput');
  const compactAlarmOffBtn = document.getElementById('compactAlarmOffBtn');
  const contextAlarmTick = document.getElementById('contextAlarmTick');
  const windowRatioVal = document.getElementById('windowRatioVal');
  const contextProgressBar = document.getElementById('contextProgressBar');
  const activeTokensVal = document.getElementById('activeTokensVal');
  const remainingTokensVal = document.getElementById('remainingTokensVal');
  const modelNameBadge = document.getElementById('modelNameBadge');
  const multiModelBadge = document.getElementById('multiModelBadge');

  const compactionAlert = document.getElementById('compactionAlert');
  const compactionToggleRow = document.getElementById('compactionToggleRow');
  const compactionTitle = document.getElementById('compactionTitle');
  const compactionSavedVal = document.getElementById('compactionSavedVal');
  const compactionCountVal = document.getElementById('compactionCountVal');
  const compactionDesc = document.getElementById('compactionDesc');
  const compactionCheckpointsList = document.getElementById('compactionCheckpointsList');

  const cacheHitBadge = document.getElementById('cacheHitBadge');
  const turnPromptTotalVal = document.getElementById('turnPromptTotalVal');
  const turnCacheReadVal = document.getElementById('turnCacheReadVal');
  const turnCachePct = document.getElementById('turnCachePct');
  const turnNewInputVal = document.getElementById('turnNewInputVal');
  const turnNewInputPct = document.getElementById('turnNewInputPct');
  const cacheLifespanStrip = document.getElementById('cacheLifespanStrip');
  const lastChatAgoVal = document.getElementById('lastChatAgoVal');
  const warmModelPill = document.getElementById('warmModelPill');
  const cacheLifespanStat = document.getElementById('cacheLifespanStat');

  const turnOutputTotalBadge = document.getElementById('turnOutputTotalBadge');
  const genOutputLimitVal = document.getElementById('genOutputLimitVal');
  const turnThinkingVal = document.getElementById('turnThinkingVal');
  const turnThinkingPct = document.getElementById('turnThinkingPct');
  const turnResponseVal = document.getElementById('turnResponseVal');
  const turnResponsePct = document.getElementById('turnResponsePct');
  const toolCallsRootRow = document.getElementById('toolCallsRootRow');
  const toolCallsTotalVal = document.getElementById('toolCallsTotalVal');
  const toolCallsTypesVal = document.getElementById('toolCallsTypesVal');
  const toolCallsTree = document.getElementById('toolCallsTree');

  const totalTurnsBadge = document.getElementById('totalTurnsBadge');
  const sessionProcessedVal = document.getElementById('sessionProcessedVal');
  const sessionCacheSavingsVal = document.getElementById('sessionCacheSavingsVal');
  const sessionCacheTotal = document.getElementById('sessionCacheTotal');
  const sessionCachePct = document.getElementById('sessionCachePct');
  const sessionPromptCacheRow = document.getElementById('sessionPromptCacheRow');
  const sessionPromptCacheRatio = document.getElementById('sessionPromptCacheRatio');
  const sessionPromptCachePct = document.getElementById('sessionPromptCachePct');
  const sessionInputTotal = document.getElementById('sessionInputTotal');
  const sessionInputPct = document.getElementById('sessionInputPct');
  const sessionThinkingTotal = document.getElementById('sessionThinkingTotal');
  const sessionThinkingPct = document.getElementById('sessionThinkingPct');
  const sessionOutputTotal = document.getElementById('sessionOutputTotal');
  const sessionOutputPct = document.getElementById('sessionOutputPct');

  // DOM Elements - Agents Tab
  const agentsSummaryMeta = document.getElementById('agentsSummaryMeta');
  const agentsList = document.getElementById('agentsList');

  // DOM Elements - Global & Quotas
  const sessionAccountBadge = document.getElementById('sessionAccountBadge');
  const sessionQuotaPoolsList = document.getElementById('sessionQuotaPoolsList');
  const globalAccountBadge = document.getElementById('globalAccountBadge');
  const quotaPoolsList = document.getElementById('quotaPoolsList');
  const globalTotalVal = document.getElementById('globalTotalVal');
  const globalMetaVal = document.getElementById('globalMetaVal');
  const globalCacheVal = document.getElementById('globalCacheVal');
  const globalBaselineNote = document.getElementById('globalBaselineNote');
  const globalCacheTotal = document.getElementById('globalCacheTotal');
  const globalCachePct = document.getElementById('globalCachePct');
  const globalInputTotal = document.getElementById('globalInputTotal');
  const globalInputPct = document.getElementById('globalInputPct');
  const globalThinkingTotal = document.getElementById('globalThinkingTotal');
  const globalThinkingPct = document.getElementById('globalThinkingPct');
  const globalOutputTotal = document.getElementById('globalOutputTotal');
  const globalOutputPct = document.getElementById('globalOutputPct');
  const snapshotNameInput = document.getElementById('snapshotNameInput');
  const storeSnapshotBtn = document.getElementById('storeSnapshotBtn');
  const resetGlobalBtn = document.getElementById('resetGlobalBtn');
  const exportGlobalBtn = document.getElementById('exportGlobalBtn');
  const importGlobalBtn = document.getElementById('importGlobalBtn');
  const importGlobalFile = document.getElementById('importGlobalFile');
  const secGlobalByModel = document.getElementById('secGlobalByModel');
  const globalModelCountVal = document.getElementById('globalModelCountVal');
  const globalModelsList = document.getElementById('globalModelsList');
  const snapshotsCountVal = document.getElementById('snapshotsCountVal');
  const snapshotsList = document.getElementById('snapshotsList');

  // Helpers
  function formatNum(num) {
    return (num || 0).toLocaleString();
  }

  function formatCompactNum(num) {
    const val = Number(num) || 0;
    if (Math.abs(val) >= 1_000_000) {
      return (val / 1_000_000).toFixed(2).replace(/\.00$/, '') + 'M';
    }
    if (Math.abs(val) >= 10_000) {
      return (val / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
    }
    if (Math.abs(val) >= 1_000) {
      return (val / 1_000).toFixed(1) + 'K';
    }
    return val.toLocaleString();
  }

  function pctStr(part, total) {
    if (!total || total <= 0) return '0%';
    const val = (part / total) * 100;
    return val > 0 && val < 0.1 ? '<0.1%' : `${val.toFixed(1)}%`;
  }

  function truncate(str, maxLen = 24) {
    if (!str) return '';
    return str.length > maxLen ? str.slice(0, maxLen).trim() + '…' : str;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function getModelPillClass(name) {
    if (!name) return '';
    const lower = name.toLowerCase();
    if (lower.includes('high')) return 'flash-high';
    if (lower.includes('low')) return 'flash-low';
    if (lower.includes('pro') || lower.includes('opus')) return 'pro';
    if (lower.includes('argon') || lower.includes('neon')) return 'argon';
    return '';
  }

  function getCacheBadgeClass(pct) {
    const num = parseFloat(pct) || 0;
    if (num >= 90) return 'cache-high';
    if (num >= 60) return 'cache-mid';
    return 'cache-low';
  }

  function apiUrl(path, extraParams = {}) {
    const q = new URLSearchParams();
    if (token) q.set('token', token);
    for (const [k, v] of Object.entries(extraParams)) {
      if (v) q.set(k, v);
    }
    const qs = q.toString();
    return qs ? `${path}?${qs}` : path;
  }

  // ---------- Fetching ----------
  async function fetchTelemetry() {
    try {
      const targetId = inspectedAgent?.conversationId || rootConversationId;
      const res = await fetch(apiUrl('/api/tokens', { conversationId: targetId }));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      currentTelemetry = data;
      if (!inspectedAgent && Array.isArray(data.subagents)) {
        mainSubagents = data.subagents;
      }

      updateModelDropdown();
      renderDashboard(data);
      renderAgentsList();
    } catch (err) {
      console.warn('Telemetry sync error:', err.message);
    }
  }

  async function fetchGlobalUsage() {
    try {
      const res = await fetch(apiUrl('/api/global'));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      globalUsageData = data;
      updateModelDropdown();
      renderGlobalView(data);
      if (data.pendingCount > 0 && activeTab === 'global') {
        setTimeout(() => { if (activeTab === 'global') fetchGlobalUsage(); }, 250);
      }
    } catch (err) {
      console.warn('Global usage sync error:', err.message);
    }
  }

  // ---------- Per-Model Dropdown ----------
  function updateModelDropdown() {
    if (!modelFilterSelect) return;
    let models = [];
    if (activeTab === 'global' && globalUsageData?.byModel) {
      models = Object.keys(globalUsageData.byModel);
    } else if (currentTelemetry) {
      models = Object.keys(currentTelemetry.modelStats || {});
      if (!models.length && currentTelemetry.sessionModels?.length) {
        models = currentTelemetry.sessionModels;
      }
    }

    const prev = selectedModel;
    if (prev !== 'all' && !models.includes(prev)) {
      selectedModel = 'all';
    }

    const opts = [`<option value="all">All Models</option>`]
      .concat(models.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`));
    const html = opts.join('');
    if (modelFilterSelect.innerHTML !== html) {
      modelFilterSelect.innerHTML = html;
    }
    modelFilterSelect.value = selectedModel;
  }

  // ---------- Session Dashboard Rendering ----------
  function renderDashboard(data) {
    if (!data) return;
    const ctx = data.liveContext || {};
    const allModelStats = data.modelStats || {};
    const filteredModel = selectedModel !== 'all' ? allModelStats[selectedModel] : null;

    const latest = filteredModel?.latestTurn || data.latestTurn || {};
    const cum = filteredModel
      ? {
          totalTurns: filteredModel.turnsCount,
          inputTokens: filteredModel.inputTokens,
          cacheReadTokens: filteredModel.cacheReadTokens,
          outputTokens: filteredModel.outputTokens,
          thinkingTokens: filteredModel.thinkingTokens,
          responseTokens: filteredModel.responseTokens,
          totalProcessedTokens: filteredModel.totalProcessedTokens,
          overallCacheSavingsPct: filteredModel.cacheEfficiencyPct
        }
      : (data.cumulative || {});
    const model = filteredModel
      ? {
          displayName: filteredModel.displayName,
          maxContextTokens: filteredModel.maxContextTokens,
          maxOutputTokens: filteredModel.maxOutputTokens
        }
      : (data.activeModel || {});

    // Header Convo ID (no "Cascade · " prefix)
    const shortId = data.cascadeId ? data.cascadeId.slice(0, 8) : 'active';
    cascadeIdBadge.textContent = shortId;
    cascadeIdBadge.title = `Conversation ID: ${data.cascadeId || 'Active'}`;

    // Subagent inspection banner
    if (agentInspectBanner) {
      if (inspectedAgent) {
        agentInspectBanner.classList.remove('hidden');
        if (agentInspectLabel) {
          agentInspectLabel.textContent = `Agent: ${inspectedAgent.role} (${shortId})`;
        }
      } else {
        agentInspectBanner.classList.add('hidden');
      }
    }

    // Model badges
    const displayModelName = filteredModel?.displayName || latest.modelDisplayName || model.displayName || 'Gemini 3.8 Flash';
    modelNameBadge.textContent = displayModelName;

    if (!filteredModel && data.isMultiModel && data.sessionModels && data.sessionModels.length > 1) {
      modelNameBadge.title = `Latest turn model: ${displayModelName}\nSession models (${data.sessionModels.length}):\n• ${data.sessionModels.join('\n• ')}`;
      if (multiModelBadge) {
        multiModelBadge.style.display = 'inline-flex';
        multiModelBadge.textContent = `${data.sessionModels.length} Models`;
        multiModelBadge.title = `Multiple models used across session:\n• ${data.sessionModels.join('\n• ')}`;
      }
    } else {
      modelNameBadge.title = `Model: ${displayModelName}`;
      if (multiModelBadge) multiModelBadge.style.display = 'none';
    }

    // Window Utilization (uses model's context ceiling when filtered)
    const activeTok = filteredModel ? (latest.totalTurnTokens || 0) : (ctx.activeTokens || 0);
    const maxLim = model.maxContextTokens || ctx.maxLimit || 1048576;
    const pct = Math.min(100, Math.max(0, maxLim > 0 ? (activeTok / maxLim) * 100 : 0));
    const remTok = Math.max(0, maxLim - activeTok);

    contextPctValue.textContent = `${pct.toFixed(1)}% used`;

    let color = 'var(--tm-ok)';
    let healthLabel = 'Optimal';
    if (pct >= 80) {
      color = 'var(--tm-crit)';
      healthLabel = 'Critical';
    } else if (pct >= 50) {
      color = 'var(--tm-warn)';
      healthLabel = 'Moderate';
    }

    healthBadge.textContent = healthLabel;
    healthBadge.style.color = color;

    if (windowRatioVal) {
      windowRatioVal.textContent = `${formatCompactNum(activeTok)} / ${formatCompactNum(maxLim)}`;
      windowRatioVal.title = `${formatNum(activeTok)} / ${formatNum(maxLim)} tokens`;
    }

    contextProgressBar.style.width = `${pct}%`;
    contextProgressBar.style.backgroundColor = color;
    updateCompactAlarmUi(activeTok, maxLim);

    if (activeTokensVal) activeTokensVal.textContent = `${formatNum(activeTok)} active`;
    remainingTokensVal.textContent = `${formatCompactNum(remTok)} free`;
    remainingTokensVal.title = `${formatNum(remTok)} tokens free`;

    // Compaction Alert (same .cat-list / .cat-row design consistency)
    if (ctx.compactionCount > 0 && Array.isArray(ctx.compactions) && ctx.compactions.length > 0) {
      compactionAlert.style.display = '';
      const lastC = ctx.compactions[ctx.compactions.length - 1];
      const totalSaved = ctx.compactions.reduce((acc, c) => acc + (c.tokensSaved || 0), 0);
      const totalBefore = ctx.compactions.reduce((acc, c) => acc + (c.tokensBefore || 0), 0);
      const savedPct = totalBefore > 0 ? ((totalSaved / totalBefore) * 100).toFixed(1) : '0.0';

      if (compactionTitle) {
        compactionTitle.textContent = 'Context Compacted';
      }
      if (compactionSavedVal) {
        compactionSavedVal.textContent = `-${formatNum(totalSaved)}`;
        compactionSavedVal.title = `${formatNum(totalSaved)} total tokens saved across ${ctx.compactionCount} checkpoint${ctx.compactionCount === 1 ? '' : 's'}`;
      }
      if (compactionCountVal) {
        compactionCountVal.textContent = `-${savedPct}%`;
      }
      if (compactionDesc) {
        compactionDesc.innerHTML = `${formatCompactNum(lastC.tokensBefore)} → ${formatCompactNum(lastC.tokensAfter)} <span class="compaction-pill" title="Latest compaction at Turn #${lastC.turnIndex} (${ctx.compactionCount} checkpoint${ctx.compactionCount === 1 ? '' : 's'})">Turn #${lastC.turnIndex} · ${ctx.compactionCount}×</span>`;
      }
      if (compactionToggleRow) {
        compactionToggleRow.classList.toggle('expanded', compactionTreeExpanded);
        compactionToggleRow.setAttribute('aria-expanded', String(compactionTreeExpanded));
      }
      if (compactionCheckpointsList) {
        compactionCheckpointsList.classList.toggle('hidden', !compactionTreeExpanded);
        if (compactionTreeExpanded) {
          compactionCheckpointsList.innerHTML = ctx.compactions.map((c, idx) => {
            const pct = c.tokensBefore > 0 ? ((c.tokensSaved / c.tokensBefore) * 100).toFixed(1) : '0.0';
            return `
              <div class="tool-target-row" title="Checkpoint #${idx + 1} at Turn #${c.turnIndex}: ${formatNum(c.tokensBefore)} → ${formatNum(c.tokensAfter)} tokens (${formatNum(c.tokensSaved)} saved)">
                <span class="tool-target-label">#${idx + 1} · Turn #${c.turnIndex} (${formatCompactNum(c.tokensBefore)} → ${formatCompactNum(c.tokensAfter)})</span>
                <span class="tool-target-count">-${formatCompactNum(c.tokensSaved)} (-${pct}%)</span>
              </div>
            `;
          }).join('');
        }
      }
    } else {
      compactionAlert.style.display = 'none';
    }

    // Active Turn Breakdown
    const promptTotal = latest.promptTokens || 0;
    cacheHitBadge.textContent = `${latest.cacheEfficiencyPct || 0}% cached`;
    turnPromptTotalVal.textContent = `${formatCompactNum(promptTotal)} prompt`;
    turnPromptTotalVal.title = `${formatNum(promptTotal)} total prompt tokens`;
    turnCacheReadVal.textContent = formatNum(latest.cacheReadTokens);
    if (turnCachePct) turnCachePct.textContent = pctStr(latest.cacheReadTokens || 0, promptTotal);
    turnNewInputVal.textContent = formatNum(latest.inputTokens);
    if (turnNewInputPct) turnNewInputPct.textContent = pctStr(latest.inputTokens || 0, promptTotal);
    renderCacheLifespanStrip();

    // Generation Output Breakdown + 3-Level Tool Calls Tree
    const outTotal = latest.outputTokens || 0;
    const thinkTok = latest.thinkingTokens || 0;
    const respTok = latest.responseTokens || 0;
    const outSum = thinkTok + respTok || outTotal;
    turnOutputTotalBadge.textContent = formatNum(outTotal);
    if (genOutputLimitVal) {
      genOutputLimitVal.textContent = model.maxOutputTokens ? `/ ${formatCompactNum(model.maxOutputTokens)}` : 'tokens';
    }
    turnThinkingVal.textContent = formatNum(thinkTok);
    if (turnThinkingPct) turnThinkingPct.textContent = pctStr(thinkTok, outSum);
    turnResponseVal.textContent = formatNum(respTok);
    if (turnResponsePct) turnResponsePct.textContent = pctStr(respTok, outSum);

    const tcSummary = filteredModel
      ? (data.toolCalls?.byModel?.[filteredModel.displayName] || { totalCalls: 0, tools: [] })
      : (data.toolCalls || { totalCalls: 0, tools: [] });
    renderToolCallsTree(tcSummary);

    // Cumulative Session Statistics
    const sessTotal = cum.totalProcessedTokens || 0;
    const sessCache = cum.cacheReadTokens || 0;
    const sessInput = cum.inputTokens || 0;
    const sessThink = cum.thinkingTokens || 0;
    const sessResp = cum.responseTokens || Math.max(0, (cum.outputTokens || 0) - sessThink);

    sessionProcessedVal.textContent = formatCompactNum(sessTotal);
    sessionProcessedVal.title = `${formatNum(sessTotal)} total processed tokens`;
    totalTurnsBadge.textContent = `${cum.totalTurns || 0} turns`;
    sessionCacheSavingsVal.textContent = `${cum.overallCacheSavingsPct || 0}% cached`;

    if (sessionCacheTotal) sessionCacheTotal.textContent = formatNum(sessCache);
    if (sessionCachePct) sessionCachePct.textContent = pctStr(sessCache, sessTotal);

    // Prompt cache rate: cacheRead / (input + cacheRead)
    const promptInputTokens = sessInput + sessCache;
    const promptCacheRatioNum = promptInputTokens > 0 ? (sessCache / promptInputTokens) * 100 : 0;
    const sessCachePctNum = sessTotal > 0 ? (sessCache / sessTotal) * 100 : 0;
    const diffPct = Math.abs(promptCacheRatioNum - sessCachePctNum);

    if (sessionPromptCacheRow) {
      // If the prompt cache rate differs by at least 0.1% from the session processed cache %, show it under Cache Read
      if (diffPct >= 0.1 && promptInputTokens > 0) {
        sessionPromptCacheRow.classList.remove('hidden');
        if (sessionPromptCacheRatio) {
          sessionPromptCacheRatio.textContent = `${formatNum(sessCache)} / ${formatNum(promptInputTokens)}`;
        }
        if (sessionPromptCachePct) {
          sessionPromptCachePct.textContent = `${promptCacheRatioNum.toFixed(1)}%`;
        }
      } else {
        sessionPromptCacheRow.classList.add('hidden');
      }
    }

    sessionInputTotal.textContent = formatNum(sessInput);
    if (sessionInputPct) sessionInputPct.textContent = pctStr(sessInput, sessTotal);
    sessionThinkingTotal.textContent = formatNum(sessThink);
    if (sessionThinkingPct) sessionThinkingPct.textContent = pctStr(sessThink, sessTotal);
    sessionOutputTotal.textContent = formatNum(sessResp);
    if (sessionOutputPct) sessionOutputPct.textContent = pctStr(sessResp, sessTotal);

    // Telemetry List & Coding HUD
    updateToggleButtons();
    renderTelemetryList();
    renderCodingHud();
  }

  // ---------- Coding HUD Mode (2×2 KPI Sparkline Grid + 4-Cell Stat Strip) ----------
  function formatCompactClean(num) {
    const val = Number(num) || 0;
    if (Math.abs(val) >= 1_000_000) {
      return (val / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M';
    }
    if (Math.abs(val) >= 100_000) {
      return Math.round(val / 1_000) + 'K';
    }
    if (Math.abs(val) >= 10_000) {
      return (val / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
    }
    if (Math.abs(val) >= 1_000) {
      return (val / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
    }
    return Math.round(val).toLocaleString();
  }

  // Always format in thousands (K) for the Context Window HUD card (e.g. 168.5K, 1,048.6K)
  function formatThousandsK(tokens, signed = false) {
    const val = Number(tokens) || 0;
    const sign = signed && val > 0 ? '+' : (val < 0 ? '-' : '');
    const k = Math.abs(val) / 1_000;
    if (k === 0) return '0K';
    if (k >= 1000) {
      return `${sign}${Math.round(k).toLocaleString()}K`;
    }
    const str = k >= 10 ? k.toFixed(1).replace(/\.0$/, '') : k.toFixed(1);
    return `${sign}${str}K`;
  }

  function formatTtlBoundShort(ms) {
    if (ms == null || ms < 0) return '—';
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const mins = Math.floor(sec / 60);
    const remSec = sec % 60;
    if (mins >= 4 && remSec < 15) return `${mins}m`;
    if (mins >= 4 && remSec > 45) return `${mins + 1}m`;
    return remSec > 0 ? `${mins}m ${remSec}s` : `${mins}m`;
  }

  function updateCompactAlarmUi(activeTokens = null, maxLimitTokens = null) {
    const actTok = activeTokens != null
      ? activeTokens
      : (currentTelemetry?.liveContext?.activeTokens || 0);
    const maxTok = maxLimitTokens != null
      ? maxLimitTokens
      : (currentTelemetry?.liveContext?.maxLimit || 1048576);
    const actK = actTok / 1000;
    const isOff = !compactAlarmK || compactAlarmK <= 0;
    const isTriggered = !isOff && actK >= compactAlarmK;
    const cleanK = Number.isInteger(compactAlarmK) ? String(compactAlarmK) : compactAlarmK.toFixed(1);
    const label = '_>';
    const title = isOff
      ? 'Compact alarm: Off (click to set K)'
      : (isTriggered
          ? `Compact alarm reached: ${cleanK}K (click to set K)`
          : `Compact alarm: ${cleanK}K (click to set K)`);

    [windowCompactAlarmBtn, hudCompactAlarmBtn].forEach((btn) => {
      if (!btn) return;
      btn.textContent = label;
      btn.title = title;
      btn.classList.toggle('triggered', isTriggered);
      btn.classList.toggle('off', isOff);
    });

    if (contextAlarmTick) {
      const tickPct = (!isOff && maxTok > 0) ? Math.min(100, Math.max(0, ((compactAlarmK * 1000) / maxTok) * 100)) : 0;
      if (isOff || tickPct <= 0 || tickPct >= 100) {
        contextAlarmTick.style.display = 'none';
      } else {
        contextAlarmTick.style.display = '';
        contextAlarmTick.style.left = `${tickPct.toFixed(1)}%`;
        contextAlarmTick.classList.toggle('triggered', isTriggered);
        contextAlarmTick.title = `Compact alarm threshold: ${cleanK}K tokens`;
      }
    }

    if (compactAlarmKInput && document.activeElement !== compactAlarmKInput) {
      compactAlarmKInput.value = isOff ? '' : String(compactAlarmK);
    }
    if (compactAlarmOffBtn) {
      compactAlarmOffBtn.classList.toggle('active', isOff);
    }
  }

  function setCompactAlarmK(nextValK) {
    const parsed = parseFloat(nextValK);
    compactAlarmK = (isFinite(parsed) && parsed > 0) ? Math.min(10000, Math.round(parsed * 10) / 10) : 0;
    try {
      localStorage.setItem('token_meter_compact_alarm_k', String(compactAlarmK));
    } catch {}
    updateCompactAlarmUi();
    if (currentTelemetry) renderCodingHud();
  }

  function openInlineAlarmEditor(btnEl, inputEl, e) {
    if (e) e.stopPropagation();
    if (!btnEl || !inputEl) return;
    btnEl.classList.add('hidden');
    inputEl.classList.remove('hidden');
    inputEl.value = compactAlarmK > 0 ? String(compactAlarmK) : '';
    inputEl.focus();
    inputEl.select();
  }

  function bindInlineAlarmInput(btnEl, inputEl) {
    if (!btnEl || !inputEl) return;
    btnEl.addEventListener('click', (e) => openInlineAlarmEditor(btnEl, inputEl, e));
    const commit = () => {
      if (inputEl.classList.contains('hidden')) return;
      const raw = inputEl.value.trim();
      setCompactAlarmK(raw === '' ? 0 : parseFloat(raw));
      inputEl.classList.add('hidden');
      btnEl.classList.remove('hidden');
    };
    inputEl.addEventListener('click', (e) => e.stopPropagation());
    inputEl.addEventListener('blur', commit);
    inputEl.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        inputEl.classList.add('hidden');
        btnEl.classList.remove('hidden');
      }
    });
  }

  function buildAreaSparklineSvg(values, colorVar, uid, minVal = null, maxVal = null, alarmThresholdVal = null) {
    const W = 180;
    const H = 38;
    const topY = 5;
    const botY = 34;
    let pts = Array.isArray(values) && values.length > 0 ? values.map(v => Number(v) || 0) : [0, 0];
    if (pts.length === 1) pts = [pts[0], pts[0]];

    const lo = minVal != null ? minVal : Math.min(...pts);
    const hi = maxVal != null ? maxVal : Math.max(...pts, lo + 1);
    const span = Math.max(1e-6, hi - lo);

    const coords = pts.map((v, idx) => {
      const x = (idx / (pts.length - 1)) * W;
      const norm = Math.min(1, Math.max(0, (v - lo) / span));
      const y = botY - norm * (botY - topY);
      return [Number(x.toFixed(1)), Number(y.toFixed(1))];
    });

    // Build smooth cubic bezier path
    let d = `M ${coords[0][0]} ${coords[0][1]}`;
    for (let i = 0; i < coords.length - 1; i++) {
      const [x0, y0] = coords[i];
      const [x1, y1] = coords[i + 1];
      const cx = Number(((x0 + x1) / 2).toFixed(1));
      d += ` C ${cx} ${y0}, ${cx} ${y1}, ${x1} ${y1}`;
    }
    const areaD = `${d} L ${W} ${H} L 0 ${H} Z`;

    let alarmLineHtml = '';
    if (alarmThresholdVal != null && alarmThresholdVal > lo && alarmThresholdVal <= hi) {
      const alarmNorm = Math.min(1, Math.max(0, (alarmThresholdVal - lo) / span));
      const alarmY = Number((botY - alarmNorm * (botY - topY)).toFixed(1));
      alarmLineHtml = `<line x1="0" y1="${alarmY}" x2="${W}" y2="${alarmY}" stroke="var(--tm-warn)" stroke-opacity="0.45" stroke-width="1" stroke-dasharray="3 3"/>`;
    }

    return `
      <svg class="hud-spark-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="${uid}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${colorVar}" stop-opacity="0.28"/>
            <stop offset="100%" stop-color="${colorVar}" stop-opacity="0.0"/>
          </linearGradient>
        </defs>
        ${alarmLineHtml}
        <path d="${areaD}" fill="url(#${uid})"/>
        <path d="${d}" fill="none" stroke="${colorVar}" stroke-width="1.75" stroke-linecap="round"/>
      </svg>
    `;
  }

  function buildTtlDecaySvg(ratioRemaining, stateClass) {
    const W = 180;
    const H = 38;
    const r = Math.min(1, Math.max(0, Number(ratioRemaining) || 0));
    const colorMap = {
      warm: 'var(--tm-ok)',
      expiring: 'var(--tm-warn)',
      cold: 'var(--tm-crit)',
      learning: 'var(--cx-primary)'
    };
    const strokeColor = colorMap[stateClass] || 'var(--tm-ok)';

    // Smooth decay S-curve from (0, 6) down to (180, 34)
    const steps = 24;
    const allPts = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps; // 0 -> 1 elapsed
      const x = Number((t * W).toFixed(1));
      // Smooth cosine decay curve
      const rem = 0.5 * (1 + Math.cos(Math.PI * t));
      const y = Number((34 - rem * 28).toFixed(1));
      allPts.push([x, y, 1 - t]);
    }

    const buildPath = (pts) => {
      if (!pts.length) return '';
      let p = `M ${pts[0][0]} ${pts[0][1]}`;
      for (let i = 1; i < pts.length; i++) {
        p += ` L ${pts[i][0]} ${pts[i][1]}`;
      }
      return p;
    };

    const fullPath = buildPath(allPts);
    // Active filled portion from current elapsed position (1 - r) to end (1.0)
    const elapsedFrac = 1 - r;
    const activeIdx = Math.min(steps, Math.max(0, Math.round(elapsedFrac * steps)));
    const remPts = allPts.slice(activeIdx);
    const remPath = buildPath(remPts);
    const startX = remPts[0]?.[0] ?? W;
    const startY = remPts[0]?.[1] ?? 34;
    const remArea = remPts.length > 1 ? `${remPath} L ${W} ${H} L ${startX} ${H} Z` : '';

    return `
      <svg class="hud-spark-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="hudTtlGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${strokeColor}" stop-opacity="0.28"/>
            <stop offset="100%" stop-color="${strokeColor}" stop-opacity="0.0"/>
          </linearGradient>
        </defs>
        <path d="${fullPath}" fill="none" stroke="var(--cx-border)" stroke-width="1.25" stroke-dasharray="3 3"/>
        ${remArea ? `<path d="${remArea}" fill="url(#hudTtlGrad)"/>` : ''}
        ${remPath ? `<path d="${remPath}" fill="none" stroke="${strokeColor}" stroke-width="1.85" stroke-linecap="round"/>` : ''}
        <circle cx="${startX}" cy="${startY}" r="2.8" fill="${strokeColor}"/>
      </svg>
    `;
  }

  function formatSecShort(sec) {
    if (sec == null || !isFinite(sec) || sec < 0) return '—';
    if (sec < 100) return `${sec.toFixed(1)}s`;
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}m ${s}s`;
  }

  function renderHudTtlLive() {
    const hudTtlValue = document.getElementById('hudTtlValue');
    const hudTtlBadge = document.getElementById('hudTtlBadge');
    const hudTtlMeta = document.getElementById('hudTtlMeta');
    const hudTtlSpark = document.getElementById('hudTtlSpark');
    if (!hudTtlValue || !currentTelemetry) return;

    const cl = currentTelemetry.cacheLifespan || {};
    const modelKey = selectedModel !== 'all' ? selectedModel : cl.warmModelDisplayName;
    const modelStat = modelKey ? cl.byModel?.[modelKey] : null;
    const stat = (modelStat && modelStat.sampleCount > 0) ? modelStat : cl.overall;

    const lastCompletedMs = selectedModel !== 'all'
      ? (currentTelemetry.modelStats?.[selectedModel]?.latestTurn?.completedAtMs || cl.lastChatCompletedAtMs)
      : cl.lastChatCompletedAtMs;
    const elapsedMs = lastCompletedMs ? Math.max(0, Date.now() - lastCompletedMs) : null;

    const DEFAULT_PROVIDER_TTL_MS = 5 * 60 * 1000; // standard 5m prompt cache window
    let valText = '—';
    let badgeText = 'Idle';
    let badgeCls = 'neutral';
    let metaText = 'No samples yet';
    let ratio = 1;
    let curveState = 'learning';

    if (!stat || stat.status === 'no_data') {
      if (elapsedMs != null && elapsedMs < DEFAULT_PROVIDER_TTL_MS) {
        valText = `~${formatDurationShort(DEFAULT_PROVIDER_TTL_MS - elapsedMs)}`;
        const hadCache = Boolean(currentTelemetry.latestTurn?.cacheReadTokens > 0);
        badgeText = hadCache ? 'Warm' : 'Est 5m';
        badgeCls = hadCache ? 'up' : 'neutral';
        metaText = `idle ${formatDurationShort(elapsedMs)} · ~5m est`;
        ratio = Math.max(0.05, 1 - elapsedMs / DEFAULT_PROVIDER_TTL_MS);
        curveState = hadCache ? 'warm' : 'learning';
      } else {
        valText = elapsedMs != null ? 'Expired' : '—';
        badgeText = elapsedMs != null ? 'Cold' : 'Idle';
        badgeCls = elapsedMs != null ? 'down' : 'neutral';
        metaText = elapsedMs != null ? `idle ${formatDurationShort(elapsedMs)}` : 'waiting for turns';
        ratio = elapsedMs != null ? 0 : 1;
        curveState = elapsedMs != null ? 'cold' : 'learning';
      }
    } else if (stat.status === 'bracketed') {
      const boundText = `~${formatTtlBoundShort(stat.maxWarmGapMs)}–${formatTtlBoundShort(stat.minColdGapMs)}`;
      metaText = boundText;
      const ceilMs = stat.minColdGapMs;
      ratio = elapsedMs != null && ceilMs > 0 ? Math.max(0, Math.min(1, 1 - elapsedMs / ceilMs)) : 1;

      if (elapsedMs == null) {
        valText = boundText;
        badgeText = 'Ready';
        badgeCls = 'neutral';
        curveState = 'warm';
      } else if (elapsedMs < stat.maxWarmGapMs) {
        valText = formatDurationShort(stat.maxWarmGapMs - elapsedMs);
        badgeText = 'Warm';
        badgeCls = 'up';
        curveState = 'warm';
      } else if (elapsedMs < stat.minColdGapMs) {
        valText = `≤ ${formatDurationShort(stat.minColdGapMs - elapsedMs)}`;
        badgeText = 'Expiring';
        badgeCls = 'warn';
        curveState = 'expiring';
      } else {
        valText = 'Expired';
        badgeText = 'Cold';
        badgeCls = 'down';
        metaText = `idle ${formatDurationShort(elapsedMs)} · ${boundText}`;
        ratio = 0;
        curveState = 'cold';
      }
    } else if (stat.status === 'lower_bound') {
      // Only warm hits observed so far: use max(5m standard TTL, maxWarmGapMs) as estimated ceiling
      const estCeilMs = Math.max(DEFAULT_PROVIDER_TTL_MS, stat.maxWarmGapMs);
      const provenText = `proven ≥${formatTtlBoundShort(stat.maxWarmGapMs)}`;
      ratio = elapsedMs != null && estCeilMs > 0 ? Math.max(0, Math.min(1, 1 - elapsedMs / estCeilMs)) : 1;

      if (elapsedMs == null) {
        valText = `≥${formatTtlBoundShort(stat.maxWarmGapMs)}`;
        badgeText = 'Ready';
        badgeCls = 'neutral';
        metaText = provenText;
        curveState = 'warm';
      } else if (elapsedMs < stat.maxWarmGapMs) {
        valText = `~${formatDurationShort(estCeilMs - elapsedMs)}`;
        badgeText = 'Warm';
        badgeCls = 'up';
        metaText = provenText;
        curveState = 'warm';
      } else if (elapsedMs < estCeilMs) {
        valText = `~${formatDurationShort(estCeilMs - elapsedMs)}`;
        badgeText = 'Warm';
        badgeCls = 'up';
        metaText = `${provenText} · ~5m est`;
        curveState = ratio < 0.25 ? 'expiring' : 'warm';
      } else {
        valText = `${formatDurationShort(elapsedMs)}`;
        badgeText = 'Expiring';
        badgeCls = 'warn';
        metaText = `idle · ${provenText}`;
        ratio = 0.05;
        curveState = 'expiring';
      }
    } else {
      // upper_bound only
      const ceilMs = stat.minColdGapMs || DEFAULT_PROVIDER_TTL_MS;
      metaText = `<${formatTtlBoundShort(ceilMs)} window`;
      ratio = elapsedMs != null && ceilMs > 0 ? Math.max(0, Math.min(1, 1 - elapsedMs / ceilMs)) : 1;
      if (elapsedMs != null && elapsedMs < ceilMs) {
        valText = `≤ ${formatDurationShort(ceilMs - elapsedMs)}`;
        badgeText = ratio < 0.25 ? 'Expiring' : 'Warm';
        badgeCls = ratio < 0.25 ? 'warn' : 'up';
        curveState = ratio < 0.25 ? 'expiring' : 'warm';
      } else {
        valText = 'Expired';
        badgeText = 'Cold';
        badgeCls = 'down';
        ratio = 0;
        curveState = 'cold';
      }
    }

    hudTtlValue.textContent = valText;
    if (hudTtlBadge) {
      hudTtlBadge.textContent = badgeText;
      hudTtlBadge.className = `hud-delta-pill ${badgeCls}`;
    }
    if (hudTtlMeta) hudTtlMeta.textContent = metaText;
    if (hudTtlSpark) hudTtlSpark.innerHTML = buildTtlDecaySvg(ratio, curveState);
  }

  function renderCodingHud() {
    if (!codingHudPane || !currentTelemetry) return;
    renderHudTtlLive();

    const data = currentTelemetry;
    const ctx = data.liveContext || {};
    const allTurns = data.turns || [];
    const relevantTurns = selectedModel !== 'all'
      ? allTurns.filter(t => t.modelDisplayName === selectedModel)
      : allTurns;
    const filteredModel = selectedModel !== 'all' ? data.modelStats?.[selectedModel] : null;
    const latest = filteredModel?.latestTurn || data.latestTurn || {};
    const cum = filteredModel
      ? {
          totalTurns: filteredModel.turnsCount,
          overallCacheSavingsPct: filteredModel.cacheEfficiencyPct
        }
      : (data.cumulative || {});
    const model = filteredModel || data.activeModel || {};

    // 0. Subtle Running Model Line at the top of Coding HUD
    const hudModelDot = document.getElementById('hudModelDot');
    const hudModelName = document.getElementById('hudModelName');
    const hudModelMeta = document.getElementById('hudModelMeta');
    const runningModelName = filteredModel?.displayName || latest.modelDisplayName || model.displayName || 'Default Model';
    if (hudModelDot) {
      hudModelDot.className = `hud-model-dot brand-${brandOf(runningModelName)}`;
    }
    if (hudModelName) {
      hudModelName.textContent = runningModelName;
      hudModelName.title = (!filteredModel && data.isMultiModel && data.sessionModels?.length > 1)
        ? `Running model: ${runningModelName}\nSession models (${data.sessionModels.length}): ${data.sessionModels.join(', ')}`
        : `Running model: ${runningModelName}`;
    }
    if (hudModelMeta) {
      hudModelMeta.textContent = latest.turnNumber ? `Turn #${latest.turnNumber}` : `${cum.totalTurns || 0} turns`;
    }

    // 2. Cache Hit Rate Card (latest + warm min · avg + sparkline without compaction cliffs)
    const hudCacheValue = document.getElementById('hudCacheValue');
    const hudCacheDelta = document.getElementById('hudCacheDelta');
    const hudCacheMeta = document.getElementById('hudCacheMeta');
    const hudCacheSpark = document.getElementById('hudCacheSpark');

    const rawCacheSeries = relevantTurns.map(t => parseFloat(t.cacheEfficiencyPct) || 0);
    // Warm turns exclude initial cold turn #1, compaction reset turns, and cold misses
    const warmTurns = relevantTurns.filter((t, idx) =>
      idx > 0 && !t.isCompaction && t.cacheStatus !== 'cold_miss' && t.cacheStatus !== 'model_switch_miss' && (parseFloat(t.cacheEfficiencyPct) || 0) > 25
    );
    const warmPcts = warmTurns.map(t => parseFloat(t.cacheEfficiencyPct) || 0);
    const latestCache = rawCacheSeries.length ? rawCacheSeries[rawCacheSeries.length - 1] : (parseFloat(latest.cacheEfficiencyPct) || 0);
    const prevCache = warmPcts.length > 1 ? warmPcts[warmPcts.length - 2] : (rawCacheSeries.length > 1 ? rawCacheSeries[rawCacheSeries.length - 2] : latestCache);
    const cacheDiff = latestCache - prevCache;
    const minCache = warmPcts.length ? Math.min(...warmPcts) : (rawCacheSeries.length ? Math.min(...rawCacheSeries) : 0);
    const avgCache = warmPcts.length
      ? (warmPcts.reduce((a, b) => a + b, 0) / warmPcts.length)
      : (parseFloat(cum.overallCacheSavingsPct) || 0);
    const sparkSeries = warmPcts.length >= 2 ? warmPcts.slice(-18) : rawCacheSeries.slice(-18);

    if (hudCacheValue) hudCacheValue.textContent = `${latestCache.toFixed(1)}%`;
    if (hudCacheDelta) {
      if (warmPcts.length > 1 && Math.abs(cacheDiff) >= 0.1 && !latest.isCompaction) {
        const up = cacheDiff >= 0;
        hudCacheDelta.textContent = `${up ? '↑' : '↓'} ${Math.abs(cacheDiff).toFixed(1)}%`;
        hudCacheDelta.className = `hud-delta-pill ${up ? 'up' : 'warn'}`;
      } else {
        hudCacheDelta.textContent = latestCache >= 80 ? 'High' : (latestCache >= 50 ? 'Mid' : 'Cold');
        hudCacheDelta.className = `hud-delta-pill ${latestCache >= 80 ? 'up' : (latestCache >= 50 ? 'warn' : 'down')}`;
      }
    }
    if (hudCacheMeta) {
      hudCacheMeta.textContent = `min ${minCache.toFixed(1)}% · avg ${avgCache.toFixed(1)}%`;
    }
    if (hudCacheSpark) {
      const loBound = sparkSeries.length ? Math.max(0, Math.min(...sparkSeries) - 10) : 0;
      hudCacheSpark.innerHTML = buildAreaSparklineSvg(sparkSeries, 'var(--tm-cache)', 'hudCacheGrad', loBound, 100);
    }

    // 3. Context Window Card (displayed in thousands K + manual K compact alarm)
    const hudContextValue = document.getElementById('hudContextValue');
    const hudContextDelta = document.getElementById('hudContextDelta');
    const hudContextMeta = document.getElementById('hudContextMeta');
    const hudContextSpark = document.getElementById('hudContextSpark');

    const activeTok = filteredModel ? (latest.totalTurnTokens || 0) : (ctx.activeTokens || 0);
    const maxLim = model.maxContextTokens || ctx.maxLimit || 1048576;
    const ctxPct = Math.min(100, Math.max(0, maxLim > 0 ? (activeTok / maxLim) * 100 : 0));
    const remTok = Math.max(0, maxLim - activeTok);
    const activeK = activeTok / 1000;
    const ctxSeriesK = relevantTurns.map(t => (t.totalTurnTokens || 0) / 1000);
    const prevK = ctxSeriesK.length > 1 ? ctxSeriesK[ctxSeriesK.length - 2] : activeK;
    const diffTok = activeTok - (prevK * 1000);
    const alarmTriggered = compactAlarmK > 0 && activeK >= compactAlarmK;
    const ctxColor = ctxPct >= 80 ? 'var(--tm-crit)' : ((ctxPct >= 50 || alarmTriggered) ? 'var(--tm-warn)' : 'var(--cx-primary)');

    updateCompactAlarmUi(activeTok, maxLim);

    if (hudContextValue) {
      hudContextValue.textContent = formatThousandsK(activeTok);
      hudContextValue.title = `${formatNum(activeTok)} / ${formatNum(maxLim)} tokens (${ctxPct.toFixed(1)}% used)`;
    }
    if (hudContextDelta) {
      if (ctxSeriesK.length > 1 && Math.abs(diffTok) >= 100) {
        hudContextDelta.textContent = formatThousandsK(diffTok, true);
        hudContextDelta.className = `hud-delta-pill ${ctxPct >= 80 ? 'down' : ((ctxPct >= 50 || alarmTriggered) ? 'warn' : (diffTok < 0 ? 'up' : 'neutral'))}`;
      } else {
        hudContextDelta.textContent = alarmTriggered ? 'Compact' : (ctxPct >= 80 ? 'Critical' : (ctxPct >= 50 ? 'Moderate' : 'Optimal'));
        hudContextDelta.className = `hud-delta-pill ${ctxPct >= 80 ? 'down' : ((ctxPct >= 50 || alarmTriggered) ? 'warn' : 'up')}`;
      }
    }
    if (hudContextMeta) {
      hudContextMeta.textContent = `of ${formatCompactClean(maxLim)} · ${formatCompactClean(remTok)} free`;
    }
    if (hudContextSpark) {
      const ceilK = Math.max(100, compactAlarmK > 0 ? compactAlarmK * 1.15 : 100, ...ctxSeriesK, activeK);
      hudContextSpark.innerHTML = buildAreaSparklineSvg(
        ctxSeriesK.slice(-18),
        ctxColor,
        'hudCtxGrad',
        0,
        ceilK,
        compactAlarmK > 0 ? compactAlarmK : null
      );
    }

    // 4. Quota Remaining Card (strictly match active model's actual pool so Argon doesn't pick Claude's 5h pool!)
    const hudQuotaValue = document.getElementById('hudQuotaValue');
    const hudQuotaWeeklyBadge = document.getElementById('hudQuotaWeeklyBadge');
    const hudQuotaMeta = document.getElementById('hudQuotaMeta');
    const hudQuotaSpark = document.getElementById('hudQuotaSpark');

    const activeModelName = filteredModel?.displayName || latest.modelDisplayName || model.displayName || '';
    const pools = globalUsageData?.quotaPools || [];
    const lowerMod = activeModelName.toLowerCase();
    const poolMatchesActiveModel = (p) => {
      if (!lowerMod) return false;
      return (p.models || []).some(m => m.toLowerCase() === lowerMod || m.toLowerCase().includes(lowerMod)) ||
             (p.correlation?.byModel || []).some(m => m.model.toLowerCase() === lowerMod || m.model.toLowerCase().includes(lowerMod));
    };

    const matched5h = pools.find(p => (p.windowType === 'weekly' ? 'weekly' : '5h') === '5h' && poolMatchesActiveModel(p)) || null;
    const matchedWk = pools.find(p => p.windowType === 'weekly' && poolMatchesActiveModel(p)) || null;
    const activeBrand = brandOf(activeModelName);
    const brandFallbackPool = (!matched5h && !matchedWk)
      ? (pools.find(p => (p.models || []).some(m => brandOf(m) === activeBrand)) || pools[0] || null)
      : null;

    const primaryPool = matched5h || matchedWk || brandFallbackPool;

    if (primaryPool) {
      const remPct = Math.max(0, Math.min(100, primaryPool.remainingPct ?? (100 - (primaryPool.usedPct || 0))));
      const isWeeklyPrimary = primaryPool.windowType === 'weekly';
      if (hudQuotaValue) hudQuotaValue.textContent = `${remPct.toFixed(1)}%`;
      if (hudQuotaWeeklyBadge) {
        if (!isWeeklyPrimary && matchedWk) {
          const wkRem = Math.max(0, Math.min(100, matchedWk.remainingPct ?? (100 - (matchedWk.usedPct || 0))));
          hudQuotaWeeklyBadge.textContent = `Wk ${wkRem.toFixed(0)}%`;
          hudQuotaWeeklyBadge.className = `hud-delta-pill ${wkRem <= 20 ? 'down' : (wkRem <= 50 ? 'warn' : 'up')}`;
        } else {
          hudQuotaWeeklyBadge.textContent = isWeeklyPrimary ? 'Weekly' : '5h pool';
          hudQuotaWeeklyBadge.className = `hud-delta-pill ${remPct <= 20 ? 'down' : (remPct <= 50 ? 'warn' : 'up')}`;
        }
      }
      if (hudQuotaMeta) {
        const resetTxt = primaryPool.resetTime ? `Resets ${formatCountdown(primaryPool.msUntilReset)}` : primaryPool.label;
        hudQuotaMeta.textContent = resetTxt;
        hudQuotaMeta.title = `${primaryPool.label}: ${remPct.toFixed(1)}% remaining`;
      }
      if (hudQuotaSpark) {
        const qState = remPct <= 20 ? 'cold' : (remPct <= 50 ? 'expiring' : 'warm');
        hudQuotaSpark.innerHTML = buildTtlDecaySvg(remPct / 100, qState);
      }
    } else {
      if (hudQuotaValue) hudQuotaValue.textContent = '—';
      if (hudQuotaWeeklyBadge) {
        hudQuotaWeeklyBadge.textContent = 'Pool —';
        hudQuotaWeeklyBadge.className = 'hud-delta-pill neutral';
      }
      if (hudQuotaMeta) hudQuotaMeta.textContent = 'No pool data';
      if (hudQuotaSpark) hudQuotaSpark.innerHTML = buildTtlDecaySvg(1, 'learning');
    }

    // Secondary 4-Cell Compact Stat Strip
    // Cell 1: Turn duration (latest + avg · max)
    const hudDurValue = document.getElementById('hudDurValue');
    const hudDurSub = document.getElementById('hudDurSub');
    const durs = relevantTurns
      .map(t => (t.completedAtMs && t.createdAtMs && t.completedAtMs >= t.createdAtMs) ? (t.completedAtMs - t.createdAtMs) / 1000 : null)
      .filter(v => v != null && v >= 0.05 && v < 1800);
    const latestDur = durs.length ? durs[durs.length - 1] : null;
    const avgDur = durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : null;
    const maxDur = durs.length ? Math.max(...durs) : null;
    if (hudDurValue) hudDurValue.textContent = formatSecShort(latestDur);
    if (hudDurSub) hudDurSub.textContent = `avg ${formatSecShort(avgDur)} · max ${formatSecShort(maxDur)}`;

    // Cell 2: New input / turn (latest + min · avg)
    const hudInValue = document.getElementById('hudInValue');
    const hudInSub = document.getElementById('hudInSub');
    const inSeries = relevantTurns.map(t => t.inputTokens || 0).filter(v => v > 0);
    const latestIn = latest.inputTokens || (inSeries.length ? inSeries[inSeries.length - 1] : 0);
    const minIn = inSeries.length ? Math.min(...inSeries) : 0;
    const avgIn = inSeries.length ? Math.round(inSeries.reduce((a, b) => a + b, 0) / inSeries.length) : 0;
    if (hudInValue) hudInValue.textContent = formatCompactClean(latestIn);
    if (hudInSub) hudInSub.textContent = `min ${formatCompactClean(minIn)} · avg ${formatCompactClean(avgIn)}`;

    // Cell 3: Output / turn (latest + think · avg)
    const hudOutValue = document.getElementById('hudOutValue');
    const hudOutSub = document.getElementById('hudOutSub');
    const outSeries = relevantTurns.map(t => t.outputTokens || 0).filter(v => v > 0);
    const latestOut = latest.outputTokens || (outSeries.length ? outSeries[outSeries.length - 1] : 0);
    const latestThink = latest.thinkingTokens || 0;
    const avgOut = outSeries.length ? Math.round(outSeries.reduce((a, b) => a + b, 0) / outSeries.length) : 0;
    if (hudOutValue) hudOutValue.textContent = formatCompactClean(latestOut);
    if (hudOutSub) hudOutSub.textContent = `think ${formatCompactClean(latestThink)} · avg ${formatCompactClean(avgOut)}`;

    // Cell 4: Tool calls (total + unique tools · per-turn avg)
    const hudToolsValue = document.getElementById('hudToolsValue');
    const hudToolsSub = document.getElementById('hudToolsSub');
    const tcSummary = filteredModel
      ? (data.toolCalls?.byModel?.[filteredModel.displayName] || { totalCalls: 0, tools: [] })
      : (data.toolCalls || { totalCalls: 0, tools: [] });
    const totalCalls = tcSummary.totalCalls || 0;
    const uniqueTools = (tcSummary.tools || []).length;
    const turnsCount = relevantTurns.length || cum.totalTurns || 1;
    const callsPerTurn = (totalCalls / turnsCount).toFixed(1);
    if (hudToolsValue) hudToolsValue.textContent = formatNum(totalCalls);
    if (hudToolsSub) hudToolsSub.textContent = `${uniqueTools} tool${uniqueTools === 1 ? '' : 's'} · ${callsPerTurn}/turn`;
  }

  // ---------- 3-Level Tool Calls Drill-Down ----------
  function renderToolCallsTree(summary) {
    const total = summary?.totalCalls || 0;
    const tools = summary?.tools || [];
    if (toolCallsTotalVal) toolCallsTotalVal.textContent = formatNum(total);
    if (toolCallsTypesVal) toolCallsTypesVal.textContent = `${tools.length} tool${tools.length === 1 ? '' : 's'}`;

    if (toolCallsRootRow) {
      toolCallsRootRow.classList.toggle('expanded', toolTreeExpanded);
      toolCallsRootRow.setAttribute('aria-expanded', String(toolTreeExpanded));
    }
    if (!toolCallsTree) return;
    toolCallsTree.classList.toggle('hidden', !toolTreeExpanded);
    if (!toolTreeExpanded) return;

    if (!tools.length) {
      toolCallsTree.innerHTML = `<div class="tool-target-row">No tool calls recorded</div>`;
      return;
    }

    toolCallsTree.innerHTML = tools.map(tool => {
      const isOpen = expandedToolNames.has(tool.name);
      const targetsHtml = (tool.targets || []).map(tg => `
        <div class="tool-target-row" title="${escapeHtml(tg.label)}">
          <span class="tool-target-label">${escapeHtml(tg.label)}</span>
          <span class="tool-target-count">${formatNum(tg.count)}</span>
        </div>
      `).join('');

      return `
        <div class="tool-node${isOpen ? ' expanded' : ''}" data-tool-name="${escapeHtml(tool.name)}">
          <div class="tool-node-row" role="button" tabindex="0" aria-expanded="${isOpen}" title="Click to show specific targets for ${escapeHtml(tool.name)}">
            <span class="tool-node-name">
              <svg class="tree-chev" width="11" height="11" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>
              <span>${escapeHtml(tool.name)}</span>
            </span>
            <span class="tool-node-count">${formatNum(tool.count)}</span>
          </div>
          <div class="tool-targets-list">${targetsHtml}</div>
        </div>
      `;
    }).join('');
  }

  // ---------- Agents Tab Rendering ----------
  function renderAgentsList() {
    const subs = mainSubagents || [];
    if (agentsCountBadge) {
      agentsCountBadge.textContent = String(subs.length);
      agentsCountBadge.classList.toggle('hidden', subs.length === 0);
    }
    if (agentsSummaryMeta) {
      agentsSummaryMeta.textContent = `${subs.length} agent${subs.length === 1 ? '' : 's'}`;
    }
    if (!agentsList) return;
    if (!subs.length) {
      agentsList.innerHTML = `<div class="empty-state">No subagents spawned in this conversation yet.</div>`;
      return;
    }

    agentsList.innerHTML = subs.map((s) => {
      const shortId = s.conversationId ? s.conversationId.slice(0, 8) : 'pending';
      const clickable = Boolean(s.conversationId);
      return `
        <div class="agent-item" data-agent-id="${escapeHtml(s.conversationId || '')}" data-agent-role="${escapeHtml(s.role || s.typeName)}" role="button" tabindex="0" title="${clickable ? 'Click to inspect subagent telemetry' : 'No conversation ID available'}">
          <div class="agent-item-top">
            <span class="agent-role">${escapeHtml(s.role || s.typeName)}</span>
            <span class="routing-pill ${getModelPillClass(s.modelDisplayName)}">${escapeHtml(s.modelDisplayName || s.requestedModel || 'inherit')}</span>
          </div>
          <div class="agent-meta">
            <span>${escapeHtml(s.typeName)} · ${escapeHtml(shortId)} · ${s.totalTurns || 0} turns</span>
            <span>${formatCompactNum(s.totalProcessedTokens || 0)} tok</span>
          </div>
        </div>
      `;
    }).join('');
  }

  function formatDurationShort(ms) {
    if (ms == null || ms < 0) return '—';
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const mins = Math.floor(sec / 60);
    const remSec = sec % 60;
    if (mins < 60) return remSec > 0 ? `${mins}m ${remSec}s` : `${mins}m`;
    const hrs = Math.floor(mins / 60);
    const remMin = mins % 60;
    return remMin > 0 ? `${hrs}h ${remMin}m` : `${hrs}h`;
  }

  function formatCacheStatusLine(gapMs, status, modelShort, prevModelShort) {
    const gapPart = gapMs != null ? `${formatDurationShort(gapMs)} gap · ` : '';
    const mod = modelShort || 'Model';
    if (status === 'initial') return `Initial (${mod})`;
    if (status === 'warm_hit') return `${gapPart}Warm Hit (${mod})`;
    if (status === 'cross_model_hit') return `${gapPart}Warm Hit (${prevModelShort || '?'} → ${mod})`;
    if (status === 'model_switch_miss') return `${gapPart}Cold · Switch (${prevModelShort || '?'} → ${mod})`;
    if (status === 'cold_miss') return `${gapPart}Cold Miss (${mod})`;
    return `${gapPart}${mod}`;
  }

  function renderCacheStatusChips(gapMs, status, modelShort, prevModelShort) {
    const mod = escapeHtml(modelShort || 'Model');
    const prev = escapeHtml(prevModelShort || '?');
    const map = {
      initial:           { cls: 'initial', label: 'Initial',    sub: mod },
      warm_hit:          { cls: 'warm',    label: 'Warm Hit',   sub: mod },
      cross_model_hit:   { cls: 'warm',    label: 'Warm Hit',   sub: `${prev} → ${mod}` },
      model_switch_miss: { cls: 'switch',  label: 'Cold Switch', sub: `${prev} → ${mod}` },
      cold_miss:         { cls: 'cold',    label: 'Cold Miss',  sub: mod }
    };
    const m = map[status];
    const gap = gapMs != null ? `<span class="cache-chip gap" title="Time since previous request">${escapeHtml(formatDurationShort(gapMs))} gap</span>` : '';
    if (!m) return `<span class="cache-chips">${gap}<span class="cache-chip neutral">${mod}</span></span>`;
    return `<span class="cache-chips">${gap}<span class="cache-chip ${m.cls}" title="${m.sub}"><span class="cache-chip-dot"></span>${m.label}</span><span class="cache-chip-sub">${m.sub}</span></span>`;
  }
  function renderCacheLifespanStrip() {
    if (!currentTelemetry || !cacheLifespanStrip) return;
    const cl = currentTelemetry.cacheLifespan;
    if (!cl) return;

    const modelKey = selectedModel !== 'all' ? selectedModel : cl.warmModelDisplayName;
    const modelStat = modelKey ? cl.byModel?.[modelKey] : null;
    const stat = (modelStat && modelStat.sampleCount > 0) ? modelStat : cl.overall;

    const warmName = selectedModel !== 'all'
      ? (currentTelemetry.modelStats?.[selectedModel]?.shortName || selectedModel)
      : (cl.warmModelShortName || '—');

    if (warmModelPill) {
      warmModelPill.textContent = warmName;
      warmModelPill.className = `routing-pill ${getModelPillClass(warmName)}`;
      warmModelPill.title = `Warm cache model: ${modelKey || warmName}`;
    }

    const lastCompletedMs = selectedModel !== 'all'
      ? (currentTelemetry.modelStats?.[selectedModel]?.latestTurn?.completedAtMs || cl.lastChatCompletedAtMs)
      : cl.lastChatCompletedAtMs;
    const elapsedMs = lastCompletedMs ? Math.max(0, Date.now() - lastCompletedMs) : null;

    if (lastChatAgoVal) {
      lastChatAgoVal.textContent = elapsedMs != null ? `${formatDurationShort(elapsedMs)} ago` : '—';
    }

    if (!cacheLifespanStat) return;
    cacheLifespanStat.classList.remove('warm', 'expiring', 'cold');
    const ttlCountdownEl = document.getElementById('cacheTtlCountdown');
    const setCountdown = (txt, cls) => {
      if (!ttlCountdownEl) return;
      ttlCountdownEl.textContent = txt;
      ttlCountdownEl.className = 'ttl-countdown' + (cls ? ' ' + cls : '');
      ttlCountdownEl.style.display = txt ? '' : 'none';
    };
    setCountdown('');

    if (!stat || stat.status === 'no_data') {
      cacheLifespanStat.textContent = '—';
      cacheLifespanStat.title = 'No lifespan data yet. Waiting for same-model chat-to-chat gaps of 30s or more (ignores short bursts and tool loops).';
      renderHudTtlLive();
      return;
    }

    const parts = [];
    if (stat.maxWarmGapMs != null) parts.push(`Max warm gap: ${formatDurationShort(stat.maxWarmGapMs)}`);
    if (stat.minColdGapMs != null) parts.push(`Min cold gap: ${formatDurationShort(stat.minColdGapMs)}`);
    parts.push(`Chat-to-chat samples (≥30s): ${stat.sampleCount}`);
    if (stat.isPersisted) parts.push('Storage: Learned across chats (persisted in account store)');
    cacheLifespanStat.title = parts.join('\n');

    if (elapsedMs != null) {
      const fmt = (ms) => formatDurationShort(Math.max(0, ms));
      if (stat.maxWarmGapMs != null && elapsedMs < stat.maxWarmGapMs) {
        setCountdown(`${fmt(stat.maxWarmGapMs - elapsedMs)} left`, 'warm');
      } else if (stat.minColdGapMs != null && elapsedMs < stat.minColdGapMs) {
        setCountdown(`≤ ${fmt(stat.minColdGapMs - elapsedMs)} left`, 'expiring');
      } else if (stat.minColdGapMs != null) {
        setCountdown('expired', 'cold');
      }
    }

    const sampleTag = stat.isPersisted ? `${stat.sampleCount} across chats` : `${stat.sampleCount}`;

    if (stat.status === 'bracketed') {
      cacheLifespanStat.textContent = `~${formatDurationShort(stat.maxWarmGapMs)}–${formatDurationShort(stat.minColdGapMs)}`;
      if (elapsedMs != null) {
        if (elapsedMs >= stat.minColdGapMs) cacheLifespanStat.classList.add('cold');
        else if (elapsedMs >= stat.maxWarmGapMs) cacheLifespanStat.classList.add('expiring');
        else cacheLifespanStat.classList.add('warm');
      }
    } else if (stat.status === 'lower_bound') {
      cacheLifespanStat.textContent = `≥ ${formatDurationShort(stat.maxWarmGapMs)}`;
      if (elapsedMs != null && elapsedMs <= stat.maxWarmGapMs) {
        cacheLifespanStat.classList.add('warm');
      }
    } else if (stat.status === 'upper_bound') {
      cacheLifespanStat.textContent = `< ${formatDurationShort(stat.minColdGapMs)}`;
      if (elapsedMs != null && elapsedMs >= stat.minColdGapMs) {
        cacheLifespanStat.classList.add('cold');
      }
    }
    renderHudTtlLive();
  }

  function formatCountdown(ms) {
    const totalSec = Math.max(0, Math.floor((ms || 0) / 1000));
    const days = Math.floor(totalSec / 86400);
    const hrs = Math.floor((totalSec % 86400) / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    if (days > 0) return `${days}d ${hrs}h`;
    if (hrs > 0) return `${hrs}h ${mins}m`;
    return `${mins}m`;
  }

  const BRAND_NAMES = { claude: 'Claude', gpt: 'GPT', gemini: 'Gemini', argon: 'Argon', other: 'Other' };
  function brandOf(name) {
    const l = String(name || '').toLowerCase();
    if (/claude|opus|sonnet|haiku|anthropic/.test(l)) return 'claude';
    if (/gpt|openai|\bo[134]\b/.test(l)) return 'gpt';
    if (/argon|neon|orchestrator/.test(l)) return 'argon';
    if (/gemini|flash|pro\b/.test(l)) return 'gemini';
    return 'other';
  }
  function renderBrandChips(models) {
    const groups = new Map();
    for (const m of models || []) {
      const b = brandOf(m);
      if (!groups.has(b)) groups.set(b, []);
      groups.get(b).push(m);
    }
    return [...groups.entries()].map(([b, ms]) =>
      `<span class="brand-chip brand-${b}" title="${escapeHtml(ms.join('\n'))}"><i></i>${BRAND_NAMES[b]}</span>`
    ).join('');
  }

  function renderQuotaPoolsInto(containerEl, pools, filterModel) {
    if (!containerEl) return;
    let list = pools || [];
    const isFiltered = filterModel && filterModel !== 'all';
    if (isFiltered) {
      const lower = filterModel.toLowerCase();
      const matched = list.filter(p =>
        (p.models || []).some(m => m.toLowerCase().includes(lower)) ||
        (p.correlation?.byModel || []).some(m => m.model.toLowerCase().includes(lower))
      );
      if (matched.length) list = [...matched, ...list.filter(p => !matched.includes(p))];
    }

    if (!list.length) {
      containerEl.innerHTML = `<div class="empty-state">No quota pool data reported by Antigravity.</div>`;
      return;
    }

    const renderPool = (p) => {
      const used = Math.min(100, Math.max(0, p.usedPct || 0));
      const barColor = used >= 80 ? 'var(--tm-crit)' : (used >= 50 ? 'var(--tm-warn)' : 'var(--tm-ok)');
      const winTag = p.windowType === 'weekly' ? 'Weekly' : '5h';
      const resetLabel = p.resetTime ? `Resets in ${formatCountdown(p.msUntilReset)}` : '';
      const isOpen = expandedQuotaPoolIds.has(p.poolId);
      const corr = p.correlation;

      let detailsHtml = '';
      if (corr && (corr.hasData || (corr.byModel && corr.byModel.length > 0))) {
        const p1 = corr.per1Pct;
        const rem = corr.estRemaining;
        const full = corr.estFull100;
        const modelsList = corr.byModel || [];

        // If filtered to a specific model, show that model's isolated separation block first
        let focusedModelHtml = '';
        if (isFiltered) {
          const lower = filterModel.toLowerCase();
          const targetM = modelsList.find(m => m.model.toLowerCase().includes(lower));
          if (targetM) {
            focusedModelHtml = `
              <div class="quota-subhead quota-model-focus-header">
                <span class="quota-focus-label">Separated: ${escapeHtml(targetM.model)}</span>
                <button type="button" class="quota-focus-clear-btn" data-quota-action="clear-model">All Models</button>
              </div>
              ${renderLedgerRows([
                { dot: 'dot-cache', label: 'Cache Read', value: `${formatCompactNum(targetM.cacheReadTokens)} (${targetM.cacheEfficiencyPct}%)`, valClass: 'val-cache' },
                { dot: 'dot-input', label: 'New Input', value: formatCompactNum(targetM.inputTokens) },
                { dot: 'dot-think', label: 'Thinking', value: formatCompactNum(targetM.thinkingTokens), valClass: 'val-think' },
                { dot: 'dot-output', label: 'Response', value: formatCompactNum(targetM.responseTokens) },
                { dot: 'dot-total', label: 'Model Total', value: `${formatCompactNum(targetM.totalProcessedTokens)} (${targetM.turns}t)`, valClass: 'val-strong' }
              ])}
              ${targetM.per1Pct ? `
                <div class="quota-subhead"><span>${escapeHtml(targetM.model)} Burn / 1%</span><span>~${targetM.estPctUsed}% used (${targetM.sharePct}% share)</span></div>
                ${renderLedgerRows([
                  { dot: 'dot-cache', label: 'Cache / 1%', value: formatCompactNum(targetM.per1Pct.cacheReadTokens), valClass: 'val-cache' },
                  { dot: 'dot-input', label: 'Input / 1%', value: formatCompactNum(targetM.per1Pct.inputTokens) },
                  { dot: 'dot-think', label: 'Thinking / 1%', value: formatCompactNum(targetM.per1Pct.thinkingTokens), valClass: 'val-think' },
                  { dot: 'dot-output', label: 'Response / 1%', value: formatCompactNum(targetM.per1Pct.responseTokens) },
                  { dot: 'dot-total', label: 'Total / 1%', value: `${formatCompactNum(targetM.per1Pct.totalProcessedTokens)} (~${targetM.per1Pct.turns}t)`, valClass: 'val-strong' }
                ])}
              ` : ''}
              ${targetM.estRemaining ? `
                <div class="quota-subhead"><span>Model Runway (${p.remainingPct.toFixed(1)}% left)</span><span>~${formatNum(targetM.estRemaining.turns)} turns</span></div>
                ${renderLedgerRows([
                  { dot: 'dot-total', label: 'Est. Remaining', value: formatCompactNum(targetM.estRemaining.totalProcessedTokens), valClass: 'val-strong' },
                  { dot: 'dot-total', label: 'Est. 100% Budget', value: `${formatCompactNum(targetM.estFull100?.totalProcessedTokens || 0)} (~${formatNum(targetM.estFull100?.turns || 0)}t)` }
                ])}
              ` : ''}
            `;
          }
        }

        // Overall Pool Burn Rate and Estimates (when corr.hasData)
        let poolLedgerHtml = '';
        if (corr.hasData && p1 && rem && full) {
          poolLedgerHtml = `
            <div class="quota-subhead"><span>Per 1% of ${winTag} Quota</span><span>(${corr.observedPct}% obs)</span></div>
            ${renderLedgerRows([
              { dot: 'dot-cache', label: 'Cache Read / 1%', value: formatCompactNum(p1.cacheReadTokens), valClass: 'val-cache' },
              { dot: 'dot-input', label: 'New Input / 1%', value: formatCompactNum(p1.inputTokens) },
              { dot: 'dot-think', label: 'Thinking / 1%', value: formatCompactNum(p1.thinkingTokens), valClass: 'val-think' },
              { dot: 'dot-output', label: 'Response / 1%', value: formatCompactNum(p1.responseTokens) },
              { dot: 'dot-total', label: 'Total / 1%', value: `${formatCompactNum(p1.totalProcessedTokens)} (~${p1.turns}t)`, valClass: 'val-strong' }
            ])}
            <div class="quota-subhead"><span>Pool Runway (${p.remainingPct.toFixed(1)}% left)</span><span>~${formatNum(rem.turns)} turns</span></div>
            ${renderLedgerRows([
              { dot: 'dot-total', label: 'Est. Remaining', value: formatCompactNum(rem.totalProcessedTokens), valClass: 'val-strong' },
              { dot: 'dot-total', label: 'Est. 100% Budget', value: `${formatCompactNum(full.totalProcessedTokens)} (~${formatNum(full.turns)}t)` }
            ])}
          `;
        } else {
          const obs = corr?.observedPct || 0;
          poolLedgerHtml = `<div class="quota-learning-note">Collecting 1% token correlation (${obs}% / 0.5% min delta observed). Use models in this pool to unlock per-1% &amp; runway estimates.</div>`;
        }

        // Model Separation list (with drill-down per model)
        let modelsHtml = '';
        if (modelsList.length > 0) {
          modelsHtml = `
            <div class="quota-subhead"><span>Model Separation (${modelsList.length})</span><span>Quota Impact</span></div>
            ${modelsList.map(m => {
              const mKey = `${p.poolId}:${m.model}`;
              const isModelOpen = expandedQuotaModelNames.has(mKey);
              const isCurrent = isFiltered && filterModel.toLowerCase() === m.model.toLowerCase();
              return `
                <div class="quota-model-card${isModelOpen ? ' open' : ''}${isCurrent ? ' selected' : ''}">
                  <div class="quota-model-row" data-quota-action="toggle-model" data-model-key="${escapeHtml(mKey)}">
                    <span class="quota-model-left">
                      <svg class="tree-chev" width="10" height="10" viewBox="0 0 16 16"><path d="M6 3.5 10.5 8 6 12.5"/></svg>
                      <span class="quota-model-name brand-${brandOf(m.model)}">${escapeHtml(m.model)}</span>
                    </span>
                    <span class="quota-model-right">
                      <span class="quota-model-share">${formatCompactNum(m.totalProcessedTokens)} · ${m.sharePct}%</span>
                      <span class="quota-model-used">~${m.estPctUsed}%</span>
                      <button type="button" class="quota-focus-btn" data-quota-action="focus-model" data-focus-model="${escapeHtml(m.model)}" title="Focus all metrics on this model">Focus</button>
                    </span>
                  </div>
                  ${isModelOpen ? `
                    <div class="quota-model-drilldown font-mono">
                      ${renderLedgerRows([
                        { dot: 'dot-cache', label: 'Cache Read', value: `${formatCompactNum(m.cacheReadTokens)} (${m.cacheEfficiencyPct}%)`, valClass: 'val-cache' },
                        { dot: 'dot-input', label: 'New Input', value: formatCompactNum(m.inputTokens) },
                        { dot: 'dot-think', label: 'Thinking', value: formatCompactNum(m.thinkingTokens), valClass: 'val-think' },
                        { dot: 'dot-output', label: 'Response', value: formatCompactNum(m.responseTokens) },
                        { dot: 'dot-total', label: 'Total Tokens', value: `${formatCompactNum(m.totalProcessedTokens)} (${m.turns}t)`, valClass: 'val-strong' }
                      ])}
                      ${m.per1Pct ? `
                        <div class="quota-drill-subhead"><span>Burn / 1% Quota</span><span>~${formatCompactNum(m.per1Pct.totalProcessedTokens)} (~${m.per1Pct.turns}t)</span></div>
                      ` : ''}
                      ${m.estRemaining ? `
                        <div class="quota-drill-subhead"><span>Runway (${p.remainingPct.toFixed(1)}% left)</span><span>~${formatCompactNum(m.estRemaining.totalProcessedTokens)} (~${m.estRemaining.turns}t)</span></div>
                      ` : ''}
                    </div>
                  ` : ''}
                </div>
              `;
            }).join('')}
          `;
        }

        detailsHtml = `
          ${focusedModelHtml}
          ${focusedModelHtml ? '<div class="quota-divider"></div>' : ''}
          ${poolLedgerHtml}
          ${modelsHtml}
        `;
      } else {
        const obs = corr?.observedPct || 0;
        detailsHtml = `<div class="quota-learning-note">Collecting 1% token correlation (${obs}% / 0.5% min delta observed). Use models in this pool to unlock per-1% &amp; runway estimates.</div>`;
      }

      const subRight = corr?.hasData
        ? `~${formatCompactNum(corr.per1Pct.totalProcessedTokens)}/1% · ${resetLabel}`
        : resetLabel;

      const modelCount = (p.models || []).length;
      const modelsTitle = modelCount ? `Models sharing this quota (${modelCount}):\n${p.models.join('\n')}` : '';
      const barState = used >= 80 ? 'crit' : (used >= 50 ? 'warn' : 'ok');
      const burn = corr?.hasData && corr.per1Pct ? `~${formatCompactNum(corr.per1Pct.totalProcessedTokens)} / 1%` : '';
      return `
        <div class="quota-pool-item brand-${brandOf((p.models || [])[0] || p.label)}${isOpen ? ' expanded' : ''}" style="--brand2: var(--brand-${brandOf((p.models || []).find(m => brandOf(m) !== brandOf((p.models || [])[0])) || (p.models || [])[0] || p.label)})" data-pool-id="${escapeHtml(p.poolId)}">
          <div class="quota-pool-top">
            <span class="quota-pool-left">
              <span class="quota-pool-label" title="${escapeHtml(p.label)}">${escapeHtml(p.label)}</span>
              ${modelCount ? `<span class="quota-brand-chips" title="${escapeHtml(modelsTitle)}">${renderBrandChips(p.models)}</span>` : ''}
            </span>
            <span class="quota-pool-pct ${barState}">${used.toFixed(1)}%</span>
          </div>
          <div class="quota-pool-bar">
            <div class="quota-pool-fill ${barState}" style="width: ${used}%"></div>
          </div>
          <div class="quota-pool-sub">
            <span>${p.remainingPct.toFixed(1)}% left${resetLabel ? ` · ${escapeHtml(resetLabel)}` : ''}</span>
            <span>${escapeHtml(burn)}</span>
          </div>
          <div class="quota-pool-details">${detailsHtml}</div>
        </div>
      `;
    };

    const windows = [
      { type: '5h', title: '5-Hour Window' },
      { type: 'weekly', title: 'Weekly Window' }
    ];
    containerEl.innerHTML = windows.map(w => {
      const pools = list.filter(p => (p.windowType === 'weekly' ? 'weekly' : '5h') === w.type);
      if (!pools.length) return '';
      return `
        <div class="quota-group">
          <div class="quota-group-head"><span>${w.title}</span><span class="quota-group-count">${pools.length} pool${pools.length === 1 ? '' : 's'}</span></div>
          ${pools.map(renderPool).join('')}
        </div>
      `;
    }).join('');
  }

  // ---------- Global Usage Rendering ----------
  function renderGlobalView(data) {
    if (!data) return;

    // Logged-in account badges (both Global and Session tabs)
    if (data.account) {
      const acct = data.account;
      const acctText = `${acct.email}${acct.planName ? ` · ${acct.planName}` : ''}`;
      const acctTitle = `Separated storage for ${acct.name} (${acct.email})`;
      if (globalAccountBadge) {
        globalAccountBadge.textContent = acctText;
        globalAccountBadge.title = acctTitle;
      }
      if (sessionAccountBadge) {
        sessionAccountBadge.textContent = acctText;
        sessionAccountBadge.title = acctTitle;
      }
    }

    // 5-Hour & Weekly Quota Pools (rendered in both Session & Global tabs)
    renderQuotaPoolsInto(sessionQuotaPoolsList, data.quotaPools || [], selectedModel);
    renderQuotaPoolsInto(quotaPoolsList, data.quotaPools || [], selectedModel);
    if (currentTelemetry) renderCodingHud();

    const filtered = selectedModel !== 'all' ? (data.byModel?.[selectedModel] || null) : null;
    const tot = filtered || data.current || {};

    const totalProc = tot.totalProcessedTokens || 0;
    const gCache = tot.cacheReadTokens || 0;
    const gInput = tot.inputTokens || 0;
    const gThink = tot.thinkingTokens || 0;
    const gResp = tot.responseTokens || Math.max(0, (tot.outputTokens || 0) - gThink);

    if (globalTotalVal) globalTotalVal.textContent = formatCompactNum(totalProc);
    if (globalMetaVal) {
      globalMetaVal.textContent = filtered
        ? `${tot.totalTurns || 0} turns`
        : `${data.conversationCount || 0} chats · ${tot.totalTurns || 0} turns`;
    }
    if (globalCacheVal) globalCacheVal.textContent = `${tot.cacheEfficiencyPct || '0.0'}% cached`;
    if (globalBaselineNote) {
      if (data.pendingCount > 0) {
        globalBaselineNote.textContent = `Scanning local chats… (${data.pendingCount} remaining)`;
      } else {
        globalBaselineNote.textContent = data.baselineAt
          ? `Since reset: ${new Date(data.baselineAt).toLocaleString()}`
          : 'All-time local usage across Antigravity chats';
      }
    }

    if (globalCacheTotal) globalCacheTotal.textContent = formatNum(gCache);
    if (globalCachePct) globalCachePct.textContent = pctStr(gCache, totalProc);
    if (globalInputTotal) globalInputTotal.textContent = formatNum(gInput);
    if (globalInputPct) globalInputPct.textContent = pctStr(gInput, totalProc);
    if (globalThinkingTotal) globalThinkingTotal.textContent = formatNum(gThink);
    if (globalThinkingPct) globalThinkingPct.textContent = pctStr(gThink, totalProc);
    if (globalOutputTotal) globalOutputTotal.textContent = formatNum(gResp);
    if (globalOutputPct) globalOutputPct.textContent = pctStr(gResp, totalProc);

    // Per-Model Breakdown
    const modelEntries = Object.entries(data.byModel || {})
      .sort((a, b) => (b[1].totalProcessedTokens || 0) - (a[1].totalProcessedTokens || 0));
    if (globalModelCountVal) globalModelCountVal.textContent = `${modelEntries.length} model${modelEntries.length === 1 ? '' : 's'}`;
    if (secGlobalByModel) secGlobalByModel.classList.toggle('hidden', selectedModel !== 'all');
    if (globalModelsList) {
      if (!modelEntries.length) {
        globalModelsList.innerHTML = `<div class="empty-state">No model usage recorded since reset.</div>`;
      } else {
        globalModelsList.innerHTML = modelEntries.map(([mName, mTot]) => `
          <div class="global-model-row">
            <span class="routing-pill ${getModelPillClass(mName)}">${escapeHtml(mName)}</span>
            <span class="global-model-right">
              <span>${mTot.totalTurns || 0}t</span>
              <span class="cache-rate">${mTot.cacheEfficiencyPct || '0.0'}%</span>
              <span class="meta-strong">${formatCompactNum(mTot.totalProcessedTokens || 0)}</span>
            </span>
          </div>
        `).join('');
      }
    }

    // Stored Snapshots
    const snaps = data.snapshots || [];
    if (snapshotsCountVal) snapshotsCountVal.textContent = `${snaps.length} saved`;
    if (snapshotsList) {
      if (!snaps.length) {
        snapshotsList.innerHTML = `<div class="empty-state">No snapshots stored yet.</div>`;
      } else {
        snapshotsList.innerHTML = snaps.map(s => {
          const st = s.totals || {};
          const stTotal = st.totalProcessedTokens || 0;
          const isOpen = expandedSnapshotIds.has(s.id);
          const snapModels = Object.entries(s.byModel || {})
            .sort((a, b) => (b[1].totalProcessedTokens || 0) - (a[1].totalProcessedTokens || 0));
          const snapModelsHtml = snapModels.length
            ? `<div class="snapshot-models">${snapModels.map(([mName, mt]) => `
                <div class="item-ledger-row">
                  <span class="routing-pill ${getModelPillClass(mName)}">${escapeHtml(mName)}</span>
                  <span class="item-ledger-val">${formatCompactNum(mt.totalProcessedTokens || 0)} · ${mt.totalTurns || 0}t</span>
                </div>
              `).join('')}</div>`
            : '';
          return `
            <div class="snapshot-item${isOpen ? ' expanded' : ''}" data-snap-id="${escapeHtml(s.id)}">
              <div class="snapshot-top">
                <span class="snapshot-name">${s.auto ? '<span class="auto-pill">AUTO</span>' : ''}${escapeHtml(s.name)}</span>
                <span class="snapshot-right">
                  <span class="meta-strong">${formatCompactNum(stTotal)}</span>
                  <span>${st.totalTurns || 0}t</span>
                  <button type="button" class="snapshot-del-btn" data-del-snap="${escapeHtml(s.id)}" title="Delete snapshot">✕</button>
                </span>
              </div>
              <div class="snapshot-details">
                ${renderLedgerRows([
                  { dot: 'dot-cache', label: 'Cache Read', value: formatNum(st.cacheReadTokens || 0), valClass: 'val-cache' },
                  { dot: 'dot-input', label: 'New Input', value: formatNum(st.inputTokens || 0) },
                  { dot: 'dot-think', label: 'Thinking', value: formatNum(st.thinkingTokens || 0), valClass: 'val-think' },
                  { dot: 'dot-output', label: 'Response & Tools', value: formatNum(st.responseTokens || 0) },
                  { dot: 'dot-total', label: 'Saved', value: new Date(s.createdAt).toLocaleString() }
                ])}
                ${snapModelsHtml}
              </div>
            </div>
          `;
        }).join('');
      }
    }
  }

  // ---------- Telemetry List Rendering & Pagination ----------
  const TELEMETRY_PAGE_SIZE = 15;
  let telemetryPromptPage = 1;
  let telemetryStepPage = 1;

  function updateToggleButtons() {
    if (viewPromptBtn && viewStepBtn) {
      viewPromptBtn.classList.toggle('active', activeView === 'prompt');
      viewStepBtn.classList.toggle('active', activeView === 'step');
    }
  }

  function renderTelemetryPagination(totalItems, currentPage, onPageSelect) {
    if (!telemetryPagination) return;
    const totalPages = Math.ceil(totalItems / TELEMETRY_PAGE_SIZE) || 1;
    if (totalPages <= 1) {
      telemetryPagination.classList.add('hidden');
      return;
    }
    telemetryPagination.classList.remove('hidden');

    const startIdx = (currentPage - 1) * TELEMETRY_PAGE_SIZE + 1;
    const endIdx = Math.min(totalItems, currentPage * TELEMETRY_PAGE_SIZE);
    if (telemetryPaginationInfo) {
      telemetryPaginationInfo.textContent = `${startIdx}–${endIdx} of ${totalItems} (Pg ${currentPage}/${totalPages})`;
    }

    if (telemetryPagePrev) {
      telemetryPagePrev.disabled = currentPage <= 1;
      telemetryPagePrev.onclick = () => onPageSelect(currentPage - 1);
    }
    if (telemetryPageNext) {
      telemetryPageNext.disabled = currentPage >= totalPages;
      telemetryPageNext.onclick = () => onPageSelect(currentPage + 1);
    }

    if (telemetryPaginationPages) {
      // Build compact page numbers with ellipsis (e.g. 1, 2, ..., 5)
      const pages = [];
      for (let p = 1; p <= totalPages; p++) {
        if (p === 1 || p === totalPages || Math.abs(p - currentPage) <= 1) {
          pages.push(p);
        } else if (pages[pages.length - 1] !== '...') {
          pages.push('...');
        }
      }

      telemetryPaginationPages.innerHTML = pages.map(p => {
        if (p === '...') {
          return `<span class="pagination-ellipsis">…</span>`;
        }
        const isActive = p === currentPage;
        return `<button type="button" class="pagination-page-btn${isActive ? ' active' : ''}" data-page="${p}">${p}</button>`;
      }).join('');

      telemetryPaginationPages.querySelectorAll('.pagination-page-btn').forEach(btn => {
        btn.onclick = () => onPageSelect(parseInt(btn.dataset.page, 10));
      });
    }
  }

  function renderTelemetryList() {
    if (!currentTelemetry || !telemetryList) return;

    if (activeView === 'prompt') {
      let prompts = currentTelemetry.prompts || currentTelemetry.recentPrompts || [];
      // reverse-chronological so latest is first
      const fullList = [...prompts].reverse();
      let filtered = fullList;
      if (selectedModel !== 'all') {
        filtered = fullList.filter(p => (p.modelsUsed || []).includes(selectedModel));
      }

      if (simpleMode) {
        const latestItems = filtered.slice(0, SIMPLE_TELEMETRY_LIMIT);
        if (telemetryCompactVal) {
          telemetryCompactVal.textContent = filtered.length > SIMPLE_TELEMETRY_LIMIT
            ? `· latest ${latestItems.length} of ${filtered.length}`
            : `· ${filtered.length} prompt${filtered.length === 1 ? '' : 's'}`;
        }
        renderPromptList(latestItems, fullList[0]?.promptNumber);
        if (telemetryPagination) telemetryPagination.classList.add('hidden');
        return;
      }

      if (telemetryCompactVal) telemetryCompactVal.textContent = `· ${filtered.length} prompt${filtered.length === 1 ? '' : 's'}`;

      const totalPages = Math.ceil(filtered.length / TELEMETRY_PAGE_SIZE) || 1;
      if (telemetryPromptPage > totalPages) telemetryPromptPage = totalPages;
      if (telemetryPromptPage < 1) telemetryPromptPage = 1;

      const pagedItems = filtered.slice((telemetryPromptPage - 1) * TELEMETRY_PAGE_SIZE, telemetryPromptPage * TELEMETRY_PAGE_SIZE);
      renderPromptList(pagedItems, fullList[0]?.promptNumber);
      renderTelemetryPagination(filtered.length, telemetryPromptPage, (newPage) => {
        telemetryPromptPage = newPage;
        renderTelemetryList();
      });
    } else {
      let turns = currentTelemetry.turns || currentTelemetry.recentTurns || [];
      // reverse-chronological so latest turn is first
      const fullList = [...turns].reverse();
      let filtered = fullList;
      if (selectedModel !== 'all') {
        filtered = fullList.filter(t => t.modelDisplayName === selectedModel);
      }

      if (simpleMode) {
        const latestItems = filtered.slice(0, SIMPLE_TELEMETRY_LIMIT);
        if (telemetryCompactVal) {
          telemetryCompactVal.textContent = filtered.length > SIMPLE_TELEMETRY_LIMIT
            ? `· latest ${latestItems.length} of ${filtered.length}`
            : `· ${filtered.length} step${filtered.length === 1 ? '' : 's'}`;
        }
        renderStepList(latestItems, filtered, 0);
        if (telemetryPagination) telemetryPagination.classList.add('hidden');
        return;
      }

      if (telemetryCompactVal) telemetryCompactVal.textContent = `· ${filtered.length} step${filtered.length === 1 ? '' : 's'}`;

      const totalPages = Math.ceil(filtered.length / TELEMETRY_PAGE_SIZE) || 1;
      if (telemetryStepPage > totalPages) telemetryStepPage = totalPages;
      if (telemetryStepPage < 1) telemetryStepPage = 1;

      const pageStartIdx = (telemetryStepPage - 1) * TELEMETRY_PAGE_SIZE;
      const pagedItems = filtered.slice(pageStartIdx, telemetryStepPage * TELEMETRY_PAGE_SIZE);
      renderStepList(pagedItems, filtered, pageStartIdx);
      renderTelemetryPagination(filtered.length, telemetryStepPage, (newPage) => {
        telemetryStepPage = newPage;
        renderTelemetryList();
      });
    }
  }

  function formatStepRange(stepIndices) {
    if (!stepIndices || !stepIndices.length) return { label: '-', title: 'No steps' };
    if (stepIndices.length === 1) return { label: String(stepIndices[0]), title: `Step ${stepIndices[0]}` };
    const first = stepIndices[0];
    const last = stepIndices[stepIndices.length - 1];
    return { label: `${first}–${last}`, title: `Steps ${stepIndices.join(', ')}` };
  }

  // ---------- Quota cost (% of 5h / weekly pool) ----------
  // Estimated from the pool's learned tokens-per-1% rate (global quota correlation).
  function findQuotaPool(modelName, windowType) {
    const pools = globalUsageData?.quotaPools || [];
    return pools.find(p => p.windowType === windowType && (p.models || []).includes(modelName)) || null;
  }

  // entries: [{ model, tokens }]. Returns { pct, state } or null when the models are not in this window's pool.
  function computeQuotaCost(entries, windowType) {
    let pct = 0;
    let matched = false;
    let ready = true;
    for (const e of entries) {
      const pool = findQuotaPool(e.model, windowType);
      if (!pool) continue;
      matched = true;
      const per1 = pool.correlation?.hasData ? pool.correlation.per1Pct?.totalProcessedTokens : 0;
      if (!per1) { ready = false; continue; }
      pct += e.tokens / per1;
    }
    if (!matched) return null;
    return { pct, ready };
  }

  function formatQuotaCost(cost) {
    if (!cost) return null;
    if (!cost.ready && cost.pct === 0) return 'learning…';
    const v = cost.pct;
    const txt = v >= 10 ? v.toFixed(1) : (v >= 0.01 ? v.toFixed(2) : (v > 0 ? '<0.01' : '0'));
    return `~${txt}%${cost.ready ? '' : ' (partial)'}`;
  }

  function turnQuotaEntry(t) {
    return { model: t.modelDisplayName, tokens: (t.inputTokens || 0) + (t.cacheReadTokens || 0) + (t.outputTokens || 0) };
  }

  function quotaCostRows(entries) {
    const rows = [];
    if (telemetryFields.quota5h) {
      const v = formatQuotaCost(computeQuotaCost(entries, '5h'));
      if (v) rows.push({ dot: 'dot-total', label: '5h Quota', value: v, valClass: 'val-quota' });
    }
    if (telemetryFields.quotaWeekly) {
      const v = formatQuotaCost(computeQuotaCost(entries, 'weekly'));
      if (v) rows.push({ dot: 'dot-total', label: 'Weekly Quota', value: v, valClass: 'val-quota' });
    }
    return rows;
  }

  function renderLedgerRows(rows) {
    return `<div class="item-ledger">${rows.map(r => `
      <div class="item-ledger-row">
        <span class="item-ledger-key"><span class="item-ledger-dot ${r.dot}"></span>${escapeHtml(r.label)}</span>
        <span class="item-ledger-val ${r.valClass || ''}">${r.html ? r.value : escapeHtml(r.value)}</span>
      </div>
    `).join('')}</div>`;
  }

  function renderPromptList(prompts, latestPromptNum) {
    if (!prompts || prompts.length === 0) {
      telemetryList.innerHTML = `<div class="empty-state font-mono">No prompt records yet</div>`;
      return;
    }

    telemetryList.innerHTML = prompts.map(p => {
      const isLatest = p.promptNumber === latestPromptNum;
      const previewText = p.userPromptPreview ? truncate(p.userPromptPreview, simpleMode ? 18 : 26) : '';
      const cacheClass = getCacheBadgeClass(p.cacheEfficiencyPct);
      const key = itemKey('prompt', p.promptNumber);
      const isCompact = isItemCompact(key);

      let routingHtml = '';
      if (telemetryFields.model && p.modelsUsedShort && p.modelsUsedShort.length > 0) {
        const modelsToShow = simpleMode ? p.modelsUsedShort.slice(-1) : p.modelsUsedShort;
        routingHtml = modelsToShow.map(m =>
          `<span class="routing-pill ${getModelPillClass(m)}" title="${escapeHtml(m)}">${escapeHtml(m)}</span>`
        ).join('<span class="routing-arrow">→</span>');
      }

      const showChatPrimary = telemetryFields.chat && Boolean(previewText);
      const promoteModelToTop = !showChatPrimary && Boolean(routingHtml);
      const hasLeadingItem = showChatPrimary || promoteModelToTop;
      const callsText = `${p.llmCallsCount} call${p.llmCallsCount === 1 ? '' : 's'}`;
      const showAnyField = showChatPrimary || Boolean(routingHtml) || telemetryFields.calls || telemetryFields.cache;

      const cacheDot = (p.promptCacheStatus === 'warm_hit' || p.promptCacheStatus === 'cross_model_hit') ? 'dot-cache' : 'dot-total';
      const ledgerRows = simpleMode
        ? [
            { dot: 'dot-cache', label: 'Cache Read', value: `${formatCompactNum(p.cacheRead)} (${p.cacheEfficiencyPct}%)`, valClass: 'val-cache' },
            { dot: 'dot-input', label: 'New Input', value: formatCompactNum(p.newInput) },
            { dot: 'dot-output', label: 'Output', value: formatCompactNum(p.output) },
            { dot: 'dot-total', label: 'Context', value: `${formatCompactNum(p.endingContext)} (${p.endingContextPct}%)`, valClass: 'val-strong' }
          ]
        : [
            { dot: 'dot-input', label: 'New Input', value: formatNum(p.newInput) },
            { dot: 'dot-cache', label: 'Cache Read', value: formatNum(p.cacheRead), valClass: 'val-cache' },
            { dot: 'dot-think', label: 'Thinking', value: formatNum(p.thinking), valClass: 'val-think' },
            { dot: 'dot-output', label: 'Output', value: formatNum(p.output) },
            ...quotaCostRows((currentTelemetry?.turns || []).filter(x => x.promptNumber === p.promptNumber).map(turnQuotaEntry)),
            { dot: cacheDot, label: 'Cache', value: renderCacheStatusChips(p.gapSincePrevPromptMs, p.promptCacheStatus, p.cachedModelShort || p.modelsUsedShort?.[0], p.prevPromptModelShort), html: true },
            { dot: 'dot-total', label: 'Ending Context', value: `${formatCompactNum(p.endingContext)} (${p.endingContextPct}%)`, valClass: 'val-strong' }
          ];
      const ledgerHtml = renderLedgerRows(ledgerRows);

      return `
        <div class="telemetry-item${isCompact ? ' compact' : ''}" data-key="${escapeHtml(key)}" role="button" tabindex="0" aria-expanded="${!isCompact}" title="Click to ${isCompact ? 'expand' : 'compact'}">
          <div class="item-top-row">
            <div class="item-title">
              <span class="num-capsule${isLatest ? ' current' : ''}" title="${isLatest ? 'Current prompt' : `Prompt ${p.promptNumber}`}">${p.promptNumber}</span>
              ${showChatPrimary ? `<span class="prompt-preview" title="${escapeHtml(p.userPromptPreview)}">${escapeHtml(previewText)}</span>` : ''}
              ${(promoteModelToTop || (simpleMode && routingHtml)) ? `<span class="item-inline-routing">${routingHtml}</span>` : ''}
              ${(!simpleMode && telemetryFields.calls) ? `<span class="calls-count">${hasLeadingItem ? '· ' : ''}${callsText}</span>` : ''}
            </div>
            <span class="item-top-right">
              ${simpleMode ? `<span class="item-simple-tok" title="${formatNum(p.totalTokens)} total tokens">${formatCompactNum(p.totalTokens)}</span>` : ''}
              ${telemetryFields.cache
                ? `<span class="item-cache-badge ${cacheClass}">${p.cacheEfficiencyPct}%${simpleMode ? '' : ' cache'}</span>`
                : (!showAnyField ? `<span class="item-context">${p.endingContextPct}% ctx</span>` : '')}
            </span>
          </div>
          ${(!simpleMode && !promoteModelToTop && routingHtml) ? `<div class="item-routing-row">${routingHtml}</div>` : ''}
          ${ledgerHtml}
        </div>
      `;
    }).join('');
  }

  function renderStepList(turns, fullList = turns, offset = 0) {
    if (!turns || turns.length === 0) {
      telemetryList.innerHTML = `<div class="empty-state font-mono">No step records yet</div>`;
      return;
    }

    telemetryList.innerHTML = turns.map((t, i) => {
      const stepRange = formatStepRange(t.stepIndices);
      const modelLabel = t.modelShortName || t.modelDisplayName || 'Flash';
      const modelFullName = t.modelDisplayName || t.modelId || 'Unknown Model';
      const cacheClass = getCacheBadgeClass(t.cacheEfficiencyPct);
      const key = itemKey('step', t.turnNumber);
      const isCompact = isItemCompact(key);
      const showAnyField = telemetryFields.chat || telemetryFields.model || telemetryFields.cache;

      // Grouping bracket logic: check against full list to correctly handle page boundaries
      const curPrompt = t.promptNumber;
      const globalIdx = offset + i;
      const globalPrev = globalIdx > 0 ? fullList[globalIdx - 1] : null; // higher turnNumber (newer)
      const globalNext = globalIdx < fullList.length - 1 ? fullList[globalIdx + 1] : null; // lower turnNumber (older)

      const hasPrevSame = curPrompt != null && globalPrev && globalPrev.promptNumber === curPrompt;
      const hasNextSame = curPrompt != null && globalNext && globalNext.promptNumber === curPrompt;

      // Check whether this item is at the visible page boundary continuing to another page
      const localPrev = i > 0 ? turns[i - 1] : null;
      const localNext = i < turns.length - 1 ? turns[i + 1] : null;
      const continuesPrev = hasPrevSame && !localPrev; // continues from previous page
      const continuesNext = hasNextSame && !localNext; // continues to next page

      let extraContinuity = '';
      if (continuesPrev) extraContinuity += ' (continues from previous page)';
      if (continuesNext) extraContinuity += ' (continues on next page)';

      const promptPreview = t.userPromptPreview ||
        (currentTelemetry?.prompts?.find(p => p.promptNumber === curPrompt)?.userPromptPreview) || '';
      const promptTitle = curPrompt != null
        ? `Prompt #${curPrompt}${promptPreview ? `: "${promptPreview}"` : ''}${extraContinuity}`
        : '';
      const promptDataAttr = curPrompt != null ? ` data-prompt="${curPrompt}"` : '';

      let groupClass = '';
      let bracketHtml = '';
      if (hasPrevSame || hasNextSame) {
        groupClass = ' grouped-step';
        let posClass = 'group-pos-middle';
        if (!hasPrevSame && hasNextSame) {
          posClass = 'group-pos-last'; // top turn in prompt group
        } else if (hasPrevSame && !hasNextSame) {
          posClass = 'group-pos-first'; // bottom turn in prompt group
        }
        if (continuesPrev) posClass += ' continues-prev';
        if (continuesNext) posClass += ' continues-next';
        groupClass += ` ${posClass}`;
        bracketHtml = `<span class="step-group-bracket" title="${escapeHtml(promptTitle)}" aria-label="${escapeHtml(promptTitle)}"></span>`;
      }

      const stepCacheDot = (t.cacheStatus === 'warm_hit' || t.cacheStatus === 'cross_model_hit') ? 'dot-cache' : 'dot-total';
      const stepLedgerRows = simpleMode
        ? [
            { dot: 'dot-cache', label: 'Cache Read', value: `${formatCompactNum(t.cacheReadTokens)} (${t.cacheEfficiencyPct}%)`, valClass: 'val-cache' },
            { dot: 'dot-input', label: 'New Input', value: formatCompactNum(t.inputTokens) },
            { dot: 'dot-output', label: 'Output', value: formatCompactNum(t.outputTokens) },
            { dot: 'dot-total', label: 'Total Turn', value: formatCompactNum(t.totalTurnTokens), valClass: 'val-strong' }
          ]
        : [
            { dot: 'dot-input', label: 'New Input', value: formatNum(t.inputTokens) },
            { dot: 'dot-cache', label: 'Cache Read', value: formatNum(t.cacheReadTokens), valClass: 'val-cache' },
            { dot: 'dot-think', label: 'Thinking', value: formatNum(t.thinkingTokens), valClass: 'val-think' },
            { dot: 'dot-output', label: 'Output', value: formatNum(t.outputTokens) },
            ...quotaCostRows([turnQuotaEntry(t)]),
            { dot: stepCacheDot, label: 'Cache', value: renderCacheStatusChips(t.gapSincePrevTurnMs, t.cacheStatus, modelLabel, t.prevModelShortName), html: true },
            { dot: 'dot-total', label: 'Total Turn', value: formatNum(t.totalTurnTokens), valClass: 'val-strong' }
          ];
      const ledgerHtml = renderLedgerRows(stepLedgerRows);

      return `
        <div class="telemetry-item step-item${groupClass}${isCompact ? ' compact' : ''}" data-key="${escapeHtml(key)}"${promptDataAttr} role="button" tabindex="0" aria-expanded="${!isCompact}" title="Click to ${isCompact ? 'expand' : 'compact'}">
          ${bracketHtml}
          <div class="item-top-row">
            <div class="item-title">
              <span class="num-capsule" title="Turn ${t.turnNumber}">${t.turnNumber}</span>
              ${telemetryFields.chat ? `<span class="step-indices" title="${escapeHtml(stepRange.title)}">Step ${escapeHtml(stepRange.label)}</span>` : ''}
              ${telemetryFields.model ? `<span class="routing-pill ${getModelPillClass(modelLabel)}" title="${escapeHtml(modelFullName)}">${escapeHtml(modelLabel)}</span>` : ''}
            </div>
            <span class="item-top-right">
              ${simpleMode ? `<span class="item-simple-tok" title="${formatNum(t.totalTurnTokens)} total tokens">${formatCompactNum(t.totalTurnTokens)}</span>` : ''}
              ${telemetryFields.cache
                ? `<span class="item-cache-badge ${cacheClass}">${t.cacheEfficiencyPct}%${simpleMode ? '' : ' cache'}</span>`
                : (!showAnyField ? `<span class="item-context">${formatCompactNum(t.totalTurnTokens)}</span>` : '')}
            </span>
          </div>
          ${ledgerHtml}
        </div>
      `;
    }).join('');
  }

  // ---------- Change pills (+N on significant updates) ----------
  const DELTA_TARGET_IDS = [
    'turnCacheReadVal', 'turnNewInputVal', 'turnThinkingVal', 'turnResponseVal', 'toolCallsTotalVal',
    'sessionCacheTotal', 'sessionInputTotal', 'sessionThinkingTotal', 'sessionOutputTotal'
  ];
  const DELTA_MIN_ABS = 100;      // ignore tiny changes
  const DELTA_MIN_REL = 0.02;     // ...and changes under 2% of the previous value
  const DELTA_SHOW_MS = 7000;

  function parseDisplayNumber(text) {
    const m = String(text || '').trim().replace(/,/g, '').match(/^(-?\d+(?:\.\d+)?)\s*([KMBkmb])?/);
    if (!m) return null;
    const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
    return parseFloat(m[1]) * mult;
  }

  function showDeltaPill(valueEl, delta, isCount) {
    const label = valueEl.closest('.cat-row')?.querySelector('.cat-label');
    if (!label) return;
    label.querySelectorAll('.delta-pill').forEach((n) => n.remove());
    const pill = document.createElement('span');
    pill.className = 'delta-pill';
    pill.textContent = '+' + (isCount ? String(Math.round(delta)) : formatCompactNum(Math.round(delta)));
    pill.title = 'Increase since the last update';
    label.appendChild(pill);
    clearTimeout(pill._t);
    pill._t = setTimeout(() => {
      pill.classList.add('leaving');
      setTimeout(() => pill.remove(), 400);
    }, DELTA_SHOW_MS);
  }

  DELTA_TARGET_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    let last = parseDisplayNumber(el.textContent);
    const isCount = id === 'toolCallsTotalVal';
    new MutationObserver(() => {
      const cur = parseDisplayNumber(el.textContent);
      if (cur == null) return;
      const prev = last;
      last = cur;
      if (prev == null || cur <= prev) return; // drops / resets only update the baseline
      const delta = cur - prev;
      const minAbs = isCount ? 1 : DELTA_MIN_ABS;
      if (delta < minAbs || (!isCount && prev > 0 && delta / prev < DELTA_MIN_REL)) return;
      showDeltaPill(el, delta, isCount);
    }).observe(el, { childList: true, characterData: true, subtree: true });
  });

  // ---------- Tab Switching ----------
  function switchTab(tab) {
    activeTab = tab;
    if (tabSession) tabSession.classList.toggle('hidden', tab !== 'session');
    if (tabAgents) tabAgents.classList.toggle('hidden', tab !== 'agents');
    if (tabGlobal) tabGlobal.classList.toggle('hidden', tab !== 'global');

    [tabSessionBtn, tabAgentsBtn, tabGlobalBtn].forEach(btn => {
      if (!btn) return;
      const on = btn.dataset.tab === tab;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', String(on));
    });

    if (modelFilterSelect) {
      modelFilterSelect.style.visibility = tab === 'agents' ? 'hidden' : 'visible';
    }

    updateModelDropdown();
    if (tab === 'global') {
      fetchGlobalUsage();
    } else if (tab === 'agents') {
      renderAgentsList();
    } else if (currentTelemetry) {
      renderDashboard(currentTelemetry);
    }
  }

  [tabSessionBtn, tabAgentsBtn, tabGlobalBtn].forEach(btn => {
    if (btn) btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  if (modelFilterSelect) {
    modelFilterSelect.addEventListener('change', () => {
      selectedModel = modelFilterSelect.value || 'all';
      if (globalUsageData) renderGlobalView(globalUsageData);
      if (activeTab !== 'global' && currentTelemetry) {
        renderDashboard(currentTelemetry);
      }
    });
  }

  // Click any quota pool (on Session or Global tab) or model action
  [sessionQuotaPoolsList, quotaPoolsList].forEach((container) => {
    if (!container) return;
    container.addEventListener('click', (e) => {
      // 1. Clear model focus button
      const clearBtn = e.target.closest('[data-quota-action="clear-model"]');
      if (clearBtn) {
        e.stopPropagation();
        selectedModel = 'all';
        if (modelFilterSelect) modelFilterSelect.value = 'all';
        if (globalUsageData) {
          renderQuotaPoolsInto(sessionQuotaPoolsList, globalUsageData.quotaPools || [], 'all');
          renderQuotaPoolsInto(quotaPoolsList, globalUsageData.quotaPools || [], 'all');
        }
        if (activeTab !== 'global' && currentTelemetry) renderDashboard(currentTelemetry);
        return;
      }

      // 2. Focus model button
      const focusBtn = e.target.closest('[data-quota-action="focus-model"]');
      if (focusBtn) {
        e.stopPropagation();
        const fMod = focusBtn.dataset.focusModel;
        if (fMod) {
          selectedModel = fMod;
          updateModelDropdown();
          if (modelFilterSelect) modelFilterSelect.value = fMod;
          if (globalUsageData) {
            renderQuotaPoolsInto(sessionQuotaPoolsList, globalUsageData.quotaPools || [], selectedModel);
            renderQuotaPoolsInto(quotaPoolsList, globalUsageData.quotaPools || [], selectedModel);
          }
          if (activeTab !== 'global' && currentTelemetry) renderDashboard(currentTelemetry);
        }
        return;
      }

      // 3. Toggle model drill-down
      const toggleModel = e.target.closest('[data-quota-action="toggle-model"]');
      if (toggleModel) {
        e.stopPropagation();
        const mKey = toggleModel.dataset.modelKey;
        if (mKey) {
          if (expandedQuotaModelNames.has(mKey)) expandedQuotaModelNames.delete(mKey);
          else expandedQuotaModelNames.add(mKey);
          if (globalUsageData) {
            renderQuotaPoolsInto(sessionQuotaPoolsList, globalUsageData.quotaPools || [], selectedModel);
            renderQuotaPoolsInto(quotaPoolsList, globalUsageData.quotaPools || [], selectedModel);
          }
        }
        return;
      }

      // 4. Toggle entire quota pool item
      const item = e.target.closest('.quota-pool-item');
      const pid = item?.dataset?.poolId;
      if (!pid) return;
      if (expandedQuotaPoolIds.has(pid)) expandedQuotaPoolIds.delete(pid);
      else expandedQuotaPoolIds.add(pid);
      if (globalUsageData) {
        renderQuotaPoolsInto(sessionQuotaPoolsList, globalUsageData.quotaPools || [], selectedModel);
        renderQuotaPoolsInto(quotaPoolsList, globalUsageData.quotaPools || [], selectedModel);
      }
    });
  });

  // ---------- Agents Interactions ----------
  if (agentsList) {
    agentsList.addEventListener('click', (e) => {
      const item = e.target.closest('.agent-item');
      const agentId = item?.dataset?.agentId;
      if (!agentId) return;
      inspectedAgent = { conversationId: agentId, role: item.dataset.agentRole || 'Subagent' };
      selectedModel = 'all';
      switchTab('session');
      fetchTelemetry();
    });
  }

  if (backToMainBtn) {
    backToMainBtn.addEventListener('click', () => {
      inspectedAgent = null;
      selectedModel = 'all';
      fetchTelemetry();
    });
  }

  // ---------- Tool Calls 3-Level Interactions ----------
  if (compactionToggleRow) {
    compactionToggleRow.addEventListener('click', (e) => {
      e.stopPropagation();
      compactionTreeExpanded = !compactionTreeExpanded;
      if (currentTelemetry) renderDashboard(currentTelemetry);
    });
    compactionToggleRow.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      compactionTreeExpanded = !compactionTreeExpanded;
      if (currentTelemetry) renderDashboard(currentTelemetry);
    });
  }

  if (toolCallsRootRow) {
    toolCallsRootRow.addEventListener('click', (e) => {
      e.stopPropagation();
      toolTreeExpanded = !toolTreeExpanded;
      if (currentTelemetry) {
        const filteredModel = selectedModel !== 'all' ? currentTelemetry.modelStats?.[selectedModel] : null;
        const summary = filteredModel
          ? (currentTelemetry.toolCalls?.byModel?.[filteredModel.displayName] || { totalCalls: 0, tools: [] })
          : (currentTelemetry.toolCalls || { totalCalls: 0, tools: [] });
        renderToolCallsTree(summary);
      }
    });
  }

  if (toolCallsTree) {
    toolCallsTree.addEventListener('click', (e) => {
      e.stopPropagation();
      const row = e.target.closest('.tool-node-row');
      const node = row?.closest('.tool-node');
      const toolName = node?.dataset?.toolName;
      if (!toolName) return;
      if (expandedToolNames.has(toolName)) expandedToolNames.delete(toolName);
      else expandedToolNames.add(toolName);
      const isOpen = expandedToolNames.has(toolName);
      node.classList.toggle('expanded', isOpen);
      row.setAttribute('aria-expanded', String(isOpen));
    });
  }

  // ---------- Global Usage Interactions ----------
  if (storeSnapshotBtn) {
    storeSnapshotBtn.addEventListener('click', async () => {
      const orig = storeSnapshotBtn.textContent;
      storeSnapshotBtn.disabled = true;
      storeSnapshotBtn.textContent = 'Saving…';
      try {
        const res = await fetch(apiUrl('/api/global/snapshot'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: snapshotNameInput?.value || '' })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        if (snapshotNameInput) snapshotNameInput.value = '';
        await fetchGlobalUsage();
      } catch (err) {
        console.error('Store snapshot failed:', err);
      } finally {
        storeSnapshotBtn.disabled = false;
        storeSnapshotBtn.textContent = orig;
      }
    });
  }

  let resetConfirmTimer = null;
  if (resetGlobalBtn) {
    resetGlobalBtn.addEventListener('click', async () => {
      if (!resetGlobalBtn.classList.contains('confirming')) {
        resetGlobalBtn.classList.add('confirming');
        resetGlobalBtn.textContent = 'Confirm Reset?';
        clearTimeout(resetConfirmTimer);
        resetConfirmTimer = setTimeout(() => {
          resetGlobalBtn.classList.remove('confirming');
          resetGlobalBtn.textContent = 'Reset';
        }, 4000);
        return;
      }
      clearTimeout(resetConfirmTimer);
      resetGlobalBtn.classList.remove('confirming');
      resetGlobalBtn.textContent = 'Resetting…';
      try {
        const res = await fetch(apiUrl('/api/global/reset'), { method: 'POST' });
        const data = await res.json();
        if (!data.error) {
          globalUsageData = data;
          renderGlobalView(data);
        }
      } catch (err) {
        console.error('Reset global usage failed:', err);
      } finally {
        resetGlobalBtn.textContent = 'Reset';
      }
    });
  }

  if (exportGlobalBtn) {
    exportGlobalBtn.addEventListener('click', () => {
      if (!globalUsageData) return;
      const blob = new Blob([JSON.stringify(globalUsageData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `token-context-meter-global-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
  }

  if (importGlobalBtn && importGlobalFile) {
    importGlobalBtn.addEventListener('click', () => importGlobalFile.click());
    importGlobalFile.addEventListener('change', async () => {
      const file = importGlobalFile.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const json = JSON.parse(text);
        const res = await fetch(apiUrl('/api/global/import'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(json)
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        await fetchGlobalUsage();
      } catch (err) {
        console.error('Import failed:', err);
      } finally {
        importGlobalFile.value = '';
      }
    });
  }

  if (snapshotsList) {
    snapshotsList.addEventListener('click', async (e) => {
      const delBtn = e.target.closest('[data-del-snap]');
      if (delBtn) {
        e.stopPropagation();
        const id = delBtn.dataset.delSnap;
        try {
          await fetch(apiUrl('/api/global/snapshot/delete'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
          });
          expandedSnapshotIds.delete(id);
          await fetchGlobalUsage();
        } catch (err) {
          console.error('Delete snapshot failed:', err);
        }
        return;
      }
      const item = e.target.closest('.snapshot-item');
      const id = item?.dataset?.snapId;
      if (!id) return;
      if (expandedSnapshotIds.has(id)) expandedSnapshotIds.delete(id);
      else expandedSnapshotIds.add(id);
      item.classList.toggle('expanded', expandedSnapshotIds.has(id));
    });
  }

  // ---------- Section Visibility, Compact & Popovers ----------
  const VIEW_MODE_LABELS = { full: 'Full', simple: 'Simple', hud: 'HUD' };
  const VIEW_MODE_ORDER = ['full', 'simple', 'hud'];

  function setViewMode(nextMode) {
    if (!['full', 'simple', 'hud'].includes(nextMode)) nextMode = 'full';
    viewMode = nextMode;
    simpleMode = viewMode === 'simple';
    try {
      localStorage.setItem('token_meter_view_mode', viewMode);
      localStorage.setItem('token_meter_simple_mode', String(simpleMode));
    } catch {}
    itemCompactOverrides.clear();
    if (simpleMode) {
      sectionCompact.genOutput = true;
      sectionCompact.sessionTotals = true;
    } else if (viewMode === 'full') {
      sectionCompact.genOutput = false;
      sectionCompact.sessionTotals = false;
    }
    saveJsonPref('token_meter_section_compact', sectionCompact);
    applySectionStates();
    renderTelemetryList();
    renderCodingHud();
  }

  function applySectionStates() {
    document.body.classList.toggle('simple-mode', viewMode === 'simple');
    document.body.classList.toggle('hud-mode', viewMode === 'hud');
    if (codingHudPane) codingHudPane.classList.toggle('hidden', viewMode !== 'hud');
    if (viewModeQuickBtn) {
      viewModeQuickBtn.textContent = VIEW_MODE_LABELS[viewMode] || 'Full';
      viewModeQuickBtn.classList.toggle('active-mode', viewMode !== 'full');
    }
    document.querySelectorAll('[data-view-mode]').forEach((rb) => {
      rb.checked = rb.dataset.viewMode === viewMode;
    });
    document.querySelectorAll('[data-section]').forEach((sec) => {
      const key = sec.dataset.section;
      const visible = viewMode !== 'hud' && sectionVisibility[key] !== false;
      const compact = Boolean(sectionCompact[key]);
      sec.classList.toggle('hidden', !visible);
      sec.classList.toggle('compact', compact);
      if (sec.classList.contains('compactable-section')) {
        sec.querySelector('.section-toggle-header')?.setAttribute('aria-expanded', String(!compact));
      }
    });
    if (telemetryHeaderToggle) {
      const compact = Boolean(sectionCompact.telemetry);
      telemetryHeaderToggle.setAttribute('aria-expanded', String(!compact));
      const activeView = document.querySelector('.view-toggle .toggle-btn.active')?.textContent?.trim() || '—';
      const compactVal = document.getElementById('telemetryCompactVal')?.textContent?.trim();
      telemetryHeaderToggle.title = ['Telemetry', `View: ${activeView}`, compactVal ? `Summary: ${compactVal}` : null, `Items: ${compact ? 'collapsed' : 'expanded'}`].filter(Boolean).join('\n');
    }
    document.querySelectorAll('[data-section-toggle]').forEach((cb) => {
      cb.checked = sectionVisibility[cb.dataset.sectionToggle] !== false;
    });
    document.querySelectorAll('[data-field-toggle]').forEach((cb) => {
      cb.checked = telemetryFields[cb.dataset.fieldToggle] !== false;
    });
  }

  function toggleSectionCompact(key) {
    if (!key) return;
    sectionCompact[key] = !sectionCompact[key];
    saveJsonPref('token_meter_section_compact', sectionCompact);
    applySectionStates();
  }

  // Wrap each section body so compaction can animate height (grid 1fr -> 0fr)
  document.querySelectorAll('.section-block > .section-body').forEach((body) => {
    if (body.querySelector(':scope > .section-body-inner')) return;
    const inner = document.createElement('div');
    inner.className = 'section-body-inner';
    while (body.firstChild) inner.appendChild(body.firstChild);
    body.appendChild(inner);
  });
  // Hover info for section headers (computed lazily from the live DOM values)
  const sectionHoverBuilders = {
    windowUtil: (t) => [
      'Context Window',
      `Used: ${t('contextPctValue')} (${t('healthBadge')})`,
      `Active / Max: ${t('windowRatioVal')}`,
      `Remaining: ${t('remainingTokensVal')}`,
      `Model: ${t('modelNameBadge')}`
    ],
    quotas: (t) => {
      const pools = [...document.querySelectorAll('#sessionQuotaPoolsList .quota-pool-item')]
        .map((el) => (el.querySelector('.quota-pool-head, .quota-pool-top') || el).textContent.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      return ['Account & Quotas', `Account: ${t('sessionAccountBadge')}`, ...pools];
    },
    activeTurn: (t) => [
      'Active Turn',
      `Prompt total: ${t('turnPromptTotalVal')} (${t('cacheHitBadge')})`,
      `Cache read: ${t('turnCacheReadVal')} (${t('turnCachePct')})`,
      `New input: ${t('turnNewInputVal')} (${t('turnNewInputPct')})`,
      `Last chat: ${t('lastChatAgoVal')}`,
      `Cache model: ${t('warmModelPill')}`,
      `Cache TTL: ${t('cacheLifespanStat')}`
    ],
    genOutput: (t) => [
      'Generation Output',
      `Total: ${t('turnOutputTotalBadge')} ${t('genOutputLimitVal')}`,
      `Thinking: ${t('turnThinkingVal')} (${t('turnThinkingPct')})`,
      `Response & tools: ${t('turnResponseVal')} (${t('turnResponsePct')})`,
      `Tool calls: ${t('toolCallsTotalVal')} (${t('toolCallsTypesVal')})`
    ],
    sessionTotals: (t) => [
      'Session Totals',
      `Processed: ${t('sessionProcessedVal')} over ${t('totalTurnsBadge')}`,
      `Cache read: ${t('sessionCacheTotal')} (${t('sessionCachePct')})`,
      `Prompt cache rate: ${t('sessionPromptCachePct')}`,
      `New input: ${t('sessionInputTotal')} (${t('sessionInputPct')})`,
      `Thinking: ${t('sessionThinkingTotal')} (${t('sessionThinkingPct')})`,
      `Response & tools: ${t('sessionOutputTotal')} (${t('sessionOutputPct')})`
    ]
  };
  function updateSectionHeaderHover(sec, header) {
    const build = sectionHoverBuilders[sec.dataset.section];
    if (!build) return;
    const t = (id) => (document.getElementById(id)?.textContent || '—').trim();
    header.title = build(t).join('\n');
  }
  document.querySelectorAll('.compactable-section').forEach((sec) => {
    const header = sec.querySelector('.section-header-row, .hero-top-row');
    if (!header) return;
    header.classList.add('section-toggle-header');
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');
    header.setAttribute('aria-expanded', 'true');
    header.addEventListener('pointerenter', () => updateSectionHeaderHover(sec, header));
    header.addEventListener('focus', () => updateSectionHeaderHover(sec, header));
    header.addEventListener('click', (e) => {
      if (e.target.closest('button, input, label, select, .popover-menu')) return;
      toggleSectionCompact(sec.dataset.section);
    });
    header.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      toggleSectionCompact(sec.dataset.section);
    });
  });

  if (telemetryHeaderToggle) {
    telemetryHeaderToggle.addEventListener('click', () => toggleSectionCompact('telemetry'));
  }

  function closeAllMenus() {
    if (headerMenu) headerMenu.classList.remove('open');
    if (headerMenuBtn) headerMenuBtn.setAttribute('aria-expanded', 'false');
    if (telemetryMenu) telemetryMenu.classList.remove('open');
    if (telemetryMenuBtn) telemetryMenuBtn.setAttribute('aria-expanded', 'false');
  }

  function bindPopoverMenu(btn, menu) {
    if (!btn || !menu) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = !menu.classList.contains('open');
      closeAllMenus();
      if (willOpen) {
        menu.classList.add('open');
        btn.setAttribute('aria-expanded', 'true');
      }
    });
    menu.addEventListener('click', (e) => e.stopPropagation());
  }

  bindPopoverMenu(headerMenuBtn, headerMenu);
  bindPopoverMenu(telemetryMenuBtn, telemetryMenu);

  document.addEventListener('click', closeAllMenus);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllMenus();
  });

  document.querySelectorAll('[data-view-mode]').forEach((rb) => {
    rb.addEventListener('change', () => {
      if (rb.checked) setViewMode(rb.dataset.viewMode);
    });
  });

  if (viewModeQuickBtn) {
    viewModeQuickBtn.addEventListener('click', () => {
      const idx = VIEW_MODE_ORDER.indexOf(viewMode);
      const next = VIEW_MODE_ORDER[(idx + 1) % VIEW_MODE_ORDER.length];
      setViewMode(next);
    });
  }

  bindInlineAlarmInput(windowCompactAlarmBtn, windowCompactAlarmInlineInput);
  bindInlineAlarmInput(hudCompactAlarmBtn, hudCompactAlarmInlineInput);

  if (compactAlarmKInput) {
    const applyMenuK = () => {
      const raw = compactAlarmKInput.value.trim();
      setCompactAlarmK(raw === '' ? 0 : parseFloat(raw));
    };
    compactAlarmKInput.addEventListener('change', applyMenuK);
    compactAlarmKInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyMenuK();
        compactAlarmKInput.blur();
      }
    });
  }
  if (compactAlarmOffBtn) {
    compactAlarmOffBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setCompactAlarmK(0);
    });
  }
  updateCompactAlarmUi();

  document.querySelectorAll('[data-section-toggle]').forEach((cb) => {
    cb.addEventListener('change', () => {
      sectionVisibility[cb.dataset.sectionToggle] = cb.checked;
      saveJsonPref('token_meter_sections', sectionVisibility);
      applySectionStates();
    });
  });

  document.querySelectorAll('[data-field-toggle]').forEach((cb) => {
    cb.addEventListener('change', () => {
      telemetryFields[cb.dataset.fieldToggle] = cb.checked;
      saveJsonPref('token_meter_telemetry_fields', telemetryFields);
      renderTelemetryList();
    });
  });

  function updateCompactAllBtn() {
    if (!compactAllBtn) return;
    compactAllBtn.classList.toggle('active', defaultItemsCompact);
    compactAllBtn.setAttribute('aria-pressed', String(defaultItemsCompact));
    compactAllBtn.title = defaultItemsCompact
      ? 'Expand all telemetry items (new items auto-compact is ON)'
      : 'Compact all telemetry items (also auto-compacts new items)';
  }

  if (compactAllBtn) {
    compactAllBtn.addEventListener('click', () => {
      defaultItemsCompact = !defaultItemsCompact;
      itemCompactOverrides.clear();
      saveCompacted();
      updateCompactAllBtn();
      renderTelemetryList();
    });
  }

  updateCompactAllBtn();
  applySectionStates();

  // Telemetry Item Click / Keyboard Toggle
  function toggleItem(el) {
    const key = el?.dataset?.key;
    if (!key) return;
    if (itemCompactOverrides.has(key)) itemCompactOverrides.delete(key);
    else itemCompactOverrides.add(key);
    saveCompacted();
    const isCompact = isItemCompact(key);
    el.classList.toggle('compact', isCompact);
    el.setAttribute('aria-expanded', String(!isCompact));
    el.title = `Click to ${isCompact ? 'expand' : 'compact'}`;
  }

  if (telemetryList) {
    let currentHoveredPrompt = null;
    telemetryList.addEventListener('pointerover', (e) => {
      const item = e.target.closest('.step-item[data-prompt]');
      const pNum = item?.dataset?.prompt || null;
      if (pNum === currentHoveredPrompt) return;
      if (currentHoveredPrompt) {
        telemetryList.querySelectorAll(`.step-item[data-prompt="${currentHoveredPrompt}"]`).forEach(el => el.classList.remove('group-hovered'));
      }
      currentHoveredPrompt = pNum;
      if (pNum) {
        telemetryList.querySelectorAll(`.step-item[data-prompt="${pNum}"]`).forEach(el => el.classList.add('group-hovered'));
      }
    });
    telemetryList.addEventListener('pointerleave', () => {
      if (currentHoveredPrompt) {
        telemetryList.querySelectorAll(`.step-item[data-prompt="${currentHoveredPrompt}"]`).forEach(el => el.classList.remove('group-hovered'));
        currentHoveredPrompt = null;
      }
    });

    telemetryList.addEventListener('click', (e) => {
      if (window.getSelection && String(window.getSelection()).length) return;
      toggleItem(e.target.closest('.telemetry-item'));
    });
    telemetryList.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const item = e.target.closest('.telemetry-item');
      if (!item) return;
      e.preventDefault();
      toggleItem(item);
    });
  }

  if (viewPromptBtn) {
    viewPromptBtn.addEventListener('click', () => {
      activeView = 'prompt';
      localStorage.setItem('token_meter_view', 'prompt');
      updateToggleButtons();
      renderTelemetryList();
    });
  }

  if (viewStepBtn) {
    viewStepBtn.addEventListener('click', () => {
      activeView = 'step';
      localStorage.setItem('token_meter_view', 'step');
      updateToggleButtons();
      renderTelemetryList();
    });
  }

  // Copy Markdown Summary
  if (copyMarkdownBtn) {
    copyMarkdownBtn.addEventListener('click', () => {
      if (!currentTelemetry) return;
      const t = currentTelemetry;
      const ctx = t.liveContext || {};
      const lat = t.latestTurn || {};
      const cum = t.cumulative || {};

      const md = [
        `### 📊 Active Chat Context & Token Meter`,
        `- **Active Model:** ${lat.modelDisplayName || t.activeModel?.displayName || 'Unknown'}${t.isMultiModel ? ` (Multi-model session: ${t.sessionModels.join(', ')})` : ''}`,
        `- **Live Context Window:** ${formatNum(ctx.activeTokens)} / ${formatNum(ctx.maxLimit)} tokens (${ctx.consumptionPct}% used, ${formatNum(ctx.remainingTokens)} free)`,
        `- **Latest Turn (#${lat.turnNumber}):**`,
        `  - Model: ${lat.modelDisplayName || 'Unknown'}`,
        `  - Input: ${formatNum(lat.inputTokens)} tokens`,
        `  - Cache Read: ${formatNum(lat.cacheReadTokens)} tokens (${lat.cacheEfficiencyPct}% cache reuse)`,
        `  - Output: ${formatNum(lat.outputTokens)} tokens (Reasoning/Thinking: ${formatNum(lat.thinkingTokens)}, Output: ${formatNum(lat.responseTokens)})`,
        `- **Session Cumulative (${cum.totalTurns} turns):**`,
        `  - Total Processed: ${formatNum(cum.totalProcessedTokens)} tokens`,
        `  - Tool Calls: ${formatNum(t.toolCalls?.totalCalls || 0)}`,
        `  - Cache Efficiency: ${cum.overallCacheSavingsPct}% overall reuse rate`,
        ctx.compactionCount > 0 ? `- **Compaction Events:** ${ctx.compactionCount} history compaction checkpoints` : null
      ].filter(Boolean).join('\n');

      navigator.clipboard.writeText(md).then(() => {
        const origText = copyMarkdownBtn.textContent.trim();
        copyMarkdownBtn.textContent = 'Copied!';
        setTimeout(() => {
          copyMarkdownBtn.textContent = origText;
        }, 1800);
      }).catch(err => {
        console.error('Clipboard copy failed:', err);
      });
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      if (activeTab === 'global') fetchGlobalUsage();
      else fetchTelemetry();
    });
  }

  // Initial load & polling
  fetchTelemetry();
  fetchGlobalUsage();
  setInterval(() => {
    if (activeTab !== 'global') fetchTelemetry();
  }, POLL_MS);

  // Tick live "Last chat: X ago" & lifespan status every 1s
  setInterval(() => {
    if (activeTab === 'session' && currentTelemetry) renderCacheLifespanStrip();
  }, 1000);

  // Background quota-cycle monitor (checks every 60s so 100% auto-snapshots fire even while on Session tab)
  setInterval(() => {
    fetchGlobalUsage();
  }, 60000);
})();
