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
  const expandedToolNames = new Set();
  const expandedSnapshotIds = new Set();
  const expandedQuotaPoolIds = new Set();
  const expandedQuotaModelNames = new Set();

  // Telemetry item compaction: default mode + per-item overrides
  let defaultItemsCompact = localStorage.getItem('token_meter_items_default_compact') === 'true';
  let itemCompactOverrides = new Set();
  try {
    itemCompactOverrides = new Set(JSON.parse(localStorage.getItem('token_meter_compacted_overrides') || '[]'));
  } catch {}
  function saveCompacted() {
    try {
      localStorage.setItem('token_meter_items_default_compact', String(defaultItemsCompact));
      localStorage.setItem('token_meter_compacted_overrides', JSON.stringify([...itemCompactOverrides].slice(-200)));
    } catch {}
  }
  function itemKey(kind, num) {
    return `${currentTelemetry?.cascadeId || 'active'}:${kind}:${num}`;
  }
  function isItemCompact(key) {
    return defaultItemsCompact ? !itemCompactOverrides.has(key) : itemCompactOverrides.has(key);
  }

  // Persisted UI preferences: visible sections, compacted sections, telemetry fields
  const DEFAULT_SECTIONS = { windowUtil: true, quotas: true, activeTurn: true, genOutput: true, sessionTotals: true, telemetry: true };
  const DEFAULT_SECTION_COMPACT = { windowUtil: false, quotas: false, activeTurn: false, genOutput: false, sessionTotals: false, telemetry: false };
  const DEFAULT_TELEMETRY_FIELDS = { model: true, chat: true, calls: true, cache: true };

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
  const windowRatioVal = document.getElementById('windowRatioVal');
  const contextProgressBar = document.getElementById('contextProgressBar');
  const activeTokensVal = document.getElementById('activeTokensVal');
  const remainingTokensVal = document.getElementById('remainingTokensVal');
  const modelNameBadge = document.getElementById('modelNameBadge');
  const multiModelBadge = document.getElementById('multiModelBadge');

  const compactionAlert = document.getElementById('compactionAlert');
  const compactionTitle = document.getElementById('compactionTitle');
  const compactionDesc = document.getElementById('compactionDesc');

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

    if (activeTokensVal) activeTokensVal.textContent = `${formatNum(activeTok)} active`;
    remainingTokensVal.textContent = `${formatCompactNum(remTok)} free`;
    remainingTokensVal.title = `${formatNum(remTok)} tokens free`;

    // Compaction Alert
    if (ctx.compactionCount > 0) {
      compactionAlert.style.display = 'block';
      compactionTitle.textContent = `Context Compaction Active (${ctx.compactionCount} Checkpoints)`;
      const lastC = ctx.compactions[ctx.compactions.length - 1];
      compactionDesc.textContent = `Compacted at Turn #${lastC.turnIndex}, saving ${formatNum(lastC.tokensSaved)} tokens from earlier history.`;
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

    // Telemetry List
    updateToggleButtons();
    renderTelemetryList();
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
      lastChatAgoVal.textContent = elapsedMs != null ? `Last chat: ${formatDurationShort(elapsedMs)} ago` : 'Last chat: —';
    }

    if (!cacheLifespanStat) return;
    cacheLifespanStat.classList.remove('warm', 'expiring', 'cold');

    if (!stat || stat.status === 'no_data') {
      cacheLifespanStat.textContent = 'No lifespan data yet';
      cacheLifespanStrip.title = 'Waiting for same-model chat-to-chat gaps ≥ 30s (ignores short bursts & tool loops)';
      return;
    }

    const parts = [];
    if (stat.maxWarmGapMs != null) parts.push(`Max warm gap: ${formatDurationShort(stat.maxWarmGapMs)}`);
    if (stat.minColdGapMs != null) parts.push(`Min cold gap: ${formatDurationShort(stat.minColdGapMs)}`);
    parts.push(`Chat-to-chat samples (≥30s): ${stat.sampleCount}`);
    if (stat.isPersisted) parts.push('Storage: Learned across chats (persisted in account store)');
    cacheLifespanStrip.title = parts.join('\n');

    const sampleTag = stat.isPersisted ? `${stat.sampleCount} across chats` : `${stat.sampleCount}`;

    if (stat.status === 'bracketed') {
      cacheLifespanStat.textContent = `TTL ~${formatDurationShort(stat.maxWarmGapMs)}–${formatDurationShort(stat.minColdGapMs)} (${sampleTag})`;
      if (elapsedMs != null) {
        if (elapsedMs >= stat.minColdGapMs) cacheLifespanStat.classList.add('cold');
        else if (elapsedMs >= stat.maxWarmGapMs) cacheLifespanStat.classList.add('expiring');
        else cacheLifespanStat.classList.add('warm');
      }
    } else if (stat.status === 'lower_bound') {
      cacheLifespanStat.textContent = `TTL ≥ ${formatDurationShort(stat.maxWarmGapMs)} (${sampleTag})`;
      if (elapsedMs != null && elapsedMs <= stat.maxWarmGapMs) {
        cacheLifespanStat.classList.add('warm');
      }
    } else if (stat.status === 'upper_bound') {
      cacheLifespanStat.textContent = `TTL < ${formatDurationShort(stat.minColdGapMs)} (${sampleTag})`;
      if (elapsedMs != null && elapsedMs >= stat.minColdGapMs) {
        cacheLifespanStat.classList.add('cold');
      }
    }
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
      if (matched.length) list = matched;
    }

    if (!list.length) {
      containerEl.innerHTML = `<div class="empty-state">No quota pool data reported by Antigravity.</div>`;
      return;
    }

    containerEl.innerHTML = list.map(p => {
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
                      <span class="routing-pill ${getModelPillClass(m.model)}">${escapeHtml(m.model)}</span>
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

      return `
        <div class="quota-pool-item${isOpen ? ' expanded' : ''}" data-pool-id="${escapeHtml(p.poolId)}" title="Click to expand per-1% token breakdown & estimates">
          <div class="quota-pool-top">
            <span class="quota-pool-left">
              <span class="quota-pool-label">${escapeHtml(p.label)}</span>
              <span class="quota-win-pill ${p.windowType === 'weekly' ? 'weekly' : ''}">${winTag}</span>
            </span>
            <span class="meta-strong" style="color: ${barColor}">${used.toFixed(1)}% used</span>
          </div>
          <div class="quota-pool-bar">
            <div class="quota-pool-fill" style="width: ${used}%; background: ${barColor}"></div>
          </div>
          <div class="quota-pool-sub">
            <span>${p.remainingPct.toFixed(1)}% left</span>
            <span>${escapeHtml(subRight)}</span>
          </div>
          <div class="quota-pool-details">${detailsHtml}</div>
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
      if (telemetryCompactVal) telemetryCompactVal.textContent = `· ${filtered.length} step${filtered.length === 1 ? '' : 's'}`;

      const totalPages = Math.ceil(filtered.length / TELEMETRY_PAGE_SIZE) || 1;
      if (telemetryStepPage > totalPages) telemetryStepPage = totalPages;
      if (telemetryStepPage < 1) telemetryStepPage = 1;

      const pagedItems = filtered.slice((telemetryStepPage - 1) * TELEMETRY_PAGE_SIZE, telemetryStepPage * TELEMETRY_PAGE_SIZE);
      renderStepList(pagedItems);
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

  function renderLedgerRows(rows) {
    return `<div class="item-ledger">${rows.map(r => `
      <div class="item-ledger-row">
        <span class="item-ledger-key"><span class="item-ledger-dot ${r.dot}"></span>${escapeHtml(r.label)}</span>
        <span class="item-ledger-val ${r.valClass || ''}">${escapeHtml(r.value)}</span>
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
      const previewText = p.userPromptPreview ? truncate(p.userPromptPreview, 26) : '';
      const cacheClass = getCacheBadgeClass(p.cacheEfficiencyPct);
      const key = itemKey('prompt', p.promptNumber);
      const isCompact = isItemCompact(key);

      let routingHtml = '';
      if (telemetryFields.model && p.modelsUsedShort && p.modelsUsedShort.length > 0) {
        routingHtml = p.modelsUsedShort.map(m =>
          `<span class="routing-pill ${getModelPillClass(m)}" title="${escapeHtml(m)}">${escapeHtml(m)}</span>`
        ).join('<span class="routing-arrow">→</span>');
      }

      const showChatPrimary = telemetryFields.chat && Boolean(previewText);
      const promoteModelToTop = !showChatPrimary && Boolean(routingHtml);
      const hasLeadingItem = showChatPrimary || promoteModelToTop;
      const callsText = `${p.llmCallsCount} call${p.llmCallsCount === 1 ? '' : 's'}`;
      const showAnyField = showChatPrimary || Boolean(routingHtml) || telemetryFields.calls || telemetryFields.cache;

      const cacheLine = formatCacheStatusLine(p.gapSincePrevPromptMs, p.promptCacheStatus, p.cachedModelShort || p.modelsUsedShort?.[0], p.prevPromptModelShort);
      const cacheDot = (p.promptCacheStatus === 'warm_hit' || p.promptCacheStatus === 'cross_model_hit') ? 'dot-cache' : 'dot-total';
      const ledgerHtml = renderLedgerRows([
        { dot: 'dot-input', label: 'New Input', value: formatNum(p.newInput) },
        { dot: 'dot-cache', label: 'Cache Read', value: formatNum(p.cacheRead), valClass: 'val-cache' },
        { dot: 'dot-think', label: 'Thinking', value: formatNum(p.thinking), valClass: 'val-think' },
        { dot: 'dot-output', label: 'Output', value: formatNum(p.output) },
        { dot: cacheDot, label: 'Cache', value: cacheLine },
        { dot: 'dot-total', label: 'Ending Context', value: `${formatCompactNum(p.endingContext)} (${p.endingContextPct}%)`, valClass: 'val-strong' }
      ]);

      return `
        <div class="telemetry-item${isCompact ? ' compact' : ''}" data-key="${escapeHtml(key)}" role="button" tabindex="0" aria-expanded="${!isCompact}" title="Click to ${isCompact ? 'expand' : 'compact'}">
          <div class="item-top-row">
            <div class="item-title">
              <span class="num-capsule${isLatest ? ' current' : ''}" title="${isLatest ? 'Current prompt' : `Prompt ${p.promptNumber}`}">${p.promptNumber}</span>
              ${showChatPrimary ? `<span class="prompt-preview" title="${escapeHtml(p.userPromptPreview)}">${escapeHtml(previewText)}</span>` : ''}
              ${promoteModelToTop ? `<span class="item-inline-routing">${routingHtml}</span>` : ''}
              ${telemetryFields.calls ? `<span class="calls-count">${hasLeadingItem ? '· ' : ''}${callsText}</span>` : ''}
            </div>
            ${telemetryFields.cache
              ? `<span class="item-cache-badge ${cacheClass}">${p.cacheEfficiencyPct}% cache</span>`
              : (!showAnyField ? `<span class="item-context">${p.endingContextPct}% ctx</span>` : '')}
          </div>
          ${!promoteModelToTop && routingHtml ? `<div class="item-routing-row">${routingHtml}</div>` : ''}
          ${ledgerHtml}
        </div>
      `;
    }).join('');
  }

  function renderStepList(turns) {
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

      // Grouping bracket logic: check adjacent turns in the list (turns is reverse-chronological)
      const curPrompt = t.promptNumber;
      const prevInList = i > 0 ? turns[i - 1] : null; // higher turnNumber
      const nextInList = i < turns.length - 1 ? turns[i + 1] : null; // lower turnNumber

      const hasPrevSame = curPrompt != null && prevInList && prevInList.promptNumber === curPrompt;
      const hasNextSame = curPrompt != null && nextInList && nextInList.promptNumber === curPrompt;

      const promptPreview = t.userPromptPreview ||
        (currentTelemetry?.prompts?.find(p => p.promptNumber === curPrompt)?.userPromptPreview) || '';
      const promptTitle = curPrompt != null
        ? `Prompt #${curPrompt}${promptPreview ? `: "${promptPreview}"` : ''}`
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
        groupClass += ` ${posClass}`;
        bracketHtml = `<span class="step-group-bracket" title="${escapeHtml(promptTitle)}" aria-label="${escapeHtml(promptTitle)}"></span>`;
      }

      const stepCacheLine = formatCacheStatusLine(t.gapSincePrevTurnMs, t.cacheStatus, modelLabel, t.prevModelShortName);
      const stepCacheDot = (t.cacheStatus === 'warm_hit' || t.cacheStatus === 'cross_model_hit') ? 'dot-cache' : 'dot-total';
      const ledgerHtml = renderLedgerRows([
        { dot: 'dot-input', label: 'New Input', value: formatNum(t.inputTokens) },
        { dot: 'dot-cache', label: 'Cache Read', value: formatNum(t.cacheReadTokens), valClass: 'val-cache' },
        { dot: 'dot-think', label: 'Thinking', value: formatNum(t.thinkingTokens), valClass: 'val-think' },
        { dot: 'dot-output', label: 'Output', value: formatNum(t.outputTokens) },
        { dot: stepCacheDot, label: 'Cache', value: stepCacheLine },
        { dot: 'dot-total', label: 'Total Turn', value: formatNum(t.totalTurnTokens), valClass: 'val-strong' }
      ]);

      return `
        <div class="telemetry-item step-item${groupClass}${isCompact ? ' compact' : ''}" data-key="${escapeHtml(key)}"${promptDataAttr} role="button" tabindex="0" aria-expanded="${!isCompact}" title="Click to ${isCompact ? 'expand' : 'compact'}">
          ${bracketHtml}
          <div class="item-top-row">
            <div class="item-title">
              <span class="num-capsule" title="Turn ${t.turnNumber}">${t.turnNumber}</span>
              ${telemetryFields.chat ? `<span class="step-indices" title="${escapeHtml(stepRange.title)}">Step ${escapeHtml(stepRange.label)}</span>` : ''}
              ${telemetryFields.model ? `<span class="routing-pill ${getModelPillClass(modelLabel)}" title="${escapeHtml(modelFullName)}">${escapeHtml(modelLabel)}</span>` : ''}
            </div>
            ${telemetryFields.cache
              ? `<span class="item-cache-badge ${cacheClass}">${t.cacheEfficiencyPct}% cache</span>`
              : (!showAnyField ? `<span class="item-context">${formatCompactNum(t.totalTurnTokens)}</span>` : '')}
          </div>
          ${ledgerHtml}
        </div>
      `;
    }).join('');
  }

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
  function applySectionStates() {
    document.querySelectorAll('[data-section]').forEach((sec) => {
      const key = sec.dataset.section;
      const visible = sectionVisibility[key] !== false;
      const compact = Boolean(sectionCompact[key]);
      sec.classList.toggle('hidden', !visible);
      sec.classList.toggle('compact', compact);
      if (sec.classList.contains('compactable-section')) {
        sec.setAttribute('aria-expanded', String(!compact));
        sec.title = `Click to ${compact ? 'expand' : 'compact'}`;
      }
    });
    if (telemetryHeaderToggle) {
      const compact = Boolean(sectionCompact.telemetry);
      telemetryHeaderToggle.setAttribute('aria-expanded', String(!compact));
      telemetryHeaderToggle.title = `Click to ${compact ? 'expand' : 'compact'} Telemetry`;
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

  document.querySelectorAll('.compactable-section').forEach((sec) => {
    sec.addEventListener('click', (e) => {
      if (window.getSelection && String(window.getSelection()).length) return;
      if (e.target.closest('button, input, label, select, .popover-menu, .tool-tree-toggle, .tool-tree-list, .quota-pool-item')) return;
      toggleSectionCompact(sec.dataset.section);
    });
    sec.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.target !== sec) return;
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
