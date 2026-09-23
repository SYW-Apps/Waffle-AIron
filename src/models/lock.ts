// ---------------------------------------------------------------------------
// approver_identity — who approved a lock, and how much that name is worth.
//
// Shared vocabulary, so it lives with the models rather than inside the store
// that happens to persist it (src/core/lockfile.ts). That placement is
// load-bearing rather than tidy: `label` is a pure projection over the value's
// own fields, and a CLI command that renders an approver has to be able to
// reach it WITHOUT reaching into sdd_core's lock store — a Portal may not
// depend on a Store, so while the function sat beside the lock file's I/O
// there was no legal route to it at all.
// ---------------------------------------------------------------------------

/**
 * Who approved, and HOW that identity was established — because the two are
 * different claims. A `hosted` identity was authenticated by the instance that
 * issued the caller's credential; `git` and `os` are self-declared, read from
 * the machine's own config. Recording the source keeps the record honest about
 * how much it proves instead of leaving a bare name to imply more than it can.
 *
 * The actual proof is the commit that introduces the lock record — signed
 * commits or a protected branch establish it; no field inside the file ever
 * can.
 */
export interface ApproverIdentity {
  /** Git author line, hosted subject id, or OS username — per `source`. */
  id: string;
  /** Display name when the source carries one separately from the id. */
  name?: string;
  /** 'legacy' is a record written before this field existed: an opaque string. */
  source: 'git' | 'hosted' | 'os' | 'legacy';
}

/**
 * approver_identity.label — one line for a human: the approver plus how much
 * that name is worth. A self-declared identity read off a machine and one an
 * instance authenticated are different claims, and a reader has to be able to
 * tell them apart at a glance.
 */
export function describeApprover(who: ApproverIdentity): string {
  const label = who.name ? `${who.name} (${who.id})` : who.id;
  return who.source === 'hosted' ? `${label} [authenticated]` : label;
}
