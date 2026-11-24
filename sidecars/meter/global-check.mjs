/**
 * Read-Only Audit Engine & CLI (`npm run global:check` / `npm run global:take`).
 *
 * Queries `global-log.db` read-only (never mutates `events`) to compute:
 * - Per-`user_id` / per-`userdata_key` + Overall splits
 * - Exact 5-hour rolling window + 5-hour negative / quota correlation
 * - Exact 7-day rolling window by UTC date, model, and workspace
 * - `agy-fast` inner tool statistics (`batch_search`, `apply_edits`, `read_slices`, `quick_outline`, `run_checks`)
 * - Terminal summary, `--json`, `--web` static HTML report, and `--verify` integrity checks
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  closeLogDb,
  openLogDb,
  readEvents,
  resolveLogDbPath,
  verifyLogDb
} from './log-db.mjs';
import { takeAll, takeConvo } from './ingest.mjs';

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const QUOTA_WEEKLY_THRESHOLD_HOURS = 8;

function emptyTokenTotals() {
  return {
    turns: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    thinkingOutputTokens: 0,
    responseOutputTokens: 0,
    totalProcessedTokens: 0
  };
}

function addTokenTotals(target, u) {
  target.turns += 1;
  const inp = Number(u.inputTokens || 0);
  const cac = Number(u.cacheReadTokens || 0);
  const out = Number(u.outputTokens || 0);
  const thk = Number(u.thinkingOutputTokens || 0);
  const rsp = Number(u.responseOutputTokens || 0) || Math.max(0, out - thk);
  target.inputTokens += inp;
  target.cacheReadTokens += cac;
  target.outputTokens += out;
  target.thinkingOutputTokens += thk;
  target.responseOutputTokens += rsp;
  target.totalProcessedTokens += inp + cac + out;
}

function emptyAgyFastStats() {
  return {
    totalCalls: 0,
    batch_search: {
      calls: 0,
      totalQueries: 0,
      avgBatchSize: 0,
      byType: {},
      outputModes: {},
      multiline: 0,
      includeBodyFalse: 0,
      hasGlob: 0,
      hasFileType: 0,
      sortByMtime: 0
    },
    apply_edits: {
      calls: 0,
      fileCount: 0,
      hunkCount: 0,
      guardedHunkCount: 0,
      targetHunkCount: 0,
      replaceAllCount: 0,
      createCount: 0,
      deleteCount: 0,
      moveCount: 0,
      dryRunCalls: 0,
      bestEffortCalls: 0,
      verifyCalls: 0,
      errorCalls: 0,
      errorRatePct: '0.0'
    },
    read_slices: {
      calls: 0,
      outlineCount: 0,
      sliceFileCount: 0,
      rangeCount: 0,
      lineRangesShorthandCount: 0
    },
    quick_outline: {
      calls: 0,
      pathCount: 0
    },
    run_checks: {
      calls: 0,
      commandCount: 0,
      byOutputMode: {}
    }
  };
}

function accumulateAgyFast(stats, inner, status) {
  if (!inner || !inner.tool) return;
  stats.totalCalls += 1;

  if (inner.tool === 'batch_search') {
    const b = stats.batch_search;
    b.calls += 1;
    b.totalQueries += Number(inner.batch_size || 0);
    b.avgBatchSize = b.calls > 0 ? Number((b.totalQueries / b.calls).toFixed(2)) : 0;
    for (const [k, v] of Object.entries(inner.by_type || {})) {
      b.byType[k] = (b.byType[k] || 0) + Number(v || 0);
    }
    for (const [k, v] of Object.entries(inner.output_modes || {})) {
      b.outputModes[k] = (b.outputModes[k] || 0) + Number(v || 0);
    }
    b.multiline += Number(inner.multiline || 0);
    b.includeBodyFalse += Number(inner.include_body_false || 0);
    b.hasGlob += Number(inner.has_glob || 0);
    b.hasFileType += Number(inner.has_file_type || 0);
    b.sortByMtime += Number(inner.sort_by_mtime || 0);
  } else if (inner.tool === 'apply_edits') {
    const a = stats.apply_edits;
    a.calls += 1;
    a.fileCount += Number(inner.file_count || 0);
    a.hunkCount += Number(inner.hunk_count || 0);
    a.guardedHunkCount += Number(inner.guarded_hunk_count || 0);
    a.targetHunkCount += Number(inner.target_hunk_count || 0);
    a.replaceAllCount += Number(inner.replace_all_count || 0);
    a.createCount += Number(inner.create_count || 0);
    a.deleteCount += Number(inner.delete_count || 0);
    a.moveCount += Number(inner.move_count || 0);
    if (inner.dry_run) a.dryRunCalls += 1;
    if (inner.best_effort) a.bestEffortCalls += 1;
    if (inner.has_verify) a.verifyCalls += 1;
    const st = String(status || '').toLowerCase();
    if (st.includes('error') || st.includes('fail')) a.errorCalls += 1;
    a.errorRatePct = a.calls > 0 ? ((a.errorCalls / a.calls) * 100).toFixed(1) : '0.0';
  } else if (inner.tool === 'read_slices') {
    const r = stats.read_slices;
    r.calls += 1;
    r.outlineCount += Number(inner.outline_count || 0);
    r.sliceFileCount += Number(inner.slice_file_count || 0);
    r.rangeCount += Number(inner.range_count || 0);
    r.lineRangesShorthandCount += Number(inner.line_ranges_shorthand_count || 0);
  } else if (inner.tool === 'quick_outline') {
    const q = stats.quick_outline;
    q.calls += 1;
    q.pathCount += Number(inner.path_count || 0);
  } else if (inner.tool === 'run_checks') {
    const c = stats.run_checks;
    c.calls += 1;
    c.commandCount += Number(inner.command_count || 0);
    const om = String(inner.output_mode || 'compact');
    c.byOutputMode[om] = (c.byOutputMode[om] || 0) + 1;
  }
}

function summarizeQuotaSnapshots(quotaEvents, window5hTotals, cap5hTokens) {
  const latest = quotaEvents.length ? quotaEvents[quotaEvents.length - 1] : null;
  const earliest = quotaEvents.length ? quotaEvents[0] : null;
  const pools5h = [];

  if (latest?.payload?.models) {
    const seenSig = new Set();
    for (const m of latest.payload.models) {
      const qi = m.quotaInfo;
      if (!qi || qi.remainingFraction === undefined || !qi.resetTime) continue;
      const resetMs = Date.parse(qi.resetTime);
      if (Number.isNaN(resetMs)) continue;
      const hoursUntilReset = (resetMs - latest.tsMs) / 3600000;
      const windowType = hoursUntilReset > QUOTA_WEEKLY_THRESHOLD_HOURS ? 'weekly' : '5h';
      const remFrac = Math.min(1, Math.max(0, Number(qi.remainingFraction)));
      const sig = `${windowType}|${Math.round(resetMs / 60000)}|${remFrac.toFixed(4)}`;
      if (seenSig.has(sig)) continue;
      seenSig.add(sig);

      const usedPct = Number(((1 - remFrac) * 100).toFixed(1));
      const remainingPct = Number((remFrac * 100).toFixed(1));

      let earliestRemFrac = null;
      if (earliest && earliest !== latest && earliest.payload?.models) {
        const match = earliest.payload.models.find(em => em.modelKey === m.modelKey);
        if (match?.quotaInfo?.remainingFraction !== undefined) {
          earliestRemFrac = Math.min(1, Math.max(0, Number(match.quotaInfo.remainingFraction)));
        }
      }
      const deltaUsedPct = (earliestRemFrac !== null && earliestRemFrac > remFrac)
        ? Number(((earliestRemFrac - remFrac) * 100).toFixed(2))
        : null;
      const burnPer1PctTokens = (deltaUsedPct && deltaUsedPct >= 0.05 && window5hTotals.totalProcessedTokens > 0)
        ? Math.round(window5hTotals.totalProcessedTokens / deltaUsedPct)
        : null;

      pools5h.push({
        windowType,
        sampleModel: m.displayName || m.modelKey,
        remainingPct,
        usedPct,
        resetTime: qi.resetTime,
        deltaUsedPct,
        burnPer1PctTokens
      });
    }
  }

  let capAnalysis = null;
  if (cap5hTokens != null && Number.isFinite(Number(cap5hTokens)) && Number(cap5hTokens) > 0) {
    const cap = Number(cap5hTokens);
    const used = window5hTotals.totalProcessedTokens;
    const remaining = cap - used;
    capAnalysis = {
      cap5hTokens: cap,
      usedTokens: used,
      remainingBudgetTokens: remaining,
      negativeTokens: remaining < 0 ? Math.abs(remaining) : 0,
      isNegative: remaining < 0,
      utilizationPct: Number(((used / cap) * 100).toFixed(2))
    };
  }

  return {
    snapshotCount: quotaEvents.length,
    latestSnapshotTsMs: latest?.tsMs || null,
    pools: pools5h,
    capAnalysis
  };
}

function createAuditBucket(label, meta = {}) {
  return {
    ...meta,
    label,
    eventCount: 0,
    promptCount: 0,
    toolCallCount: 0,
    window5h: {
      totals: emptyTokenTotals(),
      byModel: {},
      quotaEvents: []
    },
    window7d: {
      totals: emptyTokenTotals(),
      byDay: {},
      byModel: {},
      byWorkspace: {}
    },
    allTimeTurns: emptyTokenTotals(),
    agyFast: emptyAgyFastStats()
  };
}

function applyEventToBucket(bucket, ev, cutoff5hMs, cutoff7dMs, nowMs) {
  bucket.eventCount += 1;

  if (ev.kind === 'prompt.boundary') {
    bucket.promptCount += 1;
    return;
  }

  if (ev.kind === 'tool.call') {
    bucket.toolCallCount += 1;
    if (ev.payload?.inner) {
      accumulateAgyFast(bucket.agyFast, ev.payload.inner, ev.payload?.status);
    }
    return;
  }

  if (ev.kind === 'quota.snapshot') {
    if (ev.tsMs >= cutoff5hMs && ev.tsMs <= nowMs) {
      bucket.window5h.quotaEvents.push(ev);
    }
    return;
  }

  if (ev.kind === 'turn.usage') {
    const u = ev.payload?.usage || {};
    const mName = ev.payload?.modelDisplayName || 'Default Model';
    const ws = ev.workspace || '(unspecified)';

    addTokenTotals(bucket.allTimeTurns, u);

    if (ev.tsMs >= cutoff5hMs && ev.tsMs <= nowMs) {
      addTokenTotals(bucket.window5h.totals, u);
      if (!bucket.window5h.byModel[mName]) bucket.window5h.byModel[mName] = emptyTokenTotals();
      addTokenTotals(bucket.window5h.byModel[mName], u);
    }

    if (ev.tsMs >= cutoff7dMs && ev.tsMs <= nowMs) {
      addTokenTotals(bucket.window7d.totals, u);
      const day = new Date(ev.tsMs).toISOString().slice(0, 10);
      if (!bucket.window7d.byDay[day]) bucket.window7d.byDay[day] = emptyTokenTotals();
      addTokenTotals(bucket.window7d.byDay[day], u);

      if (!bucket.window7d.byModel[mName]) bucket.window7d.byModel[mName] = emptyTokenTotals();
      addTokenTotals(bucket.window7d.byModel[mName], u);

      if (!bucket.window7d.byWorkspace[ws]) bucket.window7d.byWorkspace[ws] = emptyTokenTotals();
      addTokenTotals(bucket.window7d.byWorkspace[ws], u);
    }
  }
}

function finalizeBucket(bucket, cap5hTokens) {
  const quota = summarizeQuotaSnapshots(bucket.window5h.quotaEvents, bucket.window5h.totals, cap5hTokens);
  return {
    label: bucket.label,
    ...(bucket.userId !== undefined ? { userId: bucket.userId } : {}),
    ...(bucket.userdataKey !== undefined ? { userdataKey: bucket.userdataKey } : {}),
    eventCount: bucket.eventCount,
    promptCount: bucket.promptCount,
    toolCallCount: bucket.toolCallCount,
    window5h: {
      totals: bucket.window5h.totals,
      byModel: bucket.window5h.byModel,
      quota
    },
    window7d: {
      totals: bucket.window7d.totals,
      byDay: Object.fromEntries(Object.entries(bucket.window7d.byDay).sort((a, b) => a[0].localeCompare(b[0]))),
      byModel: bucket.window7d.byModel,
      byWorkspace: bucket.window7d.byWorkspace
    },
    allTimeTurns: bucket.allTimeTurns,
    agyFast: bucket.agyFast
  };
}

/**
 * Computes read-only audit statistics from `global-log.db`.
 */
export function computeGlobalAudit(db, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const cutoff5hMs = nowMs - (opts.window5hMs ?? FIVE_HOURS_MS);
  const cutoff7dMs = nowMs - (opts.window7dMs ?? SEVEN_DAYS_MS);
  const cap5hTokens = opts.cap5hTokens ?? null;

  const events = readEvents(db, {
    userId: opts.userId || null,
    userdataKey: opts.userdataKey || null,
    maxSeq: opts.maxSeq ?? null
  });

  const overall = createAuditBucket('overall');
  const byUserMap = new Map();
  const byUserdataMap = new Map();
  const byAccountMap = new Map();

  for (const ev of events) {
    applyEventToBucket(overall, ev, cutoff5hMs, cutoff7dMs, nowMs);

    const uid = ev.userId || 'local-default';
    const ukey = ev.userdataKey || 'desktop:default';
    const acctKey = `${uid}::${ukey}`;

    if (!byUserMap.has(uid)) byUserMap.set(uid, createAuditBucket(uid, { userId: uid }));
    applyEventToBucket(byUserMap.get(uid), ev, cutoff5hMs, cutoff7dMs, nowMs);

    if (!byUserdataMap.has(ukey)) byUserdataMap.set(ukey, createAuditBucket(ukey, { userdataKey: ukey }));
    applyEventToBucket(byUserdataMap.get(ukey), ev, cutoff5hMs, cutoff7dMs, nowMs);

    if (!byAccountMap.has(acctKey)) {
      byAccountMap.set(acctKey, createAuditBucket(acctKey, { userId: uid, userdataKey: ukey }));
    }
    applyEventToBucket(byAccountMap.get(acctKey), ev, cutoff5hMs, cutoff7dMs, nowMs);
  }

  const maxSeq = events.length ? events[events.length - 1].seq : 0;

  return {
    generatedAt: new Date(nowMs).toISOString(),
    nowMs,
    cutoff5hMs,
    cutoff7dMs,
    maxSeq,
    totalEvents: events.length,
    overall: finalizeBucket(overall, cap5hTokens),
    byUser: Array.from(byUserMap.values()).map(b => finalizeBucket(b, cap5hTokens)),
    byUserdata: Array.from(byUserdataMap.values()).map(b => finalizeBucket(b, cap5hTokens)),
    byAccount: Array.from(byAccountMap.values()).map(b => finalizeBucket(b, cap5hTokens))
  };
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function fmtCompact(n) {
  const num = Number(n || 0);
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
  return String(num);
}

export function formatAuditTerminal(audit, verifyResult = null) {
  const lines = [];
  const o = audit.overall;
  lines.push(`=== Procontext Global Append-Log Audit (${audit.generatedAt}) ===`);
  lines.push(`Events: ${fmtNum(audit.totalEvents)} | Max Seq: ${audit.maxSeq}`);
  lines.push('');

  lines.push(`[Overall 5-Hour Window]`);
  lines.push(
    `  Turns: ${o.window5h.totals.turns} | Processed: ${fmtCompact(o.window5h.totals.totalProcessedTokens)} ` +
    `(In: ${fmtCompact(o.window5h.totals.inputTokens)}, Cache: ${fmtCompact(o.window5h.totals.cacheReadTokens)}, Out: ${fmtCompact(o.window5h.totals.outputTokens)})`
  );
  if (o.window5h.quota.capAnalysis) {
    const c = o.window5h.quota.capAnalysis;
    lines.push(
      `  5h Budget: ${fmtCompact(c.usedTokens)} / ${fmtCompact(c.cap5hTokens)} (${c.utilizationPct}%)` +
      (c.isNegative ? ` | NEGATIVE OVERAGE: -${fmtCompact(c.negativeTokens)}` : ` | Remaining: ${fmtCompact(c.remainingBudgetTokens)}`)
    );
  }
  for (const p of o.window5h.quota.pools) {
    lines.push(
      `  Pool [${p.windowType}] ${p.sampleModel}: ${p.usedPct}% used (${p.remainingPct}% left)` +
      (p.burnPer1PctTokens ? ` | Burn/1%: ${fmtCompact(p.burnPer1PctTokens)}` : '')
    );
  }
  lines.push('');

  lines.push(`[Overall 7-Day Window]`);
  lines.push(
    `  Turns: ${o.window7d.totals.turns} | Processed: ${fmtCompact(o.window7d.totals.totalProcessedTokens)}`
  );
  for (const [day, dTot] of Object.entries(o.window7d.byDay)) {
    lines.push(`  ${day}: ${dTot.turns}t | ${fmtCompact(dTot.totalProcessedTokens)}`);
  }
  lines.push('');

  if (audit.byAccount.length > 0) {
    lines.push(`[Per-User / Per-Userdata Splits]`);
    for (const acct of audit.byAccount) {
      lines.push(
        `  ${acct.userId} (${acct.userdataKey}): ` +
        `5h=${fmtCompact(acct.window5h.totals.totalProcessedTokens)} (${acct.window5h.totals.turns}t), ` +
        `7d=${fmtCompact(acct.window7d.totals.totalProcessedTokens)} (${acct.window7d.totals.turns}t), ` +
        `prompts=${acct.promptCount}, tools=${acct.toolCallCount}`
      );
    }
    lines.push('');
  }

  const af = o.agyFast;
  lines.push(`[agy-fast Inner Telemetry (${af.totalCalls} calls)]`);
  lines.push(
    `  batch_search: ${af.batch_search.calls} calls, ${af.batch_search.totalQueries} queries (avg ${af.batch_search.avgBatchSize}/call)` +
    (Object.keys(af.batch_search.byType).length ? ` | types: ${JSON.stringify(af.batch_search.byType)}` : '')
  );
  lines.push(
    `  apply_edits: ${af.apply_edits.calls} calls, ${af.apply_edits.fileCount} files, ` +
    `${af.apply_edits.hunkCount} hunks (guarded=${af.apply_edits.guardedHunkCount}, target=${af.apply_edits.targetHunkCount}), ` +
    `verify=${af.apply_edits.verifyCalls}, err=${af.apply_edits.errorRatePct}%`
  );
  lines.push(
    `  read_slices: ${af.read_slices.calls} calls (outlines=${af.read_slices.outlineCount}, ranges=${af.read_slices.rangeCount})`
  );
  lines.push(`  quick_outline: ${af.quick_outline.calls} calls (${af.quick_outline.pathCount} paths)`);
  lines.push(`  run_checks: ${af.run_checks.calls} calls (${af.run_checks.commandCount} cmds)`);

  if (verifyResult) {
    lines.push('');
    lines.push(`[DB Integrity Verification]`);
    lines.push(`  OK: ${verifyResult.ok} | Triggers: update=${verifyResult.triggers?.trg_events_no_update}, delete=${verifyResult.triggers?.trg_events_no_delete}`);
    lines.push(`  Migrations: ${verifyResult.migrations?.map(m => `v${m.version}`).join(', ')}`);
    lines.push(`  Prefix Checksum (seq <= ${verifyResult.prefixSeq}): ${verifyResult.prefixChecksumSha256}`);
  }

  return lines.join('\n');
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderAuditHtml(audit, verifyResult = null) {
  const o = audit.overall;
  const acctRows = audit.byAccount.map(a => `
    <tr>
      <td>${escapeHtml(a.userId)}</td>
      <td><code>${escapeHtml(a.userdataKey)}</code></td>
      <td>${a.window5h.totals.turns}</td>
      <td>${fmtCompact(a.window5h.totals.totalProcessedTokens)}</td>
      <td>${a.window7d.totals.turns}</td>
      <td>${fmtCompact(a.window7d.totals.totalProcessedTokens)}</td>
      <td>${a.agyFast.totalCalls}</td>
    </tr>
  `).join('');

  const dayRows = Object.entries(o.window7d.byDay).map(([d, tot]) => `
    <tr>
      <td>${escapeHtml(d)}</td>
      <td>${tot.turns}</td>
      <td>${fmtCompact(tot.inputTokens)}</td>
      <td>${fmtCompact(tot.cacheReadTokens)}</td>
      <td>${fmtCompact(tot.outputTokens)}</td>
      <td>${fmtCompact(tot.totalProcessedTokens)}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Procontext Global Append-Log Audit</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #0f1419; color: #e6edf3; margin: 24px auto; max-width: 1040px; padding: 0 16px; }
  h1, h2 { color: #79c0ff; margin-bottom: 8px; }
  .meta { color: #8b949e; font-size: 13px; margin-bottom: 20px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 14px; }
  .card .label { color: #8b949e; font-size: 12px; text-transform: uppercase; }
  .card .val { font-size: 22px; font-weight: 700; margin-top: 4px; }
  .neg { color: #ff7b72; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0 24px; background: #161b22; border: 1px solid #30363d; }
  th, td { padding: 8px 10px; border-bottom: 1px solid #21262d; text-align: left; font-size: 13px; }
  th { background: #1f242c; color: #8b949e; }
  code { background: #21262d; padding: 2px 5px; border-radius: 4px; }
</style>
</head>
<body>
  <h1>Procontext Global Append-Log Audit</h1>
  <div class="meta">Generated ${escapeHtml(audit.generatedAt)} · Total Events: ${fmtNum(audit.totalEvents)} · Max Seq: ${audit.maxSeq}${verifyResult ? ` · Checksum: <code>${escapeHtml(verifyResult.prefixChecksumSha256.slice(0, 16))}…</code>` : ''}</div>

  <div class="cards">
    <div class="card"><div class="label">5h Processed</div><div class="val">${fmtCompact(o.window5h.totals.totalProcessedTokens)}</div></div>
    <div class="card"><div class="label">5h Turns</div><div class="val">${o.window5h.totals.turns}</div></div>
    <div class="card"><div class="label">7d Processed</div><div class="val">${fmtCompact(o.window7d.totals.totalProcessedTokens)}</div></div>
    <div class="card"><div class="label">agy-fast Calls</div><div class="val">${o.agyFast.totalCalls}</div></div>
    ${o.window5h.quota.capAnalysis ? `<div class="card"><div class="label">5h Cap Status</div><div class="val ${o.window5h.quota.capAnalysis.isNegative ? 'neg' : ''}">${o.window5h.quota.capAnalysis.isNegative ? `-${fmtCompact(o.window5h.quota.capAnalysis.negativeTokens)}` : fmtCompact(o.window5h.quota.capAnalysis.remainingBudgetTokens)}</div></div>` : ''}
  </div>

  <h2>Per-User / Per-Userdata Splits</h2>
  <table>
    <thead><tr><th>User ID</th><th>Userdata Key</th><th>5h Turns</th><th>5h Tokens</th><th>7d Turns</th><th>7d Tokens</th><th>agy-fast Calls</th></tr></thead>
    <tbody>${acctRows || '<tr><td colspan="7">No events recorded.</td></tr>'}</tbody>
  </table>

  <h2>7-Day Daily Breakdown</h2>
  <table>
    <thead><tr><th>UTC Day</th><th>Turns</th><th>Input</th><th>Cache Read</th><th>Output</th><th>Total Processed</th></tr></thead>
    <tbody>${dayRows || '<tr><td colspan="6">No turns in last 7 days.</td></tr>'}</tbody>
  </table>

  <h2>agy-fast Inner Statistics</h2>
  <pre><code>${escapeHtml(JSON.stringify(o.agyFast, null, 2))}</code></pre>
</body>
</html>`;
}

function parseCliArgs(argv) {
  const args = argv.slice(2);
  let subcommand = 'check';
  let idx = 0;
  if (args[0] === 'take' || args[0] === 'check') {
    subcommand = args[0];
    idx = 1;
  }

  const flags = {
    all: false,
    full: false,
    json: false,
    verify: false,
    web: null,
    session: null,
    db: null,
    user: null,
    userdata: null,
    cap5h: null,
    seq: null
  };

  for (let i = idx; i < args.length; i++) {
    const a = args[i];
    if (a === '--all') flags.all = true;
    else if (a === '--full') flags.full = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--verify') flags.verify = true;
    else if (a === '--session') flags.session = args[++i] || null;
    else if (a === '--db') flags.db = args[++i] || null;
    else if (a === '--user') flags.user = args[++i] || null;
    else if (a === '--userdata') flags.userdata = args[++i] || null;
    else if (a === '--cap-5h') flags.cap5h = Number(args[++i]);
    else if (a === '--seq') flags.seq = Number(args[++i]);
    else if (a === '--web') {
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags.web = next;
        i += 1;
      } else {
        flags.web = join(
          homedir(),
          '.gemini',
          'config',
          'plugins',
          'token-context-meter',
          'global-check-report.html'
        );
      }
    }
  }

  return { subcommand, flags };
}

async function runCli() {
  const { subcommand, flags } = parseCliArgs(process.argv);

  if (subcommand === 'take') {
    if (flags.session) {
      const res = await takeConvo({
        cascadeId: flags.session,
        userdataKey: flags.userdata || 'desktop:default',
        dbPath: flags.db
      });
      console.log(flags.json ? JSON.stringify(res, null, 2) : `Captured convo ${res.cascadeId}: +${res.inserted} events (${res.turnCount} turns, ${res.stepCount} steps)`);
      return;
    }

    const res = await takeAll({
      dbPath: flags.db,
      fullArchive: flags.full
    });
    console.log(
      flags.json
        ? JSON.stringify(res, null, 2)
        : `Take All (${res.userId}): scanned ${res.conversationsScanned} convos across [${res.roots.join(', ')}], +${res.inserted} events (${res.ignored} deduped, ${res.errors} errors)`
    );
    return;
  }

  const dbPath = resolveLogDbPath(flags.db);
  const db = await openLogDb({ dbPath, readonly: true });
  if (!db) {
    const emptyMsg = { error: `No log database found at ${dbPath}`, dbPath };
    console.log(flags.json ? JSON.stringify(emptyMsg, null, 2) : emptyMsg.error);
    process.exitCode = 1;
    return;
  }

  try {
    const audit = computeGlobalAudit(db, {
      cap5hTokens: Number.isFinite(flags.cap5h) ? flags.cap5h : null,
      userId: flags.user,
      userdataKey: flags.userdata,
      maxSeq: Number.isFinite(flags.seq) ? flags.seq : null
    });
    const verifyResult = flags.verify
      ? verifyLogDb(db, { maxSeq: Number.isFinite(flags.seq) ? flags.seq : null })
      : null;

    if (flags.web) {
      const outPath = resolve(flags.web);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, renderAuditHtml(audit, verifyResult), 'utf-8');
      if (!flags.json) {
        console.log(`Web report written to ${outPath}`);
      }
    }

    if (flags.json) {
      console.log(JSON.stringify(verifyResult ? { ...audit, verify: verifyResult } : audit, null, 2));
    } else {
      console.log(formatAuditTerminal(audit, verifyResult));
    }

    if (verifyResult && !verifyResult.ok) {
      process.exitCode = 1;
    }
  } finally {
    closeLogDb(db);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  runCli().catch((err) => {
    console.error('[global-check] Fatal:', err.message);
    process.exit(1);
  });
}
