import { useEffect, useState, type ReactNode } from 'react';
import { get, post } from '../api';
import { Button, Spinner } from '../ui';
import type { DevCommandResult } from '../types';

/** What GET /web/dev/upgrade answers when the served checkout was written by an older wairon major. */
export interface DevUpgradeState {
  trees: { root: string; writtenMajor: number | string }[];
  runningMajor: number | string;
  uncommitted: boolean;
  command: string;
}

/**
 * The dev page's upgrade gate. In dev mode it asks the server whether any tree was written by an older
 * wairon major. When one was, it shows ONLY a modal that cannot be dismissed (no close button, no Escape,
 * no backdrop click) and mounts nothing else: the views would read the old forms. Otherwise it renders
 * its children. Hosted (non-dev) never mounts this.
 */
export function UpgradeGate(props: { children: ReactNode }) {
  const [state, setState] = useState<DevUpgradeState | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    get<DevUpgradeState | null>('/web/dev/upgrade')
      .then((s) => live && setState(s && s.trees && s.trees.length > 0 ? s : null))
      .catch(() => live && setState(null));
    return () => {
      live = false;
    };
  }, []);
  if (state === undefined) return <div className="boot"><Spinner /></div>;
  if (state === null) return <>{props.children}</>;
  return <UpgradeModal state={state} />;
}

function UpgradeModal(props: { state: DevUpgradeState }) {
  const { state } = props;
  const [output, setOutput] = useState<string[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<'plan' | 'upgrade' | null>(null);
  const [copied, setCopied] = useState(false);
  const majors = Array.from(new Set(state.trees.map((t) => String(t.writtenMajor)))).join(', ');

  async function run(report: boolean) {
    setBusy(report ? 'plan' : 'upgrade');
    try {
      const res = await post<DevCommandResult>('/web/dev/upgrade', { report });
      setOutput(res.output ?? []);
      setFailed(!res.ok);
      if (res.ok && !report) window.location.reload();
    } catch (e) {
      setOutput([e instanceof Error ? e.message : String(e)]);
      setFailed(true);
    } finally {
      setBusy(null);
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(state.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable: the command stays selectable */
    }
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)' }}
    >
      <div
        className="syw-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="upgrade-title"
        style={{ width: 'min(680px, 94vw)', maxHeight: '90vh', overflow: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <h2 id="upgrade-title" style={{ margin: 0 }}>Upgrade required</h2>
        <p style={{ margin: 0 }}>
          This project was written by wairon {majors} and this is wairon {String(state.runningMajor)}. It has to be upgraded before it can be shown.
        </p>
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {state.trees.map((t) => (
            <li key={t.root}>
              <code>{t.root}</code> <span className="dim">(wairon {String(t.writtenMajor)})</span>
            </li>
          ))}
        </ul>
        {state.uncommitted && (
          <p className="err" role="alert" style={{ margin: 0 }}>
            This checkout has uncommitted changes: commit them first so the upgrade is its own diff.
          </p>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <code style={{ flex: 1, padding: '6px 8px', wordBreak: 'break-all' }}>{state.command}</code>
          <Button size="sm" onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
        </div>
        {output && (
          <pre
            className={failed ? 'err' : undefined}
            style={{ margin: 0, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 12 }}
          >
            {output.join('\n')}
          </pre>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button disabled={busy !== null} onClick={() => run(true)}>
            {busy === 'plan' ? <Spinner inline /> : 'Show plan'}
          </Button>
          <Button variant="primary" disabled={busy !== null} onClick={() => run(false)}>
            {busy === 'upgrade' ? <Spinner inline /> : 'Upgrade'}
          </Button>
        </div>
      </div>
    </div>
  );
}
