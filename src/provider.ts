/**
 * OMP provider registration.
 *
 * OMP's `registerProvider(name, config)` takes a custom `streamSimple` plus a
 * `fetchDynamicModels` factory whose result OMP keeps in its SQLite model
 * cache (24 h TTL). Registration itself does no CLI probe or network work;
 * OMP runs the factory after startup, and later starts reuse the cache.
 */
import type {
  Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { PROVIDER_ID } from "./models.js";
import { lazyStream } from "./lazy-stream.js";
import { claudeDirectSdkUsage } from "./usage.js";
import type { ChatModel } from "./web-catalog.js";

export { PROVIDER_ID };

/** OMP aborts a dynamic model fetch after 15 s; finish (or fail) first. */
const CATALOG_DEADLINE_MS = 12_000;

/**
 * Placeholder credential. OMP refuses to dispatch a provider without a
 * resolvable key; the Claude CLI login is the real authentication and this
 * value is never sent anywhere.
 */
const CLI_LOGIN_PLACEHOLDER = "claude-cli-login";

export function createProviderConfig(report: (message: string) => void) {
  return {
    api: PROVIDER_ID as Api,
    baseUrl: "process://claude-directsdk",
    apiKey: CLI_LOGIN_PLACEHOLDER,
    streamSimple,
    usage: claudeDirectSdkUsage,
    async fetchDynamicModels(): Promise<ChatModel[]> {
      const signal = AbortSignal.timeout(CATALOG_DEADLINE_MS);
      try {
        const [{ discoverModels }, { loadWebCatalog }] = await Promise.all([
          import("./discovery.js"), import("./web-catalog.js"),
        ]);
        const picker = await discoverModels(signal);
        const result = await loadWebCatalog(picker, signal);
        if (result.warnings.length) {
          report(`Claude DirectSDK excluded models with incomplete metadata:\n${result.warnings.join("\n")}`);
        }
        if (!result.models.length) throw new Error("No Claude models have complete, verified metadata");
        return result.models;
      } catch (error) {
        const message = `Claude DirectSDK catalog refresh failed: ${error instanceof Error ? error.message : error}. No pinned fallback is used.`;
        report(message);
        throw new Error(message, { cause: error });
      }
    },
  };
}

export function streamSimple(
  model: Model<Api>, context: Context, options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  return lazyStream(model, async () => {
    const { streamClaudeDirectSdk } = await import("./stream.js");
    return streamClaudeDirectSdk(model, context, options);
  });
}
