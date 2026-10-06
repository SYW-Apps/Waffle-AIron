// ---------------------------------------------------------------------------
// `wairon network` — the parsed arguments and flags of its commands. The
// workflows are cli_runner's (src/cli/runner.ts); the derivation is
// sdd_network's, reached through the network adapter.
// ---------------------------------------------------------------------------

/** network_command_options — the parsed arguments and flags of the `wairon network` commands. */
export interface NetworkCommandOptions {
  /** --format: json (default), csv or markdown for flows; kubernetes-network-policy (default) for policy. */
  format?: string;
  /** --bindings <file>: the team's bindings file, kept outside .wai/ (required by policy; optional for check). */
  bindings?: string;
  /** --observed <file>: the observed-flow export (check). */
  observed?: string;
  /** --out <file>: write the output there instead of stdout. */
  out?: string;
  /** why: the caller, a project, project::component or outside. */
  from?: string;
  /** why: the callee, a project, project::portal or project::portal.verb. */
  to?: string;
  /** --no-recursive: the bound project alone instead of its family. */
  recursive?: boolean;
}
