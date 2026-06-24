import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { assertProjectInitialized } from '../config/loader.js';
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

export interface StatusOptions {
  subsystem?: string;
  recursive?: boolean | number;
}

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
      if (impl.sourcePath && pathExists(fromProjectRoot(impl.sourcePath))) {
        score += 20; // 20% for concrete source code file existing on disk
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
        const pathStr = impl.sourcePath
          ? pathExists(fromProjectRoot(impl.sourcePath))
            ? chalk.green(` -> ${impl.sourcePath}`)
            : chalk.red(` -> ${impl.sourcePath} (File Missing!)`)
          : chalk.gray(' (No source path)');
        console.log(`${chalk.gray(subIndent + compIndent + '└── ')}${chalk.green(`Implementation: ${impl.id}`)}${implStatusStr}${pathStr}`);
      } else {
        console.log(`${chalk.gray(subIndent + compIndent + '└── ')}${chalk.red('Implementation: Missing (-30%)')}`);
      }
    }
  }

  logger.blank();
}

export function getStatusReport(options: StatusOptions = {}): string {
  scanAllSpecs({ recursive: options.recursive ?? true });

  const system = loadSystemSpec();
  const loaderErrors = getLoaderIssues();

  if (loaderErrors.length > 0) {
    let errText = 'Failed to parse specification files:\n';
    for (const issue of loaderErrors) {
      const prefix = issue.specId ? `[${issue.specId}] ` : '';
      errText += `${prefix}[${issue.code}] ${issue.message}\n`;
    }
    return errText;
  }

  if (!system) {
    return 'L0 System specification (system.yaml) is missing.';
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

  let output = '';
  const componentScores = new Map<string, number>();

  for (const comp of components) {
    let score = 20;

    const intf = interfaces.find(i => i.component === comp.id);
    if (intf) {
      score += 30;
    }

    const impl = implementations.find(im => intf && im.contract === intf.id);
    if (impl) {
      score += 30;
      if (impl.sourcePath && pathExists(fromProjectRoot(impl.sourcePath))) {
        score += 20;
      }
    }

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

  const totalSubsystemsScore = subsystems.reduce((acc, s) => acc + getSubsystemScore(s.id), 0);
  const systemScore = subsystems.length > 0 ? Math.round(totalSubsystemsScore / subsystems.length) : 0;

  output += `● System: ${system.name} (${systemScore}% Complete)\n`;

  for (let i = 0; i < subsystems.length; i++) {
    const sub = subsystems[i];
    const isLastSub = i === subsystems.length - 1;
    const subPrefix = isLastSub ? '└── ' : '├── ';
    const subIndent = isLastSub ? '    ' : '│   ';

    const subScore = getSubsystemScore(sub.id);
    const subStatusStr = sub.status !== 'complete' ? ` [${sub.status}]` : '';

    output += `${subPrefix}[Subsystem] ${sub.id}${subStatusStr} (${subScore}%)\n`;

    const subComps = components.filter(c => c.subsystem === sub.id);
    for (let j = 0; j < subComps.length; j++) {
      const comp = subComps[j];
      const isLastComp = j === subComps.length - 1;
      const compPrefix = isLastComp ? '└── ' : '├── ';
      const compIndent = isLastComp ? '    ' : '│   ';

      const compScore = componentScores.get(comp.id) ?? 0;
      const compStatusStr = comp.status !== 'complete' ? ` [${comp.status}]` : '';

      output += `${subIndent}${compPrefix}[Component: ${comp.componentType}] ${comp.id}${compStatusStr} (${compScore}%)\n`;

      const intf = interfaces.find(inf => inf.component === comp.id);
      const impl = implementations.find(im => intf && im.contract === intf.id);

      const intfPrefix = (intf && impl) ? '├── ' : '└── ';
      if (intf) {
        const intfStatusStr = intf.status !== 'complete' ? ` [${intf.status}]` : '';
        output += `${subIndent}${compIndent}${intfPrefix}Interface: ${intf.id}${intfStatusStr} (${intf.methods.length} methods)\n`;
      } else {
        output += `${subIndent}${compIndent}${intfPrefix}Interface: Missing (-30%)\n`;
      }

      if (impl) {
        const implStatusStr = impl.status !== 'complete' ? ` [${impl.status}]` : '';
        const pathStr = impl.sourcePath
          ? pathExists(fromProjectRoot(impl.sourcePath))
            ? ` -> ${impl.sourcePath}`
            : ` -> ${impl.sourcePath} (File Missing!)`
          : ' (No source path)';
        output += `${subIndent}${compIndent}└── Implementation: ${impl.id}${implStatusStr}${pathStr}\n`;
      } else {
        output += `${subIndent}${compIndent}└── Implementation: Missing (-30%)\n`;
      }
    }
  }

  return output;
}

