# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- The relay strips the Claude CLI's account context `<system-reminder>` (`# userEmail`, `attachedProject`, or a "session context has changed" update) from user turns and `tool_result` content before forwarding (`src/native-context.ts`). The CLI appended it to the latest tool result on every tool-loop request, so the model kept reporting a foreign "userEmail" reminder inside tool output.
- The relay gzips the upstream Messages body on the public leg (`src/request-gzip.ts`), after the cache-breakpoint edit, because Claude Code only compresses bodies it sends to `api.anthropic.com` itself and never one bound for the loopback relay. It follows the CLI's default path: zlib default level for bodies of at least 4096 bytes. If the API answers 400, 403 or 415 with an Anthropic request id (`req_…` or `cf-ray`) and a "body is not valid JSON" message, the relay resends the body plain once and keeps the rest of the process on plain bodies. `CLAUDE_DIRECTSDK_GZIP=0` disables it; `CLAUDE_DIRECTSDK_DEBUG_DUMP_DIR` also writes `wire-*.json` with the encoding and sizes.

### Changed

- Refusals report `stop_details` instead of the fixed "The model refused to complete the request": the category and explanation (`Refusal (cyber): …`, as in OMP's Anthropic provider), the serving model when a server-side fallback produced the turn, the `fallback` hops, `usage.iterations`, `recommended_model`, whether the decline came before any output, blocked native retries, the upstream request id, and the model's own text when it wrote any (`refusalDiagnosis` in `src/stream.ts`). The assistant message also carries `stopDetails`.
- Relay failures keep the error message (`Error: Upstream request timed out`), not only its name (`relay failure Error`). `upstream` and `native` errors include the upstream request id when one was received.
- `CLAUDE_DIRECTSDK_DEBUG_DUMP_DIR` also writes a `response-*.json` summary per request, without content text.
- When the native child returns a tool call outside the advertised inventory, the `native` error now quotes the raw returned name (JSON-quoted) and lists the advertised native names (capped at 40, then `… N more`), via `describeInventory` in `src/stream.ts`. The leading text "Native returned a tool outside the current host inventory" is unchanged.

### Fixed

- A `fallback` content block on the native stdout stream (a server-side fallback switch point, sent by Claude Code 2.1.302, which opts into server-side fallback) no longer fails the turn with "Unsupported native content block: fallback".
- A native tool call whose name exactly matches an advertised wire name without the `mcp__pi__` prefix (for example `read`) is now accepted as that tool. Matching is exact and case-sensitive; other unprefixed names (for example `Bash`, `Read`) still fail with the `native` error.
- Tool names stored in the replay carrier are normalized to the prefixed `mcp__pi__<wire>` form, so an accepted unprefixed call is never replayed unprefixed.

### Notes

- Relay gzip verified against the real API with `claude-haiku-5-5` on macOS and on b200 (Linux), both through an HTTP CONNECT proxy: 60–73 KB bodies went out as 26–30 KB, every request returned 200, multi-turn answers recalled earlier turns, and cache reads and writes matched uncompressed runs. A gzip request read the cache entry a plain request had written. The plain-resend path is covered only against a fake upstream.
- Verified with Claude Code CLI 2.1.293 (inside `QUALIFIED_CLI_RANGE` `>=2.1.263 <2.2.0`): the child argv from `buildArgv` (`--tools ""`, `--strict-mcp-config`) together with `ENABLE_TOOL_SEARCH=false` from `buildChildEnv` exposes no native tool to the model. Against a fake loopback upstream, both the stream-json `system/init` `tools` list and the captured `/v1/messages` request `tools` array contained only `mcp__pi__*` names, for `claude-sonnet-5-5` with 0, 3, 7 and 20 advertised tools, for `claude-opus-5-5` with 20, and for `sonnet`, `opus` and `claude-sonnet-5-5` with 7.
- `--allowedTools` was therefore not added: it governs permissions, not the model-visible tool list, and there is no leaked native tool for it to remove.
- The observed `sonnet` rejection (seen in OMP vibe mode, logs at 2026-10-13 19:30–19:31 +08:00) was not a native CLI tool: sonnet returned the advertised tool `read` without the `mcp__pi__` prefix, and the check required the prefix, so an in-inventory call was rejected. The richer error message identifies any other out-of-inventory name.
