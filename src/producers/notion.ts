import { resolveSecret } from '../utils/secrets.js';
import type { DocPage } from './types.js';

// ---------------------------------------------------------------------------
// Notion Client Adapter (sdd_producers) — pushes a DocPage tree into a
// "wairon specs" subsection under a parent page via the Notion REST API (raw
// fetch, no SDK dependency). Idempotent: the subsection is refreshed, sibling
// content under the parent is never touched.
// ---------------------------------------------------------------------------

const API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

/* eslint-disable @typescript-eslint/no-explicit-any */

function authHeaders(): Record<string, string> {
  const token = resolveSecret('notion-token');
  if (!token) {
    throw new Error('No Notion token — set WAIRON_NOTION_TOKEN or run `wairon host secret set notion-token <secret>`.');
  }
  return { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' };
}

async function api(method: string, pathname: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`Notion ${method} ${pathname} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

export async function sync(page: DocPage, parentPageId: string): Promise<void> {
  const existing = await findChildPage(parentPageId, page.title);
  let rootId: string;
  if (existing) {
    rootId = existing;
    await archiveChildren(rootId);
    await appendBlocks(rootId, bodyToBlocks(page.body));
  } else {
    rootId = await createPage(parentPageId, page.title, bodyToBlocks(page.body));
  }
  for (const child of page.children) await createSubtree(rootId, child);
}

async function findChildPage(parentId: string, title: string): Promise<string | null> {
  let cursor: string | undefined;
  do {
    const data = await api('GET', `/blocks/${parentId}/children${cursor ? `?start_cursor=${cursor}` : ''}`);
    for (const block of data.results ?? []) {
      if (block.type === 'child_page' && block.child_page?.title === title) return block.id;
    }
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return null;
}

async function archiveChildren(pageId: string): Promise<void> {
  let cursor: string | undefined;
  const ids: string[] = [];
  do {
    const data = await api('GET', `/blocks/${pageId}/children${cursor ? `?start_cursor=${cursor}` : ''}`);
    for (const block of data.results ?? []) ids.push(block.id);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  for (const id of ids) await api('PATCH', `/blocks/${id}`, { archived: true });
}

async function createPage(parentId: string, title: string, blocks: any[]): Promise<string> {
  const page = await api('POST', '/pages', {
    parent: { page_id: parentId },
    properties: { title: { title: [textNode(title)] } },
    children: blocks.slice(0, 100),
  });
  if (blocks.length > 100) await appendBlocks(page.id, blocks.slice(100));
  return page.id;
}

async function appendBlocks(pageId: string, blocks: any[]): Promise<void> {
  for (let i = 0; i < blocks.length; i += 100) {
    await api('PATCH', `/blocks/${pageId}/children`, { children: blocks.slice(i, i + 100) });
  }
}

async function createSubtree(parentId: string, page: DocPage): Promise<void> {
  const id = await createPage(parentId, page.title, bodyToBlocks(page.body));
  for (const child of page.children) await createSubtree(id, child);
}

// ── Minimal markdown → Notion blocks ─────────────────────────────────────────

export function bodyToBlocks(body: string): any[] {
  const blocks: any[] = [];
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const lang = notionLang(line.slice(3).trim());
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
      i++; // closing fence
      blocks.push({ object: 'block', type: 'code', code: { rich_text: [textNode(code.join('\n'))], language: lang } });
      continue;
    }
    if (line.startsWith('## ')) blocks.push(heading(2, line.slice(3)));
    else if (line.startsWith('# ')) blocks.push(heading(1, line.slice(2)));
    else if (line.startsWith('- ')) blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [textNode(line.slice(2))] } });
    else if (line.trim()) blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: [textNode(line)] } });
    i++;
  }
  return blocks;
}

function heading(level: 1 | 2, t: string): any {
  const key = `heading_${level}`;
  return { object: 'block', type: key, [key]: { rich_text: [textNode(t)] } };
}

function textNode(content: string): any {
  return { type: 'text', text: { content: content.slice(0, 2000) } };
}

function notionLang(lang: string): string {
  const known = ['mermaid', 'typescript', 'javascript', 'json', 'yaml', 'bash', 'markdown'];
  return known.includes(lang) ? lang : 'plain text';
}
