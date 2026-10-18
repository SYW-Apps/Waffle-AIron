# Governance — parents require packs, members adopt them

After stage 4 every project is judged by its own gate, under its own configuration. What a family
still lacks is a way for a parent to say "members of this family run with these packs" — and a way
for anyone to see what a pack actually changes before it is applied.

Decisions this plan rests on: [`decisions.md`](decisions.md) § "Governance stage preconditions
(2026-09-29)". The central one comes from the maintainer: **packs exist to adjust wairon's checks and
behaviour, and a pack may legitimately loosen or remove concepts** — for example for automation and
integration platforms, where some patterns cannot exist. Loosening is never a finding. Installing a
pack must be intentional and its impact understood, and a pack applies per project.

## 1. Requirements — `composition.requirePolicies`

```yaml
# parent .wai/project.yaml
composition:
  requirePolicies:
    - pack: acme/service-baseline
      version: ^1.2            # semver range
      profile: service          # optional: one profile inside the pack
```

- A requirement names an extension pack by semver range, optionally one of its profiles.
- A member adopts it by selecting the pack in its own `extensions.packs` — the same versioned,
  digested selection wairon already resolves and locks. No new policy format.
- The hosted instance pack floor and hosted profile selections keep working beside it.

## 2. Judgement — in the family run only

The member's own gate applies the member's own configuration, so its verdict stays
location-independent (stage 4). Governance acts at composition:

- `POLICY_NOT_ADOPTED` (error) — a required pack the member does not select, or selects outside the
  range; the message names the requirement and the member's selection.
- `POLICY_DEVIATION` (notice) — the member selects the pack but changes one of its settings in its
  own configuration (`sddRuleSeverity`, a profile override, a `lint.allow` over a rule the pack sets);
  it names the setting, the pack's value and the member's. `--ci` never fails on it; a team may raise
  it with `sddRuleSeverity`.
- A pack's own loosening of wairon's defaults is never reported.

## 3. Pack impact

Selecting or updating a pack — CLI, MCP, hosted — first shows what it changes against wairon's
defaults, and the same report is available on demand (`wairon packs impact <pack>`):

- rules it loosens, raises, turns off or adds;
- concepts (stereotypes, variants, component kinds) it removes or adds;
- the findings that change on this project if it is applied — a dry validate before and after.

Installation stays intentional: the report comes before the write, and an unattended run states that
it applied without showing it.

## 4. Scaffolding

`createMember` writes the parent's required packs into the new member's selection once, at creation.
Afterwards it is the member's own selection; nothing reads the parent's requirements at the member's
gate.

## 5. Properties

`not-adopted-is-reported`, `deviation-is-visible-not-blocking`, `pack-loosening-is-never-a-finding`,
`member-gate-unchanged-by-requirements` (a member's own verdict is identical with and without a parent
requirement), `impact-matches-apply` (the impact report's finding changes equal what validation
reports after applying), `scaffold-once`.

## 6. Not in this stage

Approval subjects and `requireApprovedMembers` (stage 5); hosted members as records (stage 7).
