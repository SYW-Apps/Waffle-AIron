// ---------------------------------------------------------------------------
// validation_options — the type's own behaviour, beside the other value
// objects every subsystem shares, so the CLI, the MCP tool and doctor read the
// flags one way without reaching into the validator for it.
// ---------------------------------------------------------------------------

/**
 * The two switches the choice between the runs reads. `memberDepth` is how far
 * a run reaches into a project's members: absent, every level; 0, none (the
 * owner's gate alone); n, that many levels.
 */
export interface FamilySwitches {
  family?: boolean;
  memberDepth?: number;
}

/**
 * validation_options.selectsFamily — whether these options ask for the family
 * run rather than the owner's gate: true when `family` is set, or when the
 * bound project declares members or externals and `memberDepth` is not 0. A
 * project that declares externals but no members therefore composes them
 * against their live producers on a plain `validate`, as one that declares
 * members does; `--no-recursive` (memberDepth 0) still asks for the owner's
 * gate alone. The one reading of the flags every caller shares, so the choice
 * cannot drift between them.
 */
export function selectsFamily(options: FamilySwitches | undefined, declaresMembers: boolean, declaresExternals: boolean): boolean {
  if (options?.family) return true;
  return (declaresMembers || declaresExternals) && options?.memberDepth !== 0;
}
