import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { logger } from '../utils/logger.js';
import { assertProjectInitialized, loadProjectConfig } from '../config/loader.js';
import { aiDir, ensureDir } from '../utils/fs.js';
import { writeYamlFile } from '../utils/yaml.js';
import {
  loadPipeline,
  listPipelines,
  pipelinesDir,
  pipelinePath,
  executePipeline,
  resolvExecutionOrder,
} from '../core/pipeline.js';
import { loadRun, listRuns, loadStepResult } from '../core/workspace.js';

// ---------------------------------------------------------------------------
// pipeline list
// ---------------------------------------------------------------------------

export async function runPipelineList(): Promise<void> {
  assertProjectInitialized();
  const pipelines = listPipelines();

  if (pipelines.length === 0) {
    logger.info('No pipelines defined yet.');
    logger.blank();
    logger.info(`Create one with ${chalk.bold('wairon pipeline init')} or add a YAML file to ${chalk.cyan('.wai/pipelines/')}`);
    return;
  }

  logger.blank();
  for (const p of pipelines) {
    console.log(`  ${chalk.bold(p.id)}  ${chalk.gray(p.name)}`);
    if (p.description) console.log(`    ${chalk.gray(p.description)}`);
    console.log(`    ${chalk.gray(p.steps.length + ' step(s): ' + p.steps.map((s) => s.id).join(' → '))}`);
    logger.blank();
  }
}

// ---------------------------------------------------------------------------
// pipeline show <id>
// ---------------------------------------------------------------------------

export async function runPipelineShow(id: string): Promise<void> {
  assertProjectInitialized();

  let pipeline;
  try {
    pipeline = loadPipeline(id);
  } catch {
    logger.error(`Pipeline "${id}" not found. Run \`wairon pipeline list\` to see available pipelines.`);
    process.exit(1);
  }

  logger.blank();
  console.log(`${chalk.bold(pipeline.id)}  —  ${pipeline.name}`);
  if (pipeline.description) {
    logger.blank();
    console.log(chalk.gray(pipeline.description));
  }

  if (pipeline.variables && Object.keys(pipeline.variables).length > 0) {
    logger.blank();
    console.log(chalk.bold('Variables:'));
    for (const [key, def] of Object.entries(pipeline.variables)) {
      const defVal = def.default ? chalk.gray(` (default: "${def.default}")`) : '';
      const desc   = def.description ? chalk.gray(` — ${def.description}`) : '';
      console.log(`  ${chalk.cyan(key)}${defVal}${desc}`);
    }
  }

  logger.blank();
  console.log(chalk.bold('Steps:'));
  logger.blank();

  let groups: string[][];
  try {
    groups = resolvExecutionOrder(pipeline.steps);
  } catch {
    groups = [pipeline.steps.map((s) => s.id)];
  }

  for (let i = 0; i < groups.length; i++) {
    const group    = groups[i];
    const parallel = group.length > 1;
    console.log(`  ${chalk.gray('Group ' + (i + 1))}${parallel ? chalk.gray(' — parallel') : ''}`);
    for (const sid of group) {
      const s      = pipeline.steps.find((s) => s.id === sid)!;
      const tag    = s.type === 'shell' ? chalk.yellow('[shell]') : chalk.cyan(`[${s.backend ?? 'default'}]`);
      const domain = s.domain ? chalk.gray(` @${s.domain}`) : '';
      const deps   = s.dependsOn.length > 0 ? chalk.gray(` ← ${s.dependsOn.join(', ')}`) : '';
      console.log(`    ${tag} ${chalk.bold(s.id)}${domain}${deps}`);
      console.log(`      ${chalk.gray(s.task.slice(0, 100))}${s.task.length > 100 ? chalk.gray('…') : ''}`);
    }
    logger.blank();
  }
}

// ---------------------------------------------------------------------------
// pipeline run <id>
// ---------------------------------------------------------------------------

export interface PipelineRunOptions {
  variables?: string[];   // ["key=value", ...]
  dryRun?: boolean;
}

export async function runPipelineRun(id: string, options: PipelineRunOptions = {}): Promise<void> {
  assertProjectInitialized();

  let pipeline;
  try {
    pipeline = loadPipeline(id);
  } catch {
    logger.error(`Pipeline "${id}" not found. Run \`wairon pipeline list\` to see available pipelines.`);
    process.exit(1);
  }

  // Parse --var key=value pairs
  const vars: Record<string, string> = {};
  for (const v of (options.variables ?? [])) {
    const eq = v.indexOf('=');
    if (eq === -1) { logger.warn(`Ignoring malformed --var: "${v}" (expected key=value)`); continue; }
    vars[v.slice(0, eq)] = v.slice(eq + 1);
  }

  // Check that all required variables (no default) are provided
  const missing: string[] = [];
  for (const [key, def] of Object.entries(pipeline.variables ?? {})) {
    if (!def.default && !vars[key]) missing.push(key);
  }
  if (missing.length > 0) {
    logger.blank();
    for (const key of missing) {
      const def = pipeline.variables![key];
      const { value } = await inquirer.prompt<{ value: string }>([{
        type:     'input',
        name:     'value',
        message:  `Variable ${chalk.cyan(key)}${def.description ? ` — ${def.description}` : ''}:`,
        validate: (v: string) => v.trim() ? true : 'Required',
      }]);
      vars[key] = value.trim();
    }
  }

  const run = await executePipeline(pipeline, { variables: vars, dryRun: options.dryRun });

  if (options.dryRun) return;

  logger.blank();
  if (run.status === 'completed') {
    logger.success(`Pipeline "${pipeline.name}" completed.`);
  } else if (run.status === 'failed') {
    logger.error(`Pipeline "${pipeline.name}" failed.`);
  }
  logger.blank();
  logger.info(`Run id: ${chalk.bold(run.id)}`);
  logger.info(`Details: ${chalk.gray('wairon pipeline status ' + run.id)}`);
  logger.blank();
}

// ---------------------------------------------------------------------------
// pipeline status [run-id]
// ---------------------------------------------------------------------------

export async function runPipelineStatus(runId?: string): Promise<void> {
  assertProjectInitialized();

  // If run-id given — show detail
  if (runId) {
    _printRunDetail(runId);
    return;
  }

  // Otherwise list recent pipeline runs
  const runs = listRuns().filter((r) => !!r.pipelineId);

  if (runs.length === 0) {
    logger.info('No pipeline runs found. Start one with `wairon pipeline run <id>`.');
    return;
  }

  logger.blank();
  for (const run of runs.slice(0, 20)) {
    const sc     = _statusColor(run.status);
    const label  = run.label ? chalk.gray(` — ${run.label.slice(0, 50)}`) : '';
    const steps  = chalk.gray(` (${run.steps.length} steps)`);
    const pid    = chalk.gray(` [${run.pipelineId}]`);
    console.log(`  ${sc(run.status.padEnd(10))}  ${chalk.bold(run.id)}${pid}${label}${steps}`);
  }
  logger.blank();
}

function _printRunDetail(runId: string): void {
  let run: ReturnType<typeof loadRun>;
  try { run = loadRun(runId); }
  catch { logger.error(`Run "${runId}" not found.`); process.exit(1); }

  logger.blank();
  const sc = _statusColor(run.status);
  console.log(`${chalk.bold('Run:')}      ${run.id}`);
  if (run.pipelineId) console.log(`${chalk.bold('Pipeline:')} ${run.pipelineId}`);
  if (run.label)      console.log(`${chalk.bold('Label:')}    ${run.label}`);
  console.log(`${chalk.bold('Status:')}   ${sc(run.status)}`);
  console.log(`${chalk.bold('Created:')}  ${run.createdAt}`);

  if (run.variables && Object.keys(run.variables).length > 0) {
    logger.blank();
    console.log(chalk.bold('Variables:'));
    for (const [k, v] of Object.entries(run.variables)) {
      console.log(`  ${chalk.cyan(k)}: ${v}`);
    }
  }

  if (run.errorMessage) {
    logger.blank();
    logger.error(run.errorMessage);
  }

  if (run.steps.length > 0) {
    logger.blank();
    console.log(chalk.bold('Steps:'));
    for (const step of run.steps) {
      const stc    = _statusColor(step.status);
      const domain = step.domain ? chalk.gray(` [@${step.domain}]`) : '';
      const be     = step.type === 'shell' ? chalk.yellow('[shell]') : chalk.cyan(`[${step.backend}]`);
      console.log(`  ${stc(step.status.padEnd(10))} ${be} ${chalk.bold(step.id)}${domain}`);
      console.log(`    ${chalk.gray(step.task.slice(0, 90))}${step.task.length > 90 ? chalk.gray('…') : ''}`);

      if (step.type === 'shell' && step.shellOutput) {
        const lines = step.shellOutput.trim().split('\n').slice(-3);
        for (const l of lines) console.log(`    ${chalk.gray('│')} ${chalk.gray(l)}`);
      }

      const result = loadStepResult(runId, step.id);
      if (result) {
        console.log(`    ${chalk.green('↳')} ${result.summary.split('\n')[0].slice(0, 90)}`);
      }
    }
  }
  logger.blank();
  console.log(`Workspace: ${chalk.gray(`.wai/runs/${run.id}/`)}`);
  logger.blank();
}

// ---------------------------------------------------------------------------
// pipeline logs <run-id> <step-id>
// ---------------------------------------------------------------------------

export async function runPipelineLogs(runId: string, stepId: string): Promise<void> {
  assertProjectInitialized();

  let run: ReturnType<typeof loadRun>;
  try { run = loadRun(runId); }
  catch { logger.error(`Run "${runId}" not found.`); process.exit(1); }

  const step = run.steps.find((s) => s.id === stepId);
  if (!step) {
    logger.error(`Step "${stepId}" not found in run "${runId}".`);
    process.exit(1);
  }

  logger.blank();
  console.log(`${chalk.bold('Step:')}   ${step.id}`);
  console.log(`${chalk.bold('Status:')} ${_statusColor(step.status)(step.status)}`);
  console.log(`${chalk.bold('Task:')}   ${step.task}`);
  logger.blank();

  if (step.type === 'shell' && step.shellOutput) {
    console.log(chalk.bold('Shell output:'));
    console.log(chalk.gray('─'.repeat(60)));
    console.log(step.shellOutput.trim());
    console.log(chalk.gray('─'.repeat(60)));
    logger.blank();
  }

  const result = loadStepResult(runId, stepId);
  if (result) {
    console.log(chalk.bold('Result:'));
    console.log(chalk.gray('─'.repeat(60)));
    console.log(result.summary.trim());
    if (result.filesChanged.length > 0) {
      logger.blank();
      console.log(chalk.bold('Files changed:'));
      for (const f of result.filesChanged) console.log(`  ${chalk.cyan(f)}`);
    }
    if (result.flagged) {
      logger.blank();
      logger.warn('Flagged:');
      console.log(chalk.yellow(result.flagged));
    }
    console.log(chalk.gray('─'.repeat(60)));
  }

  // Context file
  const stepWsDir   = path.join(aiDir('runs'), runId, 'steps', stepId);
  const contextFile = fs.existsSync(path.join(stepWsDir, '.claude', 'CLAUDE.md'))
    ? path.join(stepWsDir, '.claude', 'CLAUDE.md')
    : fs.existsSync(path.join(stepWsDir, '.gemini', 'GEMINI.md'))
      ? path.join(stepWsDir, '.gemini', 'GEMINI.md')
      : null;

  if (contextFile) {
    logger.blank();
    logger.info(`Context file: ${chalk.gray(path.relative(process.cwd(), contextFile))}`);
  }

  logger.blank();
}

// ---------------------------------------------------------------------------
// pipeline init — interactive pipeline scaffolding wizard
// ---------------------------------------------------------------------------

export async function runPipelineInit(): Promise<void> {
  assertProjectInitialized();
  const projectConfig = loadProjectConfig();

  logger.blank();
  logger.info(chalk.bold('Pipeline wizard'));
  logger.info(chalk.gray('Creates a .wai/pipelines/<id>.yaml file.'));
  logger.blank();

  const { id } = await inquirer.prompt<{ id: string }>([{
    type:     'input',
    name:     'id',
    message:  'Pipeline id (e.g. "feature-flow"):',
    validate: (v: string) => {
      if (!v.trim()) return 'Required';
      if (!/^[a-z0-9_-]+$/.test(v.trim())) return 'Lowercase letters, numbers, hyphens, underscores only';
      if (fs.existsSync(pipelinePath(v.trim()))) return `Pipeline "${v.trim()}" already exists`;
      return true;
    },
  }]);

  const { name } = await inquirer.prompt<{ name: string }>([{
    type:    'input',
    name:    'name',
    message: 'Human-readable name:',
    default: id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
  }]);

  const { description } = await inquirer.prompt<{ description: string }>([{
    type:    'input',
    name:    'description',
    message: 'Description (optional):',
  }]);

  const { hasGoalVar } = await inquirer.prompt<{ hasGoalVar: boolean }>([{
    type:    'confirm',
    name:    'hasGoalVar',
    message: 'Add a {{goal}} variable (pass the task goal at run time)?',
    default: true,
  }]);

  // Determine how many steps
  const { stepCount } = await inquirer.prompt<{ stepCount: number }>([{
    type:     'number' as 'input',
    name:     'stepCount',
    message:  'How many steps?',
    default:  3,
    validate: (v: unknown) => Number(v) >= 1 ? true : 'At least 1',
  }]);

  // Build steps interactively
  const backends = ['claude', 'gemini', 'ollama', 'custom'];
  const steps: Array<{
    id: string; type: string; backend?: string; domain?: string;
    task: string; dependsOn: string[]; continueOnFailure: boolean;
  }> = [];

  for (let i = 0; i < Number(stepCount); i++) {
    logger.blank();
    logger.info(chalk.gray(`── Step ${i + 1} of ${stepCount} ──────────────────────`));

    const { stepId } = await inquirer.prompt<{ stepId: string }>([{
      type:     'input',
      name:     'stepId',
      message:  `Step id:`,
      default:  `step-${i + 1}`,
      validate: (v: string) => {
        if (!v.trim()) return 'Required';
        if (steps.some((s) => s.id === v.trim())) return 'Step id must be unique';
        return true;
      },
    }]);

    const { stepType } = await inquirer.prompt<{ stepType: string }>([{
      type:    'list',
      name:    'stepType',
      message: 'Step type:',
      choices: [
        { name: 'AI session  (claude, gemini, etc.)', value: 'ai' },
        { name: 'Shell command  (tests, lint, build)', value: 'shell' },
      ],
    }]);

    let backend: string | undefined;
    let domain:  string | undefined;

    if (stepType === 'ai') {
      const { be } = await inquirer.prompt<{ be: string }>([{
        type:    'list',
        name:    'be',
        message: 'Backend:',
        choices: backends,
        default: projectConfig.defaultBackend ?? 'claude',
      }]);
      backend = be;

      const { dom } = await inquirer.prompt<{ dom: string }>([{
        type:    'input',
        name:    'dom',
        message: 'Domain id (leave blank for project root):',
      }]);
      if (dom.trim()) domain = dom.trim();
    }

    const taskDefault = hasGoalVar && i === 0
      ? (stepType === 'ai' ? 'Analyse and brainstorm approaches for: {{goal}}' : 'npm test')
      : '';

    const { task } = await inquirer.prompt<{ task: string }>([{
      type:     'input',
      name:     'task',
      message:  stepType === 'shell' ? 'Shell command:' : 'Task prompt (can use {{variable}}):',
      default:  taskDefault,
      validate: (v: string) => v.trim() ? true : 'Required',
    }]);

    // Dependencies
    const prevIds = steps.map((s) => s.id);
    let dependsOn: string[] = [];

    if (prevIds.length > 0) {
      const { deps } = await inquirer.prompt<{ deps: string[] }>([{
        type:    'checkbox',
        name:    'deps',
        message: 'Depends on (must complete before this step):',
        choices: prevIds,
        default: prevIds.slice(-1), // default: previous step
      }]);
      dependsOn = deps;
    }

    const { cont } = await inquirer.prompt<{ cont: boolean }>([{
      type:    'confirm',
      name:    'cont',
      message: 'Continue pipeline if this step fails?',
      default: false,
    }]);

    steps.push({
      id:    stepId.trim(),
      type:  stepType,
      backend,
      domain,
      task:  task.trim(),
      dependsOn,
      continueOnFailure: cont,
    });
  }

  // Build and write pipeline YAML
  const pipeline = {
    name,
    description: description.trim() || undefined,
    variables:   hasGoalVar ? { goal: { description: 'The goal or feature to implement' } } : undefined,
    steps:       steps.map(({ id: sid, type, backend: be, domain: dom, task, dependsOn: deps, continueOnFailure }) => ({
      id:   sid,
      type,
      ...(be   ? { backend: be }     : {}),
      ...(dom  ? { domain:  dom }    : {}),
      task,
      ...(deps.length > 0 ? { dependsOn: deps } : {}),
      ...(continueOnFailure ? { continueOnFailure: true } : {}),
    })),
  };

  ensureDir(pipelinesDir());
  writeYamlFile(pipelinePath(id.trim()), pipeline);

  logger.blank();
  logger.success(`Created: ${chalk.cyan(`.wai/pipelines/${id.trim()}.yaml`)}`);
  logger.blank();
  logger.info(`Run it with: ${chalk.bold(`wairon pipeline run ${id.trim()}`)}`);
  if (hasGoalVar) {
    logger.info(`Example:     ${chalk.gray(`wairon pipeline run ${id.trim()} --var goal="add OAuth2 login"`)}`);
  }
  logger.blank();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _statusColor(status: string): (s: string) => string {
  switch (status) {
    case 'completed': return chalk.green;
    case 'running':   return chalk.cyan;
    case 'failed':    return chalk.red;
    case 'abandoned': return chalk.yellow;
    case 'cancelled':
    case 'skipped':   return chalk.gray;
    default:          return chalk.gray;
  }
}
