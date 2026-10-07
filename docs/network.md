# Derived networking: `wairon network`

wairon derives a system's network from its design. The inputs are the calls you model, the entries you declare on Portals (`invokedBy: {kind: entry, scope: outside | network}`), the networks your projects declare (`network` in `.wai/project.yaml`, written by `wairon network declare [--description <text>]` — `undeclare` removes it — or by the assistant's `sdd_set_network` tool) and the gateways on them (`variant: gateway`). From these it answers who may talk to whom, and on what grounds.

**The gate comes first.** Every network command reads the design as the validator judges it. A flow an error sits on (`GATEWAY_BYPASSED`, ...) is **refused**: the matrix marks its row `REFUSED` with the findings, a policy never admits it (and `policy` exits 1, naming it at the head of the file), `why` answers that the gate refuses it, and `check` files an observed flow that only a refused flow would allow as disallowed. A warning (`ENTRY_UNPROVEN`, ...) only marks its row. Each command prints the findings it was judged against.

Specs never hold an address, a port, a namespace or a label. Those deployment facts come from a **bindings file** that the team keeps outside `.wai/` and passes when generating policy. The design stays logical, and the deployment stays yours.

Every command runs at the project you are in. At a project that declares members, the commands cover its whole family; `--no-recursive` limits them to that project alone. Run them at the family root: only the family run can narrow a `network` entry to the callers it really has.

## The outputs, and what each is for

| Command | Output | What a team does with it |
|---|---|---|
| `wairon network flows [--format json\|csv\|markdown] [--out <file>]` | The **allowed-flows matrix**: one row per flow (from, to, transport, binding, networks crossed, gateway, evidence) | Review it in pull requests as the authoritative "who talks to whom". A design change that adds a dependency shows up as a new row before any code or firewall change exists. The CSV suits spreadsheets and audits, and the Markdown suits review comments. |
| `wairon network policy --bindings <file> [--out <file>]` | **Kubernetes `NetworkPolicy`** YAML: one ingress policy per called workload | Commit it to the deployment repository and diff it in CI. A design change becomes a policy diff that the security reviewer reads in the same PR. A design that fails the gate exits 1: the refused flows are left out and named at the head of the file. |
| `wairon network diagram [--out <file>]` | A **Mermaid** flowchart: declared networks as nested boundaries, gateways on them, an `outside` node, and flows aggregated per workload pair | Use it as the data-flow diagram with trust boundaries that threat modelling starts from: each boundary an edge crosses is a place to ask the STRIDE questions. It also works for onboarding and on architecture pages. The hosted canvas draws the same picture in its **Network** view (`/canvas/<project>/network`; the system spec's `diagram.defaultView: network` opens the canvas there). |
| `wairon network check --observed <file> [--bindings <file>]` | **Unexpected** flows (seen, but nothing allows the pair), **disallowed** flows (a verb the destination declares, but not allowed from that source, or only by a flow the gate refuses), **unknown verbs** (an allowed pair, but a method and path no contract of the destination declares) and **unexercised** flows (allowed, never seen) | Audit a live system against its design. Exits 1 on anything unexpected, disallowed or unknown, so it can gate a pipeline. Unexercised flows are review items, such as dead dependencies or rules to tighten, and never fail the command. |
| `wairon network why <from> <to>` | The modelled chain behind a flow: the entry or call step, each network entered, the gateway, and the verb with its binding | Answer a firewall change request or an incident question ("why does checkout talk to payments?") from the design, in one command. Exits 1 when nothing allows the flow, and names what does reach the target instead; says so when the gate refuses the flow, when a name is unknown (a typo, not a refusal), and — exiting 0 — when the callee is reached in-process, which is never a network flow. |
| `wairon network declare [--description <text>]` / `undeclare` | Writes (or removes) `network` in `.wai/project.yaml` | Declare the boundary without a hand edit. It changes which rules fire, so validate, then re-lock. |

The MCP server offers the same reads to an assistant while it designs: `sdd_get_network_flows` (optionally `to: <project | portal | portal.verb>`) and `sdd_explain_flow` (`from`, `to`), and the declaration as `sdd_set_network` (`declared`, `description`). The hosted server serves the view model at `GET /web/projects/network?projectId=…`.

### What becomes a flow

- Only **network transports** produce flows: HTTP, gRPC, GraphQL, MessageBus and Custom. In-process libraries, CLI commands, IPC and JSON-RPC over stdio never do.
- A **modelled call** into a network verb from another subsystem or project is a flow from the calling component. It names the networks it enters and the gateway it passes.
- A verb's **binding** is the path a cluster sees: an HTTP endpoint is joined under its Portal's `basePath` (`basePath: /v1` and `POST /orders` bind `POST /v1/orders`), so L7 checks match real paths.
- An **Adapter's transport** is its target Portal's: the Adapter calls the Portal's verbs over it. An Adapter may state one (`sdd_add_component` fills it in from the Portal its `dependsOn` names); a stated transport that disagrees with the target's is `ADAPTER_TRANSPORT_MISMATCH`, so changing a Portal's transport shows its impact on every Adapter that calls it.
- An **`outside` entry** is a flow from outside the verb's innermost network. For an outermost network that is the world (`outside`); for a nested network it is the next network out (`network:<parent>`). Scopes are relative.
- A **`network` entry** is a flow from anywhere inside the network. At the family root, when modelled callers prove the entry, the blanket row is replaced by those callers. The matrix is therefore least-privilege by construction: "the network may reach this" becomes "these two Adapters reach this".

### Naming parties

`from`, `to`, the observed-flow names and the binding keys all use design names:

- `outside`.
- `network` or `network:<id>`, meaning anywhere inside a declared network. A network's id is the key of the project that declares it; plain `network` is the family root's.
- A project key such as `orders`.
- A subsystem, as `project::subsystem` or bare for the root's own.
- A component, as `project::component` or bare for the root's own.
- On the receiving end, also `project::portal.verb`.

Each party has a **default workload name**: a member's project key, or for the root project's own components their subsystem — also when the root's component reaches into another project: the caller is named by its workload (its subsystem, the pod it runs in), with the component kept for the evidence, so a bindings file written per service keeps covering it after a callee is promoted.

## The bindings file

YAML, kept wherever your deployment config lives (never in `.wai/`):

```yaml
workloads:
  orders:                          # a project
    selector: { app.kubernetes.io/name: orders }
    namespace: shop
    port: 8080                     # the port its Portals listen on (optional)
  platform::api_gateway:           # a Portal: more specific than its project
    selector: { app.kubernetes.io/name: edge }
    namespace: edge
    port: 8443
  edge:                            # a subsystem of the root project
    selector: { app.kubernetes.io/name: edge }
  network:                         # "anywhere in the root network": a label every member pod carries
    selector: { platform.example/member: "true" }
outside:                           # what "outside" means for a policy
  - 0.0.0.0/0
```

- `workloads` maps a design name to a `selector` (labels, required and non-empty), a `namespace` (optional) and a `port` (optional, 1–65535). The most specific key a party has wins, in the order component, subsystem, project, default workload name.
- `outside` lists the CIDR blocks admitted for callers from outside, for example the internet, a load balancer range or an intranet. Without it, nothing from outside is admitted.
- A source in another namespace gets a `namespaceSelector` on `kubernetes.io/metadata.name`. A network-wide source bound without a namespace matches in any namespace (`namespaceSelector: {}`).

**Nothing is guessed.** A design name the bindings do not map is selected by the placeholder label `wairon.dev/workload: <name>`, which matches no pod until you bind it or label one. It is listed in the document and on stderr, and at the top of the output under `# UNBOUND:`. MessageBus flows travel through the broker rather than pod to pod, so they are listed as `# NOT EXPRESSED` instead of opening ingress. Default deny is implied: each policy selects its workload and admits only what the design allows.

## The observed-flow format

Export observed flows from whatever sees them: a service-mesh telemetry export, an eBPF flow log (Cilium/Hubble, Retina), or VPC flow logs once your tooling has mapped addresses to workloads. wairon never sees an IP address. Name each end by a design name, or by a label value that one of your bindings' selectors carries (pass `--bindings` so it can be mapped back).

CSV with a header row; `source` and `destination` are required, the rest optional:

```csv
source,destination,transport,method,path,count
outside,edge,HTTP,GET,/api/orders,120
edge,orders,HTTP,POST,/orders,40
orders,billing,HTTP,POST,/charges,38
```

Or JSON with the same fields, as a list or as `{ "flows": [...] }`:

```json
[{ "source": "orders", "destination": "billing", "method": "POST", "path": "/charges", "count": 38 }]
```

- A row without `method` and `path` is an L4 observation: it exercises every allowed flow between the pair.
- A row with both is checked at L7 against the verbs' bindings. `{id}` and `:id` path segments match any value, and gRPC paths (`/pkg.Service/Method`) match the `service/method` binding.
- A malformed row (no source or destination, or a non-integer count) is refused with its row number, and nothing is half-read.

## A typical loop

```sh
wairon network flows --format markdown --out docs/flows.md             # review in the PR
wairon network policy --bindings ../deploy/bindings.yaml --out ../deploy/netpol.yaml
wairon network check --observed hubble-export.csv --bindings ../deploy/bindings.yaml
wairon network why shop::checkout_adapter payments::payments_api.charge
```
