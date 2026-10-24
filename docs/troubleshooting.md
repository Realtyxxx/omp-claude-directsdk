# Troubleshooting

## Error kinds

`DirectSdkError` in `src/errors.ts` carries a `kind` for model-call failures. Catalog refresh reports ordinary errors.

| Symptom                                        | Kind or source | Action                                                                                                                                                                                                                                           |
| ---------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No `claude` on `PATH`                          | `missing`      | Install with `npm install -g @anthropic-ai/claude-code` or set `CLAUDE_DIRECTSDK_COMMAND` to the executable path.                                                                                                                                |
| CLI installed but not logged in                | `logged-out`   | Run `claude auth login` as the user Pi runs as, set `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) in the environment Pi runs in, or point `CLAUDE_DIRECTSDK_CONFIG_DIR` at a logged-in config directory. Then select the provider again. |
| Conflicting auth or backend overrides          | `env-conflict` | Remove the named variables from the launching environment. Values are never printed.                                                                                                                                                             |
| Catalog refresh fails                          | catalog        | Read the warning for the source or CLI failure. Retry `/model` or run `pi update --models`. No pinned fallback is used.                                                                                                                          |
| Model excluded from catalog                    | metadata       | Read the warning for the missing field. Update Claude Code if picker metadata is incomplete. Unverified limits and prices are never guessed.                                                                                                     |
| No DirectSDK models on a fresh offline install | catalog        | Connect once and run `pi update --models`, or start interactive Pi and open `/model`.                                                                                                                                                            |
| History cannot be replayed                     | `replay`       | Compact or restart the session. Common causes: an empty assistant message, a tool call outside the current inventory, assistant prefill, or an unsupported content block.                                                                        |
| Prompt is too long                             | `native`       | Read the reported route and context window. Remove stale `contextWindow` overrides in `models.json` to use verified limits, or compact the session.                                                                                              |
| Native request failed                          | `native`       | Read the native detail in the message.                                                                                                                                                                                                           |
| Upstream response incomplete                   | `upstream`     | Retry the request.                                                                                                                                                                                                                               |
| Request timed out                              | `timeout`      | Retry the request. The default timeout is 180 seconds.                                                                                                                                                                                           |
| Request cancelled                              | `cancelled`    | Re-run the request. Cancel kills the full child process tree.                                                                                                                                                                                    |

Missing CLI and logged-out CLI fail before any upstream contact. The messages are actionable and safe to show.

## Refusals

A refusal is not an error kind: the API answers 200 with `stop_reason: "refusal"`, and the turn ends with `stopReason: "error"`. The message follows OMP's Anthropic provider and adds what the stop reason alone hides:

```text
Refusal (cyber): <explanation> [served by claude-opus-4-8, requested claude-opus-5-5; server fallback claude-opus-5-5 -> claude-opus-4-8; attempts message(claude-opus-5-5) -> fallback_message(claude-opus-4-8); declined before any output; request-id req_…] Model text: "…"
```

| Part                                        | Meaning                                                                                                                                                                                                        |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Refusal (category)`                        | `stop_details.category`, such as `cyber`, `bio`, `reasoning_extraction`, `frontier_llm` or `general_harms`. `no category` means the API sent `stop_details` without one; `no stop_details` means it sent none. |
| `served by …, requested …`                  | The response `model` differs from the native route, so a server-side fallback model produced the turn.                                                                                                         |
| `server fallback A -> B`                    | `fallback` content blocks: each is a point where one model declined and another continued.                                                                                                                     |
| `attempts …`                                | `usage.iterations`, one entry per model that ran.                                                                                                                                                              |
| `recommended retry model`                   | `stop_details.recommended_model`, sent when the fallback model could not run.                                                                                                                                  |
| `declined before any output` / `mid-stream` | A classifier decline before output has empty content; a mid-stream decline keeps partial text.                                                                                                                 |
| `native retries denied: N`                  | The CLI tried to resend the request (for example its own fallback retry) and the relay blocked it. One OMP call admits one upstream request.                                                                   |
| `request-id`                                | The upstream `request-id` header, for support requests.                                                                                                                                                        |

The same `stop_details` object is set on the assistant message as `stopDetails`. Set `CLAUDE_DIRECTSDK_DEBUG_DUMP_DIR` to also write `response-*.json` per request: status, request id, relay failure, stop reason and details (fallback credit token redacted), serving model, fallback blocks, content block types and usage, without content text.

## Environment reference

| Variable                      | Set by           | Purpose                                                                                                                      |
| ----------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE_DIRECTSDK_COMMAND`    | User             | Override the `claude` executable path or argv head. Used by `resolveClaude`.                                                 |
| `CLAUDE_DIRECTSDK_CONFIG_DIR` | User             | Logged-in config directory. Mapped to `CLAUDE_CONFIG_DIR` for children and setup probes. Never forwarded under its own name. |
| `CLAUDE_CODE_OAUTH_TOKEN`     | User             | Token from `claude setup-token` for environments without an interactive login.                                               |
| `PI_DIRECTSDK_TEST_UPSTREAM`  | Development only | Bypass the subscription environment guard for an explicit custom endpoint. Never set it in normal subscription use.          |

## Subscription guard

Subscription mode refuses conflicting native auth and backend overrides in the merged environment: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_FOUNDRY_API_KEY`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, and `CLAUDE_CODE_USE_FOUNDRY`. The error names the variables without printing values. The development override `PI_DIRECTSDK_TEST_UPSTREAM=1` bypasses this guard. The installed-Pi harness does not set it.

## Version mismatch

The qualified CLI range is `>=2.1.263 <2.2.0` (`QUALIFIED_CLI_RANGE` in `src/models.ts`). The detected version is recorded per call. Behavior failures outside the range fail at runtime. Install the qualified version from [README](../README.md#install), then run the installed-Pi verification scenarios from [testing.md](testing.md).

## Session recovery

Switching providers does not require compaction or a restart. Thinking without a matching native carrier is replayed as ordinary assistant text. This also applies after editing an assistant message that carried signed thinking.

For other unsupported history, compact or restart the session. Do not hand-edit session files to reattach native blocks. A stale signature is never attached to rewritten content by design.

## Cross-provider history

The provider replays foreign thinking as ordinary text and maps incompatible tool-call IDs together with their result references. Failed or aborted responses with empty text or thinking placeholders do not block the next request. The stored session remains unchanged.
