<div align="center">

# 🐃 Freebuff Proxy

**OpenAI-compatible proxy for Freebuff (Codebuff Cloud)** — free access to frontier models through your own Freebuff account.

Zero dependencies · Pure Node.js stdlib · Streaming & non-streaming

[![Node](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/hafizhmuzani/freebuff-proxy/pulls)
[![CI](https://github.com/hafizhmuzani/freebuff-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/hafizhmuzani/freebuff-proxy/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-41%20passed-green.svg)](test/)

</div>

---

## ✨ Features

| Feature | Description |
|---|---|
| 🚀 **OpenAI-compatible** | Drop-in replacement for any `chat/completions` client (OpenAI SDK, 9Router, OpenCode, Cline…) |
| 🆓 **Free tier models** | DeepSeek V4, MiniMax M3, MiMo 2.5, Gemini 3.1 — via Freebuff's free mode |
| 🔄 **SSE ↔ JSON** | Streaming and non-streaming both supported; automatic conversion |
| 🧠 **Reasoning passthrough** | `reasoning_content` from reasoning models is preserved |
| 🎭 **Auto system marker** | Injects Freebuff's required *"You are Buffy"* marker when missing |
| 🔁 **Session management** | Handles Freebuff waiting rooms, session expiry, and retries automatically |
| 🗝️ **Multi-token round-robin** | Rotate several Freebuff tokens for higher throughput |
| 🔄 **Token rotation** | Scheduled pool reset (`ROTATION_INTERVAL`) keeps throttled tokens fresh |
| 🚦 **Rate limiting** | Optional per-IP cap (`MAX_REQUESTS_PER_MIN`) with `429` responses |
| 🔒 **API key auth** | Optional `x-api-key` / `Bearer` gate in front of the proxy |
| 🌐 **CORS** | `Access-Control-Allow-Origin` headers — usable from browser apps |
| 🤖 **Anthropic API** | `/v1/messages` endpoint — works with Claude Code & Claude-compatible clients |
| 🕵️ **HTTP proxy** | Tunnel upstream traffic through a proxy (`HTTP_PROXY`) — stealth & geo |
| 📊 **Metrics** | `/metrics` endpoint — requests, per-model usage, token health |
| 🐳 **Docker** | Official `Dockerfile` + `docker-compose.yml` — deploy anywhere |
| 🛡️ **Body limit** | `MAX_BODY_SIZE` — reject oversized requests (`413`) |
| 🧹 **Graceful shutdown** | FINISHes active Freebuff runs before exit |
| 🪟 **Windows autostart** | Hidden VBS launcher for boot-time startup (optional) |

---

## 📦 Installation

**Option A — npm (recommended, global CLI):**

```bash
# Install globally
npm install -g freebuff-proxy

# Create your config
cp $(npm root -g)/freebuff-proxy/config.example.json config.json
# → add your Freebuff token to AUTH_TOKENS

# Run from anywhere
freebuff-proxy
```

**Option B — clone (for development / contributions):**

```bash
git clone https://github.com/hafizhmuzani/freebuff-proxy.git
cd freebuff-proxy

# No npm install needed — zero dependencies!
npm start
```

**Option C — Docker:**

```bash
docker compose up -d --build   # see Docker section below
```

## 🔑 Getting a Freebuff token

**Option A — Web (easiest, no CLI):**

1. Open <https://freebuff.llm.pm> — a community login helper
2. Click **Generate Login URL**, then open the generated link
3. Sign in with **GitHub or Google** (a brand-new account = a brand-new 6-session quota)
4. After login, copy the full callback URL and paste it back on the page
5. Click **Verify & Fetch Token** → your `authToken` is displayed
6. Add it to `config.json` → `AUTH_TOKENS`

**Option B — CLI:**

1. Install the Freebuff CLI: `npm i -g freebuff`
2. Run `freebuff` and log in (opens browser)
3. Your token is stored at:
   - **Windows:** `C:\Users\<you>\.config\manicode\credentials.json`
   - **Linux/macOS:** `~/.config/manicode/credentials.json`
4. Copy the token into `config.json` → `AUTH_TOKENS`

**Multi-account tip:** Each Freebuff account gets a daily quota of **6 sessions**
(limited mode). Configure **one token per account** in `AUTH_TOKENS` to multiply
your daily quota:

```json
{
  "AUTH_TOKENS": ["token-account-1", "token-account-2", "token-account-3"]
}
```

The proxy round-robins between tokens and automatically fails over when one
hits its quota (`429`) or is temporarily throttled.

## ⚙️ Configuration

```bash
cp config.example.json config.json   # then edit
```

```jsonc
{
  "LISTEN_ADDR": ":8080",                    // listen address & port
  "UPSTREAM_BASE_URL": "https://www.codebuff.com", // Freebuff backend
  "AUTH_TOKENS": ["your-freebuff-token"],    // one or more tokens
  "ROTATION_INTERVAL": "6h",                 // token rotation interval
  "REQUEST_TIMEOUT": "15m",                  // upstream request timeout
  "API_KEYS": [],                            // optional: ["sk-..."], empty = open
  "HTTP_PROXY": "",                          // optional HTTP proxy for upstream
  "MAX_REQUESTS_PER_MIN": 0,                 // per-IP rate cap; 0 = unlimited
  "CORS_ORIGIN": "*",                        // CORS allow-origin; "*" = all
  "MAX_BODY_SIZE": 10485760                  // max request body in bytes (10MB)
}
```

> Every setting can also be supplied as an environment variable
> (`AUTH_TOKENS="a,b"`, `LISTEN_ADDR=":9000"`, `MAX_REQUESTS_PER_MIN=30`, …) — useful for Docker.

### Anthropic Messages API (Claude Code compatible)

The proxy also speaks the Anthropic Messages protocol at `/v1/messages` —
requests are translated to OpenAI format upstream, and responses are
translated back. Both streaming and non-streaming work.

```bash
curl http://localhost:8080/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-key" \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

Configure Claude Code:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8080
export ANTHROPIC_AUTH_TOKEN=anything   # ignored unless API_KEYS is set
export ANTHROPIC_MODEL=deepseek/deepseek-v4-flash
```

### CORS

Browser-based clients work out of the box (`Access-Control-Allow-Origin: *`).
Restrict with `CORS_ORIGIN`:

```json
{ "CORS_ORIGIN": "https://app.example.com" }
```

### HTTP proxy

Route all upstream traffic (session, runs, chat) through an HTTP proxy —
useful for stealth, geo-targeting, or company networks:

```json
{ "HTTP_PROXY": "http://proxy.example.com:8080" }
```

Authenticated proxies are supported:

```json
{ "HTTP_PROXY": "http://user:pass@proxy.example.com:8080" }
```

### Metrics

`GET /metrics` returns Prometheus-style metrics:

```bash
curl http://localhost:8080/metrics
# freebuff_proxy_uptime_seconds 1234
# freebuff_proxy_requests_total 42
# freebuff_proxy_model_requests{model="deepseek/deepseek-v4-flash"} 10
```

Add `?format=json` for machine-readable output:

```bash
curl http://localhost:8080/metrics?format=json
```

### Rate limiting

Set `MAX_REQUESTS_PER_MIN` to a positive integer to cap chat requests per IP
(0 = disabled). Exceeding the cap returns `429` with `Retry-After: 60`:

```json
{ "MAX_REQUESTS_PER_MIN": 30 }   // max 30 chat requests/min/IP
```

### Token rotation

With multiple `AUTH_TOKENS`, requests round-robin across tokens. Every
`ROTATION_INTERVAL`, all pool cooldowns reset so a throttled token gets a
fresh chance — ideal for long-running sessions.

## 🚀 Usage

```bash
node server.js            # start (port 8080)
node server.js --verbose  # verbose logging
node server.js --config my-config.json   # custom config path
```

### 🩺 Doctor — one-command health check

Bingung "proxy kenapa 502?" Jalankan doctor — satu perintah cek semua lapisan:

```bash
npm run doctor          # cek config + semua token (live upstream) + proxy
npm run doctor:quick    # lokal saja (config + healthz), tanpa panggil upstream
npm run doctor -- --json   # output machine-readable (buat script/monitoring)
```

Output:

```
1. CONFIG  ✓ OK
   tokens: 2 | upstream: https://www.codebuff.com

2. TOKENS  (live upstream check)
   token-1 3fc2acf7…9597 → HTTP 200
      session: ended (a71c7e3b…)
      expires: 11/8/2026, 19.21.01
      limit deepseek/deepseek-v4-flash: 6/pacific_day
      limit mimo/mimo-v2.5: 6/pacific_day

3. PROXY   ✓ OK
   healthz: models=6 tokens=2 ok=true

✓ SEMUA SEHAT — proxy siap dipakai
```

`doctor` menjawab langsung: token mana yang sehat, session aktif/ended, sisa quota per model,
waktu reset, dan apakah proxy lokal hidup — tanpa bongkar `server.log` manual.

### Health & models

```bash
curl http://localhost:8080/healthz
# {"ok":true,"models":6,"tokens":1}

curl http://localhost:8080/v1/models
```

### Chat completions

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

### Streaming

```bash
curl -N http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8080/v1",
    api_key="anything",  # ignored unless API_KEYS is set
)
resp = client.chat.completions.create(
    model="deepseek/deepseek-v4-flash",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(resp.choices[0].message.content)
```

## 🧩 Models

| Model | Agent | Notes |
|---|---|---|
| `deepseek/deepseek-v4-flash` | `base2-free-deepseek-flash` | ⭐ Fastest, default |
| `deepseek/deepseek-v4-pro` | `base2-free-deepseek` | Stronger reasoning |
| `minimax/minimax-m3` | `base2-free-minimax-m3` | Balanced |
| `mimo/mimo-v2.5` | `base2-free-mimo` | Balanced |
| `google/gemini-3.1-pro-preview` | `freebuff-desktop-thread-local` | Gemini Pro |
| `google/gemini-3.1-flash-lite-preview` | `freebuff-desktop-thread-worktree` | Gemini Flash |

The proxy **auto-refreshes the model registry** from the Codebuff upstream every 6 hours, falling back to the built-in list if offline.

## 🪟 Windows autostart (optional)

`autostart.vbs` starts the proxy **hidden** at login — copy it to:

```
shell:startup   (Win+R → shell:startup)
```

or run once:

```bat
wscript "C:\path\to\freebuff-proxy\autostart.vbs"
```

Logs are written to `server.log` in the same folder. If the port is already
in use (double-start), the proxy **exits silently** instead of crashing.

## 🗺️ Architecture

```
┌──────────────┐    ┌──────────────┐    ┌──────────────────┐    ┌─────────────────┐
│  Any OpenAI  │───▶│ Freebuff     │───▶│ Freebuff Proxy   │───▶│  codebuff.com   │
│  client      │    │ Proxy :8080  │    │ session mgmt     │    │  (upstream)     │
└──────────────┘    └──────────────┘    └──────────────────┘    └─────────────────┘
     OpenAI format         SSE/JSON           Buffy marker,
                                              agent-runs, retries
```

Every request: `session → agent-run (START) → chat/completions → agent-run (FINISH)`.

## 🐳 Docker

```bash
# 1. Create config.json with your tokens first
cp config.example.json config.json   # then add AUTH_TOKENS

# 2. Build & run
docker compose up -d --build

# 3. Verify
curl http://localhost:8080/healthz
```

Or run the image directly:

```bash
docker build -t freebuff-proxy .
docker run -d --name freebuff-proxy \
  -p 8080:8080 \
  -v "$PWD/config.json:/app/config.json:ro" \
  --restart unless-stopped \
  freebuff-proxy
```

All config keys work as environment variables too:

```bash
docker run -d -p 8080:8080 \
  -e AUTH_TOKENS="token1,token2" \
  -e MAX_REQUESTS_PER_MIN=30 \
  freebuff-proxy
```

## 🧪 Testing

The project ships with a zero-dependency test suite built on Node's built-in
test runner (`node:test`) — no extra packages needed:

```bash
npm test              # run all 41 tests (unit + integration)
node --check server.js    # syntax check
curl http://localhost:8080/healthz   # health check
```

- `test/converter.test.js` — Anthropic ↔ OpenAI conversion, SSE accumulation,
  marker injection, config parsing, token pool selection
- `test/integration.test.js` — spins up a real proxy instance on a test port
  and verifies healthz, models, CORS, rate limiting (429), and metrics

CI (GitHub Actions) runs the full suite on Node 18 / 20 / 22 on every push.

## 🤝 Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for the full
guide — setup, testing, code style, and PR workflow. The project is strictly
**zero-dependency**: contributions must use only Node.js stdlib.

- 🐛 Found a bug? [Open an issue](https://github.com/hafizhmuzani/freebuff-proxy/issues/new?template=bug_report.md)
- ✨ Have an idea? [Request a feature](https://github.com/hafizhmuzani/freebuff-proxy/issues/new?template=feature_request.md)
- 🚀 Ready to code? Fork, branch, test, and PR.

## ⚠️ Disclaimer

- This project is **not affiliated with** Codebuff, Freebuff, or DeepSeek.
- Free tier access may change at any time upstream.
- Use at your own risk; respects upstream rate limits by design.

## 📄 License

MIT © [Hafizh Muzani](https://github.com/hafizhmuzani)
