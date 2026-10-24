/** Public Anthropic metadata. A changed or incomplete source fails closed. */
import type { Effort } from "@oh-my-pi/pi-ai";
import type { DiscoveredModel } from "./discovery.js";
import { PROVIDER_ID } from "./models.js";

const ROOT = "https://platform.claude.com/docs/en";
const OVERVIEW = `${ROOT}/about-claude/models/overview.md`;
const PRICING = `${ROOT}/about-claude/pricing.md`;
const EFFORT = `${ROOT}/build-with-claude/effort.md`;
const LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

interface Rates { input: number; output: number; cacheRead: number; cacheWrite: number }
type ThinkingLevelMap = Record<"off" | Effort, string | null>;

/**
 * One catalog row in OMP's `registerProvider` model shape. OMP's model config
 * carries a flat price, so long-context pricing tiers are validated but only
 * the base rates are kept; OMP reports the cost as an estimate either way.
 */
export interface ChatModel {
  id: string;
  name: string;
  api: string;
  reasoning: boolean;
  thinking?: { mode: "effort"; efforts: Effort[] };
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  cost: Rates;
}
/**
 * `legacy` holds still-available legacy models that neither the current
 * lineup nor the CLI picker lists. Their metadata is verified like any other
 * row, but subscription access is not: the caller probes them before use.
 */
export interface CatalogResult { models: ChatModel[]; legacy: ChatModel[]; warnings: string[] }

const OMP_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** OMP efforts whose native mapping exists; undefined when none are controllable. */
function thinkingConfig(map: ThinkingLevelMap): ChatModel["thinking"] {
  const efforts = OMP_EFFORTS.filter(level => map[level] !== null) as Effort[];
  return efforts.length ? { mode: "effort", efforts } : undefined;
}

function plain(value: string): string {
  return value.replace(/<sup>.*?<\/sup>/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*]/g, "").trim();
}

function tables(document: string): string[][][] {
  const result: string[][][] = [];
  let table: string[][] = [];
  for (const line of document.split("\n")) {
    if (line.trim().startsWith("|")) {
      const cells = line.trim().slice(1, -1).split("|").map(plain);
      if (!cells.every(cell => /^[:\s-]+$/.test(cell))) table.push(cells);
    } else if (table.length) {
      result.push(table);
      table = [];
    }
  }
  if (table.length) result.push(table);
  return result;
}

async function document(url: string, signal: AbortSignal): Promise<string> {
  try {
    const response = await fetch(url, { signal, headers: { Accept: "text/markdown" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!response.body) throw new Error("empty response body");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2 * 1024 * 1024) throw new Error("document exceeds 2 MiB");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    throw new Error(`Cannot load model metadata from ${url}: ${error instanceof Error ? error.message : error}`, { cause: error });
  }
}

function tokenLimit(value: string | undefined, field: string): number {
  const match = /^(\d+(?:\.\d+)?)([KM])?(?: tokens)?$/i.exec(value ?? "");
  const count = match ? Number(match[1]) * (match[2]?.toUpperCase() === "M" ? 1e6 : match[2]?.toUpperCase() === "K" ? 1e3 : 1) : NaN;
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error(`missing or unsupported ${field}`);
  return count;
}

function price(value: string | undefined): number {
  const match = /^\$(\d+(?:\.\d+)?)\s*\/\s*MTok$/.exec(value ?? "");
  if (!match) throw new Error(`missing or unsupported price: ${value ?? "absent"}`);
  return Number(match[1]);
}

function pricingFor(name: string, pricing: string[][]): Rates {
  const rows = pricing.slice(1).filter(row => row[0]?.split(" (")[0] === name);
  if (!rows.length) throw new Error("missing pricing");
  let base: Rates | undefined;
  let ceiling: number | undefined;
  const tiers: Array<Rates & { inputTokensAbove: number }> = [];
  for (const row of rows) {
    const rates = { input: price(row[1]), cacheWrite: price(row[2]), cacheRead: price(row[4]), output: price(row[5]) };
    if (price(row[3]) !== rates.input * 2) throw new Error("1-hour cache pricing cannot be represented by Pi");
    const label = row[0] ?? "";
    const over = /\(for prompts over ([\d,]+) tokens\)$/.exec(label);
    const upTo = /\(for prompts up to ([\d,]+) tokens\)$/.exec(label);
    if (over) {
      tiers.push({ ...rates, inputTokensAbove: Number(over[1]?.replace(/,/g, "")) });
    } else {
      if (base) throw new Error("ambiguous base pricing");
      if (label !== name && !upTo && !/\((?:limited availability|retired.*)\)$/.test(label)) {
        throw new Error("unrecognized pricing condition");
      }
      base = rates;
      if (upTo) ceiling = Number(upTo[1]?.replace(/,/g, ""));
    }
  }
  if (!base || (ceiling !== undefined && (tiers.length !== 1 || tiers[0]?.inputTokensAbove !== ceiling))) {
    throw new Error("incomplete pricing tiers");
  }
  if (tiers.length && ceiling === undefined) throw new Error("missing pricing tier boundary");
  return base;
}

function thinkingMap(name: string, thinking: string, defaultEffort: string | undefined,
  live: DiscoveredModel | undefined, effort: string[][]): ThinkingLevelMap {
  let supported: string[];
  if (live?.supportsEffort === true && live.supportedEffortLevels?.length) {
    supported = live.supportedEffortLevels;
  } else if (live?.supportsEffort === false || /^extended$/i.test(thinking) && /^(?:not supported|—|n\/a)$/i.test(defaultEffort ?? "")) {
    supported = [];
  } else {
    if (!LEVELS.some(level => level === defaultEffort)) throw new Error("missing supported thinking levels");
    supported = LEVELS.filter(level => {
      const row = effort.find(cells => cells[0] === level);
      if (!row) throw new Error(`missing ${level} effort metadata`);
      if (level === "max" || level === "xhigh") {
        const listed = row[1]?.match(/Available on (.*?)(?:\.\s|\.$)/)?.[1];
        if (!listed) throw new Error(`missing ${level} model support list`);
        return listed.split(/,\s*(?:and )?| and /).includes(name);
      }
      return true;
    });
  }
  if (supported.some(level => !LEVELS.some(known => known === level))) throw new Error("unsupported effort level in Claude picker");
  return {
    off: null,
    minimal: supported.includes("low") ? "low" : null,
    low: supported.includes("low") ? "low" : null,
    medium: supported.includes("medium") ? "medium" : null,
    high: supported.includes("high") ? "high" : null,
    xhigh: supported.includes("xhigh") ? "xhigh" : null,
    max: supported.includes("max") ? "max" : null,
  };
}

export async function loadWebCatalog(picker: DiscoveredModel[], signal: AbortSignal): Promise<CatalogResult> {
  const [overview, prices, efforts] = await Promise.all([
    document(OVERVIEW, signal), document(PRICING, signal), document(EFFORT, signal),
  ]);
  const overviewTables = tables(overview);
  const current = overviewTables.find(table => table[0]?.[0] === "Feature")?.find(row => row[0] === "Claude API ID")?.slice(1);
  if (!current?.length) throw new Error(`Missing current model IDs in ${OVERVIEW}`);
  const pricing = tables(prices).find(table => table[0]?.join("|") ===
    "Model|Base input tokens|5m cache writes|1h cache writes|Cache hits and refreshes|Output tokens");
  if (!pricing) throw new Error(`Missing model pricing table in ${PRICING}`);
  const effort = tables(efforts).find(table => table.some(row => row[0] === "max") && table.some(row => row[0] === "low"));
  if (!effort) throw new Error(`Missing effort table in ${EFFORT}`);
  const links = new Map<string, { name: string; url: string }>();
  const pattern = /\[(Claude [^\]]+)\]\((https:\/\/platform\.claude\.com\/docs\/en\/models\/([a-z0-9-]+)\/overview)\)/g;
  for (const match of overview.matchAll(pattern)) {
    links.set(match[3]!, { name: match[1]!, url: `${match[2]}.md` });
  }
  // Each model page is read once, whether for a legacy ID or for its metadata.
  const pages = new Map<string, Promise<string[][][]>>();
  const page = (url: string): Promise<string[][][]> => {
    let pending = pages.get(url);
    if (!pending) {
      pending = document(url, signal).then(tables);
      pages.set(url, pending);
    }
    return pending;
  };
  const warnings: string[] = [];
  const legacyLine = /^Legacy models \(still available\):(.*)$/m.exec(overview)?.[1];
  if (!legacyLine) warnings.push(`legacy models: missing "Legacy models (still available)" list in ${OVERVIEW}`);
  const legacyIds = (await Promise.all([...(legacyLine ?? "").matchAll(pattern)].map(async match => {
    try {
      const id = (await page(`${match[2]}.md`)).flat().find(row => row[0] === "Claude API")?.[1];
      if (!id || !/^claude-[a-z0-9-]+$/.test(id)) throw new Error("missing Claude API ID");
      return id;
    } catch (error) {
      signal.throwIfAborted();
      warnings.push(`${match[1]}: ${error instanceof Error ? error.message : error}`);
      return undefined;
    }
  }))).filter((id): id is string => id !== undefined);
  const listed = new Set([...current, ...picker.map(row => row.id)]);
  const ids = [...new Set([...listed, ...legacyIds])];
  const models: ChatModel[] = [];
  const legacy: ChatModel[] = [];
  // Bound concurrent document requests independently of future catalog size.
  for (let start = 0; start < ids.length; start += 4) {
    await Promise.all(ids.slice(start, start + 4).map(async id => {
      signal.throwIfAborted();
      try {
        const link = links.get(id.replace(/^claude-/, "").replace(/-\d{8}$/, ""));
        if (!link) throw new Error("missing official model page");
        const info = await page(link.url);
        if (!info.some(table => table.some(row => row[0] === "Claude API" && row[1] === id))) {
          throw new Error("official model page does not confirm this model ID");
        }
        const features = info.find(table => table.some(row => row[0] === "Input → output"));
        const value = (key: string): string | undefined => features?.find(row => row[0] === key)?.[1];
        const thinking = value("Thinking");
        if (!thinking || !/^(Adaptive(?: \((?:always on|extended deprecated)\))?|Extended|Not supported)$/i.test(thinking)) {
          throw new Error("missing thinking capability");
        }
        const inputs = value("Input → output");
        if (inputs !== "Text and images → text" && inputs !== "Text → text") throw new Error("missing input modalities");
        const live = picker.find(row => row.id === id);
        const levels = thinkingMap(link.name, thinking, value("Default effort"), live, effort);
        const thinkingConf = thinkingConfig(levels);
        const isLegacy = !listed.has(id);
        const model: ChatModel = {
          id, name: `${link.name} (subscription${live ? "" : isLegacy ? "; legacy" : "; not in CLI picker"})`,
          api: PROVIDER_ID,
          reasoning: thinking !== "Not supported",
          ...(thinkingConf ? { thinking: thinkingConf } : {}),
          input: inputs === "Text → text" ? ["text"] : ["text", "image"],
          contextWindow: tokenLimit(value("Context window"), "context window"),
          maxTokens: tokenLimit(value("Max output"), "output limit"),
          cost: pricingFor(link.name, pricing),
        };
        if (isLegacy) {
          legacy.push(model);
          return;
        }
        models.push(model);
        for (const alias of picker.filter(row => row.id === id && row.alias !== id)) {
          models.push({ ...model, id: alias.alias, name: `${link.name} (${alias.alias} alias)${/usage credit/i.test(alias.description) ? " · usage credits" : ""}` });
        }
      } catch (error) {
        signal.throwIfAborted();
        warnings.push(`${id}: ${error instanceof Error ? error.message : error}`);
      }
    }));
  }
  const unique = new Map(models.map(model => [model.id, model]));
  return {
    models: [...unique.values()].sort((a, b) => a.id.localeCompare(b.id)),
    legacy: legacy.sort((a, b) => a.id.localeCompare(b.id)),
    warnings: warnings.sort(),
  };
}
