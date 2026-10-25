/**
 * The summary cut of sdd_get_status (mcp_orchestrator getStatus step 7).
 *
 * The whole report stays the CLI's `wairon status`; only the MCP answer is cut,
 * here, as a pure function over the pieces the handler already composed. The
 * tree is read for its counts, never re-rendered.
 */

/** How much of the status report an MCP caller asks for (type status_detail). */
export type StatusDetail = 'summary' | 'full';

/** The pieces the getStatus handler composes, each already rendered as text. */
export interface StatusPieces {
  /** The pending-transaction banner lines, led first (empty when none). */
  banner: string;
  /** The family context lines (empty for a lone project). */
  family: string;
  /** The core report text (tree, Approval line), as `wairon status` prints it. */
  report: string;
  /** The approval verdict text (empty for a project never approved). */
  verdict: string;
  /** The Externals section (empty when no external moved). */
  externals: string;
  /** The Network line (empty when nothing to say). */
  network: string;
  /** The wairon release of the running server. */
  version: string;
}

/** The whole answer: what `detail: full` returns, and what the tool always answered before. */
export function fullStatus(p: StatusPieces): string {
  return `${p.banner}${p.family}${p.network}${p.report}${p.verdict}${p.externals}\nwairon ${p.version}\n`;
}

interface Tally {
  label: string;
  depth: number;
  components: number;
  interfaces: number;
  implementations: number;
  types: number;
}

const TREE_CHARS = /^[│├└─\s]*/;

/** The cut: leads, verdict, counts per subsystem, findings by code, Externals, Network, a pointer. */
export function summarizeStatus(p: StatusPieces): string {
  const lines = p.report.split('\n');
  const isTree = lines.some((l) => l.startsWith('Architecture Status Dashboard'));
  // A report that failed (the tree will not load, no project binds) is the explanation: never cut.
  if (!isTree) return fullStatus(p);

  const head: string[] = [];
  const keep: string[] = [];
  const out: string[] = [];
  const findings = new Map<string, number>();
  const projects: { label: string; depth: number; subsystems: number }[] = [];
  const tallies: { tally: Tally; project?: string }[] = [];
  let currentProject: { label: string; depth: number; subsystems: number } | undefined;
  let current: Tally | undefined;

  for (const raw of lines) {
    const stripped = raw.replace(TREE_CHARS, '');
    const depth = raw.length - stripped.length;
    if (stripped.startsWith('● ')) { head.push(stripped); continue; }
    if (/^(Approval|Conformance off):/.test(raw)) { keep.push(raw); continue; }
    const project = /^\[(Project|Part)\] (.*)$/.exec(stripped);
    if (project) {
      currentProject = { label: `[${project[1]}] ${project[2]}`, depth, subsystems: 0 };
      projects.push(currentProject);
      current = undefined;
      continue;
    }
    const sub = /^\[Subsystem\] (.*)$/.exec(stripped);
    if (sub) {
      if (currentProject && depth <= currentProject.depth) currentProject = undefined;
      if (currentProject) currentProject.subsystems += 1;
      current = { label: sub[1], depth, components: 0, interfaces: 0, implementations: 0, types: 0 };
      tallies.push({ tally: current, project: currentProject?.label });
      continue;
    }
    if (stripped.startsWith('[Component')) { if (current) current.components += 1; continue; }
    if (/^Interface: (?!Missing)/.test(stripped)) { if (current) current.interfaces += 1; continue; }
    if (/^Implementation: (?!Missing)/.test(stripped)) { if (current) current.implementations += 1; continue; }
    const types = /^\[Types\] (\d+) type/.exec(stripped);
    if (types) {
      if (current && depth > current.depth) current.types += Number(types[1]);
      else {
        tallies.push({ tally: { label: '(shared types)', depth, components: 0, interfaces: 0, implementations: 0, types: Number(types[1]) } });
      }
      continue;
    }
    // A finding line (loader and rule findings carry their code in brackets).
    const code = /^(?:\[[^\]]+\] )?\[([A-Z][A-Z0-9_]+)\]/.exec(stripped);
    if (code) findings.set(code[1], (findings.get(code[1]) ?? 0) + 1);
  }

  out.push(...head, ...keep);
  const verdict = p.verdict.trim();
  const counts: string[] = [];
  let lastProject: string | undefined;
  for (const { tally: t, project } of tallies) {
    if (project !== lastProject) {
      if (project) counts.push(project);
      lastProject = project;
    }
    const parts = [`${t.components} components`, `${t.interfaces} interfaces`, `${t.implementations} implementations`];
    if (t.types > 0) parts.push(`${t.types} types`);
    counts.push(`${project ? '  ' : ''}${t.label === '(shared types)' ? t.label : `[Subsystem] ${t.label}`}: ${parts.join(', ')}`);
  }
  for (const pr of projects) if (pr.subsystems === 0 && !counts.includes(pr.label)) counts.push(pr.label);

  const body: string[] = [];
  if (verdict) body.push(verdict);
  body.push('', ...counts);
  if (findings.size > 0) {
    body.push('', `Findings by code: ${[...findings].map(([c, n]) => `${c} x${n}`).join(', ')}`);
  }
  const externals = p.externals.trim();
  if (externals) body.push('', externals);
  const network = p.network.trim();
  if (network) body.push('', network);
  body.push('', 'This is the summary: pass `detail: full` for the whole per-spec tree, or use sdd_search_specs to look up one spec by name or meaning.');
  return `${p.banner}${p.family}${out.join('\n')}\n${body.join('\n')}\n\nwairon ${p.version}\n`;
}

/** The answer for the detail asked for. */
export function statusAnswer(detail: StatusDetail, p: StatusPieces): string {
  return detail === 'full' ? fullStatus(p) : summarizeStatus(p);
}
