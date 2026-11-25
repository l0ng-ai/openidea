/** The tab Diagrams › Show Diagram opens: a read-only ER diagram drawn by the Markdown preview's Mermaid renderer. */
import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { renderMermaidIn } from "@/features/viewers/markdown/mermaid";
import { subscribeTheme, themeKey } from "@/platform/themeWatch";
import type { EditorInput } from "@/workbench/contributions";
import type { DiagramData } from "./erDiagram";
import styles from "./Diagram.module.css";

export function DiagramEditor({ input }: { input: EditorInput }) {
  const { source } = input.data as DiagramData;
  const block = useRef<HTMLDivElement>(null);
  const previous = useRef<Node[]>([]);
  // Drawn in the active theme's colours: a theme change redraws it.
  const theme = useSyncExternalStore(subscribeTheme, themeKey, () => "");
  useLayoutEffect(() => {
    const root = block.current;
    if (!root) return;
    const pass = renderMermaidIn(root, previous.current);
    return () => pass.cancel();
  }, [source, theme]);
  return (
    <div className={styles.diagram} ref={block}>
      <div data-mermaid="">
        <pre>
          <code className="language-mermaid">{source}</code>
        </pre>
      </div>
    </div>
  );
}
