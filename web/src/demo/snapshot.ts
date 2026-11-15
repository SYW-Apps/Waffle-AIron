import { getKey, mcpKey } from './canon.mjs';

/**
 * The recorded design the static demo reads instead of a server. The demo build writes an
 * index (which request is stored in which file) and one JSON file per request beside the page;
 * a request is answered from its file, fetched the first time it is asked for. Nothing here
 * writes: a mutation is refused with a message, and a request the recording does not hold
 * answers "not part of this demo".
 */

export const READ_ONLY_MESSAGE = 'This is a read-only demo of wairon: nothing can be changed here.';
export const NOT_IN_DEMO_MESSAGE = 'This part of the design is not included in the demo.';

/** A refused or unavailable request, shaped like the API's own error (status + message). */
export class DemoError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'DemoError';
  }
}

export interface DemoMeta {
  id: string;
  title: string;
  waironVersion: string;
}

export interface SnapshotIndex {
  v: 1;
  demo: DemoMeta;
  /** Where the visitor starts: a canvas route, and the spec the Specs view opens. */
  start: { canvas: string; specs: { kind: string; id: string } };
  /** GET key -> data file. */
  gets: Record<string, string>;
  /** MCP tool-call key -> data file. */
  mcp: Record<string, string>;
}

export type JsonLoader = (file: string) => Promise<unknown>;

const defaultLoader: JsonLoader = async (file) => {
  const res = await fetch(new URL('data/' + file, document.baseURI).toString());
  if (!res.ok) throw new DemoError(NOT_IN_DEMO_MESSAGE, 404);
  return res.json();
};

let loader: JsonLoader = defaultLoader;
let cache = new Map<string, Promise<unknown>>();

/** Replace how data files are read (tests), and forget what was read before. */
export function setSnapshotLoader(next: JsonLoader | null): void {
  loader = next ?? defaultLoader;
  cache = new Map();
}

function load<T>(file: string): Promise<T> {
  let p = cache.get(file);
  if (!p) {
    p = loader(file);
    cache.set(file, p);
    p.catch(() => cache.delete(file));
  }
  return p as Promise<T>;
}

export function loadIndex(): Promise<SnapshotIndex> {
  return load<SnapshotIndex>('index.json');
}

/** A recorded GET, by the path the page asks for. */
export async function demoGet<T>(path: string): Promise<T> {
  const index = await loadIndex();
  const file = index.gets[getKey(path)];
  if (!file) throw new DemoError(NOT_IN_DEMO_MESSAGE, 404);
  return load<T>(file);
}

/** Tools that change a design; asked for here they are refused rather than reported missing. */
const WRITE_TOOL = /^sdd_(add|update|delete|define|set|write|rename|move|pin|remove|promote|demote|attach|detach|adopt|internalize|externalize|initialize|request)_/;

/** A recorded MCP tool call, by tool name and arguments. */
export async function demoMcp<T>(name: string, args: object): Promise<T> {
  if (WRITE_TOOL.test(name)) throw new DemoError(READ_ONLY_MESSAGE, 403);
  const index = await loadIndex();
  const file = index.mcp[mcpKey(name, args)];
  if (!file) throw new DemoError(NOT_IN_DEMO_MESSAGE, 404);
  return load<T>(file);
}

/** Every write the page could attempt ends here. */
export function demoRefuse(): never {
  throw new DemoError(READ_ONLY_MESSAGE, 403);
}
