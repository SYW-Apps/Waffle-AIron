/**
 * Pure logic behind the `wairon dev` cockpit's action bar and lock confirmation: when there is something
 * to approve, which specs moved and which subsystem they belong to. Kept free of React so it is testable
 * on its own.
 */

/** What the server's GET /web/dev/approval answers (the DevApproval type). */
export interface ApprovalVerdictData {
  text: string;
  drifted: boolean;
  moved?: string[];
}
export interface DevApprovalData {
  approved: boolean;
  approvedAt?: string;
  approvedBy?: string;
  verdict: ApprovalVerdictData;
  /** The branch the served checkout has now. */
  branch?: string;
  /** The checkout's HEAD commit, when the server sends it (shown short on a detached HEAD). */
  commit?: string;
  /** The served project's name (its system spec's name); absent when unreadable. */
  projectName?: string;
}

/** The part of a graph node this logic reads. */
export interface ScopeNode {
  id: string;
  kind: string;
  parentId?: string;
}

export interface MovedSpec {
  mark: '~' | '+' | '-';
  path: string;
  /** The folder under .wai/specs (components, subsystems, ...) when the path has one. */
  folder?: string;
  /** The spec id: the file's base name. */
  id: string;
}

/** Parse the verdict's `~ path` / `+ path` / `- path` entries. */
export function parseMoved(moved: string[] | undefined): MovedSpec[] {
  const out: MovedSpec[] = [];
  for (const raw of moved ?? []) {
    const m = /^([~+-])\s+(.+?)\s*$/.exec(raw);
    if (!m) continue;
    // A renamed or relocated entry reads "old -> new": the new place is the spec.
    const path = m[2].split(' -> ').pop()!.replace(/[\\]/g, '/');
    const parts = path.split('/');
    const base = parts[parts.length - 1].replace(/\.(ya?ml|json)$/i, '');
    const at = parts.lastIndexOf('specs');
    const folder = at >= 0 && at < parts.length - 2 ? parts[at + 1] : undefined;
    out.push({ mark: m[1] as MovedSpec['mark'], path, folder, id: base });
  }
  return out;
}

const FOLDER_KIND: Record<string, string> = {
  subsystems: 'subsystem',
  components: 'component',
  interfaces: 'interface',
  implementations: 'implementation',
  types: 'type',
};

/** The subsystem a spec belongs to, walking the graph's parent chain; undefined when the data cannot say. */
export function subsystemOfSpec(kind: string, id: string, nodes: ScopeNode[]): string | undefined {
  if (kind === 'subsystem') return nodes.some((n) => n.kind === 'subsystem' && n.id === id) ? id : undefined;
  const byId = new Map<string, ScopeNode>();
  for (const n of nodes) if (!byId.has(n.id)) byId.set(n.id, n);
  let cur = nodes.find((n) => n.kind === kind && n.id === id) ?? byId.get(id);
  for (let hops = 0; cur && hops < 8; hops++) {
    if (cur.kind === 'subsystem') return cur.id;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return undefined;
}

export interface MovedScope {
  moved: MovedSpec[];
  /** The one subsystem every moved spec belongs to; undefined when several, none, or one cannot be placed. */
  subsystem?: string;
  /** Every subsystem the placeable moved specs belong to. */
  subsystems: string[];
}

/** Which subsystem(s) the moved specs fall in. A spec the data cannot place makes the move whole-design. */
export function movedScope(moved: string[] | undefined, nodes: ScopeNode[]): MovedScope {
  const specs = parseMoved(moved);
  const subs = new Set<string>();
  let unplaced = false;
  for (const s of specs) {
    const kind = s.folder ? FOLDER_KIND[s.folder] : undefined;
    const sub = kind ? subsystemOfSpec(kind, s.id, nodes) : undefined;
    if (sub) subs.add(sub);
    else unplaced = true;
  }
  const subsystems = [...subs].sort();
  return { moved: specs, subsystems, subsystem: !unplaced && subsystems.length === 1 ? subsystems[0] : undefined };
}

export interface BarState {
  show: boolean;
  /** What the bar offers: Review for a pending request, else Lock. */
  action: 'review' | 'lock' | 'none';
  /** The line to show. */
  line: string;
}

/** Whether the floating bar shows, what it offers and what it says. */
export function barState(approval: DevApprovalData | undefined, pendingCount: number, pendingKind?: string): BarState {
  if (pendingCount > 0) {
    const what = pendingKind === 'lock' ? 'Lock requested' : 'Review requested';
    return { show: true, action: 'review', line: pendingCount > 1 ? `${what} (${pendingCount} pending)` : what };
  }
  if (!approval) return { show: false, action: 'none', line: '' };
  if (!approval.approved) return { show: true, action: 'lock', line: 'This design has not been locked yet.' };
  if (approval.verdict.drifted) {
    const stamp = approval.approvedBy || approval.approvedAt
      ? `Last locked${approval.approvedBy ? ` by ${approval.approvedBy}` : ''}${approval.approvedAt ? ` ${new Date(approval.approvedAt).toLocaleString()}` : ''}. `
      : '';
    const n = approval.verdict.moved?.length ?? 0;
    return { show: true, action: 'lock', line: `${stamp}${n > 0 ? `${n} spec${n === 1 ? '' : 's'} changed since.` : 'The design changed since.'}` };
  }
  return { show: false, action: 'none', line: '' };
}

/** What a review card says when its request was made on another branch than the checkout has; none when it matches or either is unknown. */
export function otherBranchLine(requestBranch: string | undefined, checkoutBranch: string | undefined): string | undefined {
  if (!requestBranch || requestBranch === checkoutBranch) return undefined;
  return `requested on ${requestBranch}; checkout is on ${checkoutBranch ?? 'a detached HEAD'}`;
}

/** The notice shown when the checkout's branch changed between two approval reads; none on the first read or when nothing changed. */
export function branchChangeNotice(previous: { seen: boolean; branch?: string }, branch: string | undefined): string | undefined {
  if (!previous.seen || previous.branch === branch) return undefined;
  return `The checkout switched from ${previous.branch ?? 'a detached HEAD'} to ${branch ?? 'a detached HEAD'}.`;
}

/** What the header's branch chip says: the branch, else the short commit of a detached HEAD; none when neither is known. */
export function branchChipText(approval: Pick<DevApprovalData, 'branch' | 'commit'> | undefined): string | undefined {
  if (approval?.branch) return approval.branch;
  if (approval?.commit) return approval.commit.slice(0, 7);
  return undefined;
}

/** The one-line approval state the specs view shows: what is true now, never "approved" once the design moved. */
export function approvalStatusLine(approval: DevApprovalData | undefined): string | undefined {
  if (!approval) return undefined;
  if (!approval.approved) return 'This design has not been locked yet.';
  if (approval.verdict.drifted) {
    const n = approval.verdict.moved?.length ?? 0;
    return n > 0 ? `${n} spec${n === 1 ? '' : 's'} changed since the last approval.` : 'The design changed since the last approval.';
  }
  return 'This project is approved — saving a spec change puts that spec back in flux until it is approved again.';
}

/** Whether a Lock action belongs in place (specs / diagrams view). */
export function offersLockInPlace(approval: DevApprovalData | undefined): boolean {
  return !!approval && (!approval.approved || approval.verdict.drifted);
}

/**
 * The subsystem an in-place Lock is scoped to: the one being looked at, only when it is the only one that
 * moved. Otherwise the lock is whole-design.
 */
export function inPlaceScope(viewSubsystem: string | undefined, scope: MovedScope): string | undefined {
  return viewSubsystem && scope.subsystem === viewSubsystem ? viewSubsystem : undefined;
}

/** The subsystem a canvas route is inside: the first route segment naming a known subsystem. */
export function subsystemOfRoute(route: string, nodes: ScopeNode[]): string | undefined {
  const subs = new Set(nodes.filter((n) => n.kind === 'subsystem').map((n) => n.id));
  for (const seg of route.split('/').filter(Boolean)) {
    const id = decodeURIComponent(seg);
    if (subs.has(id)) return id;
  }
  return undefined;
}

/** The request body of POST /web/dev/commands for a lock. */
export function lockBody(subsystem: string | undefined): { command: 'lock'; subsystem?: string } {
  return subsystem ? { command: 'lock', subsystem } : { command: 'lock' };
}

// Naming the page after the project it serves.

/** The label shown in the dev header: the L0 system name, else the fallback. */
export function projectLabel(systemName: string | undefined | null, fallback = 'project'): string {
  const n = (systemName ?? '').trim();
  return n || fallback;
}

/** document.title of a `wairon dev` page. */
export function devPageTitle(name: string): string {
  return `${name} · wairon dev`;
}

/** document.title of a hosted page; without a project it is just the product name. */
export function hostedPageTitle(name?: string | null): string {
  const n = (name ?? '').trim();
  return n ? `${n} · wairon` : 'wairon';
}
