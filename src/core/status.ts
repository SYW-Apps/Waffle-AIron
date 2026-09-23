// ---------------------------------------------------------------------------
// project_status — how complete the spec tree is, as a report anything can
// print: which subsystems exist, how far each has been specified, and what
// failed to parse.
//
// It lives in sdd_core rather than beside the command that shows it because it
// has two readers already. The MCP server was importing it out of
// ../commands/status.js — sdd_mcp reaching into an sdd_cli command file for a
// report that was never CLI-specific, which put one subsystem behind another
// for its own status tool. The terminal dashboard (`wairon status`) renders the
// same numbers with colour; both count from the specs the loader already holds
// rather than from the filesystem, so the report describes the tree as the rest
// of wairon sees it.
// ---------------------------------------------------------------------------

import {
  loadSystemSpec,
  loadSubsystemSpecs,
  loadComponentSpecs,
  loadInterfaceSpecs,
  loadImplementationSpecs,
  getLoaderIssues,
  scanAllSpecs,
} from './specs.js';
import { implementationSourceFiles } from '../models/specs.js';
import { pathExists, fromProjectRoot } from '../utils/fs.js';

/**
 * How much of the tree a status report should cover. Both fields are optional
 * and both narrow rather than widen: absent means the whole project,
 * recursively.
 */
export interface StatusOptions {
  /** Report on one subsystem rather than the whole tree. Accepts a namespaced id. */
  subsystem?: string;
  /** How far into chained subprojects to follow. Absent means all the way down. */
  recursive?: boolean | number;
}

export function getStatusReport(options: StatusOptions = {}): string {
  // Step 1: load the tree, following chained subprojects as far as the options allow
  scanAllSpecs({ recursive: options.recursive ?? true });

  const system = loadSystemSpec();
  const loaderErrors = getLoaderIssues();

  // Step 2/3: a tree that will not load is precisely when somebody asks after
  // its status, so name each failure rather than refusing to answer.
  if (loaderErrors.length > 0) {
    let errText = 'Failed to parse specification files:\n';
    for (const issue of loaderErrors) {
      const prefix = issue.specId ? `[${issue.specId}] ` : '';
      errText += `${prefix}[${issue.code}] ${issue.message}\n`;
    }
    return errText;
  }

  // Step 4/5: a missing L0 is a different state from a tree that failed to
  // parse, and reads differently to whoever is looking.
  if (!system) {
    return 'L0 System specification (system.yaml) is missing.';
  }

  // Step 6: read the subsystems, components, interfaces and implementations
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

  // Step 7: count each component's progress through the layers
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
      const sourceFiles = implementationSourceFiles(impl);
      if (sourceFiles.length > 0 && sourceFiles.every(f => pathExists(fromProjectRoot(f)))) {
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
        const methodsWithOwnPath = impl.methods.filter(m => m.sourcePath);
        let pathStr: string;
        if (impl.sourcePath) {
          pathStr = pathExists(fromProjectRoot(impl.sourcePath))
            ? ` -> ${impl.sourcePath}`
            : ` -> ${impl.sourcePath} (File Missing!)`;
        } else if (methodsWithOwnPath.length > 0) {
          pathStr = '';
        } else {
          pathStr = ' (No source path)';
        }
        output += `${subIndent}${compIndent}└── Implementation: ${impl.id}${implStatusStr}${pathStr}\n`;

        const methodIndent = `${subIndent}${compIndent}    `;
        for (let k = 0; k < methodsWithOwnPath.length; k++) {
          const method = methodsWithOwnPath[k];
          const isLastMethod = k === methodsWithOwnPath.length - 1;
          const methodPrefix = isLastMethod ? '└── ' : '├── ';
          const methodPath = method.sourcePath as string;
          const fileMissing = !pathExists(fromProjectRoot(methodPath));
          output += `${methodIndent}${methodPrefix}method ${method.name} -> ${methodPath}${fileMissing ? ' (File Missing!)' : ''}\n`;
        }
      } else {
        output += `${subIndent}${compIndent}└── Implementation: Missing (-30%)\n`;
      }
    }
  }

  // Step 8: answer as text, so a terminal, an MCP client and a test all read
  // the same account rather than three renderings that can drift apart.
  return output;
}
