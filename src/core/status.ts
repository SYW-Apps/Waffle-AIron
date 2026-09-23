// ---------------------------------------------------------------------------
// project_status — how complete the spec tree is, as a report anything can
// print: which subsystems exist, how far each has been specified, and what
// failed to parse.
//
// It lives in sdd_core rather than beside the command that shows it because it
// has two readers already. The MCP server was importing it out of
// ../commands/status.js — sdd_mcp reaching into an sdd_cli command file for a
// report that was never CLI-specific, which put one subsystem behind another
// for its own status tool. The terminal dashboard (`wairon status`) is the same
// renderer, handed the terminal's colours as `StatusDecor` roles: it used to be
// a second copy of this code, line for line, and the two drifted apart until
// only one of them carried the approval verdict. Both count from the specs the
// loader already holds rather than from the filesystem, so the report describes
// the tree as the rest of wairon sees it.
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
 * The completeness report, and whether it could be produced at all. Two parts
 * rather than one string, for the same reason the approval verdict has two: a
 * caller decides what to DO from the fact, never by matching the prose. A
 * terminal exits non-zero on a tree it could not read; an MCP client shows the
 * text and carries on. Neither should have to recognise a sentence to tell
 * those apart — and for as long as this was one string, the terminal did not
 * try: `wairon status` answered 0 over a tree that would not parse.
 */
export interface StatusReport {
  /**
   * The report to show. On failure this is the explanation — each file that
   * would not parse and what was wrong with it, or that no system
   * specification exists — because a tree that will not load is exactly when
   * somebody is asking after its status.
   */
  text: string;
  /**
   * Whether the tree could be reported on at all: false for a normal report,
   * true when a spec file would not parse or there is no L0 system. A script
   * running `wairon status` over a broken tree must not read it as healthy.
   */
  failed: boolean;
}

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

/**
 * How a caller wants the report marked up, named by what each part MEANS
 * rather than by how it should look. Every role is optional and defaults to
 * leaving the text alone, so a caller that wants plain text passes nothing and
 * a caller that wants colour supplies its own.
 *
 * Naming roles instead of colours is what keeps this renderer ignorant of
 * terminals: it knows a line is a missing layer, not that missing is red —
 * which is what lets ONE renderer serve the terminal, the MCP client and a
 * test without any of them forking it. `wairon status` kept its own copy of
 * this rendering for exactly as long as it took the two to disagree about the
 * approval verdict.
 */
export interface StatusDecor {
  /**
   * The tree's own scaffolding — prefixes, indentation, and detail that should
   * recede, like a spec id beside an error or a note that no source path is set.
   */
  structure?(text: string): string;
  /** The one name the reader came for: the system's own. */
  emphasis?(text: string): string;
  /**
   * A layer's label, given which layer it is — `system`, `subsystem`,
   * `component`, `interface` or `implementation` — so a caller may distinguish
   * them or not, as it chooses.
   */
  layer?(kind: string, text: string): string;
  /**
   * A completeness percentage, given the number, so a caller can grade it
   * however it grades things. This renderer never decides that 100 is good and
   * 40 is bad; it reports the number and who is reading decides what it means.
   */
  score?(pct: number, text: string): string;
  /** A status tag on something not yet complete. */
  draft?(text: string): string;
  /** A source file that exists where the spec says it should. */
  present?(text: string): string;
  /** A layer never written, or a source file a spec names that is not there. */
  missing?(text: string): string;
}

/** Every role filled in, so the renderer below never asks whether one is set. */
interface FilledDecor {
  structure(text: string): string;
  emphasis(text: string): string;
  layer(kind: string, text: string): string;
  score(pct: number, text: string): string;
  draft(text: string): string;
  present(text: string): string;
  missing(text: string): string;
}

/** The default for every role: leave the text exactly as it was. */
const asWritten = (text: string): string => text;

function fillDecor(decor?: StatusDecor): FilledDecor {
  return {
    structure: decor?.structure ?? asWritten,
    emphasis: decor?.emphasis ?? asWritten,
    layer: decor?.layer ?? ((_kind, text) => text),
    score: decor?.score ?? ((_pct, text) => text),
    draft: decor?.draft ?? asWritten,
    present: decor?.present ?? asWritten,
    missing: decor?.missing ?? asWritten,
  };
}

export function getStatusReport(options: StatusOptions = {}, decor?: StatusDecor): StatusReport {
  const mark = fillDecor(decor);

  // Step 1: load the tree, following chained subprojects as far as the options allow
  scanAllSpecs({ recursive: options.recursive ?? true });

  const system = loadSystemSpec();
  const loaderErrors = getLoaderIssues();

  // Step 2/3: a tree that will not load is precisely when somebody asks after
  // its status, so name each failure rather than refusing to answer — and say
  // plainly that the report FAILED, because answering without that fact is how
  // a script came to read a tree that would not parse as a healthy one.
  if (loaderErrors.length > 0) {
    let errText = 'Failed to parse specification files:\n';
    for (const issue of loaderErrors) {
      const prefix = issue.specId ? mark.structure(`[${issue.specId}] `) : '';
      errText += `${prefix}[${issue.code}] ${issue.message}\n`;
    }
    return { text: errText, failed: true };
  }

  // Step 4/5: a missing L0 is a different state from a tree that failed to
  // parse, and reads differently to whoever is looking. The sentence stops
  // here: `wairon init` is advice only a terminal can give, and the MCP client
  // reading the same report cannot run it.
  if (!system) {
    return { text: 'L0 System specification (system.yaml) is missing.', failed: true };
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

  // Step 7: count each component's progress through the layers, marking each
  // part through the role the caller supplied — structure, layer, score, draft,
  // present or missing. Roles rather than colours, so this renderer never
  // learns what a terminal is.
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

  output += `${mark.layer('system', '● System:')} ${mark.emphasis(system.name)} ${mark.score(systemScore, `(${systemScore}% Complete)`)}\n`;

  for (let i = 0; i < subsystems.length; i++) {
    const sub = subsystems[i];
    const isLastSub = i === subsystems.length - 1;
    const subPrefix = isLastSub ? '└── ' : '├── ';
    const subIndent = isLastSub ? '    ' : '│   ';

    const subScore = getSubsystemScore(sub.id);
    const subStatusStr = sub.status !== 'complete' ? mark.draft(` [${sub.status}]`) : '';

    output += `${mark.structure(subPrefix)}${mark.layer('subsystem', `[Subsystem] ${sub.id}`)}${subStatusStr} ${mark.score(subScore, `(${subScore}%)`)}\n`;

    const subComps = components.filter(c => c.subsystem === sub.id);
    for (let j = 0; j < subComps.length; j++) {
      const comp = subComps[j];
      const isLastComp = j === subComps.length - 1;
      const compPrefix = isLastComp ? '└── ' : '├── ';
      const compIndent = isLastComp ? '    ' : '│   ';

      const compScore = componentScores.get(comp.id) ?? 0;
      const compStatusStr = comp.status !== 'complete' ? mark.draft(` [${comp.status}]`) : '';

      output += `${mark.structure(subIndent + compPrefix)}${mark.layer('component', `[Component: ${comp.componentType}] ${comp.id}`)}${compStatusStr} ${mark.score(compScore, `(${compScore}%)`)}\n`;

      const intf = interfaces.find(inf => inf.component === comp.id);
      const impl = implementations.find(im => intf && im.contract === intf.id);

      const intfPrefix = (intf && impl) ? '├── ' : '└── ';
      if (intf) {
        const intfStatusStr = intf.status !== 'complete' ? mark.draft(` [${intf.status}]`) : '';
        output += `${mark.structure(subIndent + compIndent + intfPrefix)}${mark.layer('interface', `Interface: ${intf.id}`)}${intfStatusStr} (${intf.methods.length} methods)\n`;
      } else {
        output += `${mark.structure(subIndent + compIndent + intfPrefix)}${mark.missing('Interface: Missing (-30%)')}\n`;
      }

      if (impl) {
        const implStatusStr = impl.status !== 'complete' ? mark.draft(` [${impl.status}]`) : '';
        const methodsWithOwnPath = impl.methods.filter(m => m.sourcePath);
        let pathStr: string;
        if (impl.sourcePath) {
          pathStr = pathExists(fromProjectRoot(impl.sourcePath))
            ? mark.present(` -> ${impl.sourcePath}`)
            : mark.missing(` -> ${impl.sourcePath} (File Missing!)`);
        } else if (methodsWithOwnPath.length > 0) {
          pathStr = '';
        } else {
          pathStr = mark.structure(' (No source path)');
        }
        output += `${mark.structure(subIndent + compIndent + '└── ')}${mark.layer('implementation', `Implementation: ${impl.id}`)}${implStatusStr}${pathStr}\n`;

        const methodIndent = `${subIndent}${compIndent}    `;
        for (let k = 0; k < methodsWithOwnPath.length; k++) {
          const method = methodsWithOwnPath[k];
          const isLastMethod = k === methodsWithOwnPath.length - 1;
          const methodPrefix = isLastMethod ? '└── ' : '├── ';
          const methodPath = method.sourcePath as string;
          const methodLine = pathExists(fromProjectRoot(methodPath))
            ? mark.present(`method ${method.name} -> ${methodPath}`)
            : mark.missing(`method ${method.name} -> ${methodPath} (File Missing!)`);
          output += `${mark.structure(methodIndent + methodPrefix)}${methodLine}\n`;
        }
      } else {
        output += `${mark.structure(subIndent + compIndent + '└── ')}${mark.missing('Implementation: Missing (-30%)')}\n`;
      }
    }
  }

  // Step 8: answer the report as text, not failed, so a terminal, an MCP
  // client and a test all read the same account rather than three renderings
  // that can drift apart.
  return { text: output, failed: false };
}
