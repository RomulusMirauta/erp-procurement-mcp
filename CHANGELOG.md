# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The approvals API client retries network errors, timeouts, `429` and `5xx` (3 attempts, exponential backoff with jitter, honouring `Retry-After`), never other `4xx`.

## [0.2.0] - 2026-11-18

### Added

- Streamable HTTP transport (`npm run start:http`, `POST /mcp`) with bearer token auth (`MCP_AUTH_TOKEN`), an optional origin allowlist and an unauthenticated `/health` endpoint.
- `request_approval` can send requests to the [approvals platform](https://github.com/RomulusMirauta/approvals-platform) API (`APPROVALS_API_URL`); the in-memory store stays the default.
- Every tool publishes an output schema and returns `structuredContent`.
- New `QUANTITY_EXCEEDS_PO` exception for billing above the ordered quantity.

### Changed

- The price tolerance is server configuration (`ERP_PRICE_TOLERANCE_PCT`), no longer a `match_invoice` argument, so the agent can't loosen its own check.
- Startup configuration moved into a shared module used by both the stdio and HTTP entry points.

### Fixed

- A backdated duplicate of a paid invoice came back `matched` and could be paid twice.
- Pending invoices, and two invoice lines for the same PO line, were miscounted against received quantity.
- Price check divided by zero on free-of-charge lines and was off by floating-point error at the tolerance boundary.
- `request_approval` accepted invoices that were already paid, approved or rejected.
- Approval titles and tags repeated an exception kind that appeared on several lines.

See [FINDINGS.md](FINDINGS.md) for how the bugs were found.

## [0.1.0] - 2026-11-18

Initial version (not tagged at the time).

### Added

- Mock ERP: zod data model, sample data with one invoice per exception case, and a validated repository.
- Three-way invoice matching: supplier, currency, duplicate invoice number, lines on the PO, unit price tolerance and received quantity.
- MCP server over stdio with the `search_invoices`, `get_invoice`, `match_invoice` and `request_approval` tools.
- CI: lint, typecheck, test and build on Node 22 and 24.
- README with setup for Claude Code and Claude Desktop.

[Unreleased]: https://github.com/RomulusMirauta/erp-procurement-mcp/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/RomulusMirauta/erp-procurement-mcp/compare/8113878...v0.2.0
[0.1.0]: https://github.com/RomulusMirauta/erp-procurement-mcp/tree/8113878
