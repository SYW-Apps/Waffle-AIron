import { describe, it, expect, vi } from 'vitest';
import { logger } from '../../src/utils/logger.js';
import { parseAuditPolicyEnv } from '../../src/commands/host.js';
import { effectiveAuditPolicy } from '../../src/server/audit.js';

// ---------------------------------------------------------------------------
// WAIRON_AUDIT_POLICY: the serve command's audit policy source. A JSON object of
// overrides laid over the secure default; anything else is refused at startup
// with a message naming the variable.
// ---------------------------------------------------------------------------

describe('WAIRON_AUDIT_POLICY', () => {
  it('accepts a partial policy and lays it over the secure default', () => {
    const overrides = parseAuditPolicyEnv('{"retentionDays":30,"includeReadEvents":true,"metadataMode":"none"}');
    expect(overrides).toEqual({ retentionDays: 30, includeReadEvents: true, metadataMode: 'none' });
    expect(effectiveAuditPolicy({ auditPolicy: overrides })).toEqual({
      ...effectiveAuditPolicy(),
      retentionDays: 30,
      includeReadEvents: true,
      metadataMode: 'none',
    });
  });

  it('reads the retired full-redacted as redacted, with a deprecation warning naming both values', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      expect(parseAuditPolicyEnv('{"metadataMode":"full-redacted"}')).toEqual({ metadataMode: 'redacted' });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/WAIRON_AUDIT_POLICY field "metadataMode": "full-redacted" is deprecated and reads as "redacted"/);
    } finally {
      warn.mockRestore();
    }
  });

  it('accepts an empty object, which keeps the secure default', () => {
    expect(effectiveAuditPolicy({ auditPolicy: parseAuditPolicyEnv('{}') })).toEqual(effectiveAuditPolicy());
  });

  it('refuses a value that is not JSON', () => {
    expect(() => parseAuditPolicyEnv('retentionDays=30')).toThrow(/WAIRON_AUDIT_POLICY is not valid JSON/);
  });

  it('refuses JSON that is not an object', () => {
    expect(() => parseAuditPolicyEnv('[1,2]')).toThrow(/WAIRON_AUDIT_POLICY must be a JSON object/);
    expect(() => parseAuditPolicyEnv('30')).toThrow(/WAIRON_AUDIT_POLICY must be a JSON object/);
  });

  it('refuses an unknown field, naming it', () => {
    expect(() => parseAuditPolicyEnv('{"retentionDay":30}')).toThrow(
      /WAIRON_AUDIT_POLICY sets an unknown field "retentionDay"/,
    );
  });

  it('refuses a field of the wrong type, naming the field', () => {
    expect(() => parseAuditPolicyEnv('{"enabled":"yes"}')).toThrow(/WAIRON_AUDIT_POLICY field "enabled" must be a boolean/);
    expect(() => parseAuditPolicyEnv('{"retentionDays":-1}')).toThrow(/field "retentionDays" must be a non-negative number/);
    expect(() => parseAuditPolicyEnv('{"minimumLevel":"loud"}')).toThrow(/field "minimumLevel" must be one of/);
  });
});
