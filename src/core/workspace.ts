import * as fs from 'fs';
import * as path from 'path';
import { aiDir, ensureDir, writeFile, pathExists } from '../utils/fs.js';
import { writeYamlFile, readYamlFile } from '../utils/yaml.js';
import { Run, RunSchema, Step, generateRunId } from '../models/run.js';
export { generateStepId } from '../models/run.js';
import { JobResult, JobResultSchema } from '../models/job.js';

// ---------------------------------------------------------------------------
// Workspace management
//
// A "workspace" is the .wai/runs/<run-id>/steps/<step-id>/ directory tree.
// Each step gets:
//   - A job.yaml describing the task
//   - An isolated tool config dir (.claude/ or .gemini/) with a generated
//     context file (CLAUDE.md or GEMINI.md) and domain-scoped agents/
//   - A result.yaml written by the sub-agent on completion
//
// The env vars CLAUDE_HOME / GEMINI_CONFIG_DIR point the spawned tool at the
// step's config dir. The user's ~/.claude and ~/.gemini are never touched.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function runsDir(): string {
  return aiDir('runs');
}

export function runDir(runId: string): string {
  return aiDir('runs', runId);
}

export function runStatusPath(runId: string): string {
  return aiDir('runs', runId, 'status.yaml');
}

export function stepDir(runId: string, stepId: string): string {
  return aiDir('runs', runId, 'steps', stepId);
}

export function stepJobPath(runId: string, stepId: string): string {
  return path.join(stepDir(runId, stepId), 'job.yaml');
}

export function stepResultPath(runId: string, stepId: string): string {
  return path.join(stepDir(runId, stepId), 'result.yaml');
}

export function stepToolConfigDir(runId: string, stepId: string, backend: string): string {
  const toolDir = backendConfigDirName(backend);
  return path.join(stepDir(runId, stepId), toolDir);
}

export function stepContextFilePath(runId: string, stepId: string, backend: string): string {
  const dir = stepToolConfigDir(runId, stepId, backend);
  const filename = backendContextFilename(backend);
  return path.join(dir, filename);
}

export function stepAgentsDir(runId: string, stepId: string, backend: string): string {
  return path.join(stepToolConfigDir(runId, stepId, backend), 'agents');
}

function backendConfigDirName(backend: string): string {
  if (backend === 'gemini') return '.gemini';
  return '.claude'; // claude, ollama, openai, custom all use .claude layout
}

function backendContextFilename(backend: string): string {
  if (backend === 'gemini') return 'GEMINI.md';
  return 'CLAUDE.md';
}

// ---------------------------------------------------------------------------
// Run CRUD
// ---------------------------------------------------------------------------

export function createRun(label?: string): Run {
  const now = new Date().toISOString();
  const run: Run = RunSchema.parse({
    id: generateRunId(),
    label,
    status: 'pending',
    steps: [],
    createdAt: now,
    updatedAt: now,
  });
  ensureDir(runDir(run.id));
  ensureDir(aiDir('runs', run.id, 'steps'));
  writeYamlFile(runStatusPath(run.id), run);
  return run;
}

export function loadRun(runId: string): Run {
  const raw = readYamlFile(runStatusPath(runId));
  if (!raw) throw new Error(`Run "${runId}" not found at ${runStatusPath(runId)}`);
  return RunSchema.parse(raw);
}

export function saveRun(run: Run): void {
  run.updatedAt = new Date().toISOString();
  writeYamlFile(runStatusPath(run.id), run);
}

export function listRuns(): Run[] {
  const dir = runsDir();
  if (!pathExists(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      try { return loadRun(e.name); } catch { return null; }
    })
    .filter((r): r is Run => r !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function updateRunStatus(runId: string, status: Run['status']): void {
  const run = loadRun(runId);
  run.status = status;
  saveRun(run);
}

export function updateStepStatus(runId: string, stepId: string, status: Step['status']): void {
  const run = loadRun(runId);
  const step = run.steps.find((s) => s.id === stepId);
  if (!step) throw new Error(`Step "${stepId}" not found in run "${runId}"`);
  step.status = status;
  if (status === 'running') step.startedAt = new Date().toISOString();
  if (['completed', 'failed', 'abandoned'].includes(status)) {
    step.completedAt = new Date().toISOString();
  }
  saveRun(run);
}

// ---------------------------------------------------------------------------
// Step result (read by parent after sub-agent exits)
// ---------------------------------------------------------------------------

export function loadStepResult(runId: string, stepId: string): JobResult | null {
  const raw = readYamlFile(stepResultPath(runId, stepId));
  if (!raw) return null;
  try { return JobResultSchema.parse(raw); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Context file generation
// ---------------------------------------------------------------------------

export interface WorkspaceContextOptions {
  /** The task this step should perform */
  task: string;
  /** Domain id (null = project root) */
  domainId: string | null;
  /** Backend: claude | gemini | ... */
  backend: string;
  /** Results from previous steps to include as context */
  priorResults?: Array<{ stepId: string; summary: string }>;
  /** Parallel steps this step should be aware of */
  parallelSteps?: Array<{ stepId: string; domain: string | null; task: string; jobPath: string }>;
}

/**
 * Generate the CLAUDE.md / GEMINI.md for a step workspace.
 * Combines: project context + task brief + domain constraints + awareness.
 */
export function buildStepContextFile(options: WorkspaceContextOptions): string {
  // Lazy imports to avoid circular deps at module load
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readProjectContext, readArchitectureContext } = require('./context.js') as typeof import('./context.js');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { loadDomainRegistry, loadRegistry } = require('../config/loader.js') as typeof import('../config/loader.js');

  const lines: string[] = [];

  // ── 1. Project context ──────────────────────────────────────────────────
  const projectCtx = readProjectContext();
  const archCtx    = readArchitectureContext();

  if (projectCtx) {
    lines.push('# Project Context');
    lines.push('');
    lines.push(projectCtx.trim());
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  if (archCtx) {
    lines.push('# Architecture');
    lines.push('');
    lines.push(archCtx.trim());
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // ── 2. Domain scope ─────────────────────────────────────────────────────
  if (options.domainId && options.domainId !== 'root') {
    const registry = loadDomainRegistry();
    const domain = registry.domains.find((d) => d.id === options.domainId);
    if (domain) {
      lines.push(`# Domain Scope`);
      lines.push('');
      lines.push(`You are operating within the **${domain.name ?? domain.id}** domain.`);
      lines.push('');
      lines.push(`- **Domain id:** \`${domain.id}\``);
      lines.push(`- **Path:** \`${domain.path}\``);
      lines.push('');
      lines.push('Stay within this domain. Do not modify files outside this path unless they are');
      lines.push('shared contract files explicitly mentioned in the task.');
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }

  // ── 3. Agent roster ─────────────────────────────────────────────────────
  try {
    const agentRegistry = loadRegistry();
    const domainAgents = options.domainId && options.domainId !== 'root'
      ? agentRegistry.agents.filter((a) => a.domainRoot === options.domainId)
      : agentRegistry.agents.filter((a) => !a.domainRoot);

    if (domainAgents.length > 0) {
      lines.push('# Available Sub-Agents');
      lines.push('');
      for (const a of domainAgents) {
        lines.push(`- **${a.id}** — ${a.description}`);
      }
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  } catch { /* registry not readable — skip */ }

  // ── 4. Prior step results ────────────────────────────────────────────────
  if (options.priorResults && options.priorResults.length > 0) {
    lines.push('# Prior Step Results');
    lines.push('');
    lines.push('The following steps completed before yours. Their outputs are your context:');
    lines.push('');
    for (const r of options.priorResults) {
      lines.push(`## Step: ${r.stepId}`);
      lines.push('');
      lines.push(r.summary.trim());
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }

  // ── 5. Parallel step awareness ───────────────────────────────────────────
  if (options.parallelSteps && options.parallelSteps.length > 0) {
    lines.push('# Parallel Work Awareness');
    lines.push('');
    lines.push('The following steps are running concurrently with yours.');
    lines.push('Check their job files for latest status. Use shared contract files for handoffs.');
    lines.push('');
    for (const p of options.parallelSteps) {
      const scope = p.domain ? `domain \`${p.domain}\`` : 'project root';
      lines.push(`## ${p.stepId} (${scope})`);
      lines.push('');
      lines.push(`Task: ${p.task}`);
      lines.push(`Job file: \`${p.jobPath}\``);
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }

  // ── 6. Task brief ────────────────────────────────────────────────────────
  lines.push('# Your Task');
  lines.push('');
  lines.push(options.task.trim());
  lines.push('');
  lines.push('---');
  lines.push('');

  // ── 7. Result protocol ───────────────────────────────────────────────────
  lines.push('# Result Protocol');
  lines.push('');
  lines.push('When you finish, write a result file at the path in `WAIRON_RESULT_FILE`.');
  lines.push('');
  lines.push('```yaml');
  lines.push('jobId: <value of WAIRON_JOB_ID>');
  lines.push('status: completed   # or: failed / partial');
  lines.push('completedAt: <ISO 8601 timestamp>');
  lines.push('summary: |');
  lines.push('  What was done, concisely.');
  lines.push('filesChanged:');
  lines.push('  - path/to/changed/file.ts');
  lines.push('flagged: |  # optional — things noticed but out of scope');
  lines.push('  ...');
  lines.push('```');
  lines.push('');
  lines.push('Then exit cleanly. The parent session will pick up the result.');

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Scaffold a complete step workspace
// ---------------------------------------------------------------------------

export interface ScaffoldStepOptions {
  runId: string;
  stepId: string;
  task: string;
  domainId: string | null;
  backend: string;
  priorResults?: Array<{ stepId: string; summary: string }>;
  parallelSteps?: Array<{ stepId: string; domain: string | null; task: string; jobPath: string }>;
}

/**
 * Create the full directory tree for one run step:
 *   .wai/runs/<run-id>/steps/<step-id>/
 *     .claude/CLAUDE.md   (or .gemini/GEMINI.md)
 *     .claude/agents/     (domain-scoped agent files, if any)
 *
 * Returns the absolute path to the tool config dir that should be set as
 * CLAUDE_HOME or GEMINI_CONFIG_DIR for the child process.
 */
export function scaffoldStep(options: ScaffoldStepOptions): string {
  const { runId, stepId, backend } = options;

  // Create directory tree
  const sDir = stepDir(runId, stepId);
  const toolConfigDir = stepToolConfigDir(runId, stepId, backend);
  const agentsDir = stepAgentsDir(runId, stepId, backend);

  ensureDir(sDir);
  ensureDir(toolConfigDir);
  ensureDir(agentsDir);

  // Write context file
  const contextContent = buildStepContextFile({
    task: options.task,
    domainId: options.domainId,
    backend,
    priorResults: options.priorResults,
    parallelSteps: options.parallelSteps,
  });
  const contextPath = stepContextFilePath(runId, stepId, backend);
  writeFile(contextPath, contextContent);

  // Write domain-scoped agent files into the workspace's agents/ dir
  scaffoldStepAgents(options, agentsDir);

  return toolConfigDir;
}

function scaffoldStepAgents(options: ScaffoldStepOptions, agentsDir: string): void {
  // We need the project root to find existing generated agent files
  // Copy them from the project's target output dir into the workspace agents/ dir
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { loadRegistry, loadProjectConfig, loadDomainRegistry } = require('../config/loader.js') as typeof import('../config/loader.js');

    const registry  = loadRegistry();
    const config    = loadProjectConfig();
    const domReg    = loadDomainRegistry();
    const cwd       = process.cwd();

    const relevant = options.domainId && options.domainId !== 'root'
      ? registry.agents.filter((a) => a.domainRoot === options.domainId)
      : registry.agents.filter((a) => !a.domainRoot);

    const backendType = options.backend === 'gemini' ? 'gemini' : 'claude';
    const target = config.targets.find((t) => t.type === backendType);
    if (!target) return;

    const outputDir = 'outputDir' in target ? target.outputDir : (backendType === 'gemini' ? '.gemini/agents' : '.claude/agents');

    for (const agent of relevant) {
      // For domain agents, source is inside the domain dir; for root agents, project root
      let sourceBase = cwd;
      if (agent.domainRoot) {
        const domain = domReg.domains.find((d) => d.id === agent.domainRoot);
        if (domain) sourceBase = path.resolve(cwd, domain.path);
      }
      const sourcePath = path.resolve(sourceBase, outputDir, `${agent.id}.md`);
      if (fs.existsSync(sourcePath)) {
        const destPath = path.join(agentsDir, `${agent.id}.md`);
        fs.copyFileSync(sourcePath, destPath);
      }
    }
  } catch {
    // Non-fatal — workspace still usable without pre-copied agents
  }
}

// ---------------------------------------------------------------------------
// Environment variables for a step's subprocess
// ---------------------------------------------------------------------------

export function stepEnvVars(
  runId: string,
  stepId: string,
  jobId: string,
  backend: string,
): Record<string, string> {
  const configDir  = path.resolve(stepToolConfigDir(runId, stepId, backend));
  const jobPath    = path.resolve(stepJobPath(runId, stepId));
  const resultPath = path.resolve(stepResultPath(runId, stepId));

  const envKey = backend === 'gemini' ? 'GEMINI_CONFIG_DIR' : 'CLAUDE_HOME';

  return {
    [envKey]:            configDir,
    WAIRON_JOB_ID:       jobId,
    WAIRON_JOB_FILE:     jobPath,
    WAIRON_RESULT_FILE:  resultPath,
    WAIRON_RUN_ID:       runId,
    WAIRON_STEP_ID:      stepId,
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export interface CleanRunsOptions {
  /** Remove all runs regardless of status */
  all?: boolean;
  /** Remove runs older than N days */
  olderThanDays?: number;
}

export function cleanRuns(options: CleanRunsOptions = {}): number {
  const runs = listRuns();
  const now = Date.now();
  let removed = 0;

  for (const run of runs) {
    const shouldRemove =
      options.all ||
      (['completed', 'failed', 'cancelled'].includes(run.status) &&
        (!options.olderThanDays ||
          (now - new Date(run.createdAt).getTime()) > options.olderThanDays * 86_400_000));

    if (shouldRemove) {
      try {
        fs.rmSync(runDir(run.id), { recursive: true, force: true });
        removed++;
      } catch { /* best effort */ }
    }
  }

  return removed;
}
