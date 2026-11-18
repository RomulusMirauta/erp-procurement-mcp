// Startup configuration shared by both entry points (stdio and HTTP): reads the environment, loads the ERP data
// and picks the approval store. Everything is checked here, so a bad value stops the server before it serves.
import { HttpApprovalStore } from './approvals/http-store.js';
import { InMemoryApprovalStore, type ApprovalStore } from './approvals/store.js';
import { DEFAULT_PRICE_TOLERANCE_PCT } from './erp/matching.js';
import { ErpRepository } from './erp/repository.js';
import type { ServerDeps } from './server.js';

// Resolves the same way from src/ (development) and dist/ (build), both one level below the project root.
const SAMPLE_DATA = new URL('../data/erp-sample.json', import.meta.url);

function readTolerance(env: NodeJS.ProcessEnv): number {
  const raw = env.ERP_PRICE_TOLERANCE_PCT;
  if (!raw) return DEFAULT_PRICE_TOLERANCE_PCT;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 20) {
    throw new Error(`ERP_PRICE_TOLERANCE_PCT must be a number from 0 to 20, got "${raw}"`);
  }
  return value;
}

// With APPROVALS_API_URL set, approval requests go to the approvals platform; otherwise they stay in memory.
function createApprovalStore(env: NodeJS.ProcessEnv): { store: ApprovalStore; description: string } {
  const { APPROVALS_API_URL: baseUrl, APPROVALS_API_EMAIL: email, APPROVALS_API_PASSWORD: password } = env;
  if (!baseUrl) return { store: new InMemoryApprovalStore(), description: 'in memory' };
  if (!email || !password) {
    throw new Error('APPROVALS_API_URL is set, so APPROVALS_API_EMAIL and APPROVALS_API_PASSWORD are required too');
  }
  return { store: new HttpApprovalStore({ baseUrl, email, password }), description: baseUrl };
}

// The server's dependencies, plus a one-line summary for the startup log.
export async function loadServerDeps(env: NodeJS.ProcessEnv = process.env): Promise<{ deps: ServerDeps; summary: string }> {
  const dataFile = env.ERP_DATA_FILE || SAMPLE_DATA;
  const priceTolerancePct = readTolerance(env);
  const repository = await ErpRepository.fromFile(dataFile);
  const approvals = createApprovalStore(env);
  return {
    deps: { repository, approvals: approvals.store, priceTolerancePct },
    summary: `data: ${String(dataFile)}, price tolerance: ±${priceTolerancePct}%, approvals: ${approvals.description}`,
  };
}
