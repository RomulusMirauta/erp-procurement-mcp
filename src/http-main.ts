// Entry point for remote use: serves the tools over Streamable HTTP on POST /mcp, with a bearer token.
import { createServer } from 'node:http';
import { createHttpHandlerFromEnv } from './http.js';

// Localhost by default, as the MCP spec recommends for local servers. Set HOST=0.0.0.0 to accept remote clients.
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);

async function main() {
  const { handler, summary } = await createHttpHandlerFromEnv();
  const server = createServer((req, res) => void handler(req, res));
  server.listen(PORT, HOST, () => {
    console.error(`erp-procurement MCP server listening on http://${HOST}:${PORT}/mcp, ${summary}`);
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
