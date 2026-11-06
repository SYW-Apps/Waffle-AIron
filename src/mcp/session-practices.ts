// ---------------------------------------------------------------------------
// session_practice_store — the practice entries the current session picked
// through sdd_use_practices. Each MCP server instance creates its own, so two
// sessions never share entries. A stdio server is one session: its entries last
// as long as the session and are gone at the next start, which is intended — a
// session's picks are not project configuration. The hosted server is built per
// request and holds none past it.
// ---------------------------------------------------------------------------

/** practice_listing — one declared practice as sdd_use_practices lists it, without its guidance. */
export interface PracticeListing {
  id: string;
  description: string;
  pack: string;
}

/** practice_report — what sdd_use_practices answers. */
export interface PracticeReport {
  /** Every practice the loaded packs declare. */
  available: PracticeListing[];
  /** The practices the project selects for itself. */
  project: string[];
  /** This session's own entries after the call (an id adds, `!<id>` drops). */
  session: string[];
  /** The practices in force for this session. */
  inForce: string[];
  /** The guidance of each practice in force, each under its attributed heading. */
  guidance: string;
  /** Whether this server keeps the session's entries for later calls. */
  remembered: boolean;
}

export class SessionPracticeStore {
  private held: string[] = [];

  /** isession_practice_store.entries — a copy of the session's entries, in the order they were picked. */
  entries(): string[] {
    return [...this.held];
  }

  /** isession_practice_store.replace — hold these entries in place of the old ones. */
  replace(entries: readonly string[]): void {
    this.held = [...entries];
  }
}
