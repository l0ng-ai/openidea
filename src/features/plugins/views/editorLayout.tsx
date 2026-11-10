/**
 * Custom editors that sit beside the text editor (`layout = "split"` or
 * `"preview"`): the file opens in the text editor, wrapped with the plugin's
 * editor and the Editor / Editor and Preview / Preview switch (in the tab
 * strip, or floating when tabs are hidden), as Markdown's preview. The
 * layout is kept per file; files not switched yet start in the declared one.
 */
import clsx from "clsx";
import { useRef, type ReactNode } from "react";
import { create } from "zustand";
import { tx } from "@/platform/i18n";
import { FloatingToolbar, IconButton } from "@/ui";
import { CustomEditorPreview, type CustomEditorDecl } from "./customEditor";
import styles from "./PluginView.module.css";

export type EditorLayout = "editor" | "split" | "preview";

/** `<plugin>/<editor>` → path → layout. */
export const useEditorLayouts = create<{ byPath: Record<string, EditorLayout> }>(() => ({ byPath: {} }));

const layoutKey = (pluginId: string, editorId: string, path: string) => `${pluginId}/${editorId}:${path}`;

export function layoutOf(pluginId: string, decl: CustomEditorDecl, path: string, byPath: Record<string, EditorLayout>) {
  return byPath[layoutKey(pluginId, decl.id, path)] ?? (decl.layout === "preview" ? "preview" : "split");
}

export function setEditorLayout(pluginId: string, editorId: string, path: string, layout: EditorLayout) {
  useEditorLayouts.setState((s) => ({ byPath: { ...s.byPath, [layoutKey(pluginId, editorId, path)]: layout } }));
}

function LayoutActions({ pluginId, decl, path }: { pluginId: string; decl: CustomEditorDecl; path: string }) {
  const layout = useEditorLayouts((s) => layoutOf(pluginId, decl, path, s.byPath));
  const button = (value: EditorLayout, icon: string, title: string) => (
    <IconButton
      icon={icon}
      iconSize={16}
      size="small"
      title={title}
      pressed={layout === value}
      onClick={() => setEditorLayout(pluginId, decl.id, path, value)}
    />
  );
  return (
    <div className={styles.layoutActions} role="toolbar" aria-label={tx`${decl.title} layout`}>
      {button("editor", "editor-only", tx("Editor Only"))}
      {button("split", "editor-preview", tx`Editor and ${decl.title}`)}
      {button("preview", "preview-only", tx`${decl.title} Only`)}
    </div>
  );
}

/** The `tabActions` of a wrapper: the layout switch in the editor's tab strip. */
export function layoutActions(pluginId: string, decl: CustomEditorDecl) {
  return function PluginLayoutActions({ path }: { path: string; tabId: string }) {
    return <LayoutActions pluginId={pluginId} decl={decl} path={path} />;
  };
}

/** The text editor wrapper of a custom editor with a side-by-side layout. */
export function layoutWrapper(pluginId: string, decl: CustomEditorDecl) {
  return function PluginEditorLayout({
    path,
    children,
    actionsInTabs = false,
  }: {
    path: string;
    tabId: string;
    children: ReactNode;
    actionsInTabs?: boolean;
  }) {
    const layout = useEditorLayouts((s) => layoutOf(pluginId, decl, path, s.byPath));
    const ref = useRef<HTMLDivElement>(null);
    return (
      <div ref={ref} className={clsx(styles.split, styles[`layout-${layout}`])}>
        {/* Always rendered: the text editor's view stays alive in every layout. */}
        <div className={styles.splitEditor}>{children}</div>
        {layout !== "editor" && (
          <div className={styles.splitPreview}>
            <CustomEditorPreview pluginId={pluginId} decl={decl} path={path} />
          </div>
        )}
        {!actionsInTabs && (
          <FloatingToolbar targetRef={ref}>
            <LayoutActions pluginId={pluginId} decl={decl} path={path} />
          </FloatingToolbar>
        )}
      </div>
    );
  };
}
