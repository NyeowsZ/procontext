import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendEvents,
  closeLogDb,
  normalizeEvent,
  openLogDb,
  readEvents,
  sanitizeSmallData,
  truncatePrompt,
  verifyLogDb
} from '../sidecars/meter/log-db.mjs';
import {
  importLegacyStore,
  ingestConversation,
  mapQuotaSnapshot,
  mapTrajectoryEvents,
  mapUserSnapshot,
  takeConvo
} from '../sidecars/meter/ingest.mjs';
import { computeGlobalAudit } from '../sidecars/meter/global-check.mjs';

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'procontext-log-test-'));
}

test('append-only triggers, idempotent event_uid, and prefix checksums', async () => {
  const dir = makeTempDir();
  const dbPath = join(dir, 'global-log.db');
  const db = await openLogDb({ dbPath });
  assert.ok(db, 'openLogDb should return a DatabaseSync instance');

  try {
    const ev1 = {
      event_uid: 'turn:desktop:default:c1:0',
      schema_ver: 1,
      producer_ver: '1.0.2',
      kind: 'turn.usage',
      ts_ms: 1_700_000_000_000,
      user_id: 'alice@example.com',
      userdata_key: 'desktop:default',
      cascade_id: 'c1',
      workspace: 'ws-a',
      payload: {
        turnIndex: 0,
        modelDisplayName: 'Gemini 4 Flash',
        usage: { inputTokens: 100, cacheReadTokens: 400, outputTokens: 50 }
      }
    };

    const r1 = appendEvents(db, [ev1]);
    assert.equal(r1.inserted, 1);
    assert.equal(r1.ignored, 0);

    // Duplicate event_uid is ignored
    const r2 = appendEvents(db, [ev1]);
    assert.equal(r2.inserted, 0);
    assert.equal(r2.ignored, 1);

    // UPDATE and DELETE must abort via triggers
    assert.throws(() => {
      db.prepare('UPDATE events SET ts_ms = 0 WHERE seq = 1').run();
    }, /append-only/);
    assert.throws(() => {
      db.prepare('DELETE FROM events WHERE seq = 1').run();
    }, /append-only/);

    const verify1 = verifyLogDb(db, { maxSeq: 1 });
    assert.equal(verify1.ok, true);
    assert.equal(verify1.triggers.trg_events_no_update, true);
    assert.equal(verify1.triggers.trg_events_no_delete, true);
    assert.ok(verify1.migrations.length >= 2);

    // Appending later events never changes seq <= 1 prefix checksum ("1% of past is always 1% of past")
    appendEvents(db, [{
      ...ev1,
      event_uid: 'turn:desktop:default:c1:1',
      ts_ms: 1_700_000_060_000,
      payload: { ...ev1.payload, turnIndex: 1 }
    }]);
    const verifyPrefixAfter = verifyLogDb(db, { maxSeq: 1 });
    assert.equal(verifyPrefixAfter.prefixChecksumSha256, verify1.prefixChecksumSha256);
    assert.equal(verifyPrefixAfter.totalEvents, 2);
  } finally {
    closeLogDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('truncatePrompt caps to 5-10 words / <=100 chars and masks tokens', () => {
  const raw = 'Please inspect sk-abc1234567890SECRET and ghp_1234567890abcdef1234 in our authentication router right away today please';
  const res = truncatePrompt(raw, { maxWords: 10, maxChars: 100 });

  assert.equal(res.prompt_words, 13);
  assert.equal(res.prompt_chars, raw.length);
  assert.equal(res.prompt_sha256.length, 16);
  assert.ok(res.prompt_preview.length <= 100);
  assert.ok(!res.prompt_preview.includes('sk-abc1234567890SECRET'));
  assert.ok(!res.prompt_preview.includes('ghp_1234567890abcdef1234'));
  assert.ok(res.prompt_preview.includes('[REDACTED]'));
  const previewWords = res.prompt_preview.replace(/…$/, '').trim().split(/\s+/);
  assert.ok(previewWords.length <= 10);
});

test('sanitizeSmallData preserves small extras while stripping secrets and summarizing blobs', () => {
  const input = {
    tierId: 'pro_v2',
    isEligible: true,
    creditsRemaining: 42.5,
    csrfToken: 'super-secret-csrf',
    apiKey: 'AIzaSyD-1234567890abcdef',
    nested: {
      authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
      region: 'us-central1'
    },
    hugeStdout: 'x'.repeat(1024),
    manyItems: Array.from({ length: 50 }, (_, i) => i)
  };

  const out = sanitizeSmallData(input);
  assert.equal(out.tierId, 'pro_v2');
  assert.equal(out.isEligible, true);
  assert.equal(out.creditsRemaining, 42.5);
  assert.equal(out.csrfToken, undefined);
  assert.equal(out.apiKey, undefined);
  assert.equal(out.nested.authorization, undefined);
  assert.equal(out.nested.region, 'us-central1');
  assert.equal(out.hugeStdout._omitted, true);
  assert.equal(out.manyItems._omitted, true);
  assert.equal(out.manyItems.count, 50);
});

test('RPC mappers, agy-fast inner stats, user/userdata separation, and exact 5h/7d audit math', async () => {
  const dir = makeTempDir();
  const dbPath = join(dir, 'global-log.db');
  const db = await openLogDb({ dbPath });

  try {
    const nowMs = Date.UTC(2026, 10, 25, 12, 0, 0);
    const tWithin5h = nowMs - 60 * 60 * 1000;
    const tWithin7dOlder = nowMs - 2 * 24 * 60 * 60 * 1000;
    const tOlderThan7d = nowMs - 10 * 24 * 60 * 60 * 1000;

    const uSnap = mapUserSnapshot({
      userStatus: {
        email: 'Alice@Example.com',
        name: 'Alice',
        planStatus: { planInfo: { planName: 'Pro', tierBadge: 'ultra' }, monthlyCredits: 900 },
        csrfToken: 'secret-should-drop'
      },
      userdataKey: 'desktop:default',
      userdataPath: '/home/alice/.gemini/antigravity',
      tsMs: tWithin5h
    });
    assert.equal(uSnap.user_id, 'alice@example.com');
    assert.equal(uSnap.payload.extras.planStatus.monthlyCredits, 900);
    assert.equal(uSnap.payload.extras.csrfToken, undefined);

    const qSnapStart = mapQuotaSnapshot({
      modelsResponse: {
        response: {
          regionTag: 'global-fast',
          models: {
            'gemini-4-flash': {
              displayName: 'Gemini 4 Flash',
              maxTokens: 1048576,
              maxOutputTokens: 65536,
              quotaInfo: {
                remainingFraction: 0.90,
                resetTime: new Date(nowMs + 3 * 3600_000).toISOString(),
                poolTier: '5h'
              }
            }
          }
        }
      },
      userId: 'alice@example.com',
      userdataKey: 'desktop:default',
      tsMs: nowMs - 2 * 3600_000
    });

    const qSnapEnd = mapQuotaSnapshot({
      modelsResponse: {
        response: {
          regionTag: 'global-fast',
          models: {
            'gemini-4-flash': {
              displayName: 'Gemini 4 Flash',
              maxTokens: 1048576,
              maxOutputTokens: 65536,
              quotaInfo: {
                remainingFraction: 0.80,
                resetTime: new Date(nowMs + 3 * 3600_000).toISOString(),
                poolTier: '5h'
              }
            }
          }
        }
      },
      userId: 'alice@example.com',
      userdataKey: 'desktop:default',
      tsMs: tWithin5h
    });

    const trajAlice = mapTrajectoryEvents({
      cascadeId: 'casc-alice-1',
      userId: 'alice@example.com',
      userdataKey: 'desktop:default',
      workspace: 'c:/work/repo-a',
      trajectoryResp: {
        trajectory: {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_USER_INPUT',
              status: 'DONE',
              metadata: { createdAt: new Date(tWithin5h - 5000).toISOString(), source: 'chat' },
              userInput: { userResponse: 'Search symbols and apply guarded edit to server file cleanly now' }
            },
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'DONE',
              metadata: { createdAt: new Date(tWithin5h - 2000).toISOString(), completedAt: new Date(tWithin5h).toISOString() },
              plannerResponse: {
                toolCalls: [
                  {
                    name: 'mcp_agy-fast-nyeowsz_fast_batch_search',
                    status: 'DONE',
                    argumentsJson: JSON.stringify({
                      queries: [
                        { type: 'symbol', pattern: 'openLogDb' },
                        { type: 'regex', pattern: 'WAL', outputMode: 'files_with_matches', multiline: true }
                      ]
                    })
                  },
                  {
                    name: 'mcp_agy-fast-nyeowsz_fast_apply_edits',
                    status: 'DONE',
                    argumentsJson: JSON.stringify({
                      verify: 'npm test',
                      edits: [
                        {
                          path: 'a.mjs',
                          hunks: [
                            { startLine: 1, endLine: 5, anchorStart: 'a', anchorEnd: 'b', replacement: 'c' },
                            { target: 'old', replacement: 'new', replaceAll: true }
                          ]
                        }
                      ]
                    })
                  },
                  {
                    name: 'invoke_subagent',
                    status: 'DONE',
                    argumentsJson: JSON.stringify({ TypeName: 'research', Role: 'Verifier' })
                  }
                ]
              }
            },
            {
              type: 'CORTEX_STEP_TYPE_TOOL_RESULT',
              metadata: { createdAt: new Date(tWithin5h + 1000).toISOString() },
              subagentId: '11111111-2222-3333-4444-555555555555'
            }
          ],
          generatorMetadata: [
            {
              stepIndices: [1],
              chatModel: {
                modelDisplayName: 'Gemini 4 Flash',
                responseModel: 'gemini-4-flash',
                usage: {
                  inputTokens: '1000',
                  cacheReadTokens: '4000',
                  outputTokens: '500',
                  thinkingOutputTokens: '200',
                  responseOutputTokens: '300',
                  extraRateFlag: 'cached_tier_1'
                }
              }
            }
          ]
        }
      }
    });

    const trajBob = mapTrajectoryEvents({
      cascadeId: 'casc-bob-1',
      userId: 'bob@example.com',
      userdataKey: 't3:bob-work',
      workspace: 'c:/work/repo-b',
      trajectoryResp: {
        trajectory: {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              metadata: { createdAt: new Date(tWithin7dOlder).toISOString(), completedAt: new Date(tWithin7dOlder).toISOString() },
              plannerResponse: { toolCalls: [] }
            },
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              metadata: { createdAt: new Date(tOlderThan7d).toISOString(), completedAt: new Date(tOlderThan7d).toISOString() },
              plannerResponse: { toolCalls: [] }
            }
          ],
          generatorMetadata: [
            {
              stepIndices: [0],
              chatModel: {
                modelDisplayName: 'Claude 4 Sonnet',
                usage: { inputTokens: '2000', cacheReadTokens: '0', outputTokens: '400' }
              }
            },
            {
              stepIndices: [1],
              chatModel: {
                modelDisplayName: 'Claude 4 Sonnet',
                usage: { inputTokens: '9000', cacheReadTokens: '0', outputTokens: '1000' }
              }
            }
          ]
        }
      }
    });

    appendEvents(db, [uSnap, qSnapStart, qSnapEnd, ...trajAlice.events, ...trajBob.events]);

    // Check frozen schema_ver=1 normalization & subagent link
    const toolEvents = readEvents(db, { kind: 'tool.call' });
    assert.equal(toolEvents.length, 3);
    assert.equal(toolEvents[0].payload.inner.tool, 'batch_search');
    assert.equal(toolEvents[0].payload.inner.by_type.symbol, 1);
    assert.equal(toolEvents[0].payload.inner.by_type.regex, 1);
    assert.equal(toolEvents[1].payload.inner.guarded_hunk_count, 1);
    assert.equal(toolEvents[1].payload.inner.target_hunk_count, 1);
    assert.equal(toolEvents[1].payload.inner.has_verify, true);
    assert.equal(toolEvents[2].payload.childCascadeId, '11111111-2222-3333-4444-555555555555');

    // Audit with 5h cap < Alice's 5500 tokens -> 5h negative overage
    const audit = computeGlobalAudit(db, { nowMs, cap5hTokens: 5000 });
    assert.equal(audit.overall.window5h.totals.turns, 1);
    assert.equal(audit.overall.window5h.totals.totalProcessedTokens, 5500);
    assert.equal(audit.overall.window5h.quota.capAnalysis.isNegative, true);
    assert.equal(audit.overall.window5h.quota.capAnalysis.negativeTokens, 500);
    // 10% quota drop across snapshots in 5h window => 550 tokens per 1%
    assert.equal(audit.overall.window5h.quota.pools[0].burnPer1PctTokens, 550);

    // 7d includes Alice (5500) + Bob's 2d-ago turn (2400) = 7900, excluding Bob's 10d-ago turn (10000)
    assert.equal(audit.overall.window7d.totals.turns, 2);
    assert.equal(audit.overall.window7d.totals.totalProcessedTokens, 7900);
    assert.equal(audit.overall.allTimeTurns.totalProcessedTokens, 17900);

    // User & userdata separation
    assert.equal(audit.byAccount.length, 2);
    const aliceAudit = audit.byAccount.find(a => a.userId === 'alice@example.com');
    const bobAudit = audit.byAccount.find(a => a.userId === 'bob@example.com');
    assert.equal(aliceAudit.userdataKey, 'desktop:default');
    assert.equal(aliceAudit.window5h.totals.totalProcessedTokens, 5500);
    assert.equal(bobAudit.userdataKey, 't3:bob-work');
    assert.equal(bobAudit.window5h.totals.totalProcessedTokens, 0);
    assert.equal(bobAudit.window7d.totals.totalProcessedTokens, 2400);

    // agy-fast stats
    assert.equal(audit.overall.agyFast.batch_search.calls, 1);
    assert.equal(audit.overall.agyFast.batch_search.totalQueries, 2);
    assert.equal(audit.overall.agyFast.apply_edits.guardedHunkCount, 1);
    assert.equal(audit.overall.agyFast.apply_edits.targetHunkCount, 1);
  } finally {
    closeLogDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('incremental cursor ingest, legacy import (schema_ver=0), takeConvo, and CLI --json/--verify/--web', async () => {
  const dir = makeTempDir();
  const dbPath = join(dir, 'global-log.db');
  const legacyPath = join(dir, 'usage-store.json');
  const webOutPath = join(dir, 'report.html');

  writeFileSync(legacyPath, JSON.stringify({
    version: 2,
    accounts: {
      'alice@example.com': {
        baselineAt: '2026-11-01T00:00:00.000Z',
        baseline: { totals: { totalProcessedTokens: 12000, totalTurns: 5 }, byModel: {} },
        snapshots: [{ id: 'snap_1', name: 'Old Snap', createdAt: '2026-11-10T00:00:00.000Z', totals: { totalProcessedTokens: 5000 } }]
      }
    }
  }), 'utf-8');

  const db = await openLogDb({ dbPath });
  try {
    const leg = importLegacyStore(db, { storePath: legacyPath, userdataKey: 'desktop:default' });
    assert.equal(leg.imported, 2);
    const legEvents = readEvents(db, { kind: 'legacy.import' });
    assert.equal(legEvents.length, 2);
    assert.equal(legEvents[0].schemaVer, 0);
    assert.equal(legEvents[0].payload.isLegacy, true);

    // Incremental ingest: 1 turn first, then 2 turns
    let turnCount = 1;
    const mockRpc = async (method) => {
      if (method === 'GetUserStatus') {
        return { userStatus: { email: 'alice@example.com', name: 'Alice' } };
      }
      if (method === 'GetAvailableModels') {
        return { response: { models: {} } };
      }
      if (method === 'GetCascadeTrajectory') {
        const turns = [];
        for (let i = 0; i < turnCount; i++) {
          turns.push({
            stepIndices: [i],
            chatModel: { modelDisplayName: 'Gemini 4 Flash', usage: { inputTokens: '100', cacheReadTokens: '0', outputTokens: '20' } }
          });
        }
        return {
          status: 'ACTIVE',
          trajectory: {
            steps: [{ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', metadata: { createdAt: new Date().toISOString() } }],
            generatorMetadata: turns
          }
        };
      }
      return {};
    };

    const inc1 = await ingestConversation({ db, cascadeId: 'c-inc', userId: 'alice@example.com', fileMtimeMs: 100, rpcFn: mockRpc });
    assert.equal(inc1.inserted, 1);

    // Same mtime -> skipped without RPC
    const incSame = await ingestConversation({ db, cascadeId: 'c-inc', userId: 'alice@example.com', fileMtimeMs: 100, rpcFn: mockRpc });
    assert.equal(incSame.skippedUnchanged, true);

    // Mtime bumped & turn 2 added -> only turn 2 appended
    turnCount = 2;
    const inc2 = await ingestConversation({ db, cascadeId: 'c-inc', userId: 'alice@example.com', fileMtimeMs: 200, rpcFn: mockRpc });
    assert.equal(inc2.inserted, 1);

    // takeConvo archives convo.archive marker
    const arch = await takeConvo({ cascadeId: 'c-inc', db, rpcFn: mockRpc });
    assert.equal(arch.ok, true);
    const archEvents = readEvents(db, { kind: 'convo.archive' });
    assert.equal(archEvents.length, 1);
    assert.equal(archEvents[0].payload.turnCount, 2);

    // Also test normalizeEvent directly on a frozen schema_ver=1 row
    const norm = normalizeEvent({
      seq: 99,
      event_uid: 'frozen:1',
      schema_ver: 1,
      producer_ver: '1.0.2',
      kind: 'turn.usage',
      ts_ms: 1700000000000,
      payload_json: JSON.stringify({ modelDisplayName: 'Test', usage: { inputTokens: 10, cacheReadTokens: 20, outputTokens: 5 } })
    });
    assert.equal(norm.payload.usage.totalProcessedTokens, 35);
  } finally {
    closeLogDb(db);
  }

  // Run CLI global-check with --json --verify --web
  const cliOut = execFileSync(
    process.execPath,
    ['sidecars/meter/global-check.mjs', 'check', '--db', dbPath, '--json', '--verify', '--web', webOutPath, '--cap-5h', '100'],
    { cwd: process.cwd(), encoding: 'utf-8' }
  );
  const parsed = JSON.parse(cliOut);
  assert.equal(parsed.verify.ok, true);
  assert.equal(parsed.overall.window5h.quota.capAnalysis.isNegative, true);
  assert.ok(existsSync(webOutPath));
  const html = readFileSync(webOutPath, 'utf-8');
  assert.ok(html.includes('Procontext Global Append-Log Audit'));

  rmSync(dir, { recursive: true, force: true });
});

test('version manifests and producer version stay aligned', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
  const plugin = JSON.parse(readFileSync('plugin.json', 'utf-8'));
  const serverSrc = readFileSync('mcp/server.mjs', 'utf-8');
  const logDbSrc = readFileSync('sidecars/meter/log-db.mjs', 'utf-8');
  const changelog = readFileSync('CHANGELOG.md', 'utf-8');

  assert.equal(plugin.version, pkg.version);
  assert.ok(serverSrc.includes(`version: '${pkg.version}'`));
  assert.ok(logDbSrc.includes(`PRODUCER_VERSION = '${pkg.version}'`));
  assert.ok(changelog.includes(`## [${pkg.version}]`));
});
