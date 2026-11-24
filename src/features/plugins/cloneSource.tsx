/**
 * Clone sources contributed by plugins (`[[contributes.cloneSources]]`).
 *
 * The declaration's page is a web view of the plugin: it lists repositories and
 * posts the one the user picks. The dialog's own `registerCloneSource` handles
 * everything else — ordering, the disabled state while cloning, double-click to
 * clone right away — so the dialog itself needs to know nothing about plugins.
 */
import type { ComponentType } from "react";
import type { CloneSourceProps } from "@/workbench/contributions";
import { registerCloneSource } from "@/workbench/contributions";
import { pluginsBackend } from "./backend";
import { pluginIconName } from "./pluginIcon";
import styles from "./cloneSource.module.css";
import { WebView } from "./views/WebView";

/** What the page declares (`[[contributes.cloneSources]]`), already validated by the host. */
export interface CloneSourceDecl {
  id: string;
  label: string;
  /** An IDE icon name, or a package SVG (`icons/gitee.svg`). */
  icon?: string;
  web: string;
}

/** The repository a page asked for, or null when the message is the plugin's own. */
export function clonePickFromMessage(text: string): { url: string; clone: boolean } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const message = parsed as { op?: unknown; url?: unknown; clone?: unknown };
  if (message.op !== "clone-url" || typeof message.url !== "string") return null;
  const url = message.url.trim();
  // A single line and no spaces: the dialog's field takes a clone URL, not a command.
  if (!url || /\s/.test(url)) return null;
  return { url, clone: message.clone === true };
}

/** The pane: the plugin's page, with its `clone-url` taken off the message stream. */
export function PluginCloneSource({
  pluginId,
  view,
  label,
  disabled,
  onUrl,
  onClone,
}: CloneSourceProps & { pluginId: string; view: string; label: string }) {
  return (
    <div className={styles.pane} aria-disabled={disabled || undefined}>
      <WebView
        pluginId={pluginId}
        view={view}
        label={label}
        header="none"
        onText={(text) => {
          const picked = clonePickFromMessage(text);
          if (!picked) return false;
          if (picked.clone) onClone(picked.url);
          else onUrl(picked.url);
          return true;
        }}
      />
    </div>
  );
}

/**
 * Registers a plugin's source with the dialog, icon first (a package SVG is an
 * asset of the plugin, so it arrives asynchronously), and returns the disposer.
 */
export function projectCloneSource(pluginId: string, decl: CloneSourceDecl): () => void {
  let disposed = false;
  let undo: (() => void) | undefined;
  const component: ComponentType<CloneSourceProps> = (props) => (
    <PluginCloneSource pluginId={pluginId} view={decl.id} label={decl.label} {...props} />
  );
  const register = (icon: string) => {
    if (disposed) return;
    undo = registerCloneSource({
      // Namespaced: two plugins may both call theirs "gitee".
      id: `plugin:${pluginId}/${decl.id}`,
      label: decl.label,
      icon,
      order: 100,
      component,
    });
  };

  const icon = decl.icon?.trim();
  if (icon?.endsWith(".svg")) {
    void pluginsBackend()
      .assets(pluginId, `cloneSourceIcon/${decl.id}`)
      .then((assets) => {
        const svg = assets.find(([id]) => id === `cloneSourceIcon/${decl.id}`)?.[1];
        register(svg ? pluginIconName(pluginId, { light: svg, dark: null }) : "branch");
      })
      .catch((e: unknown) => {
        console.warn(`plugin ${pluginId}: clone source icon ${decl.id}`, e);
        register("branch");
      });
  } else {
    register(icon || "branch");
  }

  return () => {
    disposed = true;
    undo?.();
  };
}
