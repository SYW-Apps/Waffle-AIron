import { describe, it, expect } from 'vitest';
import { errorText } from '../../src/server/httpio.js';

// A hosted response body carries an Error's own message and nothing else: never
// its stack, and never the string form of a value that is not an Error.

describe('errorText: what a response may say about a caught value', () => {
  it("is an Error's message, without its name or stack", () => {
    const err = new TypeError('bad input');
    expect(errorText(err)).toBe('bad input');
    expect(errorText(err)).not.toContain('TypeError');
    expect(errorText(err)).not.toContain('at ');
  });

  it('is a fixed text for anything that is not an Error', () => {
    expect(errorText('C:\\data\\secret path')).toBe('request failed');
    expect(errorText({ stack: 'at x (file.ts:1:1)' })).toBe('request failed');
    expect(errorText(undefined)).toBe('request failed');
  });
});
