/**
 * Client side of the plugin UI points: declarations the
 * backend validated, projected onto the workbench's own registries.
 *
 * - `menus`: editor / project view / editor tab context menus, and Tools in the main menu;
 * - `keymaps`: default shortcuts below the IDE's (a taken keystroke is dropped);
 * - `statusBar`: items shown before the code runs (its `set-status-item` with the same id updates them);
 * - `settings`: a page under Settings › Plugins generated from the schema;
 * - `views`: tool windows the plugin renders, or a web page of its package;
 * - `customEditors`: files opening in a plugin editor sharing the text document, in its own tab or
 *   beside the text editor;
 * - `fileIcons`: icons for the files a plugin knows, whatever icon theme is in use;
 * - `fileTemplates`: entries of the New menu.
 */
import { useMemo } from "react";
import type { PluginInfo } from "@/bindings";
import { getAction } from "@/platform/actions";
import { evaluateWhen, getContext } from "@/platform/context";
import { tx } from "@/platform/i18n";
import { isMacHost, registerExtensionBindings } from "@/platform/keymap";
import {
  Checkbox,
  Input,
  Select,
  T,
  addFileIconProvider,
  fileIconName,
  registerExternalIcons,
  type MenuItem,
} from "@/ui";
import { addContributedFileTemplate } from "@/features/templates/files/store";
import {
  registerEditorKind,
  registerFileEditorProvider,
  registerMenuGroup,
  registerMenuSlotItem,
  registerSettingsPage,
  registerTextEditorWrapper,
  registerToolWindow,
  useSettingsForm,
  type ContextMenuId,
  type ToolWindowAnchor,
} from "@/workbench/contributions";
import { pluginsBackend } from "./backend";
import { usePlugins } from "./store";
import { pluginActionId } from "./points";
import { defineUiPoint } from "./projection";
import { declareStatusItem } from "./runtimeUi";
import {
  CUSTOM_EDITOR_KIND,
  CustomEditor,
  basename,
  customEditorDocument,
  customEditorInput,
  matchesPattern,
  type CustomEditorDecl,
} from "./views/customEditor";
import { layoutActions, layoutWrapper } from "./views/editorLayout";
import { PluginView } from "./views/PluginView";
import { WebView } from "./views/WebView";
import styles from "./PluginsPage.module.css";

// --- menus ------------------------------------------------------------------------

interface MenuDecl {
  menu: "editor.context" | "projectView.context" | "editorTab.context" | "viewItem.context" | "tools";
  view?: string | null;
  command: string;
  when?: string | null;
}

const CONTEXT_MENUS: Record<string, ContextMenuId> = {
  "editor.context": "editor",
  "projectView.context": "projectView",
  "editorTab.context": "editorTab",
};

const contextItems = new Map<string, { pluginId: string; decl: MenuDecl }>();
let menuSeq = 0;

/** Plugin items of a context menu: their command's action with the menu's file as argument. */
export function pluginMenuItems(menu: ContextMenuId, paths: readonly string[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const { pluginId, decl } of contextItems.values()) {
    if (CONTEXT_MENUS[decl.menu] !== menu || !evaluateWhen(decl.when ?? undefined)) continue;
    const action = pluginActionId(pluginId, decl.command);
    if (!getAction(action)) continue;
    // The editor menu runs with the focused editor; the others name their file.
    out.push({
      kind: "action",
      action,
      arg: menu === "editor" ? undefined : { path: paths[0], paths: [...paths] },
    });
  }
  return out;
}

/** Plugin entries of a view item's context menu, with the item key as argument. */
export function pluginViewItemMenuItems(pluginId: string, view: string, key: string): MenuItem[] {
  const ctx = { ...getContext(), viewItem: key, viewItemKind: key.split(":")[0] };
  const out: MenuItem[] = [];
  for (const { pluginId: owner, decl } of contextItems.values()) {
    if (owner !== pluginId || decl.menu !== "viewItem.context" || decl.view !== view) continue;
    if (!evaluateWhen(decl.when ?? undefined, ctx)) continue;
    const action = pluginActionId(pluginId, decl.command);
    if (!getAction(action)) continue;
    out.push({ kind: "action", action, arg: key });
  }
  return out;
}

function projectMenu(pluginId: string, decl: MenuDecl, plugin: PluginInfo): () => void {
  if (decl.menu === "tools") {
    const action = pluginActionId(pluginId, decl.command);
    const title = getAction(action)?.title ?? `${plugin.name}: ${decl.command}`;
    return registerMenuSlotItem("pluginTools", { action, label: title });
  }
  const key = `${++menuSeq}`;
  contextItems.set(key, { pluginId, decl });
  return () => void contextItems.delete(key);
}

// --- keymaps ----------------------------------------------------------------------

interface KeymapDecl {
  command: string;
  key: string;
  mac?: string | null;
}

// --- status bar -------------------------------------------------------------------

interface StatusDecl {
  id: string;
  text: string;
  tooltip?: string | null;
  command?: string | null;
  align: "left" | "right";
  priority: number;
}

// --- settings ---------------------------------------------------------------------

export interface SettingSchema {
  key: string;
  type: "boolean" | "string" | "number" | "integer";
  title: string;
  description?: string | null;
  default: unknown;
  options?: string[] | null;
  multiline?: boolean;
}

interface SettingsDecl {
  title: string;
  properties: SettingSchema[];
}

type PluginSettings = Record<string, Record<string, unknown>>;

/** `settings` with `key` of `pluginId` set (`null`: back to the default). */
export function withPluginSetting(
  settings: PluginSettings | undefined,
  pluginId: string,
  key: string,
  value: unknown,
): PluginSettings {
  const own = { ...(settings?.[pluginId] ?? {}) };
  if (value === null) delete own[key];
  else own[key] = value;
  const next = { ...(settings ?? {}) };
  if (Object.keys(own).length) next[pluginId] = own;
  else delete next[pluginId];
  return next;
}

function SettingControl({ pluginId, s }: { pluginId: string; s: SettingSchema }) {
  const form = useSettingsForm();
  const all = form.useValue("plugins") as PluginSettings | undefined;
  const value = all?.[pluginId]?.[s.key] ?? s.default;
  const set = (v: unknown) => form.set("plugins", withPluginSetting(all, pluginId, s.key, v === s.default ? null : v));
  const id = `plugin-setting-${pluginId}-${s.key}`;
  const description = s.description ? <div className={styles.muted}>{s.description}</div> : null;
  if (s.type === "boolean")
    return (
      <div className={styles.settingRow}>
        <Checkbox checked={value === true} label={s.title} onChange={set} />
        {description}
      </div>
    );
  return (
    <div className={styles.settingRow}>
      <label htmlFor={id}>{s.title}</label>
      {s.options ? (
        <Select
          aria-label={s.title}
          value={String(value)}
          options={s.options.map((o) => ({ value: o, label: o }))}
          onChange={set}
        />
      ) : (
        <Input
          id={id}
          type={s.type === "string" ? "text" : "number"}
          value={String(value ?? "")}
          onChange={(e) => {
            const raw = e.target.value;
            if (s.type === "string") set(raw);
            else if (raw.trim() !== "" && Number.isFinite(Number(raw)))
              set(s.type === "integer" ? Math.trunc(Number(raw)) : Number(raw));
          }}
        />
      )}
      {description}
    </div>
  );
}

function settingsPage(pluginId: string, decl: SettingsDecl) {
  return function PluginSettingsPage() {
    const properties = useMemo(() => decl.properties, []);
    return (
      <div className={styles.settingsPage}>
        <p className={styles.muted}>
          <T>Settings of the plugin; projects can override them.</T>
        </p>
        {properties.map((s) => (
          <SettingControl key={s.key} pluginId={pluginId} s={s} />
        ))}
      </div>
    );
  };
}

/** Settings page id of a plugin (dots nest pages, so they become dashes). */
export const pluginSettingsPageId = (pluginId: string) => `plugins.${pluginId.replace(/\./g, "-")}`;

// --- views and custom editors -----------------------------------------------------

interface ViewDecl {
  id: string;
  title: string;
  icon?: string | null;
  location: ToolWindowAnchor;
  web?: string;
}

interface FileIconDecl {
  id: string;
  patterns: string[];
  /** A dark-theme variant was given. */
  dark: boolean;
}

interface FileTemplateDecl {
  id: string;
  name: string;
  extension: string;
  body: string;
}

/** A new file's icon: the plugin's own file icon for it, else the built-in one. */
function templateIcon(pluginId: string, extension: string): string {
  const file = `untitled.${extension}`;
  const own = usePlugins
    .getState()
    .ui.find(
      (c) =>
        c.pluginId === pluginId &&
        c.point === "fileIcons" &&
        (c.decl as FileIconDecl).patterns.some((p) => matchesPattern(p, file)),
    );
  return own ? `ext:fileIcon/${pluginId}/${(own.decl as FileIconDecl).id}` : fileIconName(file);
}

/** Registers a plugin's file icon (fetched first) and resolves matching files to it. */
function projectFileIcon(pluginId: string, decl: FileIconDecl): () => void {
  let disposed = false;
  let undo = () => {};
  const name = `ext:fileIcon/${pluginId}/${decl.id}`;
  void pluginsBackend()
    .assets(pluginId, `fileIcon/${decl.id}/`)
    .then((assets) => {
      if (disposed) return;
      const svg = (variant: string) => assets.find(([id]) => id === `fileIcon/${decl.id}/${variant}`)?.[1];
      const light = svg("light");
      if (!light) return;
      const dark = svg("dark");
      const unregister = registerExternalIcons(
        dark
          ? [
              [name, light],
              [`${name}_dark`, dark],
            ]
          : [[name, light]],
      );
      const remove = addFileIconProvider((file) => (decl.patterns.some((p) => matchesPattern(p, file)) ? name : null));
      undo = () => {
        remove();
        unregister();
      };
    })
    .catch((e: unknown) => console.warn(`plugin ${pluginId}: file icon ${decl.id}`, e));
  return () => {
    disposed = true;
    undo();
  };
}

export const pluginToolWindowId = (pluginId: string, view: string) => `plugin.${pluginId}.${view}`;

function registerView(pluginId: string, decl: ViewDecl, icon: string): () => void {
  return registerToolWindow({
    id: pluginToolWindowId(pluginId, decl.id),
    title: decl.title,
    icon,
    anchor: decl.location,
    order: 900,
    component: () =>
      decl.web ? (
        <WebView pluginId={pluginId} view={decl.id} label={decl.title} />
      ) : (
        <PluginView
          pluginId={pluginId}
          view={decl.id}
          label={decl.title}
          itemMenu={(key) => pluginViewItemMenuItems(pluginId, decl.id, key)}
        />
      ),
  });
}

function projectView(pluginId: string, decl: ViewDecl): () => void {
  if (!decl.icon?.endsWith(".svg")) return registerView(pluginId, decl, decl.icon ?? "plugin");
  let disposed = false;
  let undo = () => {};
  void pluginsBackend()
    .assets(pluginId, `viewIcon/${decl.id}`)
    .then((assets) => {
      if (disposed) return;
      const svg = assets.find(([id]) => id === `viewIcon/${decl.id}`)?.[1];
      const name = `ext:${pluginId}/view-${decl.id}`;
      const unregister = svg ? registerExternalIcons([[name, svg]]) : () => {};
      const remove = registerView(pluginId, decl, svg ? name : "plugin");
      undo = () => {
        remove();
        unregister();
      };
    })
    .catch((e: unknown) => {
      console.warn(`plugin ${pluginId}: view icon ${decl.id}`, e);
      if (!disposed) undo = registerView(pluginId, decl, "plugin");
    });
  return () => {
    disposed = true;
    undo();
  };
}

/** Registers the client side of the P7 points; returns their disposer. */
export function defineViewUiPoints(): () => void {
  const disposers = [
    defineUiPoint<MenuDecl>("menus", {
      title: "Menus",
      project: ({ pluginId, decl }, { plugin }) => projectMenu(pluginId, decl, plugin),
    }),
    defineUiPoint<KeymapDecl>("keymaps", {
      title: "Shortcuts",
      project: ({ pluginId, decl }) =>
        registerExtensionBindings(pluginActionId(pluginId, decl.command), [
          isMacHost() ? (decl.mac ?? decl.key) : decl.key,
        ]),
    }),
    defineUiPoint<StatusDecl>("statusBar", {
      title: "Status Bar Items",
      project: ({ pluginId, decl }) =>
        declareStatusItem(pluginId, decl.id, {
          item: { text: decl.text, tooltip: decl.tooltip ?? null, command: decl.command ?? null },
          align: decl.align,
          priority: decl.priority,
        }),
    }),
    defineUiPoint<SettingsDecl>("settings", {
      title: "Settings",
      project: ({ pluginId, decl }) =>
        registerSettingsPage({
          id: pluginSettingsPageId(pluginId),
          title: decl.title,
          projectScope: true,
          keywords: ["plugin", pluginId, ...decl.properties.flatMap((p) => [p.key, p.title])],
          component: settingsPage(pluginId, decl),
        }),
    }),
    defineUiPoint<ViewDecl>("views", {
      title: "Tool Windows",
      project: ({ pluginId, decl }) => projectView(pluginId, decl),
    }),
    defineUiPoint<CustomEditorDecl>("customEditors", {
      title: "Editors",
      project: ({ pluginId, decl }) => {
        const matches = (path: string) => decl.patterns.some((p) => matchesPattern(p, basename(path)));
        const beside = decl.layout === "split" || decl.layout === "preview";
        // A side-by-side editor wraps the text editor the file opens in; the others open their own tab.
        const provider =
          decl.priority !== "default"
            ? () => {}
            : beside
              ? registerTextEditorWrapper({
                  id: `plugin.${pluginId}.${decl.id}`,
                  matches,
                  component: layoutWrapper(pluginId, decl),
                  tabActions: layoutActions(pluginId, decl),
                })
              : registerFileEditorProvider({
                  id: `plugin.${pluginId}.${decl.id}`,
                  order: 40,
                  resolve: (path) => (matches(path) ? customEditorInput(pluginId, decl, path) : null),
                });
        openWith.set(`${pluginId}/${decl.id}`, { pluginId, decl, matches });
        return () => {
          provider();
          openWith.delete(`${pluginId}/${decl.id}`);
        };
      },
    }),
    defineUiPoint<FileIconDecl>("fileIcons", {
      title: "File Icons",
      project: ({ pluginId, decl }) => projectFileIcon(pluginId, decl),
    }),
    defineUiPoint<FileTemplateDecl>("fileTemplates", {
      title: "File Templates",
      project: ({ pluginId, decl }) =>
        addContributedFileTemplate({
          id: `plugin.${pluginId}.${decl.id}`,
          name: decl.name,
          icon: templateIcon(pluginId, decl.extension),
          extension: decl.extension,
          nameStyle: "asis",
          kinds: [{ id: "file", label: decl.name, body: decl.body }],
        }),
    }),
  ];
  return () => disposers.reverse().forEach((d) => d());
}

/** Custom editors by `plugin/id`, for Open With. */
const openWith = new Map<string, { pluginId: string; decl: CustomEditorDecl; matches: (path: string) => boolean }>();

/** One-time registrations behind the points: the editor kind and the context menu group. */
export function startViewUi(openInput: (input: ReturnType<typeof customEditorInput>) => void): () => void {
  const disposers = [
    registerEditorKind({
      kind: CUSTOM_EDITOR_KIND,
      component: CustomEditor,
      title: (input) => basename(input.path ?? input.key),
      icon: () => "db-table",
      restorable: true,
      document: customEditorDocument,
    }),
    registerMenuGroup({
      id: "plugins",
      menus: ["editor", "projectView", "editorTab"],
      order: 90,
      items: (menu, ctx) => {
        const items = pluginMenuItems(menu, ctx.paths);
        const path = ctx.paths[0];
        if (menu !== "editor" && path && !ctx.dirs?.[0]) {
          const editors = [...openWith.values()].filter((e) => e.matches(path));
          if (editors.length)
            items.push({
              label: tx("Open With"),
              submenu: editors.map((e) => ({
                label: e.decl.title,
                run: () => openInput(customEditorInput(e.pluginId, e.decl, path)),
              })),
            });
        }
        return items;
      },
    }),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
