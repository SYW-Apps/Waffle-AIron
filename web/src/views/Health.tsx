import { get } from '../api';
import { AsyncView, Badge, Button, DataTable, useAsync } from '../ui';
import type { DiagnosticCheckResult, InstanceHealthReport, ResourceUsageSnapshot } from '../types';

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'neutral'> = {
  ok: 'ok',
  pass: 'ok',
  degraded: 'warn',
  warn: 'warn',
  unhealthy: 'bad',
  fail: 'bad',
};
const tone = (s: string) => STATUS_TONE[s] ?? 'neutral';

const fmtBytes = (n?: number): string => {
  if (n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
};

/**
 * Instance health & diagnostics — the operations plane's read-only report:
 * overall status, the individual diagnostic checks, and resource-usage snapshots.
 * Ports the legacy admin "Health" panel (GET /web/admin/health, operations:read).
 */
export function Health() {
  const state = useAsync<InstanceHealthReport>(() => get('/web/admin/health'), []);

  return (
    <div className="view-pad">
      <div className="view-head">
        <div>
          <h2>Health &amp; diagnostics</h2>
          <p className="hint">Instance status, diagnostic checks, and resource usage across the projects in your scope.</p>
        </div>
        <Button variant="ghost" onClick={state.reload}>
          Refresh
        </Button>
      </div>

      <AsyncView state={state}>
        {(h) => (
          <div className="stack-lg">
            <div className="panel">
              <h4>
                Instance status <Badge tone={tone(h.status)}>{h.status}</Badge>
              </h4>
              <p className="hint">Generated {new Date(h.generatedAt).toLocaleString()}.</p>
            </div>

            <DataTable<DiagnosticCheckResult>
              rowKey={(c) => c.id}
              empty="No diagnostic checks reported."
              rows={h.checks}
              columns={[
                { key: 'check', header: 'Check', cell: (c) => <code className="subtle">{c.id}</code> },
                { key: 'status', header: 'Status', cell: (c) => <Badge tone={tone(c.status)}>{c.status}</Badge> },
                {
                  key: 'message',
                  header: 'Detail',
                  cell: (c) => (
                    <span>
                      {c.message}
                      {c.details && <span className="hint"> — {c.details}</span>}
                    </span>
                  ),
                },
              ]}
            />

            {h.usage && h.usage.length > 0 && (
              <div>
                <h4 style={{ margin: '4px 0 10px' }}>Resource usage</h4>
                <DataTable<ResourceUsageSnapshot>
                  rowKey={(u) => u.scope}
                  empty="No usage snapshots."
                  rows={h.usage}
                  columns={[
                    { key: 'scope', header: 'Scope', cell: (u) => <code>{u.scope}</code> },
                    { key: 'projects', header: 'Projects', cell: (u) => u.projectCount ?? '—' },
                    { key: 'bytes', header: 'Size', cell: (u) => fmtBytes(u.projectBytes) },
                    { key: 'mcp', header: 'MCP req/min', cell: (u) => u.mcpRequestsLastMinute ?? '—' },
                    { key: 'audit', header: 'Audit today', cell: (u) => u.auditEventsToday ?? '—' },
                    {
                      key: 'quota',
                      header: 'Quota notes',
                      cell: (u) =>
                        u.quotaMessages.length ? (
                          <span className="cell-inline">
                            {u.quotaMessages.map((m, i) => (
                              <Badge key={i} tone="warn">
                                {m}
                              </Badge>
                            ))}
                          </span>
                        ) : (
                          <span className="hint">—</span>
                        ),
                    },
                  ]}
                />
              </div>
            )}
          </div>
        )}
      </AsyncView>
    </div>
  );
}
