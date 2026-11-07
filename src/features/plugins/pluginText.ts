/**
 * Translation of a plugin's own text. A package's `locales/<tag>.json` maps
 * English source text to a translation; it is applied to the plugin's
 * declarations and view data, and only to those: the IDE's catalogs are not
 * touched and a plugin never sees another's. Text without an entry stays
 * English.
 */
import { useCallback } from "react";
import { create } from "zustand";
import type { UiContribution, View } from "@/bindings";
import { LOCALES, type Locale } from "@/platform/i18n";
import { pluginsBackend } from "./backend";

type Catalog = Record<string, string>;
export type PluginTranslate = (text: string) => string;

export const usePluginCatalogs = create<{ catalogs: Record<string, Catalog> }>(() => ({ catalogs: {} }));

const LOCALES_POINT = "locales";

/** The catalog of `tags` that serves `locale`: the exact tag (`zh-CN`), then the language (`zh`), then a variant (`zh-TW`). */
export function pickCatalogTag(tags: readonly string[], locale: string): string | undefined {
  const full = (LOCALES[locale as Locale]?.tag ?? locale).toLowerCase();
  const language = full.split("-")[0]!;
  const lower = tags.map((t) => t.toLowerCase());
  const at = lower.indexOf(full) >= 0 ? lower.indexOf(full) : lower.indexOf(language);
  if (at >= 0) return tags[at];
  return tags.find((t) => t.toLowerCase().split("-")[0] === language);
}

let loadToken = 0;

/** Reads the catalogs of the plugins that ship one for `locale`; the others have none. */
export async function loadPluginCatalogs(ui: readonly UiContribution[], locale: string): Promise<void> {
  const token = ++loadToken;
  const entries = await Promise.all(
    ui
      .filter((c) => c.point === LOCALES_POINT)
      .map(async (c): Promise<[string, Catalog] | null> => {
        const tags = ((c.decl as { tags?: string[] }).tags ?? []) as string[];
        const tag = pickCatalogTag(tags, locale);
        if (!tag) return null;
        try {
          const assets = await pluginsBackend().assets(c.pluginId, `locale/${tag}`);
          const text = assets.find(([id]) => id === `locale/${tag}`)?.[1];
          return text ? [c.pluginId, JSON.parse(text) as Catalog] : null;
        } catch (e) {
          console.warn(`plugin ${c.pluginId}: cannot load its ${tag} catalog`, e);
          return null;
        }
      }),
  );
  if (token !== loadToken) return;
  const catalogs = Object.fromEntries(entries.filter((e) => e !== null));
  if (JSON.stringify(catalogs) !== JSON.stringify(usePluginCatalogs.getState().catalogs))
    usePluginCatalogs.setState({ catalogs });
}

/** `map[key]` when `map` has the key itself, not through its prototype (`constructor`, `__proto__`). */
function ownEntry<T>(map: Record<string, T> | undefined, key: string): T | undefined {
  return map && Object.hasOwn(map, key) ? map[key] : undefined;
}

export function translatorOf(catalogs: Record<string, Catalog>, pluginId: string): PluginTranslate {
  const catalog = ownEntry(catalogs, pluginId);
  return catalog ? (text) => ownEntry(catalog, text) ?? text : (text) => text;
}

/** `text` in the active language, for the plugin's own text; re-renders when the catalog changes. */
export function usePluginT(pluginId: string): PluginTranslate {
  const catalog = usePluginCatalogs((s) => ownEntry(s.catalogs, pluginId));
  return useCallback((text) => (catalog ? (ownEntry(catalog, text) ?? text) : text), [catalog]);
}

/** The keys of each point's declaration that are shown text; ids, names of secrets and option values are not. */
const TEXT_KEYS: Record<string, readonly string[]> = {
  commands: ["title", "category"],
  menus: ["submenu"],
  views: ["title"],
  customEditors: ["title"],
  statusBar: ["text", "tooltip"],
  settings: ["title"],
  fileTemplates: ["name"],
  iconThemes: ["label"],
  themes: ["name"],
  secrets: ["label", "description"],
};

function localizeDecl(decl: unknown, keys: readonly string[], t: PluginTranslate): unknown {
  if (!decl || typeof decl !== "object") return decl;
  const out: Record<string, unknown> = { ...(decl as Record<string, unknown>) };
  for (const key of keys) if (typeof out[key] === "string") out[key] = t(out[key]);
  if (Array.isArray(out.properties))
    out.properties = out.properties.map((p) => localizeDecl(p, ["title", "description"], t));
  if (Array.isArray(out.variables)) out.variables = out.variables.map((v) => localizeDecl(v, ["prompt"], t));
  return out;
}

/** The declarations with their titles and labels translated by their plugin's catalog. */
export function localizeContributions(
  items: readonly UiContribution[],
  catalogs: Record<string, Catalog>,
): readonly UiContribution[] {
  if (Object.keys(catalogs).length === 0) return items;
  const localized = items.map((item) => {
    const keys = TEXT_KEYS[item.point];
    const decl = item.decl as Record<string, unknown> | null;
    const hasText = !!decl && (keys?.some((k) => typeof decl[k] === "string") || Array.isArray(decl.properties));
    return keys && hasText && ownEntry(catalogs, item.pluginId)
      ? { ...item, decl: localizeDecl(item.decl, keys, translatorOf(catalogs, item.pluginId)) }
      : item;
  });
  // A menu entry is labelled with its command's title, which changes with the language but not with the entry.
  const titles = new Map(
    localized
      .filter((c) => c.point === "commands")
      .map((c) => [`${c.pluginId}/${(c.decl as { id: string }).id}`, (c.decl as { title: string }).title]),
  );
  return localized.map((item) => {
    const title =
      item.point === "menus" ? titles.get(`${item.pluginId}/${(item.decl as { command: string }).command}`) : undefined;
    return title !== undefined && ownEntry(catalogs, item.pluginId)
      ? { ...item, decl: { ...(item.decl as object), commandTitle: title } }
      : item;
  });
}

/** A view with the buttons, labels, columns and messages translated; `html` bodies and cell data are left as they are. */
export function localizeView(view: View, t: PluginTranslate): View {
  const body = view.body;
  const localized: View["body"] = (() => {
    switch (body.kind) {
      case "message":
        return { ...body, value: t(body.value) };
      case "tree":
        return {
          ...body,
          value: body.value.map((i) => ({ ...i, label: t(i.label), detail: i.detail && t(i.detail) })),
        };
      case "list":
        return {
          ...body,
          value: body.value.map((i) => ({ ...i, label: t(i.label), detail: i.detail && t(i.detail) })),
        };
      case "form":
        return { ...body, value: body.value.map((f) => ({ ...f, label: t(f.label) })) };
      case "table":
        return { ...body, value: { ...body.value, columns: body.value.columns.map(t) } };
      default:
        return body;
    }
  })();
  return {
    toolbar: view.toolbar.map((b) => ({ ...b, label: t(b.label) })),
    body: localized,
    status: view.status && t(view.status),
  };
}
