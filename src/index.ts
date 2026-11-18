#!/usr/bin/env node
// Entry point: loads the ERP data and serves the tools over stdio, the transport Claude Code and Claude Desktop use
// for local servers. stdout carries the protocol, so all logging goes to stderr.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadServerDeps } from './config.js';
import { createServer } from './server.js';

async function main() {
  const { deps, summary } = await loadServerDeps();
  const server = createServer(deps);
  await server.connect(new StdioServerTransport());
  console.error(`erp-procurement MCP server running on stdio, ${summary}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
