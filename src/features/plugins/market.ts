/** How the Available tab orders and groups the marketplace. */
import type { MarketPlugin } from "@/bindings";

/** The official plugins: examples of the plugin API, not maintained products. */
export const EXAMPLE_PUBLISHER = "openidea";

export const isExample = (m: { publisher?: string | null }) => m.publisher === EXAMPLE_PUBLISHER;

const SUGGESTED_MAX = 5;
const FEATURED_MAX = 6;

export interface MarketGroups {
  /** Not installed, and the project has a file the plugin is suggested for. */
  suggested: MarketPlugin[];
  featured: MarketPlugin[];
  /** Every community plugin shown, most downloaded first (best match first when searching). */
  community: MarketPlugin[];
  /** The official plugins, always last. */
  examples: MarketPlugin[];
}

const byPopularity = (a: MarketPlugin, b: MarketPlugin) =>
  (b.downloads ?? 0) - (a.downloads ?? 0) || a.name.localeCompare(b.name);

/** 0 = name starts with the query, 1 = name contains it, 2 = matched elsewhere. */
function rank(m: MarketPlugin, q: string): number {
  const name = m.name.toLowerCase();
  return name.startsWith(q) ? 0 : name.includes(q) ? 1 : 2;
}

/**
 * Splits the shown plugins: suggestions and picks only while browsing (no query,
 * no category); community plugins before the examples.
 */
export function groupMarket(
  shown: readonly MarketPlugin[],
  query: string,
  browsing: boolean,
  suggestedFor: ReadonlyMap<string, string>,
): MarketGroups {
  const q = query.trim().toLowerCase();
  const order = q ? (a: MarketPlugin, b: MarketPlugin) => rank(a, q) - rank(b, q) || byPopularity(a, b) : byPopularity;
  const community = shown.filter((m) => !isExample(m)).sort(order);
  const examples = shown.filter(isExample).sort(order);
  if (!browsing) return { suggested: [], featured: [], community, examples };
  return {
    suggested: community.filter((m) => !m.installed && suggestedFor.has(m.id)).slice(0, SUGGESTED_MAX),
    featured: community.filter((m) => m.featured).slice(0, FEATURED_MAX),
    community,
    examples,
  };
}

/** 1234 → "1.2K", in the UI's number style. */
export function formatDownloads(n: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
}

/** The paths any entry is suggested for. */
export function suggestionPaths(market: readonly MarketPlugin[]): string[] {
  return [...new Set(market.flatMap((m) => (isExample(m) ? [] : (m.suggest ?? []))))];
}

/** Each plugin's first suggestion path the project has. */
export function suggestedFor(market: readonly MarketPlugin[], present: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of market) {
    const hit = isExample(m) ? undefined : m.suggest?.find((p) => present.has(p));
    if (hit) out.set(m.id, hit);
  }
  return out;
}

/** Tints for plugins without an icon, picked by id so each keeps its own. */
export const MONOGRAM_TONES = 6;

export function monogram(id: string, name: string): { letter: string; tone: number } {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  const letter = [...name.trim().replace(/^[^\p{L}\p{N}]+/u, "")][0] ?? "?";
  return { letter: letter.toUpperCase(), tone: Math.abs(h) % MONOGRAM_TONES };
}
