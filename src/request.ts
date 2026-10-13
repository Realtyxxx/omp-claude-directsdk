/**
 * Native request assembly: tool manifest, request body, child argv and
 * environment, and per-request private files.
 *
 * The current system prompt and tool schemas travel through private files
 * (system prompt file plus a settings file carrying `CLAUDE_CODE_EXTRA_BODY`)
 * to avoid OS argument and environment-string limits. Authentication and
 * identity headers are never replaced; the relay preserves them.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Effort, Tool, ToolChoice } from "@oh-my-pi/pi-ai";
import { isRecord } from "./types.js";
import { INERT_MCP_SOURCE } from "./inert-mcp.js";

/** MCP server name in the native child. Tool names are `mcp__pi__<name>`. */
export const MCP_SERVER_NAME = "pi";
export const TOOL_NAME_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/** Explicit test-mode bypass for the subscription env guard. Never set in production. */
export const TEST_UPSTREAM_ENV = "PI_DIRECTSDK_TEST_UPSTREAM";

const CONFLICTING_API_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_FOUNDRY_API_KEY",
] as const;

const CONFLICTING_BACKEND_VARS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

function isTruthy(value: string | undefined): boolean {
  return (
    value !== undefined &&
    !["", "0", "false", "no", "off"].includes(value.toLowerCase())
  );
}

/**
 * Markers a parent Claude Code session exports to its children. A child
 * `claude` that inherits them believes it is nested inside that session.
 */
const NESTED_SESSION_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_PLUGIN_DIRS",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_EFFORT",
  "CLAUDE_PID",
] as const;

export function isTestUpstream(env: NodeJS.ProcessEnv): boolean {
  return isTruthy(env[TEST_UPSTREAM_ENV]);
}

/**
 * Remove native auth/backend overrides from the child environment.
 *
 * OMP users routinely export `ANTHROPIC_API_KEY` or `ANTHROPIC_BASE_URL` for
 * OMP's own Anthropic provider. Upstream refuses the request when it sees
 * them; this port strips them from the child instead, so the child can only
 * authenticate through its own subscription login and never bills an API key.
 * Explicit test mode (`PI_DIRECTSDK_TEST_UPSTREAM=1`) keeps them for loopback
 * and gateway fixtures. Values are never read.
 */
export function stripConflictingEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of NESTED_SESSION_VARS) {
    delete out[name];
  }
  if (isTestUpstream(env)) {
    return out;
  }
  for (const name of [...CONFLICTING_API_VARS, ...CONFLICTING_BACKEND_VARS]) {
    delete out[name];
  }
  return out;
}

export function toolPrefixedName(bare: string): string {
  return `${TOOL_NAME_PREFIX}${bare}`;
}

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,50}$/;

/**
 * Native-safe name for an OMP tool. OMP MCP tools can exceed the 50-character
 * budget left after the `mcp__pi__` prefix or contain other characters; those
 * get a stable hash alias so history replay maps them identically every call.
 */
export function toolWireName(name: string): string {
  return TOOL_NAME_PATTERN.test(name)
    ? name
    : `pi_${createHash("sha256").update(name).digest("hex").slice(0, 24)}`;
}

/** Bare Pi tool name for a native tool name, or null when foreign. */
export function toolBareName(native: string): string | null {
  return native.startsWith(TOOL_NAME_PREFIX)
    ? native.slice(TOOL_NAME_PREFIX.length)
    : null;
}

const BANNED_TOP_LEVEL = ["oneOf", "allOf", "anyOf"] as const;

/**
 * Normalize a Pi tool schema for the native validator, which rejects
 * top-level combinators. Nested unions stay untouched. Best-effort mirror of
 * the reference implementation; re-verify against the qualified CLI.
 */
export function normalizeInputSchema(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) {
    throw new Error("Tool schema must be an object");
  }
  const out: Record<string, unknown> = { ...schema };
  if (Array.isArray(out["type"])) {
    const rest = (out["type"] as unknown[]).filter((t) => t !== "null");
    if (rest.length === 1) {
      out["type"] = rest[0];
    } else if (rest.length === 0) {
      delete out["type"];
    } else {
      out["type"] = rest;
    }
  }
  for (const key of BANNED_TOP_LEVEL) {
    delete out[key];
  }
  if (out["type"] === undefined) {
    out["type"] = "object";
  }
  if (out["type"] === "object" && !isRecord(out["properties"])) {
    out["properties"] = {};
  }
  return out;
}

export interface ManifestEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface RequestBuild {
  /** `CLAUDE_CODE_EXTRA_BODY` object. */
  body: Record<string, unknown>;
  /** Inert MCP manifest; same shape as the body tools. */
  manifest: ManifestEntry[];
  /** Bare Pi tool names in order. */
  toolNames: string[];
  /** Native wire name (without the MCP prefix) to OMP tool name. */
  wireToName: Map<string, string>;
}

/** Native effort levels Claude Code accepts in `output_config.effort`. */
export const NATIVE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * Build the native request body and the inert MCP manifest from Pi tools.
 * Throws on anything the native transport cannot express.
 */
export function buildRequestBody(options: {
  tools: Tool[];
  toolChoice?: ToolChoice | undefined;
  reasoning?: Effort | undefined;
  disableReasoning?: boolean | undefined;
  /** Native effort levels the selected model supports; empty or absent sends none. */
  efforts?: readonly string[] | undefined;
  maxTokens?: number | undefined;
}): RequestBuild {
  const { tools } = options;
  if (options.toolChoice !== undefined && options.toolChoice !== "auto" && options.toolChoice !== "none") {
    throw new Error(
      `Only tool_choice auto and none are supported by the Claude CLI transport (got ${JSON.stringify(options.toolChoice)})`,
    );
  }
  const useTools = options.toolChoice !== "none";
  const manifest: ManifestEntry[] = [];
  const bodyTools: Array<Record<string, unknown>> = [];
  const toolNames: string[] = [];
  const wireToName = new Map<string, string>();
  const seen = new Set<string>();

  if (useTools) {
    for (const tool of tools) {
      const name = tool.name;
      // Provider-hosted tools (computer use) have no JSON-schema form here.
      if (tool.native) {
        continue;
      }
      if (typeof name !== "string" || !name) {
        throw new Error(`Tool names must be nonempty strings: ${String(name)}`);
      }
      if (seen.has(name)) {
        throw new Error(`Duplicate tool name: ${name}`);
      }
      seen.add(name);
      const wire = toolWireName(name);
      if (wireToName.has(wire)) {
        throw new Error(`Tool name alias collision: ${name}`);
      }
      wireToName.set(wire, name);
      if (typeof tool.description !== "string") {
        throw new Error(`Tool description must be a string: ${name}`);
      }
      const constrained = (tool as { constrainedSampling?: unknown }).constrainedSampling;
      if (constrained) {
        // Grammar variants are optional provider-specific encodings. Like
        // Pi's Anthropic adapter, use the tool's JSON schema when grammar
        // decoding is unavailable. Best-effort strict schemas also fall back
        // to normal tool calling; required strict schemas stay rejected.
        // Malformed native input still fails downstream in parseToolInput.
        const sampling = constrained as { type?: unknown; strict?: unknown };
        const bestEffort =
          sampling.type === "grammar" ||
          (sampling.type === "json_schema" && sampling.strict === "prefer");
        if (!bestEffort) {
          throw new Error(
            `Strict constrained sampling is unsupported by this transport: ${name}. ` +
            `Only grammar fallback and best-effort (strict "prefer") tools are accepted.`,
          );
        }
      }
      // JSON round-trip drops typebox symbols and undefined fields.
      const raw = tool.parameters === undefined ? { type: "object" } : tool.parameters;
      const schema = normalizeInputSchema(JSON.parse(JSON.stringify(raw)) as unknown);
      manifest.push({ name: wire, description: tool.description, inputSchema: schema });
      bodyTools.push({
        name: toolPrefixedName(wire),
        description: tool.description,
        input_schema: schema,
      });
      toolNames.push(name);
    }
  }

  const body: Record<string, unknown> = { tools: bodyTools };

  // An undefined reasoning keeps native defaults. Native Claude Code owns
  // thinking mode; only an effort the catalog verified for this model is sent.
  // OMP's `minimal` has no native counterpart and maps to `low`.
  if (options.reasoning !== undefined && !options.disableReasoning) {
    const wanted: string = options.reasoning === "minimal" ? "low" : options.reasoning;
    if (options.efforts?.includes(wanted)) {
      body["output_config"] = { effort: wanted };
    }
  }

  if (options.maxTokens !== undefined) {
    if (!Number.isInteger(options.maxTokens) || options.maxTokens < 1) {
      throw new Error("maxTokens must be a positive integer");
    }
    body["max_tokens"] = options.maxTokens;
  }
  // Subscription routes reject sampling controls, so temperature/top_p from
  // Pi options are intentionally dropped, never forwarded.
  return { body, manifest, toolNames, wireToName };
}



export interface RequestFiles {
  systemPath: string;
  settingsPath: string;
  toolsPath: string;
  mcpPath: string;
  mcpConfigJson: string;
}

/** Write per-request private files with owner-only permissions. */
export function writeRequestFiles(
  dir: string,
  files: { systemPrompt: string; body: Record<string, unknown>; manifest: ManifestEntry[] },
): RequestFiles {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const systemPath = `${dir}/system.md`;
  const settingsPath = `${dir}/settings.json`;
  const toolsPath = `${dir}/tools.json`;
  const mcpPath = `${dir}/inert-mcp.mjs`;
  writeFileSync(systemPath, files.systemPrompt, { encoding: "utf-8", mode: 0o600 });
  writeFileSync(
    settingsPath,
    JSON.stringify({ env: { CLAUDE_CODE_EXTRA_BODY: JSON.stringify(files.body) } }),
    { encoding: "utf-8", mode: 0o600 },
  );
  writeFileSync(toolsPath, JSON.stringify(files.manifest), {
    encoding: "utf-8",
    mode: 0o600,
  });
  writeFileSync(mcpPath, INERT_MCP_SOURCE, { encoding: "utf-8", mode: 0o600 });
  const runtime = mcpRuntime();
  const mcpConfigJson = JSON.stringify({
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: runtime.command,
        args: [mcpPath, toolsPath],
        ...(runtime.env ? { env: runtime.env } : {}),
      },
    },
  });
  return { systemPath, settingsPath, toolsPath, mcpPath, mcpConfigJson };
}

/**
 * Interpreter for the inert MCP script. OMP ships as a Bun single-file
 * executable, so `process.execPath` is the `omp` binary itself and would
 * treat the script path as an OMP argument. `BUN_BE_BUN=1` makes such a
 * binary behave as the embedded `bun` CLI. A plain Node or Bun host keeps
 * using its own executable. `CLAUDE_DIRECTSDK_MCP_RUNTIME` overrides both.
 */
export function mcpRuntime(): { command: string; env?: Record<string, string> } {
  const override = process.env["CLAUDE_DIRECTSDK_MCP_RUNTIME"];
  if (override) {
    return { command: override };
  }
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  return isBun ? { command: process.execPath, env: { BUN_BE_BUN: "1" } } : { command: process.execPath };
}

/**
 * Build the child argv. `--max-turns 1` is accepted by the qualified CLI
 * even though recent `--help` output hides it; the fake-upstream gate
 * re-verifies it on every CLI bump.
 */
export function buildArgv(options: {
  claudeBin: string;
  nativeModelId: string;
  files: RequestFiles;
}): { command: string; args: string[] } {
  const { claudeBin, nativeModelId, files } = options;
  const args = [
    "-p",
    "--model",
    nativeModelId,
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--tools",
    "",
    "--system-prompt-file",
    files.systemPath,
    "--settings",
    files.settingsPath,
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--max-turns",
    "1",
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
    "--mcp-config",
    files.mcpConfigJson,
  ];
  return { command: claudeBin, args };
}

const WINDOWS_ESSENTIALS = [
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
] as const;

/** Child environment: relay routing plus native isolation flags. */
export function buildChildEnv(options: {
  baseEnv: NodeJS.ProcessEnv;
  relayUrl: string;
  body: Record<string, unknown>;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = stripConflictingEnv(options.baseEnv);
  const config = env["CLAUDE_DIRECTSDK_CONFIG_DIR"];
  if (config) {
    env["CLAUDE_CONFIG_DIR"] = config;
  }
  delete env["CLAUDE_CODE_EXTRA_BODY"];
  env["ANTHROPIC_BASE_URL"] = options.relayUrl;
  env["ENABLE_TOOL_SEARCH"] = "false";
  env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1";
  env["CLAUDE_CODE_MAX_RETRIES"] = "0";
  env["DISABLE_AUTO_COMPACT"] = "1";
  env["DISABLE_COMPACT"] = "1";
  // Pi owns budgets; the native replayed reminder would invalidate cached history.
  env["CLAUDE_CODE_TOTAL_TOKENS_REMINDER"] = "off";
  const requestBody = options.body;
  const bodyMaxTokens: unknown = requestBody["max_tokens"];
  if (typeof bodyMaxTokens === "number") {
    env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = String(bodyMaxTokens);
  }
  if (process.platform === "win32") {
    const present = new Set(Object.keys(env).map((k) => k.toUpperCase()));
    for (const [key, value] of Object.entries(process.env)) {
      const name = key.toUpperCase() as (typeof WINDOWS_ESSENTIALS)[number];
      if (
        (WINDOWS_ESSENTIALS as readonly string[]).includes(name) &&
        !present.has(name) &&
        value !== undefined
      ) {
        env[key] = value;
      }
    }
  }
  return env;
}
