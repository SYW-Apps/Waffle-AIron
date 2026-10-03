import { describe, it, expect } from 'vitest';
import { parseQuotaPolicyEnv } from '../../src/commands/host.js';
import { effectiveQuotaPolicy } from '../../src/server/operations.js';

// ---------------------------------------------------------------------------
// WAIRON_QUOTA_POLICY: the serve command's quota policy source. A JSON object of
// overrides laid over the disabled default; anything else is refused at startup
// with a message naming the variable.
// ---------------------------------------------------------------------------

describe('WAIRON_QUOTA_POLICY', () => {
  it('resolves the disabled default when no policy is configured', () => {
    expect(effectiveQuotaPolicy()).toEqual({ enabled: false, mode: 'observe' });
    expect(effectiveQuotaPolicy({})).toEqual({ enabled: false, mode: 'observe' });
  });

  it('accepts a partial policy and lays it over the disabled default', () => {
    const overrides = parseQuotaPolicyEnv('{"enabled":true,"maxProjectsPerUser":20,"maxProjectBytes":0}');
    expect(overrides).toEqual({ enabled: true, maxProjectsPerUser: 20, maxProjectBytes: 0 });
    expect(effectiveQuotaPolicy({ quotaPolicy: overrides })).toEqual({
      enabled: true,
      mode: 'observe',
      maxProjectsPerUser: 20,
      maxProjectBytes: 0,
    });
  });

  it('accepts every mode, block included', () => {
    for (const mode of ['observe', 'warn', 'block']) {
      expect(parseQuotaPolicyEnv(JSON.stringify({ mode }))).toEqual({ mode });
    }
  });

  it('accepts an empty object, which keeps the disabled default', () => {
    expect(effectiveQuotaPolicy({ quotaPolicy: parseQuotaPolicyEnv('{}') })).toEqual(effectiveQuotaPolicy());
  });

  it('refuses a value that is not JSON', () => {
    expect(() => parseQuotaPolicyEnv('enabled=true')).toThrow(/WAIRON_QUOTA_POLICY is not valid JSON/);
  });

  it('refuses JSON that is not an object', () => {
    expect(() => parseQuotaPolicyEnv('[1,2]')).toThrow(/WAIRON_QUOTA_POLICY must be a JSON object/);
    expect(() => parseQuotaPolicyEnv('null')).toThrow(/WAIRON_QUOTA_POLICY must be a JSON object/);
    expect(() => parseQuotaPolicyEnv('5')).toThrow(/WAIRON_QUOTA_POLICY must be a JSON object/);
  });

  it('refuses an unknown field, naming it', () => {
    expect(() => parseQuotaPolicyEnv('{"maxProjects":5}')).toThrow(
      /WAIRON_QUOTA_POLICY sets an unknown field "maxProjects"/,
    );
  });

  it('refuses a field of the wrong type, naming the field', () => {
    expect(() => parseQuotaPolicyEnv('{"enabled":"yes"}')).toThrow(/WAIRON_QUOTA_POLICY field "enabled" must be a boolean/);
    expect(() => parseQuotaPolicyEnv('{"mode":"enforce"}')).toThrow(/field "mode" must be one of/);
    expect(() => parseQuotaPolicyEnv('{"maxMcpRequestsPerMinute":-1}')).toThrow(
      /field "maxMcpRequestsPerMinute" must be a non-negative integer/,
    );
    expect(() => parseQuotaPolicyEnv('{"maxAuditEventsPerDay":1.5}')).toThrow(
      /field "maxAuditEventsPerDay" must be a non-negative integer/,
    );
  });
});
