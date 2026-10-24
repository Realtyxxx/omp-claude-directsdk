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
/** Time kept back from the deadline for returning the catalog. */
const CATALOG_MARGIN_MS = 500;

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
      const started = Date.now();
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
        const remaining = CATALOG_DEADLINE_MS - CATALOG_MARGIN_MS - (Date.now() - started);
        const legacy = await legacyModels(result.legacy, remaining, report);
        return [...result.models, ...legacy].sort((a, b) => a.id.localeCompare(b.id));
      } catch (error) {
        const message = `Claude DirectSDK catalog refresh failed: ${error instanceof Error ? error.message : error}. No pinned fallback is used.`;
        report(message);
        throw new Error(message, { cause: error });
      }
    },
  };
}

/**
 * Legacy models that pass the subscription access probe. Probes keep running
 * past the catalog deadline and cache their verdict, so a model whose probe
 * is still out appears on the next refresh. `CLAUDE_DIRECTSDK_LEGACY_MODELS=0`
 * lists none and sends no probe.
 */
async function legacyModels(
  candidates: ChatModel[], remainingMs: number, report: (message: string) => void,
): Promise<ChatModel[]> {
  if (!candidates.length || process.env["CLAUDE_DIRECTSDK_LEGACY_MODELS"] === "0") return [];
  const { probeLegacyModel } = await import("./model-probe.js");
  const pending = new Set(candidates.map(model => model.id));
  const models: ChatModel[] = [];
  const notes: string[] = [];
  const probes = Promise.all(candidates.map(async candidate => {
    const outcome = await probeLegacyModel(candidate);
    pending.delete(candidate.id);
    if (outcome.model) models.push(outcome.model);
    if (outcome.note) notes.push(outcome.note);
  }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    probes,
    new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, remainingMs)); }),
  ]);
  clearTimeout(timer);
  for (const id of pending) notes.push(`${id}: access probe still running; listed on the next refresh if it passes`);
  if (notes.length) report(`Claude DirectSDK legacy models:\n${notes.sort().join("\n")}`);
  return [...models];
}

export function streamSimple(
  model: Model<Api>, context: Context, options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  return lazyStream(model, async () => {
    const { streamClaudeDirectSdk } = await import("./stream.js");
    return streamClaudeDirectSdk(model, context, options);
  });
}
