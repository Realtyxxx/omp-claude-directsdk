/**
 * Gzip for the relay's upstream request body.
 *
 * The native CLI gzips large Messages bodies only when it talks to
 * api.anthropic.com itself, so a body routed through the loopback relay always
 * arrives as plain JSON. The relay compresses on the public leg instead, after
 * the breakpoint edit, so cache-breakpoint.ts and the debug dump keep seeing
 * JSON. The policy mirrors the CLI's default path: gzip at the zlib default
 * level for bodies of at least 4096 bytes, and a plain resend plus a
 * process-wide latch when the upstream answers that it could not parse the
 * body.
 *
 * `CLAUDE_DIRECTSDK_GZIP=0` disables it.
 */

import { gzipSync } from "node:zlib";
import type { IncomingHttpHeaders } from "node:http";

/** Smallest body worth compressing, matching the CLI's threshold. */
export const GZIP_MIN_BYTES = 4096;

/** Statuses the API uses for a body it could not decode. */
const REJECTION_STATUSES = new Set([400, 403, 415]);

const BAD_JSON_MESSAGES = [
  "The request body is not valid JSON",
  "Failed to parse request: could not parse request body as JSON",
];
const BAD_JSON_REASON =
  /^bad json: (?:invalid character |unexpected EOF$|unexpected end of JSON input$|EOF$)/;

/** Set once the upstream refuses a gzip body; later requests in this process go plain. */
let latchedOff = false;

export function gzipLatched(): boolean {
  return latchedOff;
}

export function latchGzipOff(): void {
  latchedOff = true;
}

/** Test hook: clear the process latch. */
export function resetGzipLatch(): void {
  latchedOff = false;
}

export function gzipEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env["CLAUDE_DIRECTSDK_GZIP"];
  return value === undefined || !["0", "false", "no", "off"].includes(value.toLowerCase());
}

export type GzipPlan =
  | { gzip: true; payload: Buffer; plainBytes: number }
  | { gzip: false; payload: Buffer; plainBytes: number; reason: string };

/**
 * Decide the wire form of an upstream body. `eligibleHost` is true only for
 * the real Anthropic upstream (or explicit test mode).
 */
export function planGzip(
  body: Buffer,
  headers: IncomingHttpHeaders,
  eligibleHost: boolean,
  env: NodeJS.ProcessEnv,
): GzipPlan {
  const plain = (reason: string): GzipPlan => ({
    gzip: false,
    payload: body,
    plainBytes: body.length,
    reason,
  });
  if (!gzipEnabled(env)) return plain("env_off");
  if (!eligibleHost) return plain("host");
  const encoding = headers["content-encoding"];
  if (encoding !== undefined && encoding !== "identity") return plain("already_encoded");
  if (body.length < GZIP_MIN_BYTES) return plain("below_min_size");
  if (latchedOff) return plain("latched_off");
  return { gzip: true, payload: gzipSync(body), plainBytes: body.length };
}

/** True when the response provably came from Anthropic rather than a proxy. */
function fromAnthropic(headers: IncomingHttpHeaders): boolean {
  const requestId = headers["request-id"];
  return (
    (typeof requestId === "string" && requestId.startsWith("req_")) ||
    headers["cf-ray"] !== undefined
  );
}

function isBadJsonText(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return BAD_JSON_REASON.test(text.trimEnd());
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const record = parsed as Record<string, unknown>;
  const error = record["error"];
  if (typeof error === "object" && error !== null) {
    const message = (error as Record<string, unknown>)["message"];
    if (typeof message === "string") {
      return BAD_JSON_MESSAGES.some((prefix) => message.startsWith(prefix));
    }
  }
  return (
    record["reason"] === "bad_json" &&
    typeof error === "string" &&
    BAD_JSON_REASON.test(error)
  );
}

/** Statuses whose body must be inspected before the response reaches the child. */
export function mayBeGzipRejection(status: number): boolean {
  return REJECTION_STATUSES.has(status);
}

/** True when an upstream answer means the gzip body itself was refused. */
export function isGzipRejection(
  status: number,
  headers: IncomingHttpHeaders,
  body: Buffer,
): boolean {
  return (
    REJECTION_STATUSES.has(status) &&
    fromAnthropic(headers) &&
    isBadJsonText(body.toString("utf-8"))
  );
}
