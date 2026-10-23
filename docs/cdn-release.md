# Releases on the SYW CDN

Every stable, beta and preview release of wairon is also published to the SYW CDN
(`https://cdn.sywapps.com`), beside the GitHub release and npm. The GitHub release
and npm stay the primary channels: `wairon update` and the install scripts read
GitHub, and npm carries the provenance attestation. The CDN copy is for pages and
tools that want a release's files, manifest and guides from one place.

Dev builds (`-dev.N`, one per merge to `dev`) are not published to the CDN; npm's
`dev` tag carries them.

## Where a release lives

```text
https://cdn.sywapps.com/apps/<app>/releases/<version>/   one immutable directory per version
https://cdn.sywapps.com/apps/<app>/releases/<alias>/     a mutable alias pointing at one version
```

`<app>` is the namespace the CDN assigns the wairon publisher. Every version
moves these aliases:

| Version | Aliases |
|---|---|
| `6.2.0` (stable) | `latest`, `v6` |
| `6.3.0-beta.1` | `beta` |
| `6.3.0-preview.1` | `preview` |

An exact version directory never changes; an alias is cached for minutes. Read an
alias to discover the current version, then download from the exact version URL.
The versions published so far are listed by `GET /api/v1/releases?namespace=<app>`.

## `version.json`

Each release directory holds `version.json`, the manifest a consumer reads:

```json
{
  "schemaVersion": 1,
  "name": "wairon",
  "version": "6.2.0",
  "tag": "v6.2.0",
  "channel": "stable",
  "released": "2026-10-22T12:00:00.000Z",
  "commit": "<the tagged commit>",
  "npm": { "package": "@wairon/cli", "version": "6.2.0" },
  "source": "https://github.com/SYW-Apps/Waffle-AIron/tree/v6.2.0",
  "notes": "notes.md",
  "docs": "docs/syw-docs.json",
  "files": [
    {
      "platform": "linux-x64",
      "name": "wairon-6.2.0-linux-x64.tar.gz",
      "sha256": "<hex>",
      "bytes": 31457280,
      "checksum": "wairon-6.2.0-linux-x64.tar.gz.sha256"
    }
  ]
}
```

- `released` is the time of the tagged commit.
- `channel` is `stable`, `beta` or `preview`.
- `files` lists one archive per platform: `windows-x64` (`.zip`), `linux-x64`,
  `linux-arm64`, `macos-x64` and `macos-arm64` (`.tar.gz`). Each is the same file
  as on the GitHub release, with its `sha256` and its `.sha256` file beside it.
- Every path (`notes`, `docs`, a file's `name` and `checksum`) is relative to the
  release directory that holds `version.json`.
- `notes` is present when the release has release notes.
- `schemaVersion` changes only when a field changes meaning or is removed; new
  fields may appear without it.

## Guides

`docs/syw-docs.json` is a manifest for the CDN's documentation reader. It
holds the README, the vision and architecture, the CLI reference, networking,
the design export, extending wairon and templates. Links between those pages stay
in the reader; any other link points at the file on GitHub at the release's tag.
Open them at:

```text
https://cdn.sywapps.com/docs?source=apps/<app>/releases/latest/docs/syw-docs.json
```

## Publishing

The `publish-cdn` job of `release.yml` runs `scripts/cdn-publish.mjs` after the
build, with the publisher credential in the `SYW_CDN_PUBLISHER_TOKEN` secret.
Without that secret it does nothing. Nothing else waits on it, so a CDN failure
never holds back the GitHub release or npm. A failed job can be re-run: the
archives come from the same build, and the CDN accepts an identical republish.

To see what would be published, without a credential:

```sh
node scripts/cdn-publish.mjs --version 6.2.0 --artifacts <dir with the archives> --dry-run <out-dir>
```
