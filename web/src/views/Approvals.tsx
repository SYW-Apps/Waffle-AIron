import { get, post } from '../api';
import { AsyncButton, AsyncView, Badge, ConfirmButton, DataTable, useAsync, useToast } from '../ui';
import { subjectLabel, type ApprovalRequest } from '../types';

/** Pending approval requests in the caller's scope (approval:decide). Decisions
 *  are server-authoritative on the decider identity, and self-approval is refused
 *  server-side. */
export function Approvals() {
  const toast = useToast();
  const approvals = useAsync<{ requests: ApprovalRequest[] }>(() => get('/web/admin/approvals'), [], ['approvals']);

  async function decide(requestId: string, approved: boolean) {
    await post('/web/admin/approvals/decide', { requestId, approved });
    toast.ok(approved ? 'Approved' : 'Denied');
    approvals.reload();
  }

  return (
    <div className="view-pad">
      <div className="view-head">
        <div>
          <h2>Approvals</h2>
          <p className="hint">Actions awaiting a decision. You can't approve your own requests.</p>
        </div>
      </div>

      <AsyncView state={approvals}>
        {(d) => (
          <DataTable<ApprovalRequest>
            rowKey={(r) => r.id}
            empty="Nothing awaiting approval."
            rows={d.requests}
            columns={[
              {
                key: 'summary',
                header: 'Request',
                cell: (r) => (
                  <div className="cell-stack">
                    <strong>{r.summary}</strong>
                    <span className="hint">
                      <Badge tone="neutral">{r.kind}</Badge> {r.projectId && <>· {r.projectId}</>}
                    </span>
                  </div>
                ),
              },
              { key: 'by', header: 'Requested by', cell: (r) => <span>{subjectLabel(r.requestedBy)}</span> },
              { key: 'when', header: 'When', cell: (r) => <span className="hint">{new Date(r.createdAt).toLocaleString()}</span> },
              {
                key: 'act',
                header: '',
                cell: (r) => (
                  <div className="row-actions">
                    <AsyncButton size="sm" variant="primary" action={() => decide(r.id, true)} onError={toast.bad}>
                      Approve
                    </AsyncButton>
                    <ConfirmButton
                      label="Deny"
                      title="Deny request"
                      message={`Deny “${r.summary}”?`}
                      confirmLabel="Deny"
                      action={() => decide(r.id, false)}
                      onError={toast.bad}
                    />
                  </div>
                ),
              },
            ]}
          />
        )}
      </AsyncView>
    </div>
  );
}
