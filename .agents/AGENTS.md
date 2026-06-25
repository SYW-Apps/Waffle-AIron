# Project-Scoped Rules for Waffle-AIron Specs & Types

## SDD Generic Type Specifications
When creating or modifying specs for generic value-objects or entities in `.wai/specs/types/`:
- **Generic Declarations**: You must append generic type parameters to the type's `name` property using angle brackets (e.g., `name: IdentifiedEntity<T>`).
- **Validation Errors**: Failure to include `<T>` (or other generic variable names) in the type's `name` will prevent the validator from resolving it as a generic scope variable. Consequently, fields referencing `T` will trigger an `UNDEFINED_TYPE_REFERENCE` validation error.

## SDD Sum Types / Enums Representation
To represent Rust enums, algebraic data types (ADTs), or discriminated unions in a cross-platform manner without losing type safety (e.g., avoiding raw `json` or `any` types):
- **Discriminated Union Structure**: Define a standard `value-object` representing the enum, using a `variant` field (type `string`) as the discriminator and a `value` field containing a pipe-separated union of all possible variant payload types.
- **Example**:
  ```yaml
  kind: value-object
  id: vm-value
  name: VmValue
  fields:
    - name: variant
      type: string # "null" | "boolean" | "integer" | "string"
      optional: false
    - name: value
      type: "boolean | i64 | string | list<VmValue>"
      optional: true
  ```
- **Why this works**: The validator parses union strings (splitting by `|`, brackets `<>`, etc.) to check each type parameter individually. This keeps types strongly verified while compiling cleanly to native tagged enums in Rust (via `#[serde(tag = "variant", content = "value")]`) and discriminated unions in TypeScript.

## SDD Semantic Guarantees in Narratives (L5)
When asserting semantic guarantees (e.g., `atomic`, `idempotent`, `transactional`, `exactly-once`) on a narrative step:
- **Explicit Assertions Only**: You must use the explicit `assertsGuarantees` array field on the narrative step block (e.g., `assertsGuarantees: [atomic]`).
- **No Prose/Description Extraction**: The validator does NOT scan the free-text `description` field for guarantee keywords. Mentioning keywords like "atomic" or "idempotent" in the description prose will NOT trigger a validation check, preventing domain-noun homonym false positives (e.g., "GPU atomic operations").


