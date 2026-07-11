// Shared control-plane error classes. They live outside identity.ts so planes
// that identity itself imports from (e.g. policy's IdP-config storage) can use
// them without forming a module-level import cycle.

/** Raised when the presented credential authenticates to no principal (maps to 401). */
export class UnauthenticatedError extends Error {
  constructor() {
    super('Unauthenticated: a valid credential is required.');
    this.name = 'UnauthenticatedError';
  }
}

/** Raised when an authenticated caller is not authorized for the action (maps to 403). */
export class ForbiddenError extends Error {
  constructor(message: string) {
    super(`Forbidden: ${message}`);
    this.name = 'ForbiddenError';
  }
}

/** Raised on the admin plane for a missing/insufficient admin credential (maps to 403). */
export class AdminAuthError extends Error {
  // A default message covers a missing/unauthenticated credential; the scoped
  // project-lifecycle methods pass a specific reason for a scope denial (an
  // authenticated caller lacking authority). Both map to 403 on the admin plane.
  constructor(message = 'Forbidden: a valid admin credential is required.') {
    super(message);
    this.name = 'AdminAuthError';
  }
}
