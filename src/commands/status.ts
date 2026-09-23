import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { assertProjectInitialized } from '../config/paths.js';
import { pathExists, fromProjectRoot } from '../utils/fs.js';
import {
  loadSystemSpec,
  loadSubsystemSpecs,
  loadComponentSpecs,
  loadInterfaceSpecs,
  loadImplementationSpecs,
  getLoaderIssues,
  scanAllSpecs,
} from '../core/specs.js';
// The approval surface comes through core_portal, not out of ../core/approval.js:
// sdd_cli reaching into another subsystem's module is the boundary this Portal
// exists to hold. The verdict itself is the approval comparison's own published
// read now: the terminal and the MCP status tool have to answer the same
// question, and two renderings of "has this drifted" that can disagree is the
// thing a lock exists to prevent.
import { approvalVerdict } from '../core/index.js';
import { implementationSourceFiles } from '../models/specs.js';
// The report itself, and the shape of its options, now live in sdd_core: the
// terminal is one of its readers, not its owner. This file renders those same
// numbers with colour for a human; `getStatusReport` renders them as text for
// everyone else.
import type { StatusOptions } from '../core/status.js';

// ---------------------------------------------------------------------------
// status command
//
// Shows a hierarchical completeness map of the SDD Spec Tree.
// ---------------------------------------------------------------------------

export async function runStatus(options: StatusOptions = {}): Promise<void> {
  assertProjectInitialized();

  scanAllSpecs({ recursive: options.recursive ?? true });

  const system = loadSystemSpec();
  const loaderErrors = getLoaderIssues();

  if (loaderErrors.length > 0) {
    logger.error('Failed to parse specification files:');
    for (const issue of loaderErrors) {
      const prefix = issue.specId ? chalk.gray(`[${issue.specId}] `) : '';
      logger.error(`${prefix}[${issue.code}] ${issue.message}`);
    }
    process.exit(1);
  }

  let subsystems = loadSubsystemSpecs();
  let components = loadComponentSpecs();
  let interfaces = loadInterfaceSpecs();
  let implementations = loadImplementationSpecs();

  if (options.subsystem) {
    subsystems = subsystems.filter(s => s.id === options.subsystem || s.id.startsWith(`${options.subsystem}::`));
    components = components.filter(c => c.subsystem === options.subsystem || c.subsystem.startsWith(`${options.subsystem}::`));
    interfaces = interfaces.filter(i => {
      const c = components.find(comp => comp.id === i.component);
      return c !== undefined;
    });
    implementations = implementations.filter(im => {
      const inf = interfaces.find(i => i.id === im.contract);
      return inf !== undefined;
    });
  }

  if (!system) {
    logger.error('L0 System specification (system.yaml) is missing. Run `wairon init` first.');
    process.exit(1);
  }

  logger.header('Architecture Status Dashboard');
  logger.blank();

  // 1. Calculate completeness for all components
  const componentScores = new Map<string, number>();

  for (const comp of components) {
    let score = 20; // 20% for component specification existing

    const intf = interfaces.find(i => i.component === comp.id);
    if (intf) {
      score += 30; // 30% for interface specification existing
    }

    const impl = implementations.find(im => intf && im.contract === intf.id);
    if (impl) {
      score += 30; // 30% for implementation specification existing
      const sourceFiles = implementationSourceFiles(impl);
      if (sourceFiles.length > 0 && sourceFiles.every(f => pathExists(fromProjectRoot(f)))) {
        score += 20; // 20% for every named concrete source file existing on disk
      }
    }

    // Cap at 50% if either component, interface, or implementation is explicitly draft/design
    const isDraft =
      comp.status === 'draft' ||
      comp.status === 'design' ||
      (intf && (intf.status === 'draft' || intf.status === 'design')) ||
      (impl && (impl.status === 'draft' || impl.status === 'design'));

    if (isDraft) {
      score = Math.min(score, 50);
    }

    componentScores.set(comp.id, score);
  }

  // Helper to calculate subsystem score
  const getSubsystemScore = (subId: string): number => {
    const sub = subsystems.find(s => s.id === subId);
    if (!sub) return 0;

    const subComps = components.filter(c => c.subsystem === subId);
    if (subComps.length === 0) return 0;

    const totalScore = subComps.reduce((acc, c) => acc + (componentScores.get(c.id) ?? 0), 0);
    let avg = Math.round(totalScore / subComps.length);

    if (sub.status === 'draft' || sub.status === 'design') {
      avg = Math.min(avg, 50);
    }
    return avg;
  };

  // Calculate system score
  const totalSubsystemsScore = subsystems.reduce((acc, s) => acc + getSubsystemScore(s.id), 0);
  const systemScore = subsystems.length > 0 ? Math.round(totalSubsystemsScore / subsystems.length) : 0;

  // Print System
  const systemColor = systemScore === 100 ? chalk.green : systemScore >= 50 ? chalk.yellow : chalk.red;
  console.log(`${chalk.bold.blue('● System:')} ${chalk.bold(system.name)} ${systemColor(`(${systemScore}% Complete)`)}`);

  // Print Subsystems and Components
  for (let i = 0; i < subsystems.length; i++) {
    const sub = subsystems[i];
    const isLastSub = i === subsystems.length - 1;
    const subPrefix = isLastSub ? '└── ' : '├── ';
    const subIndent = isLastSub ? '    ' : '│   ';

    const subScore = getSubsystemScore(sub.id);
    const subStatusStr = sub.status !== 'complete' ? chalk.yellow(` [${sub.status}]`) : '';
    const subScoreColor = subScore === 100 ? chalk.green : subScore >= 50 ? chalk.yellow : chalk.red;

    console.log(`${chalk.gray(subPrefix)}${chalk.bold.cyan(`[Subsystem] ${sub.id}`)}${subStatusStr} ${subScoreColor(`(${subScore}%)`)}`);

    const subComps = components.filter(c => c.subsystem === sub.id);
    for (let j = 0; j < subComps.length; j++) {
      const comp = subComps[j];
      const isLastComp = j === subComps.length - 1;
      const compPrefix = isLastComp ? '└── ' : '├── ';
      const compIndent = isLastComp ? '    ' : '│   ';

      const compScore = componentScores.get(comp.id) ?? 0;
      const compStatusStr = comp.status !== 'complete' ? chalk.yellow(` [${comp.status}]`) : '';
      const compScoreColor = compScore === 100 ? chalk.green : compScore >= 50 ? chalk.yellow : chalk.red;

      console.log(`${chalk.gray(subIndent + compPrefix)}${chalk.magenta(`[Component: ${comp.componentType}] ${comp.id}`)}${compStatusStr} ${compScoreColor(`(${compScore}%)`)}`);

      const intf = interfaces.find(inf => inf.component === comp.id);
      const impl = implementations.find(im => intf && im.contract === intf.id);

      // Print interface info
      const intfPrefix = (intf && impl) ? '├── ' : '└── ';
      if (intf) {
        const intfStatusStr = intf.status !== 'complete' ? chalk.yellow(` [${intf.status}]`) : '';
        console.log(`${chalk.gray(subIndent + compIndent + intfPrefix)}${chalk.blue(`Interface: ${intf.id}`)}${intfStatusStr} (${intf.methods.length} methods)`);
      } else {
        console.log(`${chalk.gray(subIndent + compIndent + intfPrefix)}${chalk.red('Interface: Missing (-30%)')}`);
      }

      // Print implementation info
      if (impl) {
        const implStatusStr = impl.status !== 'complete' ? chalk.yellow(` [${impl.status}]`) : '';
        const methodsWithOwnPath = impl.methods.filter(m => m.sourcePath);
        let pathStr: string;
        if (impl.sourcePath) {
          pathStr = pathExists(fromProjectRoot(impl.sourcePath))
            ? chalk.green(` -> ${impl.sourcePath}`)
            : chalk.red(` -> ${impl.sourcePath} (File Missing!)`);
        } else if (methodsWithOwnPath.length > 0) {
          // No implementation-level path, but methods name their own — listed below
          // instead of claiming there is no source path at all.
          pathStr = '';
        } else {
          pathStr = chalk.gray(' (No source path)');
        }
        console.log(`${chalk.gray(subIndent + compIndent + '└── ')}${chalk.green(`Implementation: ${impl.id}`)}${implStatusStr}${pathStr}`);

        const methodIndent = subIndent + compIndent + '    ';
        for (let k = 0; k < methodsWithOwnPath.length; k++) {
          const method = methodsWithOwnPath[k];
          const isLastMethod = k === methodsWithOwnPath.length - 1;
          const methodPrefix = isLastMethod ? '└── ' : '├── ';
          const methodPath = method.sourcePath as string;
          const methodLine = pathExists(fromProjectRoot(methodPath))
            ? chalk.green(`method ${method.name} -> ${methodPath}`)
            : chalk.red(`method ${method.name} -> ${methodPath} (File Missing!)`);
          console.log(`${chalk.gray(methodIndent + methodPrefix)}${methodLine}`);
        }
      } else {
        console.log(`${chalk.gray(subIndent + compIndent + '└── ')}${chalk.red('Implementation: Missing (-30%)')}`);
      }
    }
  }

  // The same approval verdict the MCP report carries — the CLI is where a
  // human actually looks, so it must not be the surface that stays quiet.
  const lock = approvalVerdict();
  if (lock.text.trim()) {
    logger.blank();
    if (lock.drifted) logger.warn(lock.text.trim());
    else logger.info(lock.text.trim());
  }

  logger.blank();
}
