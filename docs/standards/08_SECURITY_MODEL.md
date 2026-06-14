> **⚠ LEGACY / SUPERSEDED — do NOT implement from this document.**
> This describes the **pre-ledger** state of waffler_core (before the canonical design sessions). It is retained for historical reference only. **Authoritative now:** `docs/waffler_core/CANONICAL_DECISIONS.md` §8 (design decisions) + the per-service docs under `docs/waffler_core/services/security/` and `docs/waffler_core/services/vault/`. Where this file conflicts with the ledger, the ledger wins (see the ledger's "Authority order").

---

# Security Model Standards

**Version:** 1.0 · **Date:** 2025-10-01

Security in Waffler is not an afterthought — it is woven into the message bus, the
package system, and the execution engine. This document defines the security model
and the rules that all contributors must follow.

---

## Core Principle: Least Privilege

Every package, blueprint, and component must have access only to what it explicitly
needs to function. Broad permissions are a design failure, not a shortcut.

Concretely:
- Packages declare exactly the commands they need in `permissions.groups`.
- No wildcard-all patterns (`*:*`) are ever acceptable in a shipping manifest.
- Permission groups are shown to the user at install time — write them to be
  understandable by a non-technical user.

---

## Security Middleware

Every command routed through the message bus passes through the `SecurityMiddleware`
before reaching its target handler. The middleware:

1. Extracts the source package's identity from the command's `MessageContext` (JWT).
2. Looks up the source package's approved permission groups in the `SecurityEngine`.
3. Checks whether the target `{service}:{command_type}` is covered by any approved rule.
4. If allowed: forwards the command to the target.
5. If denied: returns a `WafflerError::Unauthorized` to the caller without reaching the target.

This check runs for every command, every time. It cannot be bypassed from package code.

### Internal (Trusted) Commands

Commands sent by waffler_core's own internal components (Portals, Orchestrators) do not
carry a package JWT — they use the system identity. The middleware recognizes the system
identity and allows all commands from it.

---

## Permission Groups

Packages declare permissions in `package.json` under `permissions.groups`.

### Structure

```json
"permissions": {
  "groups": [
    {
      "id": "blueprint_read",
      "label": "Read Blueprints",
      "description": "Allows reading your blueprint definitions to display them in the UI.",
      "required": true,
      "rules": [
        {
          "pattern": { "kind": "Command", "path": "blueprints:list" },
          "effect": "Allow"
        },
        {
          "pattern": { "kind": "Command", "path": "blueprints:get" },
          "effect": "Allow"
        }
      ]
    }
  ]
}
```

### Rules for Writing Permission Groups

1. **One group per coherent capability.** Group the permissions that are needed together
   (e.g., read + list for the same resource) into one group. Don't split `list` and `get`
   into separate groups — that's noise.

2. **Separate optional capabilities into their own groups.** If a feature is optional,
   put its permissions in a group with `required: false`. This lets users decline optional
   features without blocking installation.

3. **Use the minimum required pattern.** If you only need `blueprints:get`, don't use
   `blueprints:*`. Wildcards in permission rules mean "I might need anything in this
   service" — be specific.

4. **Write the `label` and `description` for the user.** The label is shown as a checkbox
   in the install dialog. It must answer "what does approving this allow the package to do?"
   in plain language.

5. **Group IDs are permanent.** Once installed, the approved group IDs are stored in the
   package state. If you rename a group ID, existing installations lose their approval.
   Never rename a group ID in a published version.

---

## Encryption (observed lane tiers — NOT declared in rules)

**Encryption is NOT a permission-rule property (DECIDED — Ledger §17.19 Q supersedes the legacy
declared/negotiated model).** The old per-rule `encryption: { outgoing, incoming }` block (and
`FirewallRule.encryption` / `PermissionRule.encryption_preference`) is **removed**. Encryption requirements
are now expressed and enforced as **per-capability lane tiers**, observed per-frame:

- A capability declares a **`request_tier` + `response_tier`** on the lane-tier ladder
  `bus(0) < fastlane(1) < secure_fastlane(2) < internal(3)`.
- The receiver **observes `arrived_via` from the actual frame** (an AEAD-encrypted frame is what makes a
  message `secure_fastlane`); a message below the required tier is rejected **`LaneRequirementUnmet`**. There
  is **no `wire_encrypt` header** to declare.
- The broker does **no** channel encryption (secret-bearing traffic never crosses it); channel encryption
  exists only on **secure fast lanes** (off-broker, transparent SDK-provided). The link grant's `secure`
  bool decides whether a lane is encryption-capable; a host that must force-encrypt all of its traffic sets
  the **`sensitive`** host-posture flag (§17.19 O).

See `docs/sdk/SERVICE_BASELINE_SDK.md` §5.5 and Ledger §17.19 Q for the full model.

---

## Secrets

Secrets (API keys, credentials, tokens) are managed by the `core:security.vault.*` commands.

Rules:
- **Never store secrets in package manifests, code, or blueprint definitions.**
  Always fetch them at runtime via `core:security.vault.get`.
- **Never log secrets.** The logging system does not automatically redact secret values.
  It is the developer's responsibility not to include them in log messages.
- **Use typed secret definitions.** Packages that need user-provided secrets should
  define secret types in their `entities.secret_types` manifest field so the UI can
  prompt the user appropriately.
- **Exchange, don't expose.** Use `core:security.vault.exchange` to get a short-lived
  token for an operation rather than fetching the raw secret.

---

## Firewall Rules

The firewall layer is a configurable allow/deny policy on top of the permission-group
system. Administrators can add firewall rules to further restrict what approved packages
can do.

Managed via:
```
core:security.firewall.list
core:security.firewall.save
core:security.firewall.delete
```

Firewall rules are evaluated after permission group checks. They can only further
restrict — they cannot grant more access than the installed permission groups.

---

## Package Signature Verification

Package manifests and installed state files are HMAC-signed. The `ManifestSigner` and
`StateSigner` compute and verify these signatures.

Rules:
- Never modify a package's `package.json` manually after signing.
- Never modify a package's `.state` file manually.
- If a signature verification fails at startup, the package is put in `Failed` state
  and its capabilities are unavailable.
- The signing key is stored outside the package directory and never committed to source control.

---

## Security Rules for Developers

### When writing waffler_core code

1. **All external inputs are untrusted.** Validate data from IPC, WASM, network, and
   user-submitted blueprints before processing it. Trust nothing that crosses a process boundary.

2. **Log security-relevant events.** Package installs, permission approvals, failed
   authorization checks, and vault accesses should all be logged at `info` or `warn` level.

3. **Do not short-circuit the middleware.** Internal components that send commands via
   `BusHandle` go through the middleware like everyone else (with the system identity).
   Never bypass `execute_command` to write directly to a handler's channel.

4. **The security engine is a read-mostly resource.** Policy and firewall rule loads happen
   at startup or when explicitly triggered via `core:security.policy.load`. Do not reload
   policies on every command — cache the result.

### When writing package code

1. **Declare only the permissions you need.** Before shipping, audit your permission groups
   and remove any rules for commands you do not actually call.

2. **Do not embed secrets in your package.** Use the vault. If your package ships with
   hardcoded credentials for testing, remove them before the first published version.

3. **Validate inputs from blueprints.** The execution engine enforces input contracts for
   strict capabilities, but for non-strict capabilities, you must validate your own inputs.

4. **Do not use the bus to probe what commands exist.** A package that sends exploratory
   commands to unauthorized services will trigger security violations.

---

## Security Review Requirement

Any change that touches:
- `SecurityMiddleware` or `SecurityEngine`
- `FirewallRuleStore` or permission group processing
- The vault or secret exchange flow
- Package manifest signing or verification
- The `MessageContext` / JWT structure

...must go through a security review (`docs/rfcs/SECURITY_REVIEW.md`) before merging.
See `.ai/AI.md` §3 for the workflow order.
