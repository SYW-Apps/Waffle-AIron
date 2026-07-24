// ---------------------------------------------------------------------------
// Filesystem / header filename safety.
//
// One definition, used wherever an id or name is interpolated into a path
// segment or a Content-Disposition header: keep only characters that cannot
// escape the segment (no `/`, `\`, `..`, drive letters, CR/LF, quotes). Every
// caller here feeds an already-constrained value (a SpecIdSchema component id,
// a resolved project id), so this is defense in depth — it guarantees a future
// caller that ever passes an imported/unvalidated id cannot traverse out of the
// intended directory or inject into the header.
// ---------------------------------------------------------------------------

/** Reduce a value to safe filename/path-segment characters. */
export function safeFilenamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}
