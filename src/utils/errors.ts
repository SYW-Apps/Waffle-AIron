// ---------------------------------------------------------------------------
// Typed error classes for waffagent
// ---------------------------------------------------------------------------

export class WaffagentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WaffagentError';
  }
}

/**
 * Thrown when the project has not been initialized (.ai/ directory missing).
 */
export class ProjectNotInitializedError extends WaffagentError {
  constructor() {
    super(
      'No waffagent project found in this directory.\n' +
        'Run `waffagent init` to initialize the project.',
    );
    this.name = 'ProjectNotInitializedError';
  }
}

/**
 * Thrown when configuration is invalid or missing required fields.
 */
export class ConfigValidationError extends WaffagentError {
  constructor(detail: string) {
    super(`Configuration validation failed: ${detail}`);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Thrown when a template referenced by an agent or bundle does not exist.
 */
export class TemplateNotFoundError extends WaffagentError {
  constructor(id: string) {
    super(`Template not found: "${id}"`);
    this.name = 'TemplateNotFoundError';
  }
}

/**
 * Thrown when a bundle definition does not exist.
 */
export class BundleNotFoundError extends WaffagentError {
  constructor(id: string) {
    super(`Bundle not found: "${id}"`);
    this.name = 'BundleNotFoundError';
  }
}
