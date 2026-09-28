// ---------------------------------------------------------------------------
// validation_options — the type's own behaviour, beside the other value
// objects every subsystem shares, so the CLI, the MCP tool and doctor read the
// flags one way without reaching into the validator for it.
// ---------------------------------------------------------------------------

/** The two switches the choice between the runs reads. */
export interface FamilySwitches {
  family?: boolean;
  recursive?: boolean | number;
}

/**
 * validation_options.selectsFamily — whether these options ask for the family
 * run rather than the owner's gate: true when `family` is set, or when the
 * bound project declares members and `recursive` is not false. The one reading
 * of the flags every caller shares, so the choice cannot drift between them.
 */
export function selectsFamily(options: FamilySwitches | undefined, declaresMembers: boolean): boolean {
  if (options?.family) return true;
  return declaresMembers && options?.recursive !== false;
}
