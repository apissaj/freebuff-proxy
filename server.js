/**
 * Freebuff Proxy — OpenAI-compatible proxy for Freebuff (Codebuff Cloud)
 *
 * Translates standard OpenAI chat-completions requests into Freebuff's
 * backend protocol (sessions → agent runs → upstream chat), giving you
 * free access to several frontier models through your own Freebuff account.
 *
 * Zero runtime dependencies — pure Node.js stdlib.
 * See README.md for full documentation.
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

// ── Configuration ────────────────────────────────────────────────────────────

const configPath =
  process.argv.find((a, i) => process.argv[i - 1] === '--config') ||
  'config.json';
const config = loadConfig(configPath);
const VERBOSE = process.argv.includes('--verbose');

/**
 * Freebuff requires this exact system marker on every request.
 * Requests already containing it (or a known variant) are left untouched.
 */
const FREEBUFF_MARKER = 'You are Buffy, the strategic coding assistant.';
const FREEBUFF_OPENINGS = [
  FREEBUFF_MARKER,
  'You are Buffy, the Freebuff Cloud project planner.',
  'You are Buffy, a strategic assistant that orchestrates complex coding tasks through specialized sub-agents.',
];

const MODEL_REFRESH_INTERVAL = 6 * 60 * 60 * 1000; // 6h
const SESSION_TTL = 60 * 60 * 1000; // 1h
const QUEUE_POLL_INTERVAL = 5000; // waiting-room poll
const MAX_RETRIES = 2;

let modelToAgent = {}; // model id → freebuff agent id
let allModels = [];
const tokenPools = [];
let nextPoolIdx = 0;

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  log('Freebuff Proxy starting...');
  for (let i = 0; i < config.AUTH_TOKENS.length; i++) {
    tokenPools.push(createTokenPool(config.AUTH_TOKENS[i], `token-${i + 1}`));
  }
  if (tokenPools.length === 0) {
    log('ERROR: No AUTH_TOKENS configured. Add your Freebuff token to config.json');
    process.exit(1);
  }
  await refreshModels();
  setInterval(refreshModels, MODEL_REFRESH_INTERVAL);

  const server = http.createServer(handleRequest);
  const port = parseInt(config.LISTEN_ADDR.replace(':', ''), 10) || 8080;

  // EADDRINUSE: exit silently if another instance already owns the port.
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log(`Port ${port} already in use — proxy is likely already running. Exiting silently.`);
      process.exit(0);
    }
    console.error('Fatal server error:', err);
    process.exit(1);
  });

  server.listen(port, () => {
    log(`Listening on http://localhost:${port}`);
    log(`Available models: ${allModels.join(', ') || '(none)'}`);
    log(`Token pools: ${tokenPools.length}`);
  });

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

// ── HTTP routing ─────────────────────────────────────────────────────────────

function handleRequest(req, res) {
  handleAsync(req, res).catch((err) => {
    log(`UNHANDLED ${req.method} ${req.url}: ${err.message}`);
    sendJSON(res, 500, { error: { message: err.message, type: 'server_error' } });
  });
}

async function handleAsync(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (config.API_KEYS.length > 0 && !isAuthorized(req)) {
    return sendJSON(res, 401, {
      error: { message: 'invalid api key', type: 'authentication_error' },
    });
  }

  if (url.pathname === '/healthz' && req.method === 'GET') {
    return sendJSON(res, 200, {
      ok: true,
      models: allModels.length,
      tokens: tokenPools.length,
    });
  }

  if (url.pathname === '/v1/models' && req.method === 'GET') {
    return sendJSON(res, 200, {
      object: 'list',
      data: allModels.map((m) => ({
        id: m,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'freebuff-proxy',
        root: m,
        permission: [],
      })),
    });
  }

  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    return await handleChatCompletions(req, res);
  }

  sendJSON(res, 404, {
    error: { message: 'not found', type: 'invalid_request_error' },
  });
}

function isAuthorized(req) {
  const apiKey = (req.headers['x-api-key'] || '').trim();
  if (apiKey && config.API_KEYS.includes(apiKey)) return true;
  const auth = (req.headers['authorization'] || '').trim();
  if (auth.startsWith('Bearer ')) {
    return config.API_KEYS.includes(auth.slice(7).trim());
  }
  return false;
}

// ── Chat completions ─────────────────────────────────────────────────────────

async function handleChatCompletions(req, res) {
  const body = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return sendJSON(res, 400, {
      error: { message: 'invalid JSON', type: 'invalid_request_error' },
    });
  }

  const requestedModel = (payload.model || '').trim();
  if (!requestedModel) {
    return sendJSON(res, 400, {
      error: { message: 'model is required', type: 'invalid_request_error' },
    });
  }

  const agentID = modelToAgent[requestedModel];
  if (!agentID) {
    return sendJSON(res, 400, {
      error: {
        message: `unsupported model "${requestedModel}". Available: ${allModels.join(', ')}`,
        type: 'invalid_request_error',
      },
    });
  }

  const stream = !!payload.stream;
  payload = injectFreebuffMarker(payload);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const pool = selectPool();
    if (!pool) {
      return sendJSON(res, 502, {
        error: { message: 'no healthy token pool', type: 'server_error' },
      });
    }

    let instanceId, runId;
    try {
      instanceId = await ensureSession(pool);
      if (!instanceId) {
        return sendJSON(res, 503, {
          error: { message: 'freebuff waiting room queued', type: 'server_error' },
        });
      }
      runId = await startRun(pool, agentID);
    } catch (err) {
      log(`[${pool.name}] setup error: ${err.message}`);
      if (attempt === MAX_RETRIES - 1) {
        return sendJSON(res, 502, {
          error: { message: err.message, type: 'server_error' },
        });
      }
      continue;
    }

    const upstreamBody = injectUpstreamMetadata(payload, requestedModel, runId, instanceId);
    const result = await sendUpstream(pool, '/api/v1/chat/completions', upstreamBody, stream, requestedModel, runId);

    if (result.shouldRetry) {
      log(`[${pool.name}] retrying (attempt ${attempt + 1}): ${result.reason}`);
      continue;
    }

    if (result.statusCode >= 200 && result.statusCode < 300) {
      log(`[${pool.name}] OK model=${requestedModel} run=${runId}`);
    }
    finishRun(pool, runId).catch(() => {});

    if (result.stream) {
      res.writeHead(result.statusCode, result.headers);
      result.body.pipe(res);
      return;
    }
    res.writeHead(result.statusCode, result.headers);
    res.end(result.body);
    return;
  }

  sendJSON(res, 502, {
    error: { message: 'upstream failed after retries', type: 'server_error' },
  });
}

function sendUpstream(pool, apiPath, body, stream, requestedModel, runId) {
  return new Promise((resolve) => {
    const url = new URL(apiPath, config.UPSTREAM_BASE_URL);
    const transport = url.protocol === 'https:' ? https : http;

    const req = transport.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        headers: {
          Authorization: `Bearer ${pool.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'freebuff-proxy/1.0',
        },
        timeout: parseDuration(config.REQUEST_TIMEOUT),
      },
      (upstreamResp) => {
        if (upstreamResp.statusCode < 400) {
          const ct = (upstreamResp.headers['content-type'] || '').toLowerCase();
          if (stream && ct.includes('text/event-stream')) {
            // Upstream is already SSE — pipe straight through.
            resolve({
              statusCode: upstreamResp.statusCode,
              headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
              },
              body: upstreamResp,
              stream: true,
              shouldRetry: false,
            });
          } else if (stream) {
            // Upstream returned JSON but client wants SSE — convert.
            const chunks = [];
            upstreamResp.on('data', (c) => chunks.push(c));
            upstreamResp.on('end', () => {
              const jsonBody = Buffer.concat(chunks).toString();
              const lines = `data: ${jsonBody}\n\ndata: [DONE]\n\n`;
              resolve({
                statusCode: 200,
                headers: {
                  'Content-Type': 'text/event-stream',
                  'Cache-Control': 'no-cache',
                },
                body: lines,
                stream: false,
                shouldRetry: false,
              });
            });
          } else {
            // Non-stream: accumulate SSE chunks or pass JSON through.
            const chunks = [];
            upstreamResp.on('data', (c) => chunks.push(c));
            upstreamResp.on('end', () => {
              const raw = Buffer.concat(chunks).toString();
              let jsonBody;
              if (ct.includes('text/event-stream')) {
                jsonBody = accumulateSSEToJSON(raw);
              } else {
                try {
                  jsonBody = JSON.stringify(JSON.parse(raw));
                } catch {
                  jsonBody = raw;
                }
              }
              resolve({
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: jsonBody,
                stream: false,
                shouldRetry: false,
              });
            });
          }
        } else {
          // Upstream error — inspect body to decide retry vs surface.
          const chunks = [];
          upstreamResp.on('data', (c) => chunks.push(c));
          upstreamResp.on('end', () => {
            const errBody = Buffer.concat(chunks).toString();
            const lower = errBody.toLowerCase();
            if (
              upstreamResp.statusCode === 400 &&
              (lower.includes('runid not found') || lower.includes('runid not running'))
            ) {
              pool.activeRun = null;
              resolve({ shouldRetry: true, reason: 'run invalid' });
              return;
            }
            if (
              ['freebuff_update_required', 'waiting_room_required', 'waiting_room_queued', 'session_superseded', 'session_expired'].some(
                (k) => errBody.includes(k),
              )
            ) {
              pool.session = null;
              resolve({ shouldRetry: true, reason: 'session invalid' });
              return;
            }
            resolve({
              statusCode: upstreamResp.statusCode,
              headers: { 'Content-Type': 'application/json' },
              body: errBody,
              stream: false,
              shouldRetry: false,
            });
          });
        }
      },
    );

    req.on('error', (err) =>
      resolve({
        statusCode: 502,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: { message: err.message, type: 'server_error' },
        }),
        stream: false,
        shouldRetry: false,
      }),
    );
    req.write(body);
    req.end();
  });
}

// ── Token pools & sessions ───────────────────────────────────────────────────

function createTokenPool(token, name) {
  return { name, token, session: null, activeRun: null, lastError: '', cooldownUntil: 0 };
}

function selectPool() {
  const now = Date.now();
  for (let i = 0; i < tokenPools.length; i++) {
    const idx = (nextPoolIdx + i) % tokenPools.length;
    if (tokenPools[idx].cooldownUntil > now) continue;
    nextPoolIdx = (idx + 1) % tokenPools.length;
    return tokenPools[idx];
  }
  return null;
}

async function ensureSession(pool) {
  const now = Date.now();
  if (pool.session && pool.session.status === 'active' && pool.session.instanceId) {
    if (!pool.session.expiresAt || pool.session.expiresAt > now + 5000) {
      return pool.session.instanceId;
    }
  }

  let resp;
  if (pool.session && pool.session.status === 'queued' && pool.session.instanceId) {
    resp = await sessionRequest('GET', pool.token, pool.session.instanceId);
  } else {
    resp = await sessionRequest('POST', pool.token);
  }

  for (let i = 0; i < 20; i++) {
    if (resp.status === 'active') {
      pool.session = {
        status: 'active',
        instanceId: resp.instanceId,
        expiresAt: resp.expiresAt ? new Date(resp.expiresAt).getTime() : now + SESSION_TTL,
      };
      log(`[${pool.name}] session active: ${resp.instanceId}`);
      return resp.instanceId;
    }
    if (resp.status === 'queued') {
      pool.session = {
        status: 'queued',
        instanceId: resp.instanceId,
        position: resp.position || 1,
        queueDepth: resp.queueDepth || 1,
      };
      log(`[${pool.name}] waiting room: pos ${resp.position}/${resp.queueDepth}`);
      const delay = Math.max(resp.estimatedWaitMs || QUEUE_POLL_INTERVAL, 1000);
      await sleep(Math.min(delay, QUEUE_POLL_INTERVAL));
      resp = await sessionRequest('GET', pool.token, resp.instanceId);
      continue;
    }
    if (['none', 'ended', 'superseded'].includes(resp.status)) {
      resp = await sessionRequest('POST', pool.token);
      continue;
    }
    if (resp.status === 'disabled') {
      log(`[${pool.name}] session disabled`);
      return null;
    }
    throw new Error(`unexpected session status: ${resp.status}`);
  }
  throw new Error('session loop exhausted');
}

function sessionRequest(method, authToken, instanceId) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/v1/freebuff/session', config.UPSTREAM_BASE_URL);
    const transport = url.protocol === 'https:' ? https : http;
    const headers = {
      Authorization: `Bearer ${authToken}`,
      Accept: 'application/json',
      'User-Agent': 'freebuff-proxy/1.0',
    };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    if (method === 'GET' && instanceId) headers['x-freebuff-instance-id'] = instanceId;

    const req = transport.request(
      {
        method,
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString();
          if (res.statusCode === 404) return resolve({ status: 'disabled' });
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`session ${res.statusCode}: ${body.slice(0, 200)}`));
          }
          try {
            const parsed = JSON.parse(body);
            if (typeof parsed.expiresAt === 'number') {
              parsed.expiresAt = new Date(parsed.expiresAt).toISOString();
            }
            resolve(parsed);
          } catch (e) {
            reject(new Error(`session parse: ${e.message}`));
          }
        });
      },
    );
    req.on('error', reject);
    if (method === 'POST') req.write('{}');
    req.end();
  });
}

function startRun(pool, agentId) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/v1/agent-runs', config.UPSTREAM_BASE_URL);
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        headers: {
          Authorization: `Bearer ${pool.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'freebuff-proxy/1.0',
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString();
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`start run ${res.statusCode}: ${body.slice(0, 200)}`));
          }
          try {
            const { runId } = JSON.parse(body);
            if (!runId) return reject(new Error('missing runId'));
            pool.activeRun = { runId, agentId, startedAt: Date.now() };
            log(`[${pool.name}] run started: ${runId} (agent: ${agentId})`);
            resolve(runId);
          } catch (e) {
            reject(new Error(`run parse: ${e.message}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(JSON.stringify({ action: 'START', agentId }));
    req.end();
  });
}

function finishRun(pool, runId) {
  return new Promise((resolve) => {
    const url = new URL('/api/v1/agent-runs', config.UPSTREAM_BASE_URL);
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        headers: {
          Authorization: `Bearer ${pool.token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'freebuff-proxy/1.0',
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve());
      },
    );
    req.on('error', () => resolve());
    req.write(
      JSON.stringify({
        action: 'FINISH',
        runId,
        status: 'completed',
        totalSteps: 1,
        directCredits: 0,
        totalCredits: 0,
      }),
    );
    req.end();
  });
}

// ── Freebuff marker & metadata ───────────────────────────────────────────────

function injectFreebuffMarker(payload) {
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) return payload;
  const first = payload.messages[0];
  if (first && first.role === 'system' && typeof first.content === 'string') {
    const trimmed = first.content.trimStart();
    if (FREEBUFF_OPENINGS.some((o) => trimmed.startsWith(o))) return payload;
    return {
      ...payload,
      messages: [
        { ...first, content: `${FREEBUFF_MARKER}\n\n${first.content}` },
        ...payload.messages.slice(1),
      ],
    };
  }
  return {
    ...payload,
    messages: [{ role: 'system', content: FREEBUFF_MARKER }, ...payload.messages],
  };
}

function injectUpstreamMetadata(payload, model, runId, instanceId) {
  const cloned = { ...payload };
  cloned.model = model;
  if (Array.isArray(cloned.messages)) {
    cloned.messages = cloned.messages.map((m) =>
      m && m.role === 'developer' ? { ...m, role: 'system' } : m,
    );
  }
  cloned.codebuff_metadata = {
    run_id: runId,
    cost_mode: 'free',
    client_id: crypto.randomUUID(),
    ...(instanceId ? { freebuff_instance_id: instanceId } : {}),
  };
  return JSON.stringify(cloned);
}

// ── Model registry ───────────────────────────────────────────────────────────

async function refreshModels() {
  try {
    const sourceURL =
      'https://raw.githubusercontent.com/CodebuffAI/codebuff/main/common/src/constants/free-agents.ts';
    const content = await httpGet(sourceURL);
    const parsed = parseFreeAgents(content);
    if (Object.keys(parsed).length > 0) {
      modelToAgent = parsed;
      allModels = Object.keys(parsed).sort();
      log(`Model registry refreshed: ${allModels.length} models from upstream`);
      return;
    }
  } catch (err) {
    log(`Model registry fetch failed: ${err.message}`);
  }
  if (Object.keys(modelToAgent).length === 0) {
    const fallback = {
      'deepseek/deepseek-v4-flash': 'base2-free-deepseek-flash',
      'deepseek/deepseek-v4-pro': 'base2-free-deepseek',
      'minimax/minimax-m3': 'base2-free-minimax-m3',
      'mimo/mimo-v2.5': 'base2-free-mimo',
      'google/gemini-3.1-pro-preview': 'freebuff-desktop-thread-local',
      'google/gemini-3.1-flash-lite-preview': 'freebuff-desktop-thread-worktree',
    };
    modelToAgent = fallback;
    allModels = Object.keys(fallback).sort();
    log(`Using hardcoded fallback (${allModels.length} models)`);
  }
}

function parseFreeAgents(tsContent) {
  const result = {};
  const agentRegex = /['"]?([\w-]+)['"]?\s*:\s*\{[^}]*models\s*:\s*\[([^\]]+)\]/g;
  let match;
  while ((match = agentRegex.exec(tsContent)) !== null) {
    const agentId = match[1];
    const models =
      match[2].match(/['"]([^'"]+)['"]/g)?.map((s) => s.replace(/['"]/g, '')) || [];
    for (const model of models) if (!result[model]) result[model] = agentId;
  }
  return result;
}

// ── Utilities ────────────────────────────────────────────────────────────────

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith('https') ? https : http;
    transport
      .get(url, { timeout: 15000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return httpGet(res.headers.location).then(resolve).catch(reject);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString()));
      })
      .on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Accumulate an SSE stream into a single OpenAI-style JSON response.
 * Each `data: {...}` chunk carries a delta; we merge content, reasoning,
 * role and finish_reason into one final object.
 */
function accumulateSSEToJSON(raw) {
  const lines = raw.split('\n');
  let accumulatedContent = '';
  let accumulatedReasoning = '';
  let role = 'assistant';
  let finishReason = 'stop';
  let id = 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
  let model = '';
  let usage = null;

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]' || !data) continue;
    try {
      const parsed = JSON.parse(data);
      if (parsed.id) id = parsed.id;
      if (parsed.model) model = parsed.model;
      if (parsed.usage) usage = parsed.usage;
      const delta = parsed.choices?.[0]?.delta;
      if (delta) {
        if (delta.role) role = delta.role;
        if (delta.content) accumulatedContent += delta.content;
        if (delta.reasoning_content) accumulatedReasoning += delta.reasoning_content;
      }
      const finish = parsed.choices?.[0]?.finish_reason;
      if (finish) finishReason = finish;
    } catch {}
  }

  const response = {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'freebuff',
    choices: [
      {
        index: 0,
        message: {
          role,
          content: accumulatedContent,
          ...(accumulatedReasoning ? { reasoning_content: accumulatedReasoning } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage:
      usage || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
  };
  return JSON.stringify(response);
}

function extractFinalJSONFromSSE(raw) {
  const lines = raw.split('\n');
  let lastJson = '';
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      lastJson = data;
    }
  }
  if (!lastJson) return accumulateSSEToJSON(raw);
  try {
    return JSON.stringify(JSON.parse(lastJson));
  } catch {
    return lastJson;
  }
}

function parseDuration(str) {
  const s = str.trim();
  if (s.endsWith('ms')) return parseInt(s);
  if (s.endsWith('s')) return parseInt(s) * 1000;
  if (s.endsWith('m')) return parseInt(s) * 60 * 1000;
  if (s.endsWith('h')) return parseInt(s) * 3600 * 1000;
  return 15 * 60 * 1000;
}

function loadConfig(configPath) {
  const defaults = {
    LISTEN_ADDR: ':8080',
    UPSTREAM_BASE_URL: 'https://www.codebuff.com',
    AUTH_TOKENS: [],
    ROTATION_INTERVAL: '6h',
    REQUEST_TIMEOUT: '15m',
    API_KEYS: [],
    HTTP_PROXY: '',
  };
  let fileConfig = {};
  const fullPath = path.resolve(configPath);
  if (fs.existsSync(fullPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
      log(`Config loaded from ${fullPath}`);
    } catch (err) {
      log(`Config parse warning: ${err.message}`);
    }
  }
  const envMap = {
    LISTEN_ADDR: 'LISTEN_ADDR',
    UPSTREAM_BASE_URL: 'UPSTREAM_BASE_URL',
    AUTH_TOKENS: 'AUTH_TOKENS',
    ROTATION_INTERVAL: 'ROTATION_INTERVAL',
    REQUEST_TIMEOUT: 'REQUEST_TIMEOUT',
    API_KEYS: 'API_KEYS',
    HTTP_PROXY: 'HTTP_PROXY',
  };
  const cfg = { ...defaults, ...fileConfig };
  for (const [key, envKey] of Object.entries(envMap)) {
    if (process.env[envKey]) {
      cfg[key] =
        key === 'AUTH_TOKENS' || key === 'API_KEYS'
          ? process.env[envKey]
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : process.env[envKey];
    }
  }
  return cfg;
}

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [FreebuffProxy] ${msg}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
