# The static demo

A read-only snapshot of wairon's own design that runs in a browser with no server: the canvas and
the specs views of `wairon dev`, over a recording. It is published to GitHub Pages after every
stable release at

    https://syw-apps.github.io/Waffle-AIron/demos/wairon/

and is built to be framed by another page (the embed contract below) as well as opened directly.

## Build it locally

```
npm run build:web && npm run build     # the web app and the CLI the recorder runs
npm run build:demo                     # records, filters, verifies, writes site/demos/wairon/
```

Then serve `site/` with any static file server and open `/demos/wairon/`. Options of the script
(`node scripts/demo/build-demo.mjs`): `--config <file>` (default `scripts/demo/wairon.demo.json`),
`--out <dir>` (default `site/demos/wairon`), `--skip-web` (reuse `web/dist-demo`), `--explain`
(list every string the redaction and scrub rules change). It prints the size of every part, raw and
gzipped, and fails when the initial load passes 1.5 MB gzipped or the whole site 6 MB.

## What it does

1. **Builds the demo bundle.** `vite build --mode demo` (in `web/`) compiles the same views with a
   compile-time switch, `__WAIRON_DEMO__`, set to true. The result is one HTML file,
   `web/dist-demo/index.html`. The normal web app is built with the switch false, so every demo
   branch is removed from `dist/webapp.html`.
2. **Records.** It starts `wairon dev` on this checkout (on a free port, stopped by its own process
   handle afterwards), takes the dev session, and reads what the two views read: the canvas model,
   the spec graph, the project-type catalog, the validation result, and `sdd_get_spec` for every
   spec of the selection.
3. **Selects.** `wairon.demo.json` lists the subsystems the demo holds. Everything outside them is
   left out: components, edges, types, specs and findings. A spec that is asked for and was left out
   shows "not part of this demo".
4. **Strips code linkage.** `sourcePath`, `symbol`, `exportedVia`, `simPath`, `injectedParams` and
   the conformance fields (`conformance`, tiers, dials, source files, symbol maps, resolved
   signatures) and `externalLinks` (a framed page has no popups) are removed everywhere. Repository-relative paths in prose (the `redactRoots` of the
   config) and absolute paths become an ellipsis. A finding that names a source file is dropped.
   Source code is never read.
5. **Scrubs.** The git user name and email, the lock's approver, any email address, the names of the
   repository's branches and branch-shaped references (`feat/…`, `fix/…`) are replaced.
6. **Verifies.** The files about to be written are searched for any email, person, branch, source
   path, absolute path or linkage field that remains. One hit fails the build (non-zero exit,
   naming the file and the match) before anything is written.
7. **Writes** `index.html` plus `data/`: `index.json` (which request is stored where), `get/*.json`
   and one `spec/<kind>__<id>.json` per spec. The page fetches `index.json`, the canvas model and a
   few small files at start, and each spec when it is opened. All URLs are relative, so the page
   works under any path.

The page reads the recording through the same functions the live app uses (`get`, `post`,
`mcpCall` in `web/src/api.ts`): reads are answered from the files, every write is refused with
"This is a read-only demo of wairon: nothing can be changed here", and the controls that write
(Save, the project-type card, lock and approval bars, family actions) are not part of the demo
shell. There is no WebSocket and no login probe. The address never changes (an in-memory router),
whatever view is shown.

## The embed contract (version 1)

A page that frames the demo (`<iframe sandbox="allow-scripts allow-same-origin">`) and the demo
exchange `window.postMessage` messages, each `{ wairon: 'embed', v: 1, kind, … }`:

| Direction | kind | Fields |
|---|---|---|
| frame to parent | `ready` | `demo: { id, title, waironVersion }`, `views: ['canvas', 'specs']` |
| frame to parent | `view` | `view`, `path`: once after the first `appearance`, then on every route change |
| parent to frame | `appearance` | `mode: 'light' \| 'dark' \| 'high-contrast'`, `tokens`: the 19 `--syw-*` tokens |
| parent to frame | `navigate` | `view`: go to that view's start |

The frame acts only on messages whose origin is `https://wairon.sywapps.com` or
`http://localhost:<port>` and whose source is its parent window. It posts only to its parent, to
the concrete origin it was framed by (from the ancestor origins or the referrer, else
production), never to `*`. `ready` is repeated once a second until the parent speaks. A framed
demo stays blank until the first `appearance`, applies each one live, and shows no theme controls
of its own. Opened directly it is a plain snapshot with the UI's own theme settings (nothing is
stored).

Start points: the canvas opens drilled into one subsystem and the specs view opens one
implementation (both set in `wairon.demo.json`).

The frame side lives in `web/src/demo/embed.ts` (pure, tested without a browser) and
`web/src/demo/DemoApp.tsx`.

## Publishing

`.github/workflows/pages-demo.yml` builds the demo from a fresh checkout of the released tag and
deploys it with `actions/deploy-pages`. It cannot use `on: release`, because the Release workflow
creates the release with the repository token and an event made by that token starts no workflow.
It runs when the Release workflow completes, asks GitHub whether a stable release (not a pre-release
or draft) exists for that tag, and publishes only then. It can also be run by hand
(`workflow_dispatch`), with a tag or with none for the latest stable release. The URL is the same
for every release: each deploy replaces the site.

One repository setting is needed once: Settings, Pages, Source = GitHub Actions.

## Tests

`tests/web/demo-embed.test.ts` (the frame side of the contract), `tests/web/demo-readonly.test.ts`
(reads from the recording, mutations refused), `tests/scripts/demo-lib.test.ts` (stripping,
scrubbing, the verification, the selection).
