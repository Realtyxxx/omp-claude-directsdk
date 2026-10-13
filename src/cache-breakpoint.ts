/**
 * Place the native message-level cache breakpoints on stable history.
 *
 * The native child rewrites two parts of every request that OMP never keeps
 * in its transcript:
 *
 * - It prepends its account context block (`<system-reminder>` with the
 *   user email) to the message it is answering now, and it is absent once
 *   that message is replayed as history on the next request.
 * - From the second request on, it appends a volatile system message (the
 *   current date) and puts its only message-level `cache_control` there.
 *
 * So the next request's prefix diverges at the current query message, and no
 * cache entry ever exists before it: measured, every request read only the
 * system prompt and tools from cache and re-wrote the whole conversation.
 *
 * This edit moves the native marker to the last block before the current
 * query (the boundary the next request repeats byte for byte), and, when the
 * four-breakpoint budget allows, adds one at the previous request's same
 * boundary so the read hits exactly even when a turn adds more blocks than
 * the API's lookback window.
 *
 * Any body this cannot prove safe to edit (compressed, unparsable, no native
 * message marker, string or thinking target) passes unchanged.
 * `CLAUDE_DIRECTSDK_CACHE_RELOCATE=0` disables the edit.
 */
import type { IncomingHttpHeaders } from "node:http";
import { isRecord } from "./types.js";

/** Blocks the Messages API accepts `cache_control` on. */
const CACHEABLE_BLOCKS = new Set(["text", "image", "document", "tool_use", "tool_result"]);
const MAX_BREAKPOINTS = 4;

type Json = Record<string, unknown>;

export function relocationEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env["CLAUDE_DIRECTSDK_CACHE_RELOCATE"];
  return value === undefined || !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function blocksOf(message: unknown): Json[] {
  const content = isRecord(message) ? message["content"] : undefined;
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

function role(message: unknown): unknown {
  return isRecord(message) ? message["role"] : undefined;
}

/** Last block of a message when it can carry a breakpoint. */
function cacheableTail(message: unknown): Json | undefined {
  const content = isRecord(message) ? message["content"] : undefined;
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const block = content[content.length - 1];
  return isRecord(block) && typeof block["type"] === "string" && CACHEABLE_BLOCKS.has(block["type"])
    ? block
    : undefined;
}

export function relocateHistoryBreakpoint(body: Buffer, headers: IncomingHttpHeaders): Buffer {
  const encoding = headers["content-encoding"];
  if (encoding !== undefined && encoding !== "identity") return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return body;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["messages"])) return body;
  const messages = parsed["messages"] as unknown[];

  // The current query: the last non-system message.
  let query = messages.length - 1;
  while (query >= 0 && role(messages[query]) === "system") query -= 1;
  if (query < 1) return body;

  const marked = messages.flatMap(blocksOf).filter((block) => block["cache_control"] !== undefined);
  const marker = marked[0]?.["cache_control"];
  if (marker === undefined) return body;

  const boundary = cacheableTail(messages[query - 1]);
  if (!boundary) return body;

  for (const block of marked) delete block["cache_control"];
  boundary["cache_control"] = marker;

  // The previous request answered the user message before this query; its
  // stable boundary is the message right before that one.
  let previous = query - 1;
  while (previous >= 0 && role(messages[previous]) !== "user") previous -= 1;
  const earlier = previous >= 1 ? cacheableTail(messages[previous - 1]) : undefined;
  const systemMarks = Array.isArray(parsed["system"])
    ? (parsed["system"] as unknown[]).filter((block) => isRecord(block) && block["cache_control"] !== undefined).length
    : 0;
  const toolMarks = Array.isArray(parsed["tools"])
    ? (parsed["tools"] as unknown[]).filter((tool) => isRecord(tool) && tool["cache_control"] !== undefined).length
    : 0;
  if (earlier && earlier !== boundary && systemMarks + toolMarks + 2 <= MAX_BREAKPOINTS) {
    earlier["cache_control"] = marker;
  }
  return Buffer.from(JSON.stringify(parsed), "utf8");
}
