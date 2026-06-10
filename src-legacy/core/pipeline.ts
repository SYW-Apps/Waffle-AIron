import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { spawn } from 'child_process';
import chalk from 'chalk';
import { aiDir, ensureDir, pathExists } from '../utils/fs.js';
import { readYamlFile, writeYamlFile } from '../utils/yaml.js';
import { Pipeline, PipelineSchema, PipelineStep } from '../models/pipeline.js';
import { Run, Step } from '../models/run.js';
import { logger } from '../utils/logger.js';
import {
  createRun,
  loadRun,
  saveRun,
  updateRunStatus,
  updateStepStatus,
  loadStepResult,
  scaffoldStep,
  stepEnvVars,
  stepJobPath,
  generateStepId,
} from './workspace.js';

// ---------------------------------------------------------------------------
// Pipeline storage helpers
// ---------------------------------------------------------------------------

export function pipelinesDir(): string {
  return aiDir('pipelines');
}

export function pipelinePath(id: string): string {
  return path.join(pipelinesDir(), `${id}.yaml`);
}

export function loadPipeline(id: string): Pipeline {
  const raw = readYamlFile(pipelinePath(id));
  if (!raw) throw new Error(`Pipeline "${id}" not found at ${pipelinePath(id)}`);
  return PipelineSchema.parse({ id, ...raw });
}

export function listPipelines(): Pipeline[] {
  const dir = pipelinesDir();
  if (!pathExists(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map((f) => {
      const id = f.replace(/\.ya?ml$/, '');
      try { return loadPipeline(id); } catch { return null; }
    })
    .filter((p): p is Pipeline => p !== null);
}

export function savePipeline(pipeline: Pipeline): void {
  ensureDir(pipelinesDir());
  // Write without the id field (it's the filename)
  const { id: _id, ...rest } = pipeline;
  writeYamlFile(pipelinePath(pipeline.id), rest);
}

// ---------------------------------------------------------------------------
// Variable interpolation
// ---------------------------------------------------------------------------

export function interpolate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

export function interpolateStep(step: PipelineStep, vars: Record<string, string>): PipelineStep {
  return {
    ...step,
    task:  interpolate(step.task, vars),
    label: step.label ? interpolate(step.label, vars) : step.label,
  };
}

// ---------------------------------------------------------------------------
// Dependency / execution order resolution
// ---------------------------------------------------------------------------

/**
 * Topological sort of pipeline steps.
 * Returns groups of step ids that can run in parallel.
 * Each group depends only on steps in prior groups.
 */
export function resolvExecutionOrder(steps: PipelineStep[]): string[][] {
  const stepMap = new Map(steps.map((s) => [s.id, s]));
  const completed = new Set<string>();
  const groups: string[][] = [];
  let remaining = steps.map((s) => s.id);

  while (remaining.length > 0) {
    // Find all steps whose dependencies are all completed
    const ready = remaining.filter((id) => {
      const step = stepMap.get(id)!;
      // Hard deps must be completed; awareOf does not block
      return step.dependsOn.every((dep) => completed.has(dep));
    });

    if (ready.length === 0) {
      throw new Error(
        `Pipeline has a circular dependency or unresolvable step. ` +
        `Remaining: ${remaining.join(', ')}`
      );
    }

    groups.push(ready);
    for (const id of ready) completed.add(id);
    remaining = remaining.filter((id) => !completed.has(id));
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Pipeline executor
// ---------------------------------------------------------------------------

export interface PipelineRunOptions {
  variables?: Record<string, string>;
  dryRun?: boolean;
}

export async function executePipeline(
  pipeline: Pipeline,
  options: PipelineRunOptions = {},
): Promise<Run> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { loadProjectConfig } = require('../config/loader.js') as typeof import('../config/loader.js');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { resolveToolCommand } = require('../config/profiles.js') as typeof import('../config/profiles.js');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { fromProjectRoot } = require('../utils/fs.js') as typeof import('../utils/fs.js');

  const projectConfig = loadProjectConfig();

  // ── Resolve variables ──────────────────────────────────────────────────
  const vars: Record<string, string> = {};
  // Defaults from pipeline definition
  for (const [key, def] of Object.entries(pipeline.variables ?? {})) {
    if (def.default !== undefined) vars[key] = def.default;
  }
  // Caller overrides
  Object.assign(vars, options.variables ?? {});

  // ── Create run ─────────────────────────────────────────────────────────
  const run = createRun(pipeline.name);
  run.pipelineId = pipeline.id;
  run.variables  = vars;
  saveRun(run);

  logger.blank();
  logger.info(`Pipeline: ${chalk.bold(pipeline.name)}`);
  logger.info(`Run:      ${chalk.bold(run.id)}`);
  if (Object.keys(vars).length > 0) {
    for (const [k, v] of Object.entries(vars)) {
      logger.info(`  ${chalk.gray(k + ':')} ${v}`);
    }
  }
  logger.blank();

  if (options.dryRun) {
    return _dryRunPipeline(pipeline, run, vars);
  }

  // Determine execution groups
  let groups: string[][];
  try {
    groups = resolvExecutionOrder(pipeline.steps);
  } catch (err) {
    run.status       = 'failed';
    run.errorMessage = (err as Error).message;
    saveRun(run);
    throw err;
  }

  updateRunStatus(run.id, 'running');

  // ── Execute groups sequentially; steps within a group run in parallel ──
  const stepIdMap = new Map<string, string>(); // pipelineStepId → runtime stepId
  const resultMap = new Map<string, string>();  // runtime stepId → summary text

  for (const group of groups) {
    logger.info(chalk.gray(`▶ executing group: [${group.join(', ')}]`));

    const groupResults = await Promise.allSettled(
      group.map(async (pipelineStepId) => {
        const pipelineStep = pipeline.steps.find((s) => s.id === pipelineStepId)!;
        const resolved     = interpolateStep(pipelineStep, vars);

        // Build prior results from dependencies
        const priorResults = pipelineStep.dependsOn
          .map((depId) => {
            const runtimeId = stepIdMap.get(depId);
            if (!runtimeId) return null;
            const summary   = resultMap.get(runtimeId);
            return summary ? { stepId: depId, summary } : null;
          })
          .filter((r): r is { stepId: string; summary: string } => r !== null);

        // Build parallel awareness
        const parallelSteps = pipelineStep.awareOf
          .map((awareId) => {
            const awareStep = pipeline.steps.find((s) => s.id === awareId);
            if (!awareStep) return null;
            const runtimeId = stepIdMap.get(awareId);
            return {
              stepId:  awareId,
              domain:  awareStep.domain ?? null,
              task:    interpolate(awareStep.task, vars),
              jobPath: runtimeId
                ? path.resolve(stepJobPath(run.id, runtimeId))
                : '(not yet started)',
            };
          })
          .filter((p): p is NonNullable<typeof p> => p !== null);

        const stepId = generateStepId(pipelineStepId);
        stepIdMap.set(pipelineStepId, stepId);

        // Add step to run record
        const step: Step = {
          id:          stepId,
          label:       resolved.label ?? pipelineStepId,
          status:      'pending',
          type:        resolved.type,
          domain:      resolved.domain ?? null,
          backend:     (resolved.backend ?? projectConfig.defaultBackend ?? 'claude') as Step['backend'],
          backendModel: resolved.model,
          task:        resolved.task,
          dependsOn:   pipelineStep.dependsOn,
          awareOf:     pipelineStep.awareOf,
          createdAt:   new Date().toISOString(),
        };

        const runLoaded = loadRun(run.id);
        runLoaded.steps.push(step);
        saveRun(runLoaded);

        // ── Shell step ──────────────────────────────────────────────────
        if (resolved.type === 'shell') {
          return _executeShellStep(run.id, stepId, resolved);
        }

        // ── AI step ─────────────────────────────────────────────────────
        return _executeAiStep(
          run,
          stepId,
          resolved,
          priorResults,
          parallelSteps,
          projectConfig,
          resolveToolCommand,
          fromProjectRoot,
          resultMap,
        );
      })
    );

    // Check if any non-continueOnFailure step failed
    for (let i = 0; i < group.length; i++) {
      const pipelineStepId = group[i];
      const pipelineStep   = pipeline.steps.find((s) => s.id === pipelineStepId)!;
      const settled        = groupResults[i];

      if (settled.status === 'rejected' || _stepFailed(run.id, stepIdMap.get(pipelineStepId)!)) {
        if (!pipelineStep.continueOnFailure) {
          updateRunStatus(run.id, 'failed');
          const reason = settled.status === 'rejected' ? (settled.reason as Error).message : 'step failed';
          logger.blank();
          logger.error(`Pipeline failed at step "${pipelineStepId}": ${reason}`);
          return loadRun(run.id);
        }
      }
    }
  }

  // ── All groups complete ────────────────────────────────────────────────
  const finalRun = loadRun(run.id);
  const anyFailed = finalRun.steps.some((s) => s.status === 'failed');
  finalRun.status = anyFailed ? 'failed' : 'completed';
  saveRun(finalRun);

  return finalRun;
}

// ---------------------------------------------------------------------------
// AI step execution
// ---------------------------------------------------------------------------

async function _executeAiStep(
  run: Run,
  stepId: string,
  step: PipelineStep,
  priorResults: Array<{ stepId: string; summary: string }>,
  parallelSteps: Array<{ stepId: string; domain: string | null; task: string; jobPath: string }>,
  projectConfig: { defaultBackend?: string; profile?: string; targets: Array<{ type: string; outputDir?: string }> },
  resolveToolCommand: (backend: string, profile?: string) => string,
  fromProjectRoot: (...segments: string[]) => string,
  resultMap: Map<string, string>,
): Promise<void> {
  const backend  = step.backend ?? projectConfig.defaultBackend ?? 'claude';
  const domainId = step.domain ?? null;

  updateStepStatus(run.id, stepId, 'running');

  // Scaffold workspace
  scaffoldStep({
    runId:   run.id,
    stepId,
    task:    step.task,
    domainId,
    backend,
    priorResults,
    parallelSteps,
  });

  // Write job file
  const jobId = `${run.id}-${stepId}`;
  const domainPath = _resolveDomainPath(domainId);
  writeYamlFile(stepJobPath(run.id, stepId), {
    id:          jobId,
    status:      'pending',
    domain:      domainId ?? 'root',
    domainPath,
    createdBy:   `pipeline:${run.pipelineId ?? 'unknown'}`,
    backend,
    backendModel: step.model,
    task:        step.task,
    createdAt:   new Date().toISOString(),
    context:     { files: [], notes: [] },
  });

  const cmd = resolveToolCommand(backend, projectConfig.profile);
  const cwd = domainId ? fromProjectRoot(domainPath) : fromProjectRoot();
  const env = {
    ...process.env,
    ...stepEnvVars(run.id, stepId, jobId, backend),
  };

  logger.info(`  [${step.id ?? stepId}] Starting ${chalk.bold(cmd)}${domainId ? ` in ${chalk.cyan(domainId)}` : ''}`);

  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(cmd, [], { cwd, stdio: 'inherit', shell: true, env });
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', (err) => { logger.error(`Failed to start ${cmd}: ${err.message}`); resolve(1); });
  });

  const result = loadStepResult(run.id, stepId);

  if (result) {
    updateStepStatus(run.id, stepId, 'completed');
    resultMap.set(stepId, result.summary);
    logger.success(`  [${step.id ?? stepId}] Completed`);
  } else if (exitCode === 0) {
    updateStepStatus(run.id, stepId, 'abandoned');
    resultMap.set(stepId, '(session ended without writing a result)');
    logger.warn(`  [${step.id ?? stepId}] Abandoned — no result written`);
  } else {
    updateStepStatus(run.id, stepId, 'failed');
    logger.error(`  [${step.id ?? stepId}] Failed (exit ${exitCode})`);
    throw new Error(`AI step "${step.id}" failed with exit code ${exitCode}`);
  }
}

// ---------------------------------------------------------------------------
// Shell step execution
// ---------------------------------------------------------------------------

async function _executeShellStep(
  runId: string,
  stepId: string,
  step: PipelineStep,
): Promise<void> {
  updateStepStatus(runId, stepId, 'running');

  logger.info(`  [${step.id ?? stepId}] Running: ${chalk.gray(step.task)}`);

  let exitCode = 0;
  let output   = '';

  try {
    output    = execSync(step.task, { encoding: 'utf-8', stdio: 'pipe' });
    exitCode  = 0;
  } catch (err: unknown) {
    const execError = err as { status?: number; stdout?: string; stderr?: string; message?: string };
    exitCode = execError.status ?? 1;
    output   = [execError.stdout, execError.stderr].filter(Boolean).join('\n');
  }

  // Truncate output to avoid bloating status.yaml
  const truncated = output.length > 4000 ? '...\n' + output.slice(-4000) : output;

  // Save shell output to the step
  const run  = loadRun(runId);
  const step_ = run.steps.find((s) => s.id === stepId);
  if (step_) {
    step_.exitCode    = exitCode;
    step_.shellOutput = truncated;
  }
  saveRun(run);

  if (exitCode === 0) {
    updateStepStatus(runId, stepId, 'completed');
    logger.success(`  [${step.id ?? stepId}] Shell step passed (exit 0)`);
  } else {
    updateStepStatus(runId, stepId, 'failed');
    logger.error(`  [${step.id ?? stepId}] Shell step failed (exit ${exitCode})`);
    if (truncated.trim()) {
      logger.blank();
      console.log(chalk.gray(truncated.trim().split('\n').slice(-10).join('\n')));
    }
    if (!step.continueOnFailure) {
      throw new Error(`Shell step "${step.id}" failed (exit ${exitCode})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Dry-run
// ---------------------------------------------------------------------------

function _dryRunPipeline(pipeline: Pipeline, run: Run, vars: Record<string, string>): Run {
  let groups: string[][];
  try {
    groups = resolvExecutionOrder(pipeline.steps);
  } catch (err) {
    logger.error((err as Error).message);
    return run;
  }

  logger.info('[dry-run] Execution plan:');
  logger.blank();

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const parallel = group.length > 1;
    console.log(`  Group ${i + 1}${parallel ? chalk.gray(' (parallel)') : ''}:`);
    for (const id of group) {
      const s = pipeline.steps.find((s) => s.id === id)!;
      const resolved = interpolateStep(s, vars);
      const tag = resolved.type === 'shell' ? chalk.yellow('[shell]') : chalk.cyan(`[${resolved.backend ?? 'claude'}]`);
      const domain = resolved.domain ? chalk.gray(` @${resolved.domain}`) : '';
      console.log(`    ${tag} ${chalk.bold(id)}${domain}`);
      console.log(`      ${chalk.gray(resolved.task.slice(0, 80))}${resolved.task.length > 80 ? chalk.gray('…') : ''}`);
    }
    logger.blank();
  }

  run.status = 'cancelled';
  saveRun(run);
  return run;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _resolveDomainPath(domainId: string | null): string {
  if (!domainId || domainId === 'root') return '.';
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { loadDomainRegistry } = require('../config/loader.js') as typeof import('../config/loader.js');
    const reg = loadDomainRegistry();
    return reg.domains.find((d) => d.id === domainId)?.path ?? '.';
  } catch {
    return '.';
  }
}

function _stepFailed(runId: string, stepId: string): boolean {
  try {
    const run = loadRun(runId);
    return run.steps.find((s) => s.id === stepId)?.status === 'failed';
  } catch {
    return false;
  }
}
