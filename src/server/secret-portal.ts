// ---------------------------------------------------------------------------
// secret_portal (sdd_host) — the in-process front door onto the container's
// integration secrets, for the adapters in other subsystems that present a
// credential to an outside service: sdd_git's clone, sdd_producers' Notion and
// Miro sync.
//
// An identity re-export of the secret repository's resolve, in a module of its
// own so a consumer lands on the portal and loads nothing of the hosting server.
// It resolves one key and nothing else: setting and listing secrets belong to
// the operator-facing admin plane.
// ---------------------------------------------------------------------------
export { resolveSecret as resolve } from '../utils/secrets.js';
