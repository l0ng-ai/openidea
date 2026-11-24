/**
 * The clone dialog's plugin sources (`[[contributes.cloneSources]]`): the page
 * of a source picks a repository and hands the dialog its URL.
 */

/**
 * The URL a source's page asked to clone, or null. The page posts
 * `{ "op": "clone-url", "url": "https://…" }` through `openidea.postMessage`;
 * anything else it posts is the plugin's business and passes through.
 */
export function cloneUrlFromSource(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const message = parsed as { op?: unknown; url?: unknown };
  if (message.op !== "clone-url" || typeof message.url !== "string") return null;
  const url = message.url.trim();
  return url && !/\s/.test(url) ? url : null;
}

/** A clone source the dialog shows as a plugin's web page. */
export interface PluginCloneSource {
  id: string;
  label: string;
  icon: string;
  pluginId: string;
  /** The declaration's key, which the page is served and messaged under. */
  view: string;
}

/** What the plugin projection carries for a clone source (`[[contributes.cloneSources]]`). */
export interface CloneSourceContributionLike {
  pluginId: string;
  key: string;
  point: string;
  decl: unknown;
}

/**
 * The dialog's entries for the plugins' clone sources, in projection order.
 * The key already carries the point's name (`cloneSources/gitee`), so it is
 * used as-is for the page and for view events.
 */
export function pluginCloneSources(items: readonly CloneSourceContributionLike[]): PluginCloneSource[] {
  return items
    .filter((item) => item.point === "cloneSources")
    .map(({ pluginId, key, decl }) => {
      const fields = (decl ?? {}) as { label?: unknown; icon?: unknown };
      return {
        id: `${pluginId}/${key}`,
        label: typeof fields.label === "string" ? fields.label : key,
        icon: typeof fields.icon === "string" ? fields.icon : "branch",
        pluginId,
        view: key,
      };
    });
}
