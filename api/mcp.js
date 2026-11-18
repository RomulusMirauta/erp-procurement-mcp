// Vercel serverless function for /mcp and /health (see vercel.json). It runs the compiled handler from dist/,
// built by `npm run build` during the deploy. Configuration is read once per instance, at cold start, and a
// missing or weak MCP_AUTH_TOKEN fails the function instead of serving without authentication.
import { createHttpHandlerFromEnv } from '../dist/http.js';

const { handler } = await createHttpHandlerFromEnv();

export default handler;
