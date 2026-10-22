/**
 * Strip the native CLI's account context reminder from the forwarded body.
 *
 * The Claude CLI builds a user context (`userEmail`, `attachedProject`, ...)
 * from its login record and wraps it in a `<system-reminder>` that starts
 * "As you answer the user's questions, you can use the following context:"
 * (or "The session context ... replace the earlier ones:" when it changes).
 * It attaches that block to the message it is answering: a leading text block
 * on a user turn, or text appended to the latest `tool_result` in a tool loop.
 *
 * OMP owns the system prompt and transcript, so this block is foreign to it:
 * the model sees it as tool output it did not ask for (reported by users as a
 * recurring "userEmail" reminder), and it is absent once the message is
 * replayed as history. Removing it keeps the forwarded body equal to what OMP
 * sent plus the CLI's system prompt and date message.
 *
 * Any body this cannot parse, or a compressed body, passes unchanged.
 */
import type { IncomingHttpHeaders } from "node:http";
import { isRecord } from "./types.js";

type Json = Record<string, unknown>;

const NATIVE_CONTEXT =
  /\n*<system-reminder>\n(?:As you answer the user's questions, you can use the following context:|The session context (?:has changed|was re-read)[^\n]*)\n[\s\S]*?<\/system-reminder>\n?/g;

function stripText(text: string): string {
  return text.replace(NATIVE_CONTEXT, "");
}

/** Strip in place; returns true when anything changed. */
function stripBlocks(blocks: unknown[]): { blocks: unknown[]; changed: boolean } {
  let changed = false;
  let orphanMarker: unknown;
  const kept: unknown[] = [];
  for (const block of blocks) {
    if (!isRecord(block)) {
      kept.push(block);
      continue;
    }
    if (block["type"] === "text" && typeof block["text"] === "string") {
      const text = stripText(block["text"]);
      if (text !== block["text"]) {
        changed = true;
        if (text.trim() === "") {
          // Whole block was the reminder: drop it (the API rejects empty text).
          if (block["cache_control"] !== undefined) orphanMarker = block["cache_control"];
          continue;
        }
        block["text"] = text;
      }
    } else if (block["type"] === "tool_result") {
      if (stripToolResult(block)) changed = true;
    }
    kept.push(block);
  }
  if (orphanMarker !== undefined) {
    const tail = kept[kept.length - 1];
    if (isRecord(tail) && tail["cache_control"] === undefined) tail["cache_control"] = orphanMarker;
  }
  return { blocks: kept, changed };
}

function stripToolResult(block: Json): boolean {
  const content = block["content"];
  if (typeof content === "string") {
    const text = stripText(content);
    if (text === content) return false;
    block["content"] = text;
    return true;
  }
  if (Array.isArray(content)) {
    const result = stripBlocks(content);
    if (result.changed) block["content"] = result.blocks;
    return result.changed;
  }
  return false;
}

export function stripNativeContext(body: Buffer, headers: IncomingHttpHeaders): Buffer {
  const encoding = headers["content-encoding"];
  if (encoding !== undefined && encoding !== "identity") return body;
  if (!body.includes("<system-reminder>")) return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return body;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["messages"])) return body;

  let changed = false;
  for (const message of parsed["messages"] as unknown[]) {
    if (!isRecord(message) || message["role"] !== "user") continue;
    const content = message["content"];
    if (typeof content === "string") {
      const text = stripText(content);
      if (text !== content && text.trim() !== "") {
        message["content"] = text;
        changed = true;
      }
    } else if (Array.isArray(content)) {
      const result = stripBlocks(content);
      if (result.changed && result.blocks.length > 0) {
        message["content"] = result.blocks;
        changed = true;
      }
    }
  }
  return changed ? Buffer.from(JSON.stringify(parsed), "utf8") : body;
}
