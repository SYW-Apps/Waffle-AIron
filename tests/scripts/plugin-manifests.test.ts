import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
// @ts-expect-error — a plain ESM build script without type declarations
import { VERSIONED_FILES, versionsIn, stamp } from '../../scripts/plugin/stamp-version.mjs';

const ROOT = path.resolve(__dirname, '..', '..');
const PLUGIN = path.join(ROOT, 'plugins', 'wairon');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const json = (rel: string): Record<string, unknown> => JSON.parse(read(rel));

describe('agent-tool plugin manifests', () => {
  it('every versioned file names one and the same version', () => {
    const versions = new Set((VERSIONED_FILES as string[]).flatMap((rel) => versionsIn(read(rel)) as string[]));
    expect([...versions]).toHaveLength(1);
  });

  it('every versioned file is valid JSON', () => {
    for (const rel of VERSIONED_FILES as string[]) expect(() => json(rel)).not.toThrow();
  });

  it('ships each built-in skill once, in the plugin layout', () => {
    const names = fs.readdirSync(path.join(PLUGIN, 'skills')).sort();
    expect(names).toEqual(['sdd-architect', 'sdd-auditor', 'sdd-delegate', 'sdd-implement', 'sdd-narrative']);
    for (const n of names) {
      const skill = fs.readFileSync(path.join(PLUGIN, 'skills', n, 'SKILL.md'), 'utf8');
      expect(skill).toMatch(new RegExp(`^---\\r?\\nname: ${n}\\r?\\ndescription: \\S`));
    }
  });

  it('every tool runs the same pinned server command', () => {
    const servers = [
      (json('plugins/wairon/.mcp.json').mcpServers as Record<string, { command: string; args: string[] }>).wairon,
      (json('plugins/wairon/mcp.json').mcpServers as Record<string, { command: string; args: string[] }>).wairon,
      (json('plugins/wairon/mcp_config.json').mcpServers as Record<string, { command: string; args: string[] }>).wairon,
      (json('plugins/wairon/gemini-extension.json').mcpServers as Record<string, { command: string; args: string[] }>).wairon,
    ];
    for (const s of servers) {
      expect(s.command).toBe('npx');
      expect(s.args[0]).toBe('-y');
      expect(s.args[1]).toMatch(/^@wairon\/cli@\d+\.\d+\.\d+/);
      expect(s.args.slice(2)).toEqual(['mcp', 'serve']);
    }
  });

  it('every marketplace points at the plugin folder, never the repository root', () => {
    const claude = json('.claude-plugin/marketplace.json') as { plugins: { name: string; source: string }[] };
    expect(claude.plugins).toEqual([expect.objectContaining({ name: 'wairon', source: './plugins/wairon' })]);
    const codex = json('.agents/plugins/marketplace.json') as { plugins: { source: { path: string } }[] };
    expect(codex.plugins[0].source.path).toBe('./plugins/wairon');
    const cursor = json('.cursor-plugin/marketplace.json') as { metadata: { pluginRoot: string }; plugins: { source: string }[] };
    expect(path.join(cursor.metadata.pluginRoot, cursor.plugins[0].source)).toBe(path.join('plugins', 'wairon'));
  });

  it('stamp rewrites manifest versions and CLI pins, and nothing else', () => {
    const before = '{ "version": "6.7.3", "args": ["-y", "@wairon/cli@6.7.3", "mcp"], "name": "wairon" }';
    const after = stamp(before, '6.8.0') as string;
    expect(after).toBe('{ "version": "6.8.0", "args": ["-y", "@wairon/cli@6.8.0", "mcp"], "name": "wairon" }');
    expect(versionsIn(after)).toEqual(['6.8.0', '6.8.0']);
  });
});
