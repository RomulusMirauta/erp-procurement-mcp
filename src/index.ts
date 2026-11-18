#!/usr/bin/env node
// Entry point: loads the ERP data and serves the tools over stdio, the transport Claude Code and Claude Desktop use
// for local servers. stdout carries the protocol, so all logging goes to stderr.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { InMemoryApprovalStore } from './approvals/store.js';
import { ErpRepository } from './erp/repository.js';
import { createServer } from './server.js';

// Resolves the same way from src/ (development) and dist/ (build), both one level below the project root.
const SAMPLE_DATA = new URL('../data/erp-sample.json', import.meta.url);

async function main() {
  const dataFile = process.env.ERP_DATA_FILE || SAMPLE_DATA;
  const repository = await ErpRepository.fromFile(dataFile);
  const server = createServer({ repository, approvals: new InMemoryApprovalStore() });
  await server.connect(new StdioServerTransport());
  console.error(`erp-procurement MCP server running on stdio, data: ${String(dataFile)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
