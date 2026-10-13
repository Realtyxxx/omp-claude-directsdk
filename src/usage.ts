/**
 * Subscription usage for OMP's `/usage`.
 *
 * Reuses OMP's built-in Anthropic OAuth usage fetcher, feeding it the access
 * token the Claude CLI keeps in `~/.claude/.credentials.json`, or on macOS in
 * the login Keychain item `Claude Code-credentials`. The token is only read,
 * never refreshed or written: the CLI owns refresh.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { claudeUsageProvider } from "@oh-my-pi/pi-ai";
import type { UsageFetchContext, UsageFetchParams, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai";
import { PROVIDER_ID } from "./models.js";

const execFileAsync = promisify(execFile);

/** Keychain service the Claude CLI uses for the default config directory. */
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const KEYCHAIN_TIMEOUT_MS = 5_000;

interface CliAccessToken {
  accessToken: string;
  expiresAt?: number;
}

function parseCredentials(text: string): CliAccessToken | null {
  try {
    const oauth = JSON.parse(text)?.claudeAiOauth;
    if (typeof oauth?.accessToken !== "string" || !oauth.accessToken) return null;
    return {
      accessToken: oauth.accessToken,
      ...(typeof oauth.expiresAt === "number" ? { expiresAt: oauth.expiresAt } : {}),
    };
  } catch {
    return null;
  }
}

async function readCredentialsFile(dir: string): Promise<CliAccessToken | null> {
  try {
    return parseCredentials(await readFile(join(dir, ".credentials.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * On macOS the CLI stores its login in the Keychain instead of a file. Only the
 * default config directory maps to this service name; a custom
 * `CLAUDE_CONFIG_DIR` uses a derived name and is not looked up here.
 */
async function readKeychain(): Promise<CliAccessToken | null> {
  if (process.platform !== "darwin" || process.env["CLAUDE_CONFIG_DIR"]) return null;
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { timeout: KEYCHAIN_TIMEOUT_MS },
    );
    return parseCredentials(stdout);
  } catch {
    return null;
  }
}

async function readCliAccessToken(): Promise<CliAccessToken | null> {
  const dir = process.env["CLAUDE_CONFIG_DIR"] || join(homedir(), ".claude");
  return (await readCredentialsFile(dir)) ?? (await readKeychain());
}

export const claudeDirectSdkUsage: UsageProvider = {
  id: PROVIDER_ID as UsageProvider["id"],
  async fetchUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
    const token = await readCliAccessToken();
    // Expired token: skip instead of failing; the next CLI run refreshes it.
    if (!token || (token.expiresAt !== undefined && token.expiresAt <= Date.now())) return null;
    const report = await claudeUsageProvider.fetchUsage(
      {
        provider: "anthropic",
        credential: {
          type: "oauth",
          accessToken: token.accessToken,
          ...(token.expiresAt !== undefined ? { expiresAt: token.expiresAt } : {}),
        },
        ...(params.signal ? { signal: params.signal } : {}),
      },
      ctx,
    );
    if (!report) return null;
    return {
      ...report,
      provider: PROVIDER_ID,
      limits: report.limits.map(limit => ({ ...limit, scope: { ...limit.scope, provider: PROVIDER_ID } })),
    };
  },
};
