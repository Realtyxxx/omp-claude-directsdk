/**
 * Subscription access probe for legacy models.
 *
 * The official docs say which legacy models the API still serves, not which
 * ones a Claude subscription login may use, and the CLI picker lists only the
 * current lineup. The only reliable check is one minimal request on the exact
 * native route the provider would use, through the same relay and login as a
 * real call (about 300 input tokens). Results are cached on disk so a catalog
 * refresh rarely sends one.
 *
 * A probe passes only when the requested model itself answered: retired IDs
 * can be served silently by a newer model, which is not access to the old one.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Api, Context, Model } from "@oh-my-pi/pi-ai";
import { PROVIDER_ID } from "./models.js";
import { qualifiedCliAsync, resolveClaude, runCli } from "./setup.js";
import type { ChatModel } from "./web-catalog.js";

const OK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UNAVAILABLE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const STANDARD_CONTEXT = 200_000;

export type ProbeStatus = "ok" | "unavailable" | "long-context-unavailable" | "inconclusive";

export interface ProbeOutcome {
  status: ProbeStatus;
  detail: string;
}

interface CacheEntry extends ProbeOutcome {
  checkedAt: number;
}

/** Probe one native route; injectable for tests. */
export type RouteProbe = (route: string, timeoutMs: number) => Promise<ProbeOutcome>;

export function probeCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return env["CLAUDE_DIRECTSDK_PROBE_CACHE"] || join(homedir(), ".cache", "omp-claude-directsdk", "model-probes.json");
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * Opaque identity of the login a probe runs as, or undefined when it cannot
 * be read. Access differs per account, so the cache is partitioned by it:
 * `auth status` names the account and config directory, and an OAuth token
 * from the environment is folded in by hash because it may override both.
 */
export async function probeAccount(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const resolved = resolveClaude(undefined, env);
  if (!resolved) return undefined;
  let status: Record<string, unknown>;
  try {
    status = JSON.parse(await runCli(resolved, ["auth", "status"], env, 5_000)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (status["loggedIn"] !== true) return undefined;
  const token = env["CLAUDE_CODE_OAUTH_TOKEN"];
  const parts = [status["configDirectory"], status["authMethod"], status["email"], status["orgId"], token ? sha256(token) : ""];
  return sha256(JSON.stringify(parts)).slice(0, 32);
}

function readCache(path: string): Record<string, CacheEntry> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, CacheEntry>) : {};
  } catch {
    return {};
  }
}

function writeCacheEntry(path: string, key: string, outcome: ProbeOutcome): void {
  if (outcome.status === "inconclusive") return;
  try {
    // Re-read so concurrent probes do not drop each other's entries.
    const cache = Object.fromEntries(Object.entries(readCache(path)).filter(([, entry]) => fresh(entry)));
    cache[key] = { ...outcome, checkedAt: Date.now() };
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(cache, null, 2), { mode: 0o600 });
    renameSync(temp, path);
  } catch {
    // A missing cache only costs a repeat probe.
  }
}

function fresh(entry: CacheEntry | undefined): entry is CacheEntry {
  if (!entry || typeof entry.checkedAt !== "number") return false;
  const ttl = entry.status === "ok" ? OK_TTL_MS : UNAVAILABLE_TTL_MS;
  return Date.now() - entry.checkedAt < ttl;
}

const base = (route: string): string => route.replace(/\[1m\]$/, "");

/** Map one finished probe call to an access verdict. */
export function classifyProbe(
  route: string,
  result: { stopReason: string; errorMessage?: string | undefined; upstreamModel?: string | undefined },
): ProbeOutcome {
  if (result.stopReason === "stop" || result.stopReason === "length") {
    const served = result.upstreamModel ? base(result.upstreamModel) : base(route);
    return served === base(route)
      ? { status: "ok", detail: "answered" }
      : { status: "unavailable", detail: `retired: served by ${served}` };
  }
  const message = result.errorMessage ?? "";
  const status = Number(/status (\d{3})/.exec(message)?.[1]);
  const said = /upstream said: (.*)$/.exec(message)?.[1]?.slice(0, 200) ?? message.slice(0, 200);
  if (route.endsWith("[1m]") && /long context|usage credits/i.test(message)) {
    return { status: "long-context-unavailable", detail: said };
  }
  if (status === 404 || status === 403 || (status === 400 && /model/i.test(message))) {
    return { status: "unavailable", detail: `HTTP ${status}: ${said}` };
  }
  return { status: "inconclusive", detail: said || result.stopReason };
}

/** Default probe: one real request through the provider's own call path. */
export const probeRoute: RouteProbe = async (route, timeoutMs) => {
  const { defaultDeps, streamClaudeDirectSdk } = await import("./stream.js");
  // The request path checks the CLI version synchronously; doing that here
  // would stall the event loop and with it the catalog deadline.
  const resolved = resolveClaude(undefined, process.env);
  const qualified = resolved ? await qualifiedCliAsync(resolved, process.env) : false;
  const model = {
    id: route, name: route, api: PROVIDER_ID, provider: PROVIDER_ID, baseUrl: "process://claude-directsdk",
    reasoning: false, input: ["text"], contextWindow: 0, maxTokens: 64,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as unknown as Model<Api>;
  const context = {
    systemPrompt: ["Reply with the single word OK."],
    messages: [{ role: "user", content: "OK?", timestamp: Date.now() }],
    tools: [],
  } as unknown as Context;
  const message = await streamClaudeDirectSdk(model, context, {
    maxTokens: 64,
    signal: AbortSignal.timeout(timeoutMs),
  }, { ...defaultDeps, checkCli: () => qualified }).result();
  return classifyProbe(route, message);
};

export interface ProbedModel {
  model?: ChatModel;
  /** Set when the model is left out, or kept with a reduced context window. */
  note?: string;
}

/**
 * Probe one legacy model on the route it would use. A 1M route refused for
 * lack of long-context credits falls back to the standard 200K route.
 * `account` comes from `probeAccount`; without one the cache is bypassed.
 */
export async function probeLegacyModel(
  model: ChatModel,
  account: string | undefined,
  probe: RouteProbe = probeRoute,
  timeoutMs = 25_000,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProbedModel> {
  const path = probeCachePath(env);
  const check = async (route: string): Promise<ProbeOutcome> => {
    const key = account ? `${account}::${route}` : undefined;
    const cached = key ? readCache(path)[key] : undefined;
    if (fresh(cached)) return cached;
    let outcome: ProbeOutcome;
    try {
      outcome = await probe(route, timeoutMs);
    } catch (error) {
      outcome = { status: "inconclusive", detail: error instanceof Error ? error.message : String(error) };
    }
    if (key) writeCacheEntry(path, key, outcome);
    return outcome;
  };
  const long = model.contextWindow >= 1_000_000;
  // The standard route is probed alongside the 1M one, so a fallback to it
  // still fits inside one catalog deadline.
  const standardProbe = long ? check(model.id) : undefined;
  const first = await check(long ? `${model.id}[1m]` : model.id);
  if (first.status === "ok") return { model };
  if (first.status === "long-context-unavailable") {
    const standard = await (standardProbe ?? check(model.id));
    if (standard.status === "ok") {
      const contextWindow = Math.min(model.contextWindow, STANDARD_CONTEXT);
      return {
        model: { ...model, contextWindow, name: model.name.replace(/\)$/, "; 200K, 1M needs usage credits)") },
        note: `${model.id}: 1M context needs usage credits (${first.detail}); listed with ${contextWindow} tokens`,
      };
    }
    return { note: `${model.id}: not available to this login (${standard.status}: ${standard.detail})` };
  }
  return {
    note: first.status === "inconclusive"
      ? `${model.id}: access probe inconclusive (${first.detail}); retried on the next refresh`
      : `${model.id}: not available to this login (${first.detail})`,
  };
}
