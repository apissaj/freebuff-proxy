'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PROXY_DIR = path.resolve(__dirname, '..');
const TEST_PORT = 18099;

function startProxy() {
  return new Promise((resolve, reject) => {
    const tmpCfg = path.join(os.tmpdir(), 'freebuff-test-cfg.json');
    fs.writeFileSync(tmpCfg, JSON.stringify({
      LISTEN_ADDR: `:${TEST_PORT}`,
      AUTH_TOKENS: ['test-token'],
      API_KEYS: [],
      MAX_REQUESTS_PER_MIN: 0,
    }));
    const child = spawn('node', ['server.js', '--config', tmpCfg], {
      cwd: PROXY_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('Listening on')) resolve(child);
    });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`proxy exited early: ${code}`)));
    setTimeout(() => reject(new Error('proxy start timeout')), 15000);
  });
}

function stopProxy(child) {
  return new Promise((resolve) => {
    if (!child || child.killed) return resolve();
    child.kill();
    child.on('exit', () => resolve());
    setTimeout(resolve, 5000);
  });
}

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
}

function post(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

let child;

test('proxy: starts and serves healthz', async () => {
  child = await startProxy();
  const r = await get(`http://localhost:${TEST_PORT}/healthz`);
  const body = JSON.parse(r.body);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.models, 6);
  assert.strictEqual(body.tokens, 1);
});

test('proxy: /v1/models lists models', async () => {
  const r = await get(`http://localhost:${TEST_PORT}/v1/models`);
  const body = JSON.parse(r.body);
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(body.data));
  assert.ok(body.data.length >= 6);
  const ids = body.data.map((m) => m.id);
  assert.ok(ids.includes('deepseek/deepseek-v4-flash'));
  assert.ok(ids.includes('mimo/mimo-v2.5'));
});

test('proxy: CORS headers present', async () => {
  const r = await get(`http://localhost:${TEST_PORT}/healthz`, { Origin: 'http://example.com' });
  assert.strictEqual(r.headers['access-control-allow-origin'], '*');
});

test('proxy: OPTIONS preflight returns 204', async () => {
  const r = await new Promise((resolve, reject) => {
    const req = http.request(`http://localhost:${TEST_PORT}/v1/chat/completions`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://example.com', 'Access-Control-Request-Method': 'POST' },
    }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers })); });
    req.on('error', reject);
    req.end();
  });
  assert.strictEqual(r.status, 204);
});

test('proxy: rate limit 429 when MAX_REQUESTS_PER_MIN exceeded', async () => {
  const tmpCfg = path.join(os.tmpdir(), 'freebuff-test-rate.json');
  fs.writeFileSync(tmpCfg, JSON.stringify({
    LISTEN_ADDR: `:${TEST_PORT + 1}`,
    AUTH_TOKENS: ['test-token'],
    MAX_REQUESTS_PER_MIN: 2,
  }));
  const child2 = spawn('node', ['server.js', '--config', tmpCfg], { cwd: PROXY_DIR, stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 15000);
    const poll = setInterval(() => {
      http.get(`http://localhost:${TEST_PORT + 1}/healthz`, (res) => {
        res.resume();
        if (res.statusCode === 200) { clearInterval(poll); clearTimeout(t); resolve(); }
      }).on('error', () => {});
    }, 300);
  });
  try {
    const body = { model: 'm', messages: [{ role: 'user', content: 'x' }] };
    await post(`http://localhost:${TEST_PORT + 1}/v1/chat/completions`, body).catch(() => ({}));
    await post(`http://localhost:${TEST_PORT + 1}/v1/chat/completions`, body).catch(() => ({}));
    const r3 = await post(`http://localhost:${TEST_PORT + 1}/v1/chat/completions`, body).catch(() => ({ status: 0 }));
    assert.strictEqual(r3.status, 429);
  } finally {
    child2.kill();
  }
});

test('proxy: unknown route → 404 JSON', async () => {
  const r = await get(`http://localhost:${TEST_PORT}/v1/unknown`);
  assert.strictEqual(r.status, 404);
  assert.ok(r.body.includes('not found'));
});

test('proxy: /metrics returns prometheus text', async () => {
  const r = await get(`http://localhost:${TEST_PORT}/metrics`);
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.includes('freebuff_proxy_uptime_seconds'));
  assert.ok(r.body.includes('freebuff_proxy_requests_total'));
});

test('proxy: /metrics?format=json returns JSON', async () => {
  const r = await get(`http://localhost:${TEST_PORT}/metrics?format=json`);
  const body = JSON.parse(r.body);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(typeof body.totalRequests, 'number');
  assert.ok(body.byModel && typeof body.byModel === 'object');
});

test('proxy: stops', async () => {
  await stopProxy(child);
  child = null;
});
