/**
 * Navigate › Related Symbol (⌃⌘↑): files and places tied to the current one by a language's or
 * framework's conventions (a C header and its source, a Rails action and its views). Features
 * register providers; the action merges what they find.
 */

export interface RelatedContext {
  path: string;
  language: string;
  text: string;
  /** The caret offset in `text`. */
  offset: number;
}

export interface RelatedItem {
  path: string;
  /** 0-based; the file's start when absent. */
  line?: number;
  col?: number;
  /** What the chooser shows (else the file name). */
  label?: string;
  /** The kind of relation shown after the label, e.g. "Header" or "View". */
  group: string;
}

type Provider = (ctx: RelatedContext) => Promise<RelatedItem[]>;
const providers = new Set<Provider>();

export function registerRelatedProvider(provider: Provider): () => void {
  providers.add(provider);
  return () => {
    providers.delete(provider);
  };
}

/** Every provider's items, the first of each place kept; a failing provider adds nothing. */
export async function relatedItems(ctx: RelatedContext): Promise<RelatedItem[]> {
  const found = await Promise.all([...providers].map((p) => p(ctx).catch(() => [] as RelatedItem[])));
  const seen = new Set<string>();
  return found.flat().filter((item) => {
    const key = `${item.path}:${item.line ?? 0}`;
    if (item.path === ctx.path && item.line === undefined) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
