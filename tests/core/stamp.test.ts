import { describe, it, expect } from 'vitest';
import { versionStamp, readStampVersion } from '../../src/core/stamp.js';
import { WAIRON_VERSION } from '../../src/config/defaults.js';

describe('version stamp', () => {
  it('embeds the current wairon version', () => {
    expect(versionStamp()).toBe(`<!-- wairon-version: ${WAIRON_VERSION} -->`);
  });

  it('round-trips: readStampVersion recovers the stamped version', () => {
    const content = `# Some generated file\n${versionStamp()}\nbody`;
    expect(readStampVersion(content)).toBe(WAIRON_VERSION);
  });

  it('returns null when no stamp is present', () => {
    expect(readStampVersion('# A hand-written or older file\nno stamp here')).toBeNull();
  });

  it('parses an arbitrary (older) stamped version, not just the current one', () => {
    expect(readStampVersion('<!-- wairon-version: 0.0.1 -->')).toBe('0.0.1');
  });

  it('tolerates extra whitespace in the marker', () => {
    expect(readStampVersion('<!--   wairon-version:   1.2.3   -->')).toBe('1.2.3');
  });
});
