// ---------------------------------------------------------------------------
// network_file_adapter — the deployment-side inputs a team keeps outside
// .wai/: the bindings file (YAML) and an observed-flow export (CSV or JSON).
// A malformed file is refused naming the path and the line or row; nothing is
// half-read. It writes nothing.
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as nodePath from 'path';
import { LineCounter, parseDocument } from 'yaml';
import { WaironError } from '../../utils/errors.js';
import type { NetworkBindings, ObservedFlow, WorkloadBinding } from '../types.js';

/** A bindings or observed-flow file that cannot be read as one. */
export class NetworkInputError extends WaironError {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkInputError';
  }
}

function readText(file: string): string {
  const resolved = nodePath.resolve(file);
  if (!fs.existsSync(resolved)) throw new NetworkInputError(`${file}: no such file`);
  return fs.readFileSync(resolved, 'utf-8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** One workload entry, validated field by field; `where` names the line of a field (or of the entry). */
function workloadOf(where: (field?: string) => string, value: unknown): WorkloadBinding {
  if (!isRecord(value)) throw new NetworkInputError(`${where()}: a workload is a map with selector, and optionally namespace and port`);
  const { selector, namespace, port } = value;
  if (!isRecord(selector) || Object.keys(selector).length === 0 || Object.values(selector).some((v) => typeof v !== 'string')) {
    throw new NetworkInputError(`${where('selector')}: selector must be a non-empty map of label to string value`);
  }
  if (namespace !== undefined && typeof namespace !== 'string') throw new NetworkInputError(`${where('namespace')}: namespace must be a string`);
  if (port !== undefined && !(Number.isInteger(port) && (port as number) > 0 && (port as number) < 65536)) {
    throw new NetworkInputError(`${where('port')}: port must be an integer from 1 to 65535`);
  }
  const unknown = Object.keys(value).filter((k) => !['selector', 'namespace', 'port'].includes(k));
  if (unknown.length > 0) throw new NetworkInputError(`${where(unknown[0])}: unknown field(s) ${unknown.join(', ')}`);
  return {
    selector: selector as Record<string, string>,
    ...(namespace !== undefined ? { namespace } : {}),
    ...(port !== undefined ? { port: port as number } : {}),
  };
}

/** A parsed YAML file and the line each key path sits on. */
interface ParsedYaml {
  root: unknown;
  lineOf: (...keys: string[]) => number;
}

/** Parse a YAML file, refusing a syntax error with its line. */
function parseYaml(file: string): ParsedYaml {
  const lines = new LineCounter();
  const doc = parseDocument(readText(file), { lineCounter: lines });
  if (doc.errors.length > 0) {
    const e = doc.errors[0];
    throw new NetworkInputError(`${file}:${lines.linePos(e.pos[0]).line}: ${e.message.split('\n')[0]}`);
  }
  const lineOf = (...keys: string[]): number => {
    const node = doc.getIn(keys, true) as { range?: [number, number, number] } | undefined;
    return node?.range ? lines.linePos(node.range[0]).line : 1;
  };
  return { root: doc.toJS(), lineOf };
}

/** The outside blocks, when given: a list of CIDR blocks. */
function outsideOf(file: string, parsed: ParsedYaml, outside: unknown): string[] | undefined {
  if (outside === undefined) return undefined;
  const cidr = (b: unknown): boolean => typeof b === 'string' && /^[0-9a-fA-F:.]+\/\d{1,3}$/.test(b);
  if (!Array.isArray(outside) || !outside.every(cidr)) {
    throw new NetworkInputError(`${file}:${parsed.lineOf('outside')}: outside must be a list of CIDR blocks (0.0.0.0/0, 10.0.0.0/8, ...)`);
  }
  return outside as string[];
}

/** The top level: a map with a workloads map and nothing but outside beside it. */
function bindingsRoot(file: string, parsed: ParsedYaml): Record<string, unknown> & { workloads: Record<string, unknown> } {
  const root = parsed.root;
  if (!isRecord(root) || !isRecord(root.workloads)) throw new NetworkInputError(`${file}:1: a bindings file is a map with a \`workloads\` map`);
  const unknown = Object.keys(root).filter((k) => k !== 'workloads' && k !== 'outside');
  if (unknown.length > 0) throw new NetworkInputError(`${file}:${parsed.lineOf(unknown[0])}: unknown field ${unknown[0]} (workloads, outside)`);
  return root as Record<string, unknown> & { workloads: Record<string, unknown> };
}

/**
 * inetwork_file_adapter.readBindings — read and parse a bindings file (YAML):
 * workloads by design name, each with its selector, namespace and port, and
 * the outside address blocks. Refused naming the line; never half-read.
 */
export function readBindings(path: string): NetworkBindings {
  const parsed = parseYaml(path);
  const root = bindingsRoot(path, parsed);
  const workloads: Record<string, WorkloadBinding> = {};
  for (const [name, value] of Object.entries(root.workloads)) {
    const where = (field?: string): string => `${path}:${parsed.lineOf('workloads', name, ...(field ? [field] : []))}: workloads.${name}`;
    workloads[name] = workloadOf(where, value);
  }
  const outside = outsideOf(path, parsed, root.outside);
  return { workloads, ...(outside !== undefined ? { outside } : {}) };
}

// ---------------------------------------------------------------------------
// Observed flows
// ---------------------------------------------------------------------------

const OBSERVED_FIELDS = ['source', 'destination', 'transport', 'method', 'path', 'count'] as const;

/** One observed row, validated: source and destination required, count an integer. */
function observedOf(where: string, row: Record<string, unknown>): ObservedFlow {
  const text = (k: string): string | undefined => {
    const v = row[k];
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string') throw new NetworkInputError(`${where}: ${k} must be text`);
    return v.trim();
  };
  const source = text('source');
  const destination = text('destination');
  if (!source || !destination) throw new NetworkInputError(`${where}: source and destination are required`);
  const raw = row.count;
  let count: number | undefined;
  if (raw !== undefined && raw !== null && raw !== '') {
    count = typeof raw === 'number' ? raw : /^\d+$/.test(String(raw).trim()) ? Number(String(raw).trim()) : NaN;
    if (!Number.isInteger(count) || count < 0) throw new NetworkInputError(`${where}: count must be a non-negative integer`);
  }
  const optional = Object.fromEntries((['transport', 'method', 'path'] as const).map((k) => [k, text(k)]).filter(([, v]) => v !== undefined));
  return { source, destination, ...optional, ...(count !== undefined ? { count } : {}) };
}

/** One CSV line split into cells: commas outside double quotes, "" an escaped quote. */
function csvCells(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted && c === '"' && line[i + 1] === '"') { cell += '"'; i++; }
    else if (c === '"') quoted = !quoted;
    else if (c === ',' && !quoted) { cells.push(cell); cell = ''; }
    else cell += c;
  }
  cells.push(cell);
  return cells;
}

function observedFromCsv(file: string, text: string): ObservedFlow[] {
  const lines = text.split(/\r?\n/);
  const header = csvCells(lines[0] ?? '').map((h) => h.trim().toLowerCase());
  const missing = ['source', 'destination'].filter((h) => !header.includes(h));
  if (missing.length > 0) throw new NetworkInputError(`${file}:1: the header row must name ${missing.join(' and ')} (columns: ${OBSERVED_FIELDS.join(', ')})`);
  const out: ObservedFlow[] = [];
  lines.slice(1).forEach((line, i) => {
    if (line.trim() === '' || line.trimStart().startsWith('#')) return;
    const cells = csvCells(line);
    const row = Object.fromEntries(header.map((h, j) => [h, cells[j]]));
    out.push(observedOf(`${file}:${i + 2}`, row));
  });
  return out;
}

function observedFromJson(file: string, text: string): ObservedFlow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new NetworkInputError(`${file}: not JSON (${(e as Error).message})`);
  }
  const rows = isRecord(parsed) && Array.isArray(parsed.flows) ? parsed.flows : parsed;
  if (!Array.isArray(rows)) throw new NetworkInputError(`${file}: a JSON list of observed flows (or { "flows": [...] }) is expected`);
  return rows.map((row, i) => {
    if (!isRecord(row)) throw new NetworkInputError(`${file}: row ${i + 1} is not an object`);
    return observedOf(`${file}: row ${i + 1}`, row);
  });
}

/**
 * inetwork_file_adapter.readObservedFlows — read and parse an observed-flow
 * export by extension: CSV with a header row, or a JSON list of the same
 * fields. A malformed row is refused naming the row; never half-read.
 */
export function readObservedFlows(path: string): ObservedFlow[] {
  const text = readText(path).replace(/^﻿/, '');
  return /\.json$/i.test(path) ? observedFromJson(path, text) : observedFromCsv(path, text);
}
