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
