/**
 * Round 6 (platform, top-3): from a MEMBER root, sdd_get_network_flows with a
 * component or subsystem `to` filter answered [] while the unfiltered call
 * returned the member's flows — the matrix keys the member's own parties under
 * its alias (`orders::orders_api`), and the MCP filter read the name bare.
 * The CLI read it right (flow-matrix partyName); the MCP workflow now reads a
 * party the same way.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { materializeFixtureProject } from '../rules-matrix/harness.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { flows } from '../../src/mcp/network.js';
import { platformFamily } from '../helpers/network-family.js';

let dir = '';

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-mcp-flows-')));
  materializeFixtureProject(dir, platformFamily());
  invalidateSpecCache();
});

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* windows locks */ }
});

describe('sdd_get_network_flows `to` filter at a member root (round 6)', () => {
  it('filters by the member\'s own Portal, bare and qualified, and by its subsystem — the rows the unfiltered call lands there', () => {
    setProjectRoot(path.join(dir, 'services', 'orders'));
    invalidateSpecCache();
    const all = flows(null);
    const landing = all.filter((f) => f.to.component === 'orders::orders_api');
    expect(landing.length).toBeGreaterThan(0);
    expect(flows('orders_api')).toEqual(landing);
    expect(flows('orders::orders_api')).toEqual(landing);
    expect(flows('ordering').length).toBe(landing.length);
  });

  it('still refuses a party nothing in the design is named', () => {
    setProjectRoot(path.join(dir, 'services', 'orders'));
    invalidateSpecCache();
    expect(() => flows('nonsense')).toThrow(/unknown party/);
  });

  it('at the family root a bare member Portal is not the member\'s (named as <alias>::<name> there)', () => {
    setProjectRoot(dir);
    invalidateSpecCache();
    const qualified = flows('orders::orders_api');
    expect(qualified.length).toBeGreaterThan(0);
  });
});
