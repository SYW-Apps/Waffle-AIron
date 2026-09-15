import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as admin from '../../src/server/admin.js';
import * as gitbacking from '../../src/server/gitbacking.js';
import { start, stop, sweep } from '../../src/server/backup-schedule.js';
import type { HostConfig } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Backup Schedule (sdd_host)
//
// The hosted instance's periodic 60-second backup timer: sweeps the
// git-bound projects, then the container-level backing repositories, each
// tick. A failure in either sweep is recorded and never stops the other, and
// the timer is unref'd so it never keeps a closing process alive.
// ---------------------------------------------------------------------------

function cfg(): HostConfig {
  return { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir: '/tmp/unused', authEnabled: false };
}

describe('backup schedule sweep (sdd_host)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a throwing git sync is caught and still runs the backing sync', () => {
    const gitSpy = vi.spyOn(admin, 'runPeriodicGitSync').mockImplementation(() => {
      throw new Error('git sync boom');
    });
    const backingSpy = vi.spyOn(gitbacking, 'runPeriodicBackingSync').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => sweep(cfg())).not.toThrow();

    expect(gitSpy).toHaveBeenCalledTimes(1);
    expect(backingSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('project sweep failed'));
  });

  it('a throwing backing sync is caught and never escapes sweep', () => {
    const gitSpy = vi.spyOn(admin, 'runPeriodicGitSync').mockImplementation(() => {});
    const backingSpy = vi.spyOn(gitbacking, 'runPeriodicBackingSync').mockImplementation(() => {
      throw new Error('backing sync boom');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => sweep(cfg())).not.toThrow();

    expect(gitSpy).toHaveBeenCalledTimes(1);
    expect(backingSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('backing sweep failed'));
  });
});

describe('backup schedule start/stop (sdd_host)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runs sweep every 60 seconds after start, never after stop, and unrefs the timer', () => {
    const gitSpy = vi.spyOn(admin, 'runPeriodicGitSync').mockImplementation(() => {});
    const backingSpy = vi.spyOn(gitbacking, 'runPeriodicBackingSync').mockImplementation(() => {});

    // Intercept setInterval's own return value to prove the timer is unref'd
    // — a live assertion, not a re-implementation of the timer.
    const realSetInterval = globalThis.setInterval;
    let unrefSpy: ReturnType<typeof vi.spyOn> | undefined;
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: TimerHandler, ms?: number) => {
      const real = realSetInterval(fn as () => void, ms);
      unrefSpy = vi.spyOn(real, 'unref');
      return real;
    }) as typeof setInterval);

    start(cfg());

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
    expect(unrefSpy).toHaveBeenCalledTimes(1);

    // Never runs before the first tick.
    expect(gitSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60_000);
    expect(gitSpy).toHaveBeenCalledTimes(1);
    expect(backingSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(120_000);
    expect(gitSpy).toHaveBeenCalledTimes(3);
    expect(backingSpy).toHaveBeenCalledTimes(3);

    // stop() cancels the timer; no further sweeps fire.
    stop();
    vi.advanceTimersByTime(180_000);
    expect(gitSpy).toHaveBeenCalledTimes(3);
    expect(backingSpy).toHaveBeenCalledTimes(3);
  });

  it('starting an already-running schedule keeps exactly one live timer', () => {
    const gitSpy = vi.spyOn(admin, 'runPeriodicGitSync').mockImplementation(() => {});
    vi.spyOn(gitbacking, 'runPeriodicBackingSync').mockImplementation(() => {});
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');

    start(cfg());
    start(cfg()); // re-start: replaces the previous timer, never doubles it

    expect(clearSpy).toHaveBeenCalledTimes(1); // the first timer was cancelled

    vi.advanceTimersByTime(60_000);
    expect(gitSpy).toHaveBeenCalledTimes(1); // exactly one live timer ticking
  });
});
