/**
 * Custom editors that sit beside the text editor (`layout = "split"` or
 * `"preview"`): the file opens in the text editor, wrapped with the plugin's
 * editor and the Editor / Editor and Preview / Preview switch (in the tab
 * strip, or floating when tabs are hidden), as Markdown's preview. The
 * layout is kept per editor tab (split panes of one file each have their own);
 * tabs not switched yet start in the declared one.
 */
import clsx from "clsx";
import { useRef, type ReactNode } from "react";
import { create } from "zustand";
import { tx } from "@/platform/i18n";
import { FloatingToolbar, IconButton } from "@/ui";
import { CustomEditorPreview, type CustomEditorDecl } from "./customEditor";
import styles from "./PluginView.module.css";

export type EditorLayout = "editor" | "split" | "preview";

/** `<plugin>/<editor>:<tab>` → layout. */
const useEditorLayouts = create<{ byTab: Record<string, EditorLayout> }>(() => ({ byTab: {} }));

const layoutKey = (pluginId: string, editorId: string, tabId: string) => `${pluginId}/${editorId}:${tabId}`;

function layoutOf(pluginId: string, decl: CustomEditorDecl, tabId: string, byTab: Record<string, EditorLayout>) {
  return byTab[layoutKey(pluginId, decl.id, tabId)] ?? (decl.layout === "preview" ? "preview" : "split");
}

function setEditorLayout(pluginId: string, editorId: string, tabId: string, layout: EditorLayout) {
  useEditorLayouts.setState((s) => ({ byTab: { ...s.byTab, [layoutKey(pluginId, editorId, tabId)]: layout } }));
}

function LayoutActions({ pluginId, decl, tabId }: { pluginId: string; decl: CustomEditorDecl; tabId: string }) {
  const layout = useEditorLayouts((s) => layoutOf(pluginId, decl, tabId, s.byTab));
  const button = (value: EditorLayout, icon: string, title: string) => (
    <IconButton
      icon={icon}
      iconSize={16}
      size="small"
      title={title}
      pressed={layout === value}
      onClick={() => setEditorLayout(pluginId, decl.id, tabId, value)}
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
  return function PluginLayoutActions({ tabId }: { path: string; tabId: string }) {
    return <LayoutActions pluginId={pluginId} decl={decl} tabId={tabId} />;
  };
}

/** The text editor wrapper of a custom editor with a side-by-side layout. */
export function layoutWrapper(pluginId: string, decl: CustomEditorDecl) {
  return function PluginEditorLayout({
    path,
    tabId,
    children,
    actionsInTabs = false,
  }: {
    path: string;
    tabId: string;
    children: ReactNode;
    actionsInTabs?: boolean;
  }) {
    const layout = useEditorLayouts((s) => layoutOf(pluginId, decl, tabId, s.byTab));
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
            <LayoutActions pluginId={pluginId} decl={decl} tabId={tabId} />
          </FloatingToolbar>
        )}
      </div>
    );
  };
}
