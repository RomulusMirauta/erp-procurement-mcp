# CLAUDE.md

MCP server that lets an AI agent query a mock ERP, run three-way invoice matching and send
exceptions to a person for approval (in memory, or the approvals-platform API). See README.md.

## Commands

- `npm run dev` / `npm run dev:http`: run from source (stdio / Streamable HTTP)
- `npm run lint && npm run typecheck && npm test && npm run build`: what CI runs (Node 22, 24; Windows)

## Conventions

- TypeScript, ESM, zod schemas in `src/erp/schema.ts` are the source of truth for types.
- Tests go in `tests/` (Vitest); every bug fix gets a regression test.
- Bugs found in review are logged in `FINDINGS.md`; user-facing changes in `CHANGELOG.md`.
- Conventional Commits (`feat:`, `fix:`, `docs:`, `ci:`, `chore:` ...). Versions follow semver; release = annotated tag `vX.Y.Z` + GitHub Release.
- `main` is protected by a ruleset: changes go through a pull request with green CI.
  The repository admin can bypass it (through a pull request) for emergencies only.

## Don't

- Never commit secrets (`.env`, tokens, `MCP_AUTH_TOKEN`); use `.env.example` for new settings.
- Don't force-push or delete `main`, and don't loosen the matching rules to make a test pass.
- Don't let a tool argument change server policy (e.g. the price tolerance).
