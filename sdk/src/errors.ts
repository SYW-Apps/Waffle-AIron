// ---------------------------------------------------------------------------
// Pack archive errors (pack_archive_error, pack_archive_error_code) — the one
// error every .wpack reader of the SDK fails with. A caller matches on `code`,
// never on message text.
// ---------------------------------------------------------------------------

/** Why a .wpack archive was refused. */
export type PackArchiveErrorCode =
  | 'NOT_A_PACK'
  | 'UNSAFE_PATH'
  | 'LIMIT_EXCEEDED'
  | 'ENVELOPE_INVALID'
  | 'FORMAT_VERSION_UNSUPPORTED'
  | 'PACK_MANIFEST_INVALID'
  | 'IDENTITY_MISMATCH'
  | 'DIGEST_MISMATCH';

/** A .wpack archive was refused: a stable `code` beside a human message. */
export class PackArchiveError extends Error {
  readonly code: PackArchiveErrorCode;

  constructor(code: PackArchiveErrorCode, message: string) {
    super(message);
    this.name = 'PackArchiveError';
    this.code = code;
    Object.setPrototypeOf(this, PackArchiveError.prototype);
  }
}
