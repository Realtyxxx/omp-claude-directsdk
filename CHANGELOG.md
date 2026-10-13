# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- When the native child returns a tool call outside the advertised inventory, the `native` error now quotes the raw returned name (JSON-quoted) and lists the advertised native names (capped at 40, then `… N more`), via `describeInventory` in `src/stream.ts`. The leading text "Native returned a tool outside the current host inventory" is unchanged.

### Fixed

- A native tool call whose name exactly matches an advertised wire name without the `mcp__pi__` prefix (for example `read`) is now accepted as that tool. Matching is exact and case-sensitive; other unprefixed names (for example `Bash`, `Read`) still fail with the `native` error.

### Notes

- Verified with Claude Code CLI 2.1.293 (inside `QUALIFIED_CLI_RANGE` `>=2.1.263 <2.2.0`): the child argv from `buildArgv` (`--tools ""`, `--strict-mcp-config`) together with `ENABLE_TOOL_SEARCH=false` from `buildChildEnv` exposes no native tool to the model. Against a fake loopback upstream, both the stream-json `system/init` `tools` list and the captured `/v1/messages` request `tools` array contained only `mcp__pi__*` names, for `claude-sonnet-5-5` with 0, 3, 7 and 20 advertised tools, for `claude-opus-5-5` with 20, and for `sonnet`, `opus` and `claude-sonnet-5-5` with 7.
- `--allowedTools` was therefore not added: it governs permissions, not the model-visible tool list, and there is no leaked native tool for it to remove.
- The observed `sonnet` rejection (seen in OMP vibe mode, logs at 2026-10-13 19:30–19:31 +08:00) was not a native CLI tool: sonnet returned the advertised tool `read` without the `mcp__pi__` prefix, and the check required the prefix, so an in-inventory call was rejected. The richer error message identifies any other out-of-inventory name.
