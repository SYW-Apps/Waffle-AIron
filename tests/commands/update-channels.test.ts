import { describe, it, expect } from 'vitest';
import { isEligibleForChannel, releaseTier, releaseChannelLabel } from '../../src/commands/update.js';
import { UPDATE_CHANNELS, isUpdateChannel, UpdateChannel } from '../../src/config/userconfig.js';
import { isNewerVersion } from '../../src/utils/version.js';

// ---------------------------------------------------------------------------
// Release-channel eligibility.
//
// The regression this pins: `-dev.N` tags used to be classified as stable
// (the filter only knew -beta.N and -preview.N), so `wairon update` on a
// stable install downloaded the dev build cut from the last merge to `dev`.
// ---------------------------------------------------------------------------

/** Every channel a tag is eligible for, in declared order. */
function channelsFor(tag: string, githubPrerelease = false): UpdateChannel[] {
  return UPDATE_CHANNELS.filter((c) => isEligibleForChannel(tag, c, githubPrerelease));
}

describe('release channel eligibility', () => {
  it('offers a stable release on every channel', () => {
    expect(channelsFor('v5.1.0')).toEqual(['stable', 'beta', 'preview', 'dev']);
  });

  it('keeps a -dev.N build off every channel but dev', () => {
    expect(channelsFor('v5.1.1-dev.5')).toEqual(['dev']);
  });

  it('offers a -beta.N build to beta and wider', () => {
    expect(channelsFor('v5.2.0-beta.1')).toEqual(['beta', 'preview', 'dev']);
  });

  it('offers a -preview.N build to preview and wider', () => {
    expect(channelsFor('v5.2.0-preview.3')).toEqual(['preview', 'dev']);
  });

  it('accepts tags with or without the leading v', () => {
    expect(isEligibleForChannel('5.1.1-dev.5', 'stable')).toBe(false);
    expect(isEligibleForChannel('v5.1.1-dev.5', 'stable')).toBe(false);
    expect(isEligibleForChannel('5.1.0', 'stable')).toBe(true);
  });

  it('ranks an unrecognized pre-release suffix at the widest tier, not stable', () => {
    // Closed by default: a suffix this build does not know must never fall
    // through to stable the way -dev.N did.
    expect(channelsFor('v6.0.0-rc.1')).toEqual(['dev']);
    expect(channelsFor('v6.0.0-nightly.20260812')).toEqual(['dev']);
    expect(channelsFor('v6.0.0-alpha')).toEqual(['dev']);
    // Including a suffix that merely spells a channel name.
    expect(channelsFor('v6.0.0-stable.1')).toEqual(['dev']);
  });

  it("honors GitHub's own prerelease flag for an otherwise stable-looking tag", () => {
    expect(channelsFor('v5.3.0', true)).toEqual(['dev']);
    expect(channelsFor('v5.3.0', false)).toEqual(['stable', 'beta', 'preview', 'dev']);
  });

  it('falls back to the narrowest channel for an unknown channel value', () => {
    // A hand-edited ~/.wairon/config.json must not widen what gets installed.
    const unknown = 'nightly' as UpdateChannel;
    expect(isEligibleForChannel('v5.1.1-dev.5', unknown)).toBe(false);
    expect(isEligibleForChannel('v5.1.0', unknown)).toBe(true);
  });

  it('ranks the tiers narrowest to widest', () => {
    expect(releaseTier('v1.0.0')).toBeLessThan(releaseTier('v1.0.0-beta.1'));
    expect(releaseTier('v1.0.0-beta.1')).toBeLessThan(releaseTier('v1.0.0-preview.1'));
    expect(releaseTier('v1.0.0-preview.1')).toBeLessThan(releaseTier('v1.0.0-dev.1'));
  });
});

describe('release channel labels', () => {
  it('labels each known tier', () => {
    expect(releaseChannelLabel('v5.1.0')).toBe('stable');
    expect(releaseChannelLabel('v5.1.1-dev.5')).toBe('dev');
    expect(releaseChannelLabel('v5.2.0-beta.1')).toBe('beta');
    expect(releaseChannelLabel('v5.2.0-preview.3')).toBe('preview');
  });

  it('reports an unrecognized suffix verbatim rather than guessing', () => {
    expect(releaseChannelLabel('v6.0.0-rc.1')).toBe('rc');
  });
});

describe('update channel config', () => {
  it('recognizes exactly the four channels', () => {
    expect(UPDATE_CHANNELS).toEqual(['stable', 'beta', 'preview', 'dev']);
    for (const c of UPDATE_CHANNELS) expect(isUpdateChannel(c)).toBe(true);
    expect(isUpdateChannel('nightly')).toBe(false);
    expect(isUpdateChannel('')).toBe(false);
  });
});

describe('the reported incident', () => {
  // v5.1.0 stable install, v5.1.1-dev.5 published from a dev merge.
  const current = '5.1.0';
  const devBuild = 'v5.1.1-dev.5';

  it('still sees the dev build as a newer version', () => {
    // The comparator was never wrong — the channel filter was.
    expect(isNewerVersion(current, devBuild.replace(/^v/, ''))).toBe(true);
  });

  it('no longer offers it to a stable install', () => {
    expect(isEligibleForChannel(devBuild, 'stable', true)).toBe(false);
  });

  it('still offers it to a dev install', () => {
    expect(isEligibleForChannel(devBuild, 'dev', true)).toBe(true);
  });
});
