// ---------------------------------------------------------------------------
// Typed error classes for waffle-airon
// ---------------------------------------------------------------------------

export class WaironError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WaironError';
  }
}

/**
 * Thrown when a YAML file does not parse (a duplicated key, a bad indent):
 * one line naming the file, the line and — when the error is about one — the
 * key, e.g. `.wai/project.yaml:33: duplicated mapping key "rules"`. A
 * WaironError, so every command prints it as one `✖` line, never a stack.
 */
export class YamlSyntaxError extends WaironError {
  constructor(
    readonly file: string | undefined,
    readonly line: number | undefined,
    readonly reason: string,
    readonly key: string | undefined,
  ) {
    const where = file ? `${file}${line !== undefined ? `:${line}` : ''}: ` : line !== undefined ? `line ${line}: ` : '';
    const advice = /duplicated mapping key/.test(reason)
      ? ' — a key may appear once per mapping: merge the two blocks into one'
      : '';
    super(`${where}${reason}${key !== undefined ? ` "${key}"` : ''}${advice} (the YAML does not parse, so nothing in it was read)`);
    this.name = 'YamlSyntaxError';
  }
}

/**
 * Thrown when the project has not been initialized (.wai/ directory missing).
 */
export class ProjectNotInitializedError extends WaironError {
  constructor() {
    super(
      'No wairon project found in this directory.\n' +
        'Run `wairon init` to initialize the project.',
    );
    this.name = 'ProjectNotInitializedError';
  }
}

/**
 * Thrown when configuration is invalid or missing required fields.
 */
export class ConfigValidationError extends WaironError {
  constructor(detail: string) {
    super(`Configuration validation failed: ${detail}`);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Thrown when a template referenced by an agent or bundle does not exist.
 */
export class TemplateNotFoundError extends WaironError {
  constructor(id: string) {
    super(`Template not found: "${id}"`);
    this.name = 'TemplateNotFoundError';
  }
}

/**
 * Thrown when a bundle definition does not exist.
 */
export class BundleNotFoundError extends WaironError {
  constructor(id: string) {
    super(`Bundle not found: "${id}"`);
    this.name = 'BundleNotFoundError';
  }
}

/**
 * Thrown by `wairon doctor` for flags that do not combine: `--report` prints a
 * plan and writes nothing, so it never goes with `--fix`, and `chaining` is the
 * one section it knows.
 */
export class DoctorOptionsError extends WaironError {
  constructor(detail: string) {
    super(`wairon doctor: ${detail}`);
    this.name = 'DoctorOptionsError';
  }
}

/**
 * Thrown by the `wairon network` commands for a missing input: a policy needs
 * the team's bindings file, a check needs an observed-flow export.
 */
export class NetworkOptionsError extends WaironError {
  constructor(detail: string) {
    super(`wairon network: ${detail}`);
    this.name = 'NetworkOptionsError';
  }
}

/**
 * Thrown when the chaining migration refuses to apply a plan, before its first
 * write: the family was only partly in reach, or a project the plan writes has
 * no configuration. `reasons` names each blocking finding.
 */
export class ChainingMigrationRefusedError extends WaironError {
  constructor(readonly reasons: string[]) {
    super(`The chaining migration was not applied; nothing was written:\n${reasons.map((r) => `  - ${r}`).join('\n')}`);
    this.name = 'ChainingMigrationRefusedError';
  }
}
