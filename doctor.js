#!/usr/bin/env node
/**
 * freebuff-proxy doctor — one-command health check for the whole stack.
 *
 * Inspired by codex-router's `doctor` CLI: verify every layer in one shot
 * and answer "is my proxy healthy?" without digging through logs.
 *
 * Layers checked:
 *   1. config.json            — AUTH_TOKENS present, upstream URL set
 *   2. Upstream reachability  — GET /api/v1/freebuff/session (read-only)
 *   3. Per-token state        — live session, quota remaining, streak, reset time
 *   4. Local proxy            — is :8080 up, /healthz OK, token pools state
 *
 * Zero dependencies (Node >= 18 stdlib only), same as the proxy.
 *
 * Usage:
 *   node doctor.js            # full check (queries upstream)
 *   node doctor.js --quick    # local-only (config + proxy healthz), no upstream calls
 *   node doctor.js --json     # machine-readable output
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const CONFIG_DEFAULT = { UPSTREAM_BASE_URL: 'https://www.codebuff.com', AUTH_TOKENS: [] };

// ── helpers ──────────────────────────────────────────────────────────────────

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return { error: `config.json not found at ${CONFIG_PATH}`, config: null };
  }
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const cfg = JSON.parse(raw);
    return { error: null, config: { ...CONFIG_DEFAULT, ...cfg } };
  } catch (e) {
    return { error: `config.json parse error: ${e.message}`, config: null };
  }
}

function maskToken(token) {
  if (!token || token.length < 12) return token || '(empty)';
  return `${token.slice(0, 8)}…${token.slice(-4)}`;
}

function getJson(url, headers = {}, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const transport = u.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        method: 'GET',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: { Accept: 'application/json', ...headers },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString();
          let parsed = null;
          try { parsed = JSON.parse(body); } catch { /* keep null */ }
          resolve({ status: res.statusCode, body, parsed });
        });
      },
    );
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ status: 0, body: '', parsed: null, error: e.message }));
    req.end();
  });
}

function fmtTime(ms) {
  if (!ms || ms <= 0) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}j ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function fmtReset(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false });
}

function badge(ok, label = 'OK') {
  return ok ? `\x1b[32m✓ ${label}\x1b[0m` : `\x1b[31m✗ ${label}\x1b[0m`;
}

function statusColor(text, ok) {
  return ok ? `\x1b[32m${text}\x1b[0m` : `\x1b[31m${text}\x1b[0m`;
}

// ── layer checks ─────────────────────────────────────────────────────────────

async function checkConfig() {
  const { error, config } = loadConfig();
  if (error) return { ok: false, error, config: null };
  const tokens = config.AUTH_TOKENS || [];
  const problems = [];
  if (tokens.length === 0) problems.push('AUTH_TOKENS kosong');
  if (!config.UPSTREAM_BASE_URL) problems.push('UPSTREAM_BASE_URL tidak diset');
  return {
    ok: problems.length === 0,
    error: problems.join('; ') || null,
    config,
    tokenCount: tokens.length,
  };
}

async function checkUpstream(baseUrl, token) {
  // GET session is read-only: returns current session state without consuming quota.
  const res = await getJson(`${baseUrl.replace(/\/$/, '')}/api/v1/freebuff/session`, {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'freebuff-proxy-doctor/1.0',
  });
  return res;
}

async function checkLocalProxy() {
  return new Promise((resolve) => {
    const req = http.request(
      { method: 'GET', hostname: '127.0.0.1', port: 8080, path: '/healthz', timeout: 5000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString();
          let parsed = null;
          try { parsed = JSON.parse(body); } catch { /* keep null */ }
          resolve({ ok: res.statusCode === 200, status: res.statusCode, body, parsed });
        });
      },
    );
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ ok: false, status: 0, body: '', parsed: null, error: e.message }));
    req.end();
  });
}

function readProxyLogLastError(tokenName) {
  // Best-effort: pull the most recent cooldown/quota line for this pool from server.log
  try {
    const logPath = path.join(__dirname, 'server.log');
    if (!fs.existsSync(logPath)) return null;
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    const re = new RegExp(`\\[${tokenName}\\] .*(quota|cooldown|429|409|session)`);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (re.test(lines[i])) return lines[i].slice(0, 220);
    }
    return null;
  } catch {
    return null;
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const quick = args.includes('--quick');
  const asJson = args.includes('--json');

  const cfgCheck = await checkConfig();
  const results = { config: cfgCheck, upstream: null, tokens: [], proxy: null };

  if (cfgCheck.ok && !quick) {
    const baseUrl = cfgCheck.config.UPSTREAM_BASE_URL;
    const tokens = cfgCheck.config.AUTH_TOKENS;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const tokenName = `token-${i + 1}`;
      const up = await checkUpstream(baseUrl, token);
      const session = up.parsed || {};
      const poolState = { name: tokenName, cooldownUntil: 0, lastError: '' };
      results.tokens.push({
        name: tokenName,
        masked: maskToken(token),
        reachable: up.status === 200,
        httpStatus: up.status,
        rawError: up.error || null,
        sessionStatus: session.status || 'unknown',
        instanceId: session.instanceId || null,
        expiresAt: session.expiresAt || null,
        quota: session.entitlementBreakdown || null,
        rateLimits: session.rateLimitsByModel || null,
        streak: session.streak != null ? session.streak : null,
        poolState,
      });
    }
    results.upstream = { baseUrl };
  }

  if (!quick) {
    results.proxy = await checkLocalProxy();
  } else {
    results.proxy = await checkLocalProxy();
  }

  // ── render ────────────────────────────────────────────────────────────────
  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  const out = [];
  out.push('');
  out.push('┌─────────────────────────────────────────────┐');
  out.push('│  freebuff-proxy doctor — health check       │');
  out.push('└─────────────────────────────────────────────┘');

  // config
  out.push('');
  out.push(`1. CONFIG  ${cfgCheck.ok ? badge(true) : badge(false, cfgCheck.error)}`);
  if (cfgCheck.ok) {
    out.push(`   tokens: ${cfgCheck.tokenCount} | upstream: ${cfgCheck.config.UPSTREAM_BASE_URL}`);
  }

  // upstream + tokens
  if (cfgCheck.ok && !quick) {
    out.push('');
    out.push('2. TOKENS  (live upstream check)');
    for (const t of results.tokens) {
      const ok = t.reachable && (t.sessionStatus === 'active' || t.sessionStatus === 'none' || t.sessionStatus === 'ended');
      out.push(`   ${t.name} ${maskToken(t.masked)} → ${t.reachable ? statusColor(`HTTP ${t.httpStatus}`, true) : statusColor(`HTTP ${t.httpStatus || 'ERR'} ${t.rawError || ''}`, false)}`);
      if (t.reachable) {
        out.push(`      session: ${t.sessionStatus}${t.instanceId ? ` (${String(t.instanceId).slice(0, 8)}…)` : ''}`);
        if (t.expiresAt) out.push(`      expires: ${fmtReset(t.expiresAt)}`);
        if (t.streak != null) out.push(`      streak:  ${t.streak} hari`);
        if (t.quota) {
          const q = t.quota;
          out.push(`      quota:   base=${q.base ?? '?'} referral=${q.referral ?? 0} streak=${q.streak ?? 0} → total ${(q.base ?? 0) + (q.referral ?? 0) + (q.streak ?? 0)}/hari`);
        }
        if (t.rateLimits) {
          for (const [model, rl] of Object.entries(t.rateLimits)) {
            out.push(`      limit ${model}: ${rl.limit ?? '?'}/${rl.period ?? '?'}`);
          }
        }
        const lastErr = readProxyLogLastError(t.name);
        if (lastErr) out.push(`      last log: ${lastErr}`);
      }
    }
  }

  // local proxy
  out.push('');
  out.push(`3. PROXY   ${results.proxy.ok ? badge(true) : badge(false, results.proxy.error || `HTTP ${results.proxy.status}`)}`);
  if (results.proxy.ok && results.proxy.parsed) {
    const p = results.proxy.parsed;
    out.push(`   healthz: models=${p.models} tokens=${p.tokens} ok=${p.ok}`);
  } else if (!results.proxy.ok) {
    out.push('   → Proxy tidak jalan. Start dengan: npm start');
  }

  // verdict
  out.push('');
  const allOk = cfgCheck.ok && (!results.proxy || results.proxy.ok);
  out.push(allOk ? statusColor('✓ SEMUA SEHAT — proxy siap dipakai', true) : statusColor('✗ ADA MASALAH — cek detail di atas', false));
  out.push('');

  console.log(out.join('\n'));
}

// Run only when executed directly (not when required by tests)
if (require.main === module) {
  main().catch((e) => {
    console.error('doctor error:', e.message);
    process.exit(1);
  });
}

module.exports = {
  loadConfig,
  maskToken,
  badge,
  statusColor,
  fmtTime,
  fmtReset,
  checkConfig,
  checkUpstream,
  checkLocalProxy,
  readProxyLogLastError,
  main,
};
