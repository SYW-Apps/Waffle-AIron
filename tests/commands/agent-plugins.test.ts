import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// agent_plugin_adapter.detectPlugin — reads a tool's own `plugin list --json`.
// The process adapter is mocked: no real claude or codex is ever run.
// ---------------------------------------------------------------------------

const { run, runShell } = vi.hoisted(() => ({ run: vi.fn(), runShell: vi.fn() }));

vi.mock('../../src/io/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/io/index.js')>();
  return { ...actual, processes: { ...actual.processes, run, runShell } };
});

import { detectPlugin } from '../../src/commands/agent-plugins.js';

describe('agent_plugin_adapter.detectPlugin', () => {
  const saved = process.env.WAIRON_NO_PLUGIN_DETECT;
  beforeEach(() => {
    delete process.env.WAIRON_NO_PLUGIN_DETECT;
    run.mockReset();
    runShell.mockReset();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.WAIRON_NO_PLUGIN_DETECT; else process.env.WAIRON_NO_PLUGIN_DETECT = saved;
  });

  it('claude: enabled when the listing holds wairon@<marketplace> enabled, with a time limit', () => {
    run.mockReturnValue(JSON.stringify([
      { id: 'caveman@caveman', enabled: true },
      { id: 'wairon@wairon-marketplace', enabled: true },
    ]));
    expect(detectPlugin('claude')).toBe('enabled');
    expect(run).toHaveBeenCalledWith('claude', ['plugin', 'list', '--json'], expect.objectContaining({ timeout: expect.any(Number), windowsHide: true }));
    expect(run.mock.calls[0][2].timeout).toBeLessThanOrEqual(10_000);
  });

  it('claude: absent when the listing has no wairon entry, or only a disabled one', () => {
    run.mockReturnValue(JSON.stringify([{ id: 'caveman@caveman', enabled: true }]));
    expect(detectPlugin('claude')).toBe('absent');
    run.mockReturnValue(JSON.stringify([{ id: 'wairon@x', enabled: false }]));
    expect(detectPlugin('claude')).toBe('absent');
  });

  it('codex: reads the installed list by name', () => {
    run.mockReturnValue(JSON.stringify({ installed: [{ pluginId: 'wairon@mine', name: 'wairon', enabled: true, installed: true }], available: [] }));
    expect(detectPlugin('codex')).toBe('enabled');
    expect(run).toHaveBeenCalledWith('codex', ['plugin', 'list', '--json'], expect.any(Object));
  });

  it('does not take a plugin merely named like wairon for the wairon plugin', () => {
    run.mockReturnValue(JSON.stringify([{ id: 'wairon-tools@x', enabled: true }, { id: 'notwairon', enabled: true }]));
    expect(detectPlugin('claude')).toBe('absent');
  });

  it('unknown for any other target type, without running anything', () => {
    for (const t of ['cursor', 'agy', 'gemini', 'copilot', 'custom']) expect(detectPlugin(t)).toBe('unknown');
    expect(run).not.toHaveBeenCalled();
    expect(runShell).not.toHaveBeenCalled();
  });

  it('unknown when the command is missing, fails or times out, and it never throws', () => {
    run.mockImplementation(() => { throw Object.assign(new Error('boom'), { code: 'ETIMEDOUT' }); });
    expect(detectPlugin('claude')).toBe('unknown');
  });

  it('unknown for output that is not the expected JSON', () => {
    run.mockReturnValue('not json at all');
    expect(detectPlugin('claude')).toBe('unknown');
    run.mockReturnValue(JSON.stringify({ something: 'else' }));
    expect(detectPlugin('codex')).toBe('unknown');
  });

  it('unknown without running when the environment opts out', () => {
    process.env.WAIRON_NO_PLUGIN_DETECT = '1';
    expect(detectPlugin('claude')).toBe('unknown');
    expect(run).not.toHaveBeenCalled();
  });

  it('on Windows a command only a shell can start is tried through the shell', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      run.mockImplementation(() => { throw Object.assign(new Error('spawn'), { code: 'ENOENT' }); });
      runShell.mockReturnValue(JSON.stringify([{ id: 'wairon', enabled: true }]));
      expect(detectPlugin('codex')).toBe('enabled');
      expect(runShell).toHaveBeenCalledWith('codex plugin list --json', expect.objectContaining({ windowsHide: true }));
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });
});
