# wairon plugin

Spec-driven development for AI coding tools. The plugin adds:

- the **wairon MCP server** (`npx -y @wairon/cli@<version> mcp serve`), pinned to
  the release the plugin ships with, so Node.js must be on your PATH;
- the five **SDD skills**: `sdd-architect`, `sdd-narrative`, `sdd-auditor`,
  `sdd-implement` and `sdd-delegate`.

The server works on the project the tool has open: the folder that holds `.wai/`.
Set one up with `npx @wairon/cli init`, or see the
[main README](../../README.md) for the CLI.

## Install

| Tool | How |
|---|---|
| Claude Code | `/plugin install wairon --marketplace SYW-Apps/Waffle-AIron` |
| Codex | `codex plugin marketplace add SYW-Apps/Waffle-AIron`, then `codex plugin add wairon@wairon` |
| Antigravity | `agy plugin install <path to this folder>` |
| Gemini CLI | `gemini extensions link <path to this folder>` |
| Cursor | copy this folder to `~/.cursor/plugins/local/wairon`, then reload the window |

With the plugin installed, do not also run `wairon mcp install` for that tool:
a second registration gives the agent every tool twice.

## Files

One folder serves every tool; each reads only its own manifest.

| Tool | Manifest | MCP server |
|---|---|---|
| Claude Code | `.claude-plugin/plugin.json` | `.mcp.json` |
| Codex | `.codex-plugin/plugin.json` | `.mcp.json` |
| Cursor | `.cursor-plugin/plugin.json` | `mcp.json` |
| Antigravity | `plugin.json` | `mcp_config.json` |
| Gemini CLI | `gemini-extension.json` | inline |

`skills/<name>/SKILL.md` is the source of the built-in skills: `wairon generate`
copies the same files into a project, and the MCP server publishes them as
`wairon-skill://` resources.

Every manifest carries the same version. A release stamps it with
`node scripts/plugin/stamp-version.mjs <version>`.
