/**
 * Pure logic behind the `wairon dev` cockpit's action bar and lock confirmation: when there is something
 * to approve, which specs moved and which subsystem they belong to. Kept free of React so it is testable
 * on its own.
 */

import type { MemberApproval } from '../types';

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
  /** Direct member projects and their own approval state (absent without members). */
  members?: MemberApproval[];
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
  const driftedMembers = membersToLock(approval);
  if (!approval.verdict.drifted && driftedMembers.length > 0) {
    return { show: true, action: 'lock', line: memberChangedText(driftedMembers) };
  }
  if (approval.verdict.drifted) {
    const stamp = approval.approvedBy || approval.approvedAt
      ? `Last locked${approval.approvedBy ? ` by ${approval.approvedBy}` : ''}${approval.approvedAt ? ` ${new Date(approval.approvedAt).toLocaleString()}` : ''}. `
      : '';
    const n = approval.verdict.moved?.length ?? 0;
    const tail = driftedMembers.length > 0 ? ` ${memberChangedText(driftedMembers)}` : '';
    return { show: true, action: 'lock', line: `${stamp}${n > 0 ? `${n} spec${n === 1 ? '' : 's'} changed since.` : 'The design changed since.'}${tail}` };
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
export function lockBody(subsystem: string | undefined, member?: string): { command: 'lock'; subsystem?: string; member?: string } {
  if (member) return { command: 'lock', member };
  return subsystem ? { command: 'lock', subsystem } : { command: 'lock' };
}

// Member projects.

/** The label a member goes by: its alias, else its key. */
export function memberName(m: Pick<MemberApproval, 'alias' | 'key'>): string {
  return m.alias || m.key;
}

/** The direct members whose own approval is owed and that hold something to approve. */
export function membersToLock(approval: Pick<DevApprovalData, 'members'> | undefined): MemberApproval[] {
  return (approval?.members ?? []).filter((m) => m.state !== 'approved' && m.approvable !== false);
}

function memberChangedText(members: MemberApproval[]): string {
  const names = members.map(memberName).join(', ');
  return `Member project${members.length === 1 ? '' : 's'} ${names} ${members.length === 1 ? 'is' : 'are'} not approved.`;
}

/** The lock dialog's scope select encodes a member project as `member:<alias>`. */
export const MEMBER_SCOPE_PREFIX = 'member:';
export function memberOfScope(scope: string): string | undefined {
  return scope.startsWith(MEMBER_SCOPE_PREFIX) ? scope.slice(MEMBER_SCOPE_PREFIX.length) : undefined;
}

/** A review entry's pending requests are the ones to act on; `member` names the member project it was made in. */
export function pendingReviews<T extends { request: { status: string } }>(reviews: T[] | undefined): T[] {
  return (reviews ?? []).filter((r) => r.request.status === 'pending');
}

// Changed specs: the specs page banner, tree markers and the changes panel.

export type ChangeMark = '~' | '+' | '-';

/** The route kind of a moved spec's folder (the SpecKind the specs page opens). */
export function movedKind(m: Pick<MovedSpec, 'folder'>): string | undefined {
  return m.folder ? FOLDER_KIND[m.folder] : undefined;
}

/** The specs-page path of a spec: /specs/<kind>/<id with :: as path segments>. */
export function specRoute(kind: string, id: string): string {
  return `/specs/${kind}/${id.split('::').map(encodeURIComponent).join('/')}`;
}

/**
 * Which tree node each added/changed spec marks. An interface or implementation marks the component it
 * belongs to (the tree lists components only); a removed spec is not in the tree and marks nothing.
 * An id the tree does not hold is left out.
 */
export function changeMarks(moved: MovedSpec[], nodes: ScopeNode[]): Map<string, ChangeMark> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, ChangeMark>();
  for (const m of moved) {
    if (m.mark === '-') continue;
    let node = byId.get(m.id);
    if (!node) continue;
    if ((node.kind === 'interface' || node.kind === 'implementation') && node.parentId) node = byId.get(node.parentId) ?? node;
    // An added (+) spec stays added even when a changed one lands on the same node.
    if (out.get(node.id) !== '+') out.set(node.id, m.mark);
  }
  return out;
}

export interface ChangeGroup {
  /** The subsystem; '' for specs the data cannot place. */
  subsystem: string;
  items: MovedSpec[];
}

/** The moved specs grouped by subsystem (placed groups sorted, unplaced last), each group sorted by id. */
export function groupMoved(moved: MovedSpec[], nodes: ScopeNode[]): ChangeGroup[] {
  const groups = new Map<string, MovedSpec[]>();
  for (const m of moved) {
    const kind = movedKind(m);
    const sub = kind ? subsystemOfSpec(kind, m.id, nodes) ?? '' : '';
    groups.set(sub, [...(groups.get(sub) ?? []), m]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
    .map(([subsystem, items]) => ({ subsystem, items: items.slice().sort((x, y) => x.id.localeCompare(y.id)) }));
}

/** What the changes button counts: moved specs plus member projects owed an approval. */
export function changeCount(approval: DevApprovalData | undefined): number {
  if (!approval) return 0;
  return (approval.verdict.moved?.length ?? 0) + membersToLock(approval).length;
}

export interface BannerState {
  show: boolean;
  /** Whether the project was never locked (no change list). */
  never: boolean;
  /** The banner line. */
  text: string;
  /** Own specs that changed. */
  specs: number;
  /** Member projects owed an approval. */
  members: MemberApproval[];
}

/** The specs page's approval banner: none for an approved, unchanged design (members included). */
export function bannerState(approval: DevApprovalData | undefined): BannerState {
  const none: BannerState = { show: false, never: false, text: '', specs: 0, members: [] };
  if (!approval) return none;
  const members = membersToLock(approval);
  if (!approval.approved) {
    return { show: true, never: true, text: 'This design has not been locked yet.', specs: 0, members };
  }
  const specs = approval.verdict.moved?.length ?? 0;
  if (!approval.verdict.drifted && members.length === 0) return none;
  const parts: string[] = [];
  if (specs > 0) parts.push(`${specs} spec${specs === 1 ? '' : 's'} changed`);
  else if (approval.verdict.drifted) parts.push('The design changed');
  if (members.length > 0) parts.push(`member project ${members.map(memberName).join(', ')} changed`);
  const text = parts.join(' · ');
  return { show: true, never: false, text: text.charAt(0).toUpperCase() + text.slice(1), specs, members };
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
