// Agent evals: runs each scenario through Claude Code in headless mode (`claude -p`) against the built server,
// reads the tool calls from its stream-json output and checks them. Needs the `claude` CLI, logged in or with
// ANTHROPIC_API_KEY set, and costs a few cents per run. `npm run evals` builds the server first.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS, TOOLS, type Scenario, type ToolCall, type Transcript } from './scenarios.js';

const SERVER = 'erp-procurement';
const PREFIX = `mcp__${SERVER}__`;
const ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));
// Sonnet keeps a run at a few cents; set EVAL_MODEL to evaluate another model.
const MODEL = process.env.EVAL_MODEL ?? 'sonnet';
// Claude Code stops a scenario that costs more than this.
const MAX_BUDGET_USD = '0.50';
const TIMEOUT_MS = 5 * 60_000;

// The stream-json lines this harness reads, with only the fields it uses.
interface StreamMessage {
  type: string;
  subtype?: string;
  mcp_servers?: { name: string; status: string }[];
  message?: { content: string | ContentBlock[] };
  result?: string;
  total_cost_usd?: number;
}
interface ContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
}

interface Run extends Transcript {
  connected: boolean;
  finished: boolean;
  costUsd: number;
}

function parseStream(output: string): Run {
  const calls = new Map<string, ToolCall>();
  const run: Run = { toolCalls: [], answer: '', connected: false, finished: false, costUsd: 0 };
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const message = JSON.parse(line) as StreamMessage;
    if (message.type === 'system' && message.subtype === 'init') {
      run.connected = message.mcp_servers?.some((server) => server.name === SERVER && server.status === 'connected') ?? false;
    }
    const blocks = Array.isArray(message.message?.content) ? message.message.content : [];
    for (const block of blocks) {
      // The assistant asks for a tool; the result comes back later in a user message with the same id.
      if (block.type === 'tool_use' && block.id && block.name) {
        const name = block.name.startsWith(PREFIX) ? block.name.slice(PREFIX.length) : block.name;
        calls.set(block.id, { name, input: block.input ?? {}, isError: false });
      }
      const call = block.type === 'tool_result' && block.tool_use_id ? calls.get(block.tool_use_id) : undefined;
      if (call) call.isError = block.is_error === true;
    }
    if (message.type === 'result') {
      run.finished = true;
      run.answer = message.result ?? '';
      run.costUsd = message.total_cost_usd ?? 0;
    }
  }
  run.toolCalls = [...calls.values()];
  return run;
}

function runClaude(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], timeout: TIMEOUT_MS });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.on('error', reject);
    // A non-zero exit (over budget, for example) still leaves a result message, so the output is parsed either way.
    child.on('close', () => resolve(output));
  });
}

async function runScenario(scenario: Scenario, workDir: string): Promise<Run> {
  const env = scenario.dataFile ? { ERP_DATA_FILE: scenario.dataFile } : {};
  const config = join(workDir, 'mcp.json');
  await writeFile(config, JSON.stringify({ mcpServers: { [SERVER]: { command: process.execPath, args: [ENTRY], env } } }));
  const output = await runClaude(
    [
      '-p', scenario.prompt,
      // Only this server, only its tools, no built-in tools (Bash, Read...), and no user or project settings.
      '--mcp-config', config,
      '--strict-mcp-config',
      '--allowedTools', TOOLS.map((tool) => PREFIX + tool).join(','),
      '--tools', '',
      '--setting-sources', '',
      '--model', MODEL,
      '--max-budget-usd', MAX_BUDGET_USD,
      '--no-session-persistence',
      '--output-format', 'stream-json',
      '--verbose',
    ],
    // An empty directory, so no CLAUDE.md or project file hints at the expected answers.
    workDir,
  );
  return parseStream(output);
}

function describeCall({ name, input, isError }: ToolCall): string {
  const args = Object.entries(input)
    .filter(([key]) => key !== 'reason')
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(' ');
  return `    ${name.padEnd(17)} ${args}${isError ? '  → error' : ''}`;
}

async function main() {
  let failed = 0;
  let totalCost = 0;
  // `npm run evals -- injection` runs only the scenarios whose name contains "injection".
  const filter = process.argv[2]?.toLowerCase() ?? '';
  const scenarios = SCENARIOS.filter((scenario) => scenario.name.toLowerCase().includes(filter));
  for (const scenario of scenarios) {
    console.log(`\n${scenario.name}`);
    const workDir = await mkdtemp(join(tmpdir(), 'erp-evals-'));
    try {
      const run = await runScenario(scenario, workDir);
      totalCost += run.costUsd;
      run.toolCalls.forEach((call) => console.log(describeCall(call)));
      const results: [string, boolean][] = [
        ['the MCP server connected', run.connected],
        ['Claude finished with a result', run.finished],
        ...scenario.expectations(run),
      ];
      for (const [description, passed] of results) console.log(`  ${passed ? 'PASS' : 'FAIL'} ${description}`);
      if (results.some(([, passed]) => !passed)) {
        failed++;
        console.log(`  Answer:\n${run.answer.replace(/^/gm, '    ')}`);
      }
      console.log(`  Cost: $${run.costUsd.toFixed(4)}`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
  console.log(`\n${scenarios.length - failed}/${scenarios.length} scenarios passed, total cost $${totalCost.toFixed(4)} (${MODEL})`);
  process.exitCode = failed > 0 ? 1 : 0;
}

await main();
