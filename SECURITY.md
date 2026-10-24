# Security policy

## Reporting a vulnerability

Please do not open a public issue, discussion or pull request for a vulnerability.

Report it privately through GitHub's private vulnerability reporting:
**[Report a vulnerability](https://github.com/SYW-Apps/Waffle-AIron/security/advisories/new)**
(Security tab → Report a vulnerability).

A useful report says:

- the wairon version (`wairon --version`) and how it was installed (binary, npm, Docker);
- the part affected: the CLI, the MCP server, the hosted server and its web UI, `wairon dev`,
  or a published package;
- what an attacker can do, and what they need first (local access, a credential, a role);
- the steps to reproduce, as small as you can make them.

We acknowledge a report within seven days, keep you informed in the advisory while we work
on it, and credit you in the advisory when it is published, unless you ask us not to.

## Supported versions

Security fixes land on the latest release line and ship as a patch release of it.

| Version | Supported |
| --- | --- |
| Latest 6.x minor | Yes |
| Earlier 6.x minors | No — update to the latest |
| 5.x and older | No |

## Scope

In scope: this repository's code and what it publishes — the `wairon` CLI and its release
binaries, the npm packages, the Docker image, the MCP server, the hosted server with its web
UI and API, and `wairon dev`.

Out of scope: vulnerabilities in third-party dependencies with no wairon-specific impact
(report those upstream), and findings that need an attacker who already controls the machine
or the project folder wairon runs in.
