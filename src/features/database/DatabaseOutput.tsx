import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useEditorRegistry, type TextEditorHandle } from "@/editor/api";
import { tx } from "@/platform/i18n";
import { basename } from "@/platform/project";
import { Select } from "@/ui";
import { ResultsContent } from "./ResultsView";
import { SQL_LANGUAGE } from "./sqlLanguage";
import { useDatabase } from "./store";
import styles from "./Database.module.css";

function sqlPath(active: TextEditorHandle | null) {
  const ctx = active?.ctx;
  return ctx?.language === SQL_LANGUAGE && !ctx.virtual ? ctx.path : null;
}

export function DatabaseOutput() {
  const [{ editor, manual }, setClient] = useState(() => ({
    editor: sqlPath(useEditorRegistry.getState().active),
    manual: null as string | null,
  }));
  useEffect(
    () =>
      useEditorRegistry.subscribe(({ active }) => {
        const path = sqlPath(active);
        if (path) setClient((prev) => (prev.editor === path ? prev : { editor: path, manual: null }));
      }),
    [],
  );

  const clients = useDatabase(
    useShallow((s) => [
      ...new Set([
        ...s.results.map((tab) => tab.path),
        ...s.output.flatMap((line) => (line.path ? [line.path] : [])),
        ...Object.keys(s.executions),
      ]),
    ]),
  );
  const path = manual ?? editor ?? clients.at(-1) ?? null;
  const choices = [...new Set(path ? [path, ...clients] : clients)].map((value) => ({
    value,
    label: basename(value),
    detail: value,
    verbatim: true,
    verbatimDetail: true,
  }));
  return (
    <ResultsContent
      path={path ?? ""}
      clientSelector={
        <Select
          aria-label={tx("SQL client")}
          placeholder="No SQL client"
          variant="ghost"
          className={styles.outputClient}
          options={choices}
          value={path}
          disabled={!choices.length}
          searchable
          onChange={(path) => setClient((prev) => ({ ...prev, manual: path }))}
        />
      }
    />
  );
}
