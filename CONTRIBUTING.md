# Contributing to Freebuff Proxy

First off, thanks for taking the time to contribute! 🎉

## Code of Conduct

Be respectful and constructive. This project is open source and welcomes
everyone regardless of experience level.

## Getting Started

### Prerequisites

- **Node.js ≥ 18** (tested on 18/20/22)
- Git

### Setup

```bash
# 1. Fork the repo on GitHub, then clone your fork
git clone https://github.com/<your-username>/freebuff-proxy.git
cd freebuff-proxy

# 2. Create your config (tokens stay local, never committed)
cp config.example.json config.json
# → add your Freebuff token to AUTH_TOKENS

# 3. Run the proxy
npm start

# 4. Run the test suite
npm test
```

**No `npm install` needed** — the project has zero dependencies. Everything
runs on Node.js stdlib.

## Project Structure

```
server.js                  # The whole proxy (single file, by design)
test/
  converter.test.js        # Unit: Anthropic↔OpenAI, SSE, marker, config, pool
  unit.test.js             # More unit coverage (marker, SSE, duration, agents)
  integration.test.js      # Spins up a real instance on a test port
config.example.json        # Public template (never put real tokens here)
Dockerfile                 # Container packaging
docker-compose.yml         # Compose orchestration
.github/workflows/ci.yml   # CI on Node 18/20/22
```

## Making Changes

1. Create a branch: `git checkout -b feat/your-feature`
2. Write your changes. Keep the **zero-dependency** rule:
   - Use only Node.js built-ins (`http`, `https`, `fs`, `path`, `crypto`,
     `url`, `net`, `tls`)
   - No npm packages — this is a hard requirement
3. Add tests for your changes in `test/` using `node:test` + `node:assert`
4. Run the full suite: `npm test` — **all tests must pass**
5. Run `node --check server.js` — syntax must be clean

## Code Style

- 2-space indentation, single quotes, semicolons
- JSDoc comments on exported functions
- Keep functions small and pure where possible (easier to unit test)
- English only in code and comments

## Testing Guidelines

- New logic **must** ship with tests
- Pure functions → unit tests (no network)
- HTTP endpoints → integration tests (spin up the server on a test port,
  like `test/integration.test.js`)
- Never test against the real Freebuff API with real tokens in CI — use
  stubs or test-only endpoints

## Commit Conventions

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add XYZ
fix: correct ABC
test: add coverage for DEF
docs: update README
```

## Submitting a PR

1. Push your branch: `git push origin feat/your-feature`
2. Open a PR against `main`
3. Fill out the PR template
4. CI runs automatically — make sure it's green
5. Wait for review; address feedback if any

## Reporting Bugs

Use the [Bug Report template](.github/ISSUE_TEMPLATE/bug_report.md). Include:

- Proxy version / commit hash
- Node version (`node --version`)
- OS
- Steps to reproduce
- Expected vs actual behavior
- Relevant log output (redact any tokens!)

## Security

If you find a security issue (token leakage, auth bypass, etc.), **do not**
open a public issue. Email the maintainer privately or open a draft PR with
the fix. Never commit real tokens.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
