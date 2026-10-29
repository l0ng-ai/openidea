import { useEffect, useMemo, useState } from "react";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, type LanguageSupport } from "@codemirror/language";
import { highlightTree } from "@lezer/highlight";
import { findLanguageDescription, loadSupport, loadedSupport } from "@/editor/core/cm/languages";
import { openideaHighlightStyle } from "@/editor/core/cm/highlight";

const sql = findLanguageDescription("SQL", "console.sql");

/** Render with the same language mode and highlight style as a SQL console. */
export function SqlHighlight({ text }: { text: string }) {
  const [support, setSupport] = useState<LanguageSupport | null>(() => loadedSupport(sql));
  useEffect(() => {
    if (!sql || support) return;
    let mounted = true;
    void loadSupport(sql).then((value) => {
      if (mounted) setSupport(value);
    });
    return () => {
      mounted = false;
    };
  }, [support]);
  const pieces = useMemo(() => {
    if (!support) return [<span key={0}>{text}</span>];
    const state = EditorState.create({ doc: text, extensions: [support] });
    const tree = ensureSyntaxTree(state, text.length, 100);
    if (!tree) return [<span key={0}>{text}</span>];
    const result: React.ReactNode[] = [];
    let offset = 0;
    highlightTree(tree, openideaHighlightStyle, (from, to, classes) => {
      // Every piece is an element: the overlay is a flex row, which drops bare whitespace-only text.
      if (from > offset) result.push(<span key={`t${offset}`}>{text.slice(offset, from)}</span>);
      result.push(
        <span key={from} className={classes}>
          {text.slice(from, to)}
        </span>,
      );
      offset = to;
    });
    if (offset < text.length) result.push(<span key={`t${offset}`}>{text.slice(offset)}</span>);
    return result;
  }, [support, text]);
  return (
    <>
      <style>{openideaHighlightStyle.module?.getRules()}</style>
      {pieces}
    </>
  );
}
