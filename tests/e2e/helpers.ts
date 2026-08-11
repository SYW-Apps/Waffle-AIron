import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

// ---------------------------------------------------------------------------
// Black-box e2e helpers: every journey talks to the REAL BUILT server
// (`node dist/cli/index.js mcp serve`) over actual MCP stdio, in a scratch
// project directory, and asserts on the YAML that lands on disk. This is the
// tier that catches the "stale server / stale binary" incident class the
// src-importing unit tests are structurally blind to.
// ---------------------------------------------------------------------------

export const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const DIST_CLI = path.join(REPO_ROOT, 'dist', 'cli', 'index.js');

/** Fail FAST and clearly when the built artifact is missing — never rebuild
 *  from inside a test. */
export function assertDistBuilt(): void {
  if (!fs.existsSync(DIST_CLI)) {
    throw new Error(
      `Built CLI not found at ${DIST_CLI} — the e2e suite tests the BUILT artifact. Run \`npm run build\` first.`,
    );
  }
}

export interface ScratchProject {
  /** Absolute path of the scratch project directory (contains .wai/). */
  dir: string;
  /** Connected MCP client speaking to the spawned dist server. */
  client: Client;
  /** Close the client (and its child process), then remove the temp dir. */
  cleanup: () => Promise<void>;
}

/** Minimal valid .wai/ project skeleton (same shape the existing
 *  server-schema-roundtrip suite uses). */
function writeProjectSkeleton(dir: string, name: string): void {
  const now = new Date().toISOString();
  fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), [
    "schemaVersion: '1.0.0'",
    `name: ${name}`,
    'targets:',
    '  - type: claude',
    '    outputDir: .claude/agents',
    '    enabled: true',
    `createdAt: '${now}'`,
    `updatedAt: '${now}'`,
    '',
  ].join('\n'));
}

/**
 * mkdtemp a scratch wairon project, spawn the BUILT stdio MCP server against
 * it (cwd = repo root, WAIRON_PROJECT_DIR = the scratch dir — exactly how
 * .mcp.json launches it), and connect an SDK client.
 */
export async function createScratchProject(name = 'e2e-journey'): Promise<ScratchProject> {
  assertDistBuilt();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-e2e-'));
  writeProjectSkeleton(dir, name);

  const client = new Client({ name: 'wairon-e2e', version: '0.0.1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_CLI, 'mcp', 'serve'],
    cwd: REPO_ROOT,
    // getDefaultEnvironment() keeps the platform essentials (SystemRoot, PATH,
    // …) — passing only WAIRON_PROJECT_DIR would REPLACE the child env.
    env: { ...getDefaultEnvironment(), WAIRON_PROJECT_DIR: dir },
    stderr: 'ignore',
  });
  await client.connect(transport);

  const cleanup = async (): Promise<void> => {
    try { await client.close(); } catch { /* transport already gone */ }
    await rmrfWithRetry(dir);
  };

  return { dir, client, cleanup };
}

/** rm -rf with retry: on Windows the just-killed server child can hold file
 *  locks for a moment. Zero residue on pass is part of the suite contract. */
export async function rmrfWithRetry(dir: string, attempts = 5): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200 * (i + 1)));
    }
  }
  // Last try — surface the real error if it still fails.
  fs.rmSync(dir, { recursive: true, force: true });
}

export interface ToolOutcome {
  /** True when the call succeeded (no isError, no thrown protocol error). */
  ok: boolean;
  /** Concatenated text content (success or isError payload). */
  text: string;
  /** Parsed JSON of the first text block, when it parses. */
  json?: unknown;
  /** The raw result object (absent when the SDK threw, e.g. zod InvalidParams). */
  raw?: { isError?: boolean; content?: Array<{ type: string; text?: string }> };
}

/**
 * Call a tool and normalize BOTH failure channels the server uses:
 * `isError: true` results (handler-level refusals) and thrown protocol errors
 * (the SDK's zod input validation → InvalidParams). Assertions should look at
 * `ok` + message content, never at which channel carried the refusal.
 */
export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  let result: { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  try {
    result = await client.callTool({ name, arguments: args }) as typeof result;
  } catch (e) {
    return { ok: false, text: String(e) };
  }
  const text = (result.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n');
  let json: unknown;
  try { json = JSON.parse(text); } catch { /* plain-prose result */ }
  return { ok: result.isError !== true, text, json, raw: result };
}

/** Call a tool that MUST succeed; throws with the server's message otherwise. */
export async function callToolOk(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const out = await callTool(client, name, args);
  if (!out.ok) {
    throw new Error(`Tool ${name} failed unexpectedly: ${out.text}`);
  }
  return out;
}

/** Read + parse one YAML file under the scratch project by relative path. */
export function readSpecYaml(dir: string, relPath: string): unknown {
  const p = path.join(dir, relPath);
  return yaml.load(fs.readFileSync(p, 'utf8'));
}

/** Recursively list every YAML file under .wai/specs (absolute paths). */
export function listSpecFiles(dir: string): string[] {
  const root = path.join(dir, '.wai', 'specs');
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) out.push(p);
    }
  };
  walk(root);
  return out;
}

/**
 * Find the ON-DISK spec YAML whose `id` field matches, layout-agnostically
 * (nested .index.yaml vs flat legacy files). Returns the parsed document.
 * This is the disk-truth assertion seam: what the MCP tools report is only
 * half the contract — the YAML that lands in .wai/specs is the other half.
 */
export function findSpecOnDisk(dir: string, id: string): Record<string, unknown> | null {
  for (const file of listSpecFiles(dir)) {
    let doc: unknown;
    try { doc = yaml.load(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (doc && typeof doc === 'object' && (doc as Record<string, unknown>)['id'] === id) {
      return doc as Record<string, unknown>;
    }
  }
  return null;
}

/** Snapshot the raw bytes of every file under .wai/specs, keyed by relative
 *  path — for "clean refusal leaves the tree byte-identical" assertions. */
export function snapshotSpecTree(dir: string): Map<string, string> {
  const snap = new Map<string, string>();
  for (const file of listSpecFiles(dir)) {
    snap.set(path.relative(dir, file), fs.readFileSync(file, 'utf8'));
  }
  return snap;
}

// ---------------------------------------------------------------------------
// The shared LEGAL journey topology: a small tree that authors cleanly and
// validates with zero errors — an Orchestrator whose entry method is a
// declared runtime entrypoint (invokedBy seeds reachability, so no Portal
// ceremony is needed) calling into a Specialist it dependsOn. Used by the
// authoring journey and by the CLI smoke suite (whose `validate --ci` run
// requires the tree to be warning-clean at draft status too).
// ---------------------------------------------------------------------------

export const JOURNEY = {
  subsystem: 'journey',
  orch: 'journey-orch',
  worker: 'journey-worker',
  orchInterface: 'ijourney-orch',
  workerInterface: 'ijourney-worker',
  orchImpl: 'journey-orch-impl',
  workerImpl: 'journey-worker-impl',
  invokedByCaller:
    'The deployment host invokes this once per inbound journey request, after configuration is loaded and the service reports ready.',
} as const;

/** Author the full legal journey tree through the live MCP client.
 *  Every call must succeed — the first refusal throws with the server text. */
export async function authorJourneyTree(client: Client): Promise<void> {
  await callToolOk(client, 'sdd_initialize_system', {
    name: 'JourneySystem',
    vision: 'End-to-end agent-journey system authored through the built MCP server',
    targetLanguage: 'typescript',
  });
  await callToolOk(client, 'sdd_add_subsystem', {
    id: JOURNEY.subsystem,
    name: 'Journey',
    description: 'Bounded context exercised by the black-box authoring journey',
  });
  // Dependency order: the Specialist first, then the Orchestrator that depends on it.
  await callToolOk(client, 'sdd_add_component', {
    id: JOURNEY.worker,
    name: 'Journey Worker',
    description: 'Specialist that enriches journey payloads on demand',
    subsystem: JOURNEY.subsystem,
    componentType: 'Specialist',
  });
  await callToolOk(client, 'sdd_add_component', {
    id: JOURNEY.orch,
    name: 'Journey Orchestrator',
    description: 'Owns the journey workflow and coordinates the worker',
    subsystem: JOURNEY.subsystem,
    componentType: 'Orchestrator',
    dependsOn: [JOURNEY.worker],
  });
  await callToolOk(client, 'sdd_define_interface', {
    id: JOURNEY.workerInterface,
    name: 'IJourneyWorker',
    description: 'Contract for enriching journey payloads',
    component: JOURNEY.worker,
    methods: [
      {
        name: 'enrich',
        description: 'Enrich a raw journey payload with derived fields',
        signature: 'enrich(payload: string): Promise<string>',
        returns: 'Promise<string>',
        params: [
          { name: 'payload', type: 'string', description: 'The raw journey payload to enrich' },
        ],
      },
    ],
  });
  await callToolOk(client, 'sdd_define_interface', {
    id: JOURNEY.orchInterface,
    name: 'IJourneyOrchestrator',
    description: 'Contract for running one journey end to end',
    component: JOURNEY.orch,
    methods: [
      {
        name: 'runJourney',
        description: 'Run a single journey from validation to completion',
        signature: 'runJourney(journeyId: string): Promise<void>',
        returns: 'Promise<void>',
        params: [
          { name: 'journeyId', type: 'string', description: 'The id of the journey to run' },
        ],
        // A real caller outside the modeled graph: seeds reachability so the
        // little tree needs no Portal to be fully reached.
        invokedBy: { kind: 'runtime', caller: JOURNEY.invokedByCaller },
      },
    ],
  });
  await callToolOk(client, 'sdd_write_narrative', {
    id: JOURNEY.workerImpl,
    name: 'Journey Worker Impl',
    description: 'Enrichment flow',
    contract: JOURNEY.workerInterface,
    methods: [
      {
        name: 'enrich',
        narrative: [
          { description: 'Derive the enrichment fields from the payload', type: 'local' },
          { description: 'Enriched payload produced', type: 'return', outcome: 'success' },
        ],
      },
    ],
  });
  await callToolOk(client, 'sdd_write_narrative', {
    id: JOURNEY.orchImpl,
    name: 'Journey Orchestrator Impl',
    description: 'The journey workflow',
    contract: JOURNEY.orchInterface,
    methods: [
      {
        name: 'runJourney',
        narrative: [
          { description: 'Validate the journey request payload', type: 'local' },
          { description: 'Enrich the journey via the worker', type: 'call', targetComponent: JOURNEY.worker, targetMethod: 'enrich' },
          { description: 'Journey completed', type: 'return', outcome: 'success' },
        ],
      },
    ],
  });

  // A design-only tree deliberately declares no sourcePath (declaring one
  // without the file on disk is MISSING_SOURCE_FILE, an error) — acknowledge
  // the resulting MISSING_SOURCE_PATH warnings through the sanctioned
  // lint.allow seam so `validate --ci` judges the tree on its own terms.
  for (const implId of [JOURNEY.orchImpl, JOURNEY.workerImpl]) {
    await callToolOk(client, 'sdd_update_spec', {
      kind: 'implementation',
      id: implId,
      delta: {
        lint: { allow: [{ code: 'MISSING_SOURCE_PATH', reason: 'design-only e2e journey — code realization happens outside this scratch project' }] },
      },
    });
  }
}
