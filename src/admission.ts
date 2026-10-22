/**
 * Request-scoped native HTTP admission relay.
 *
 * The relay binds an ephemeral loopback port with a random per-request route.
 * It forwards only the first upstream Messages request and rejects later
 * native recovery or retry attempts locally, so one Pi model call produces at
 * most one upstream request. Native authentication and identity headers pass
 * through memory; they are never logged or persisted.
 *
 * Only HTTP transfer and content encoding change (large bodies go upstream
 * gzipped, see request-gzip.ts). Request identity and payload stay native.
 */

import { IncomingMessage, Server, ServerResponse, createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { relocateHistoryBreakpoint, relocationEnabled } from "./cache-breakpoint.js";
import { stripNativeContext } from "./native-context.js";
import { isTestUpstream } from "./request.js";
import { describeProxy, openProxiedTls, resolveUpstreamProxy } from "./upstream-proxy.js";
import { isGzipRejection, latchGzipOff, mayBeGzipRejection, planGzip } from "./request-gzip.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { join } from "node:path";
import { NativeAssistantMessage, NativeUsage, deepClone, isRecord } from "./types.js";

const ERROR_BODY_CAP = 64 * 1024;
const REQUEST_BODY_CAP = 512 * 1024 * 1024;
const PROXY_TUNNEL_ATTEMPTS = 4;
const PROXY_RETRY_BASE_MS = 500;
const ANTHROPIC_HOST = "api.anthropic.com";

/** Relay failure marker for a request that carried non-subscription credentials. */
export const AUTH_REFUSED = "NON_SUBSCRIPTION_AUTH_REFUSED";

/** Claude subscription OAuth tokens (login or `claude setup-token`) use this prefix. */
const SUBSCRIPTION_BEARER = /^Bearer sk-ant-oat/;

/** True only for a request authenticated by a subscription OAuth bearer and nothing else. */
export function isSubscriptionAuth(headers: IncomingMessage["headers"]): boolean {
  if (headers["x-api-key"] !== undefined) return false;
  const auth = headers["authorization"];
  return typeof auth === "string" && SUBSCRIPTION_BEARER.test(auth);
}

/** Reconstructed upstream assistant message from the SSE stream. */
export class SseCapture {
  message: NativeAssistantMessage | null = null;
  complete = false;
  private pending = "";
  private decoder = new TextDecoder();
  private arguments: Map<number, string> = new Map();

  feed(chunk: Buffer): void {
    this.pending += this.decoder.decode(chunk, { stream: true });
    let index: number;
    while ((index = this.pending.search(/\r?\n\r?\n/)) !== -1) {
      const frame = this.pending.slice(0, index);
      const match = /\r?\n\r?\n/.exec(this.pending);
      this.pending = this.pending.slice(index + (match?.[0].length ?? 2));
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) {
        this.event(JSON.parse(data) as Record<string, unknown>);
      }
    }
  }

  private event(event: Record<string, unknown>): void {
    switch (event["type"]) {
      case "message_start":
        this.onStart(event);
        break;
      case "content_block_start":
        this.onBlockStart(event);
        break;
      case "content_block_delta":
        this.onBlockDelta(event);
        break;
      case "content_block_stop":
        this.onBlockStop(event);
        break;
      case "message_delta":
        this.onDelta(event);
        break;
      case "message_stop":
        this.onStop();
        break;
      default:
        break;
    }
  }

  private onStart(event: Record<string, unknown>): void {
    this.message = deepClone(event["message"] as NativeAssistantMessage);
  }

  private onBlockStart(event: Record<string, unknown>): void {
    if (!this.message) {
      return;
    }
    this.message.content.push(
      deepClone(event["content_block"] as NativeAssistantMessage["content"][number]),
    );
  }

  private onBlockDelta(event: Record<string, unknown>): void {
    if (!this.message) {
      return;
    }
    const delta = event["delta"] as Record<string, unknown>;
    const index = event["index"] as number;
    const block = this.message.content[index] as Record<string, unknown> | undefined;
    if (!block || !isRecord(delta)) {
      return;
    }
    const field =
      delta["type"] === "text_delta"
        ? "text"
        : delta["type"] === "thinking_delta"
          ? "thinking"
          : delta["type"] === "signature_delta"
            ? "signature"
            : undefined;
    if (field) {
      block[field] = `${block[field] ?? ""}${delta[field] ?? ""}`;
    } else if (delta["type"] === "input_json_delta") {
      const prev = this.arguments.get(index) ?? "";
      this.arguments.set(index, prev + String(delta["partial_json"] ?? ""));
    } else if (delta["type"] === "citations_delta") {
      const citations = Array.isArray(block["citations"])
        ? (block["citations"] as unknown[])
        : [];
      citations.push(deepClone(delta["citation"]));
      block["citations"] = citations;
    }
  }

  private onBlockStop(event: Record<string, unknown>): void {
    if (!this.message) {
      return;
    }
    const index = event["index"] as number;
    const raw = this.arguments.get(index);
    if (raw !== undefined) {
      this.arguments.delete(index);
      const block = this.message.content[index] as Record<string, unknown>;
      // A no-argument tool call streams one input_json_delta with empty partial_json.
      block["input"] = raw.trim() ? JSON.parse(raw) : {};
    }
  }

  private onDelta(event: Record<string, unknown>): void {
    if (!this.message) {
      return;
    }
    const delta = event["delta"];
    if (isRecord(delta)) {
      Object.assign(this.message, deepClone(delta));
    }
    const usage = event["usage"];
    if (isRecord(usage) && isRecord(this.message.usage)) {
      Object.assign(this.message.usage, deepClone(usage));
    }
  }

  private onStop(): void {
    this.complete = Boolean(
      this.message?.stop_reason && this.arguments.size === 0,
    );
  }
}

export interface UpstreamTarget {
  scheme: "https:" | "http:";
  host: string;
  port: number;
  path: string;
}

/** Parse and validate the upstream. HTTP is allowed only for loopback fixtures. */
export function parseUpstream(raw: string): UpstreamTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid native upstream URL: ${raw}`);
  }
  const host = url.hostname.toLowerCase();
  const loopback =
    host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    !host ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Native upstream must be HTTPS or a loopback HTTP fixture",
    );
  }
  return {
    scheme: url.protocol as "https:" | "http:",
    host: url.hostname,
    port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
    path: url.pathname.replace(/\/$/, ""),
  };
}

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "proxy-authorization",
  "proxy-connection",
  "accept-encoding",
]);

export class AdmissionRelay {
  readonly url: string;
  readonly ready: Promise<void>;
  used = false;
  denied = 0;
  status: number | null = null;
  requestId: string | null = null;
  failure: string | null = null;
  capture = new SseCapture();
  errorBody = Buffer.alloc(0);
  /** Wire form of the admitted upstream body, set once it is sent. */
  gzip: RelayGzip | null = null;
  /** Fired when the admitted upstream response headers arrive. */
  onUpstreamResponse: ((status: number, headers: Record<string, string>) => void) | null = null;

  private server: Server;
  private readonly target: UpstreamTarget;
  private readonly timeoutMs: number;
  private readonly route: string;
  private cancelled = false;
  private sockets = new Set<Socket>();
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;

  private constructor(target: UpstreamTarget, timeoutMs: number) {
    this.target = target;
    this.timeoutMs = timeoutMs;
    this.route = `/admit/${randomBytes(32).toString("base64url")}`;
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server.on("connection", (socket) => {
      this.track(socket);
    });
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.server.once("error", (error) => this.rejectReady(error as Error));
    this.server.listen(0, "127.0.0.1", () => {
      const address = this.server.address();
      if (address === null || typeof address === "string") {
        this.rejectReady(new Error("Admission relay failed to bind"));
        return;
      }
      this.resolveReady();
    });
    // The relay must never keep the Pi process alive on its own.
    this.server.unref();
    this.url = "";
  }

  /** Bind the relay and resolve its URL. */
  static async create(
    upstream: string,
    timeoutMs: number,
  ): Promise<AdmissionRelay> {
    const relay = new AdmissionRelay(parseUpstream(upstream), timeoutMs);
    await relay.ready;
    const address = relay.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Admission relay failed to bind");
    }
    (relay as { url: string }).url =
      `http://127.0.0.1:${address.port}${relay.route}`;
    return relay;
  }

  /** The upstream's own message for a non-200 answer, "" when none was captured. */
  errorText(): string {
    const text = this.errorBody.toString("utf-8");
    try {
      const message = (JSON.parse(text) as Record<string, unknown>)["error"] as Record<
        string,
        unknown
      >;
      return typeof message?.["message"] === "string" ? message["message"] : text;
    } catch {
      return text;
    }
  }

  abort(): void {
    this.cancelled = true;
    for (const socket of this.sockets) {
      try {
        socket.destroy();
      } catch {
        // Peer may have closed between the read and cancellation.
      }
    }
  }

  close(): Promise<void> {
    this.abort();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private track(socket: Socket): void {
    this.sockets.add(socket);
    socket.on("close", () => {
      this.sockets.delete(socket);
    });
  }

  /**
   * OMP port: the relay forwards only subscription OAuth requests. An API key
   * (`x-api-key`) or any other bearer never reaches upstream, even if one
   * leaks into the child environment past stripConflictingEnv. Explicit test
   * mode keeps fixture credentials working.
   */
  private refuseNonSubscriptionAuth(req: IncomingMessage, res: ServerResponse): boolean {
    if (isTestUpstream(process.env) || isSubscriptionAuth(req.headers)) return false;
    req.resume();
    this.failure = AUTH_REFUSED;
    const body = Buffer.from(
      `{"type":"error","error":{"type":"authentication_error","message":"${AUTH_REFUSED}"}}`,
    );
    res.writeHead(401, {
      "Content-Type": "application/json",
      "Content-Length": body.length,
      Connection: "close",
    });
    res.end(body);
    return true;
  }

  private deny(res: ServerResponse): void {
    this.denied += 1;
    const body = Buffer.from(
      '{"type":"error","error":{"type":"invalid_request_error","message":"PI_MODEL_ADMISSION_CONSUMED"}}',
    );
    res.writeHead(400, {
      "Content-Type": "application/json",
      "Content-Length": body.length,
      Connection: "close",
    });
    res.end(body);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let path = "";
    try {
      path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      res.writeHead(404, { Connection: "close" });
      res.end();
      return;
    }
    // The check-and-set below runs synchronously before any await, so it is
    // atomic on the Node event loop: exactly one request is admitted.
    if (
      req.method !== "POST" ||
      !safeEqualPath(path, `${this.route}/v1/messages`) ||
      req.headers["origin"] !== undefined ||
      this.cancelled ||
      this.used
    ) {
      if (
        req.method === "POST" &&
        safeEqualPath(path, `${this.route}/v1/messages`) &&
        req.headers["origin"] === undefined &&
        (this.cancelled || this.used)
      ) {
        // Drain the body so the child sees a clean denial.
        req.resume();
        this.deny(res);
        return;
      }
      req.resume();
      res.writeHead(404, { Connection: "close" });
      res.end();
      return;
    }
    this.used = true;
    this.track(req.socket);
    if (this.refuseNonSubscriptionAuth(req, res)) {
      return;
    }

    let body: Buffer;
    try {
      body = await readBody(req, REQUEST_BODY_CAP);
    } catch (error) {
      this.failure = error instanceof Error ? error.name : String(error);
      res.writeHead(400, { Connection: "close" });
      res.end();
      return;
    }
    // OMP port: the only edits to the native body. See native-context.ts and
    // cache-breakpoint.ts.
    body = stripNativeContext(body, req.headers);
    if (relocationEnabled(process.env)) {
      body = relocateHistoryBreakpoint(body, req.headers);
    }
    // Debug aid for prompt-cache analysis: the forwarded body only, never headers.
    const dumpDir = process.env["CLAUDE_DIRECTSDK_DEBUG_DUMP_DIR"];
    if (dumpDir) {
      try {
        mkdirSync(dumpDir, { recursive: true, mode: 0o700 });
        writeFileSync(join(dumpDir, `body-${Date.now()}-${process.pid}.json`), body, { mode: 0o600 });
      } catch {
        // Diagnostics must never affect the request.
      }
    }

    try {
      await this.forward(req, res, body);
      if (dumpDir && this.gzip) {
        try {
          writeFileSync(
            join(dumpDir, `wire-${Date.now()}-${process.pid}.json`),
            JSON.stringify({ ...this.gzip, status: this.status }),
            { mode: 0o600 },
          );
        } catch {
          // Diagnostics must never affect the request.
        }
      }
    } catch (error) {
      // Keep a specific diagnosis (proxy tunnel failure) set by forward().
      this.failure ??= error instanceof Error ? error.name : String(error);
      if (!res.headersSent) {
        res.writeHead(502, { Connection: "close" });
      }
      try {
        res.end();
      } catch {
        // Child is gone; the failure field carries the diagnosis.
      }
    } finally {
      this.sockets.delete(req.socket);
    }
  }

  private async forward(
    req: IncomingMessage,
    res: ServerResponse,
    body: Buffer,
  ): Promise<void> {
    // OMP port: gzip the public leg. The native child never compresses a body
    // bound for the loopback relay. See request-gzip.ts.
    const eligibleHost =
      (this.target.scheme === "https:" && this.target.host === ANTHROPIC_HOST) ||
      isTestUpstream(process.env);
    const plan = planGzip(body, req.headers, eligibleHost, process.env);
    this.gzip = plan.gzip
      ? { encoding: "gzip", plainBytes: plan.plainBytes, wireBytes: plan.payload.length }
      : { encoding: "identity", plainBytes: plan.plainBytes, wireBytes: plan.plainBytes, reason: plan.reason };
    if (plan.gzip) {
      const outcome = await this.send(req, res, plan.payload, true);
      if (outcome === "done") return;
      // The upstream could not decode the gzip body and ran nothing. Resend
      // it plain once and keep this process on plain bodies.
      latchGzipOff();
      this.gzip = { ...this.gzip, encoding: "identity", wireBytes: body.length, fellBack: true };
      this.status = null;
      this.requestId = null;
      this.errorBody = Buffer.alloc(0);
    }
    await this.send(req, res, body, false);
  }

  private async send(
    req: IncomingMessage,
    res: ServerResponse,
    body: Buffer,
    gzip: boolean,
  ): Promise<"done" | "gzip_rejected"> {
    // OMP port: node:https ignores proxy variables, so tunnel explicitly when
    // the user's environment routes HTTPS through a proxy.
    const proxy =
      this.target.scheme === "https:"
        ? resolveUpstreamProxy(this.target.host, process.env)
        : undefined;
    let tunnel: Socket | undefined;
    if (proxy) {
      // Some proxy nodes drop new tunnels in bursts, e.g. when /btw opens a
      // second connection beside the main turn. Nothing has been sent
      // upstream yet, so retrying the tunnel is safe.
      for (let attempt = 1; ; attempt++) {
        try {
          tunnel = await openProxiedTls(proxy, this.target.host, this.target.port, this.timeoutMs);
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (attempt >= PROXY_TUNNEL_ATTEMPTS || req.socket.destroyed) {
            this.failure = `proxy ${describeProxy(proxy)}: ${message} (after ${attempt} attempts)`;
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, PROXY_RETRY_BASE_MS * 2 ** (attempt - 1)));
        }
      }
      this.track(tunnel);
    }
    return new Promise<"done" | "gzip_rejected">((resolve, reject) => {
      const headers: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) {
          continue;
        }
        headers[key] = value;
      }
      headers["accept-encoding"] = "identity";
      if (gzip) {
        headers["content-encoding"] = "gzip";
      }
      const send =
        this.target.scheme === "https:" ? httpsRequest : httpRequest;
      const options: RequestOptions = {
        host: this.target.host,
        port: this.target.port,
        path: `${this.target.path}/v1/messages`,
        method: "POST",
        headers: { ...headers, "content-length": body.length },
        timeout: this.timeoutMs,
      };
      if (tunnel) {
        const socket = tunnel;
        options.createConnection = () => socket;
      }
      const upstream = send(
        options,
        (upstreamRes) => {
          this.status = upstreamRes.statusCode ?? null;
          this.requestId =
            (upstreamRes.headers["request-id"] as string | undefined) ??
            (upstreamRes.headers["x-request-id"] as string | undefined) ??
            null;
          const passthrough: Record<string, string | string[]> = {};
          for (const [key, value] of Object.entries(upstreamRes.headers)) {
            if (
              value === undefined ||
              ["connection", "transfer-encoding", "server", "date"].includes(
                key.toLowerCase(),
              )
            ) {
              continue;
            }
            passthrough[key] = value;
          }
          if (gzip && mayBeGzipRejection(this.status ?? 0)) {
            // Hold a possible gzip refusal back from the child until the
            // body shows whether a plain resend is due.
            const chunks: Buffer[] = [];
            upstreamRes.on("data", (chunk: Buffer) => {
              chunks.push(chunk);
            });
            upstreamRes.on("end", () => {
              const held = Buffer.concat(chunks);
              const errorBody = held.subarray(0, ERROR_BODY_CAP);
              if (isGzipRejection(this.status ?? 0, upstreamRes.headers, errorBody)) {
                resolve("gzip_rejected");
                return;
              }
              this.errorBody = errorBody;
              try {
                this.onUpstreamResponse?.(this.status ?? 502, flatten(passthrough));
                res.writeHead(this.status ?? 502, passthrough);
                res.end(held);
              } catch {
                // Child went away; errorBody still holds the diagnosis.
              }
              resolve("done");
            });
            upstreamRes.on("error", reject);
            return;
          }
          try {
            this.onUpstreamResponse?.(this.status ?? 502, flatten(passthrough));
            res.writeHead(this.status ?? 502, passthrough);
          } catch (error) {
            upstreamRes.destroy();
            reject(error);
            return;
          }
          upstreamRes.on("data", (chunk: Buffer) => {
            if (this.status === 200) {
              try {
                this.capture.feed(chunk);
              } catch (error) {
                this.failure =
                  error instanceof Error ? error.name : String(error);
              }
            } else if (this.errorBody.length < ERROR_BODY_CAP) {
              // Bounded: keeps the rejection reason, never the whole stream.
              this.errorBody = Buffer.concat([
                this.errorBody,
                chunk.subarray(0, ERROR_BODY_CAP - this.errorBody.length),
              ]);
            }
            if (!res.write(chunk)) {
              upstreamRes.pause();
              res.once("drain", () => upstreamRes.resume());
            }
          });
          upstreamRes.on("end", () => {
            try {
              res.end();
            } catch {
              // Child went away; capture still holds the diagnosis.
            }
            resolve("done");
          });
          upstreamRes.on("error", reject);
        },
      );
      upstream.on("socket", (socket: Socket) => {
        this.track(socket);
      });
      upstream.on("timeout", () => {
        upstream.destroy(new Error("Upstream request timed out"));
      });
      upstream.on("error", reject);
      req.on("aborted", () => {
        upstream.destroy();
      });
      res.on("close", () => {
        upstream.destroy();
      });
      upstream.end(body);
    });
  }
}

/** Wire form of the upstream body; sizes are bytes. */
export interface RelayGzip {
  encoding: "gzip" | "identity";
  plainBytes: number;
  wireBytes: number;
  /** Why the body went plain, when it did on the first attempt. */
  reason?: string;
  /** The upstream refused the gzip body and the relay resent it plain. */
  fellBack?: boolean;
}

function flatten(headers: Record<string, string | string[]>): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    flat[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return flat;
}

function readBody(req: IncomingMessage, cap: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > cap) {
        reject(new Error("Request body exceeds relay cap"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function safeEqualPath(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export type { NativeUsage };
