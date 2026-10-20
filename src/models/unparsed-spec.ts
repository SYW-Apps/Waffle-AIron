// ---------------------------------------------------------------------------
// unparsed-spec — the sentence for a spec whose file EXISTS but which the
// loader refused (a SCHEMA_VALIDATION_ERROR keyed on its id).
//
// Such a spec is not missing: "does not exist" would send the author to
// recreate a file that is there. The sentence quotes the loader's own reason
// and says the file is repaired first. Pure.
// ---------------------------------------------------------------------------

/** The part of a loader finding the sentence reads. */
export interface LoaderRefusal {
  code: string;
  message: string;
  specId?: string;
  unparsed?: { kind: string };
}

/**
 * unparsed_spec.sentence — the one sentence for a spec of this kind and id that
 * fails to parse, or null when no loader refusal stands for it. A refusal
 * recorded by a scan carries its kind; one recorded by a single-spec load
 * names it in the message.
 */
export function unparsedSpecSentence(kind: string, id: string, refusals: readonly LoaderRefusal[]): string | null {
  const refusal = refusals.find((r) => r.code === 'SCHEMA_VALIDATION_ERROR' && r.specId === id
    && (r.unparsed ? r.unparsed.kind === kind : r.message.startsWith(`Failed to parse ${kind} spec`)));
  if (!refusal) return null;
  return `spec-unparsed: the ${kind} "${id}" exists but fails to parse, so it cannot be read or changed — ${refusal.message} Repair the file first; nothing was written.`;
}
