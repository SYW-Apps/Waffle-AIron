import { resolveSecret } from '../utils/secrets.js';
import type { GraphModel, GraphNode } from './types.js';

// ---------------------------------------------------------------------------
// Miro Client Adapter (sdd_producers) — renders the architecture GraphModel onto
// a Miro board as native shapes + connectors via the REST API (raw fetch, no
// SDK). Idempotent: a "wairon architecture" frame is cleared and rebuilt, other
// board content is untouched.
// ---------------------------------------------------------------------------

const API = 'https://api.miro.com/v2';
const FRAME_TITLE = 'wairon architecture';

/* eslint-disable @typescript-eslint/no-explicit-any */

function authHeaders(): Record<string, string> {
  const token = resolveSecret('miro-token');
  if (!token) {
    throw new Error('No Miro token — set WAIRON_MIRO_TOKEN or run `wairon host secret set miro-token <secret>`.');
  }
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', accept: 'application/json' };
}

async function api(method: string, pathname: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`Miro ${method} ${pathname} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.status === 204 ? {} : res.json();
}

export async function sync(graph: GraphModel, boardId: string): Promise<void> {
  await clearFrame(boardId);

  const positions = layout(graph.nodes);
  const b = bounds(positions);
  const frame = await api('POST', `/boards/${boardId}/frames`, {
    data: { title: FRAME_TITLE, type: 'freeform', format: 'custom' },
    position: { x: b.cx, y: b.cy },
    geometry: { width: b.width, height: b.height },
  });

  const shapeIds = new Map<string, string>();
  for (const node of graph.nodes) {
    const p = positions.get(node.id)!;
    const shape = await api('POST', `/boards/${boardId}/shapes`, {
      data: { content: `<b>${node.label}</b><br>${node.componentType}`, shape: 'round_rectangle' },
      position: { x: p.x, y: p.y },
      geometry: { width: 200, height: 80 },
      parent: { id: frame.id },
    });
    shapeIds.set(node.id, shape.id);
  }

  for (const edge of graph.edges) {
    const from = shapeIds.get(edge.from);
    const to = shapeIds.get(edge.to);
    if (from && to) {
      await api('POST', `/boards/${boardId}/connectors`, { startItem: { id: from }, endItem: { id: to } });
    }
  }
}

/** Delete the wairon frame and its children, if present (idempotency). */
async function clearFrame(boardId: string): Promise<void> {
  const items: any[] = [];
  let cursor: string | undefined;
  do {
    const data = await api('GET', `/boards/${boardId}/items?limit=50${cursor ? `&cursor=${cursor}` : ''}`);
    items.push(...(data.data ?? []));
    cursor = data.cursor;
  } while (cursor);

  const frame = items.find((i) => i.type === 'frame' && i.data?.title === FRAME_TITLE);
  if (!frame) return;
  for (const item of items) {
    if (item.parent?.id === frame.id) await api('DELETE', `/boards/${boardId}/items/${item.id}`);
  }
  await api('DELETE', `/boards/${boardId}/items/${frame.id}`);
}

/** Simple grid: subsystems as columns, components stacked in each column. */
export function layout(nodes: GraphNode[]): Map<string, { x: number; y: number }> {
  const bySub = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    const list = bySub.get(n.subsystem) ?? [];
    list.push(n);
    bySub.set(n.subsystem, list);
  }
  const pos = new Map<string, { x: number; y: number }>();
  let col = 0;
  for (const [, list] of bySub) {
    list.forEach((n, row) => pos.set(n.id, { x: col * 320, y: row * 120 }));
    col++;
  }
  return pos;
}

function bounds(pos: Map<string, { x: number; y: number }>): { cx: number; cy: number; width: number; height: number } {
  const xs = [...pos.values()].map((p) => p.x);
  const ys = [...pos.values()].map((p) => p.y);
  const minX = Math.min(0, ...xs);
  const maxX = Math.max(0, ...xs);
  const minY = Math.min(0, ...ys);
  const maxY = Math.max(0, ...ys);
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, width: maxX - minX + 400, height: maxY - minY + 300 };
}
