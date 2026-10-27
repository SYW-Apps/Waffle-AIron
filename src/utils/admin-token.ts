// The one rule for a usable WAIRON_ADMIN_TOKEN, shared by the hosted server's
// start and the `wairon host` commands so both refuse the same tokens in the
// same words. A pure check: it reads no store and holds no state.

/** The hosted server's master credential (WAIRON_ADMIN_TOKEN), as configured. */
export type AdminToken = string;

/** The literal placeholder shipped in .env.example — never a real credential. */
export const PLACEHOLDER_ADMIN_TOKEN = 'replace-with-a-random-64-hex-character-token';
/** Shortest admin token accepted; anything below this is trivially guessable. */
export const MIN_ADMIN_TOKEN_LENGTH = 16;

/** Why a WAIRON_ADMIN_TOKEN is refused, or undefined when it is acceptable. */
export function adminTokenProblem(token: AdminToken): string | undefined {
  if (token !== PLACEHOLDER_ADMIN_TOKEN && token.length >= MIN_ADMIN_TOKEN_LENGTH) return undefined;
  return (
    'WAIRON_ADMIN_TOKEN is the example placeholder or too weak '
    + `(must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters and not the shipped default). `
    + 'Generate a strong one with `openssl rand -hex 32`.'
  );
}
