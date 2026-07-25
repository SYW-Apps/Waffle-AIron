# Demo extension packs — testing profile application on the local dev stack

These two packs exist so the hosted **profile application** feature can be tested
by hand. They are dev-only fixtures, not product content.

`docker-compose.local.yml` mounts this directory read-only into the container's
**immutable image-layer pack tier** (`/opt/wairon/packs`), so both packs are
present the moment the stack boots and are offered as **adoptable** to every
project. The mutable instance tier (`/data/packs`) is untouched, so installing and
removing packs over the API still works normally.

| Pack | Profile | Doctrine |
|---|---|---|
| `demo-doctrine` | `demo-strict` | `family: backend-like`; **forbids** Actor/Supervisor; **discourages** Store; profile `rules`: description floor **120**, max 3 component deps, and `UNOWNED_STORE` raised **warning → error** |
| `demo-frontend-doctrine` | `demo-frontend` | `family: frontend-like` (backend stereotypes become warnings, frontend ones legal); description floor **40** |

Two packs, because adopting each one vendors *its own* pack into the project — so
switching between them exercises the adopt path twice and shows the picker
grouping options by contributing pack.

## Setup

```bash
docker compose -f docker-compose.local.yml up -d --build
docker compose -f docker-compose.local.yml exec wairon wairon host project create --id demo
# Seed a small spec tree — a fresh project holds only an L0 spec, so profile
# doctrine would have nothing to bite on:
docker compose -f docker-compose.local.yml cp dev/demo-specs/demo_flows wairon:/data/projects/demo/.wai/specs/demo_flows
# `cp` writes as root while the server runs as uid 10001 — hand the files over,
# or the seeded specs are readable but NOT writable from the Specs editor:
docker compose -f docker-compose.local.yml exec --user root wairon chown -R wairon:wairon /data/projects/demo/.wai
```

The seed adds a subsystem (`demo_flows`) with an **Actor** (`flow_runner`) and a
standalone **Store** (`flow_store`), each with a deliberately short description
(~45 chars — under `demo-strict`'s floor of 120, over `demo-frontend`'s 40).

> The seed's `parentSystem: demo` must match the project's L0 name, which is the
> id you created the project with. Using a different id? Edit
> `dev/demo-specs/demo_flows/.index.yaml` first.

## What to test in the web UI

Open <http://localhost:8080/>, go to the project → **Specs** tab. Hard-refresh
(Ctrl+Shift+R) after a redeploy — the dev image serves the SPA with no cache
headers.

**1. Adoptable profiles are offered, and labelled as such.** The *Project type*
picker groups options by source: built-ins, then `demo-doctrine`, then
`demo-frontend-doctrine`. Both pack profiles read **`demo-strict — adopts pack`**,
because their packs are server-global and not yet in this project. Selecting one
switches the hint to *"Not yet installed in this project — saving will adopt the
"demo-doctrine" pack so this profile applies."*

**2. Saving adopts the contributing pack.** Save → the toast reads *"Project type
saved — adopted pack "demo-doctrine" so this profile applies."* Check the
project's **Packs** tab: `demo-doctrine` is now installed. Re-open the Specs tab:
the option no longer says *adopts pack* (it is installed now), and no warning
banner appears.

**3. The doctrine is genuinely in force.** Hit **Validate**. Under
`demo-strict` you should see, on the unchanged seed tree:

```
✖ [flow_runner] PROFILE_FORBIDDEN_STEREOTYPE   Actor, forbidden by profile "demo-strict"
✖ [flow_store]  UNOWNED_STORE                  (raised warning → error by the profile's rules)
⚠ [flow_store]  PROFILE_DISCOURAGED_STEREOTYPE Store, discouraged by profile "demo-strict"
⚠ [demo_flows]  DESCRIPTION_TOO_SHORT          49 chars, min 120
⚠ [flow_runner] DESCRIPTION_TOO_SHORT          45 chars, min 120
⚠ [flow_store]  DESCRIPTION_TOO_SHORT          45 chars, min 120
```

That is the whole point of the feature: **six findings that only exist because a
pack-provided profile is resolving.** Before this change, picking `demo-strict`
wrote the name, the pack was never installed in the project, and validation
reported *none* of the above (just a single `UNKNOWN_PROFILE` warning).

**4. Switch profiles and watch the verdict change.** Set the project type to
`demo-frontend` and re-validate — the same tree now reports:

```
⚠ [flow_runner] BACKEND_STEREOTYPE_IN_FRONTEND  Actor in a frontend subsystem
⚠ [flow_store]  UNOWNED_STORE                   (plain warning again)
```

No forbidden-stereotype error and no description findings (floor 40 vs 120), and
the second pack is adopted on save. Set it back to `backend` and only the single
`UNOWNED_STORE` warning remains. Three project types, three verdicts, one
unchanged spec tree.

**5. An unresolvable project type is reported, not hidden.** With the project on
`demo-strict`, go to the project's **Packs** tab and remove `demo-doctrine`. Back
on Specs, the panel shows a banner: *"The recorded project type "demo-strict"
doesn't resolve to a loaded profile, so its rules aren't being applied. Pick a
profile from the list below to fix this."* Validate agrees (`UNKNOWN_PROFILE`).
Re-picking `demo-strict` re-adopts the pack and clears it. (The image-tier
original is immutable, so the pack is always available to re-adopt.)

**6. A profile no tier carries is refused outright.** Not reachable from the
picker by design — the catalog only offers resolvable profiles. Over the API:

```bash
curl -X POST http://localhost:8080/web/projects/config \
  -H 'Content-Type: application/json' -b <your session cookie> \
  -d '{"projectId":"demo","projectType":"ghost-profile"}'
```

is refused, and the project's previous type is left untouched — an unresolvable
name is never written as a project type.

## Policy-driven application (instance admin)

On the **Instance** page, set the pack policy's *required profile ids* to
`demo-strict`, then:

- **Create a new project** → it comes up already governed by `demo-strict`, with
  the contributing pack vendored in (init applies the recorded selection).
- **An existing project** that predates the policy → its *Policy* evaluation
  reports non-compliance; hitting **Reconcile** repairs the governing profile,
  records it, and the next evaluation reports compliant. One pass, no loop.

## Removing the demo packs

Delete the `./dev/packs:/opt/wairon/packs:ro` volume line from
`docker-compose.local.yml` and recreate the container. Projects that adopted a
demo pack keep their vendored copy (it lives in the project), so remove it from
each project's Packs tab too if you want a clean slate.
