/**
 * Subscription usage for OMP's `/usage`.
 *
 * Reuses OMP's built-in Anthropic OAuth usage fetcher, feeding it the access
 * token the Claude CLI keeps in `~/.claude/.credentials.json`. The token is
 * only read, never refreshed or written: the CLI owns refresh.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeUsageProvider } from "@oh-my-pi/pi-ai";
import type { UsageFetchContext, UsageFetchParams, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai";
import { PROVIDER_ID } from "./models.js";

async function readCliAccessToken(): Promise<{ accessToken: string; expiresAt?: number } | null> {
  const dir = process.env["CLAUDE_CONFIG_DIR"] || join(homedir(), ".claude");
  try {
    const parsed = JSON.parse(await readFile(join(dir, ".credentials.json"), "utf8"));
    const oauth = parsed?.claudeAiOauth;
    if (typeof oauth?.accessToken !== "string" || !oauth.accessToken) return null;
    return {
      accessToken: oauth.accessToken,
      ...(typeof oauth.expiresAt === "number" ? { expiresAt: oauth.expiresAt } : {}),
    };
  } catch {
    return null;
  }
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
        credential: { type: "oauth", accessToken: token.accessToken, expiresAt: token.expiresAt },
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
