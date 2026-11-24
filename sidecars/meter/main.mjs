/**
 * Token & Context Meter - Sidecar Backend.
 *
 * Runs as a native Antigravity sidecar docked inside the auxiliary panel.
 * Serves the interactive telemetry dashboard and provides live token metrics.
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getConversationTokenTelemetry, getModelLimits } from './telemetry.mjs';
import {
  getGlobalUsage,
  getGlobalLogAudit,
  saveGlobalSnapshot,
  resetGlobalUsage,
  deleteGlobalSnapshot,
  importGlobalData,
  takeAllToLog,
  takeConvoToLog
} from './global-store.mjs';

function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`Invalid JSON: ${e.message}`)); }
    });
    req.on('error', reject);
  });
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const STATIC_FILES = {
  '/styles.css': ['styles.css', 'text/css'],
  '/app.js': ['app.js', 'application/javascript']
};

let SidecarApp = null;
let SidecarResponse = null;

try {
  const sdk = await import('sidecar_sdk');
  SidecarApp = sdk.SidecarApp;
  SidecarResponse = sdk.Response;
} catch {
  // If bare specifier didn't resolve directly, try direct path to central SDK
  try {
    const sdkPath = join(homedir(), '.gemini', 'config', 'node_modules', 'sidecar_sdk', 'index.mjs');
    const directSdk = await import(pathToFileURL(sdkPath).href);
    SidecarApp = directSdk.SidecarApp;
    SidecarResponse = directSdk.Response;
  } catch (err) {
    console.warn('Sidecar SDK not found, using standalone HTTP server fallback.');
  }
}

// Check if running inside Antigravity sidecar environment
const hasSidecarEnv = Boolean(
  process.env.ANTIGRAVITY_LS_ADDRESS &&
  process.env.ANTIGRAVITY_CSRF_TOKEN &&
  process.env.ANTIGRAVITY_SIDECAR_WEB_PORT
);

if (SidecarApp && hasSidecarEnv) {
  // --- RUN VIA OFFICIAL SIDECAR SDK ---
  const app = new SidecarApp();

  app.page('/', () => {
    return readFileSync(join(__dirname, 'index.html'), 'utf-8');
  });

  for (const [route, [file, mimeType]] of Object.entries(STATIC_FILES)) {
    app.api(route, () => {
      const content = readFileSync(join(__dirname, file), 'utf-8');
      return new SidecarResponse(content, { contentType: mimeType });
    }, 'GET');
  }

  app.api('/api/tokens', async (data) => {
    try {
      const convId = data?.conversationId || null;
      return await getConversationTokenTelemetry(convId);
    } catch (err) {
      return { error: err.message };
    }
  }, 'GET');

  app.api('/api/models', async () => {
    try {
      return await getModelLimits();
    } catch (err) {
      return { error: err.message };
    }
  }, 'GET');

  app.api('/api/global', async () => {
    try {
      return await getGlobalUsage();
    } catch (err) {
      return { error: err.message };
    }
  }, 'GET');

  app.api('/api/global/snapshot', async (data) => {
    try {
      return await saveGlobalSnapshot(data?.name || '');
    } catch (err) {
      return { error: err.message };
    }
  }, 'POST');

  app.api('/api/global/reset', async () => {
    try {
      return await resetGlobalUsage();
    } catch (err) {
      return { error: err.message };
    }
  }, 'POST');

  app.api('/api/global/snapshot/delete', async (data) => {
    try {
      return await deleteGlobalSnapshot(data?.id || '');
    } catch (err) {
      return { error: err.message };
    }
  }, 'POST');

  app.api('/api/global/import', async (data) => {
    try {
      return await importGlobalData(data);
    } catch (err) {
      return { error: err.message };
    }
  }, 'POST');

  app.api('/api/global/audit', async (data) => {
    try {
      const cap5h = data?.cap5h ? Number(data.cap5h) : null;
      return await getGlobalLogAudit({ cap5hTokens: Number.isFinite(cap5h) ? cap5h : null });
    } catch (err) {
      return { error: err.message };
    }
  }, 'GET');

  app.api('/api/global/take', async (data) => {
    try {
      if (data?.mode === 'convo' || data?.cascadeId) {
        return await takeConvoToLog(data?.cascadeId || null);
      }
      return await takeAllToLog();
    } catch (err) {
      return { error: err.message };
    }
  }, 'POST');

  app.run();
  console.log(`[TokenContextMeter] Sidecar initialized on port ${process.env.ANTIGRAVITY_SIDECAR_WEB_PORT}`);
} else {
  // --- RUN VIA STANDALONE HTTP SERVER FALLBACK ---
  const port = parseInt(process.env.PORT || process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || '51337', 10);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    // Restrict CORS to local or sidecar origins only
    const origin = req.headers.origin || '';
    if (!origin || /^(https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?|sidecar:\/\/)/i.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin || `http://127.0.0.1:${port}`);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(join(__dirname, 'index.html'), 'utf-8'));
      return;
    }

    if (STATIC_FILES[url.pathname]) {
      const [file, mime] = STATIC_FILES[url.pathname];
      res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` });
      res.end(readFileSync(join(__dirname, file), 'utf-8'));
      return;
    }

    if (url.pathname === '/api/tokens') {
      try {
        const convId = url.searchParams.get('conversationId') || null;
        const telemetry = await getConversationTokenTelemetry(convId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(telemetry));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname === '/api/models') {
      try {
        const models = await getModelLimits();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(models));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname === '/api/global' && req.method === 'GET') {
      try {
        const data = await getGlobalUsage();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname === '/api/global/snapshot' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const data = await saveGlobalSnapshot(body?.name || '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname === '/api/global/reset' && req.method === 'POST') {
      try {
        const data = await resetGlobalUsage();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname === '/api/global/snapshot/delete' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const data = await deleteGlobalSnapshot(body?.id || '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname === '/api/global/import' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const data = await importGlobalData(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname === '/api/global/audit' && req.method === 'GET') {
      try {
        const capParam = url.searchParams.get('cap5h');
        const cap5h = capParam ? Number(capParam) : null;
        const data = await getGlobalLogAudit({ cap5hTokens: Number.isFinite(cap5h) ? cap5h : null });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname === '/api/global/take' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const data = (body?.mode === 'convo' || body?.cascadeId)
          ? await takeConvoToLog(body?.cascadeId || null)
          : await takeAllToLog();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[TokenContextMeter] Standalone server running at http://127.0.0.1:${port}`);
  });
}
