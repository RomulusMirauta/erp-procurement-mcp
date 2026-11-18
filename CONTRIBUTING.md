# Contributing

## Setup

Requires Node.js 22.12 or newer.

```bash
npm ci
npm run dev        # MCP server over stdio, from source
npm run dev:http   # Streamable HTTP server (needs MCP_AUTH_TOKEN, see .env.example)
```

## Checks

CI runs these on Node 22 and 24 (Ubuntu) and Node 24 (Windows); run them before you push:

```bash
npm run lint && npm run typecheck && npm test && npm run build && npm run smoke
```

Tests live in `tests/` (Vitest). A bug fix comes with a test that fails without it.

## Commits

[Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `docs:`, `test:`, `ci:`, `chore:`, `refactor:`.
Bugs found in review go in [FINDINGS.md](FINDINGS.md). User-facing changes go in [CHANGELOG.md](CHANGELOG.md).
