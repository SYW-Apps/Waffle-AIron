// ---------------------------------------------------------------------------
// mcp_lookup_orchestrator — the lookup tools' workflows: the validator's answer
// shaped for an agent's context (a small default, a handle per group).
// ---------------------------------------------------------------------------
import { searchSpecs, findReferences } from './adapters/validator.js';
import type {
  LookupMatch,
  LookupPlace,
  LookupReference,
  LookupReferencesResult,
  LookupSearchResult,
  LookupSnapshot,
} from '../models/lookup.js';

/** A lookup tool's answer: the text an agent reads and the whole typed result. */
export interface LookupAnswer {
  text: string;
  result: LookupSearchResult | LookupReferencesResult;
}

/** The groups a references answer writes, in order. */
export const REFERENCE_GROUPS = ['design', 'code', 'tests', 'text', 'waivers', 'declared-only', 'observed-only'] as const;
type ReferenceGroup = (typeof REFERENCE_GROUPS)[number];

/** How many entries a cut group keeps. */
const GROUP_SHOWN = 5;

const EVIDENCE_RANK: Record<string, number> = { id: 0, declared: 1, resolved: 2, syntactic: 3, text: 4, unresolved: 5 };

function placeText(p: LookupPlace): string {
  return [p.member, p.subsystem, p.component, p.container].filter((s): s is string => !!s).join('/') || p.project;
}

function matchLine(m: LookupMatch): string {
  const where = m.sourcePath ? (m.planned ? `${m.sourcePath} (planned)` : m.sourcePath) : (m.planned ? 'planned' : '-');
  return `${m.id}  ${m.kind}  ${placeText(m.place)}  ${m.evidence}  ${m.approval}  ${where}${m.briefId ? `  brief:${m.briefId}` : ''}`;
}

function snapshotLine(s: LookupSnapshot): string {
  const list = (xs: string[]): string => (xs.length ? xs.join(', ') : 'nothing');
  return `Snapshot: searched ${list(s.searched)}; not searched ${list(s.notSearched)}; code grade ${s.codeGrade}.`;
}

function matchLines(matches: LookupMatch[]): string[] {
  return matches.map(matchLine);
}

/** mcp_lookup_orchestrator.search — the sdd_search_specs workflow. */
export function search(query: string, limit?: number): LookupAnswer {
  // Step 1: ask the validator for the matches.
  const result = searchSpecs(query, limit);
  // Step 2: one line per match, how many more, the snapshot line.
  const lines = result.matches.length ? matchLines(result.matches) : [`No match for "${query}".`];
  if (result.total > result.matches.length) {
    lines.push(`${result.total - result.matches.length} more; raise limit or narrow the query.`);
  }
  lines.push(snapshotLine(result.snapshot));
  // Step 3: answer the text with the whole result.
  return { text: `${lines.join('\n')}\n`, result };
}

function groupOf(r: LookupReference): ReferenceGroup {
  if (r.agreement === 'declared-only') return 'declared-only';
  if (r.agreement === 'observed-only') return 'observed-only';
  if (r.inTest) return 'tests';
  if (r.kind === 'mention') return 'text';
  if (r.kind === 'code-call' || r.kind === 'import') return 'code';
  return 'design';
}

function strength(r: LookupReference): number {
  return (EVIDENCE_RANK[r.evidence] ?? 9) * 2 + (r.linked ? 0 : 1);
}

function referenceLine(r: LookupReference): string {
  const spec = r.fromSpec ? (r.fromMember ? `${r.fromSpec}.${r.fromMember}` : r.fromSpec) : '';
  const at = r.file ? (r.line !== undefined ? `${r.file}:${r.line}` : r.file) : spec || placeText(r.place);
  const via = r.file && spec ? ` (${spec})` : '';
  return `  ${at}${via}  ${r.kind}  ${r.evidence}  ${r.agreement}`;
}

/** mcp_lookup_orchestrator.references — the sdd_find_references workflow. */
export function references(target: string, expand?: string[], includeText?: boolean): LookupAnswer {
  // Step 1: ask the validator for the references.
  // Text mentions only when asked for: the tool answers small by default.
  const result = findReferences(target, includeText ?? false);
  // Step 2: the target and its impact, each group's count and strongest few, the snapshot line.
  const lines: string[] = [];
  if (!result.target) {
    if (result.candidates.length > 0) {
      lines.push(`"${target}" is ambiguous; ${result.candidates.length} candidates:`, ...matchLines(result.candidates));
      lines.push('Call again with one exact id.');
    } else {
      lines.push(`Nothing named "${target}" was found.`);
    }
    lines.push(snapshotLine(result.snapshot));
    return { text: `${lines.join('\n')}\n`, result };
  }
  const whole = new Set(expand ?? []);
  lines.push(`${matchLine(result.target)}  impact:${result.impact}`);
  const grouped = new Map<ReferenceGroup, LookupReference[]>();
  for (const r of result.references) {
    const g = groupOf(r);
    grouped.set(g, [...(grouped.get(g) ?? []), r]);
  }
  for (const group of REFERENCE_GROUPS) {
    if (group === 'waivers') {
      const ws = result.waivers;
      if (ws.length === 0) continue;
      const shown = whole.has(group) ? ws : ws.slice(0, GROUP_SHOWN);
      lines.push(`waivers (${ws.length})`, ...shown.map((w) => `  ${w.kind}  ${w.subject}  ${w.reason}`));
      if (shown.length < ws.length) lines.push(`  expand: ["waivers"] for all ${ws.length}`);
      continue;
    }
    const refs = [...(grouped.get(group) ?? [])].sort((a, b) => strength(a) - strength(b));
    if (refs.length === 0) continue;
    const shown = whole.has(group) ? refs : refs.slice(0, GROUP_SHOWN);
    lines.push(`${group} (${refs.length})`, ...shown.map(referenceLine));
    if (shown.length < refs.length) lines.push(`  expand: ["${group}"] for all ${refs.length}`);
  }
  lines.push(snapshotLine(result.snapshot));
  // Step 3: answer the text with the whole result.
  return { text: `${lines.join('\n')}\n`, result };
}
