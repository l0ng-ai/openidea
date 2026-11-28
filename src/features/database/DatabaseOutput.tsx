import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useEditorRegistry, type TextEditorHandle } from "@/editor/api";
import { tx } from "@/platform/i18n";
import { basename } from "@/platform/project";
import { IconButton, Select } from "@/ui";
import { editorService } from "@/workbench/contributions";
import { onOutputReveal } from "./outputDestination";
import { ResultsContent } from "./ResultsView";
import { SQL_LANGUAGE } from "./sqlLanguage";
import { consoleSource, sourceById, targetLabel, useDatabase } from "./store";
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
  useEffect(() => {
    const followEditor = useEditorRegistry.subscribe(({ active }) => {
      const path = sqlPath(active);
      if (path) setClient((prev) => (prev.editor === path ? prev : { editor: path, manual: null }));
    });
    const followReveal = onOutputReveal((path) => {
      // Parsing may have finished after the user switched editors.
      if (sqlPath(useEditorRegistry.getState().active) === path) setClient({ editor: path, manual: null });
    });
    return () => {
      followEditor();
      followReveal();
    };
  }, []);

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
  const paths = [...new Set(path ? [path, ...clients] : clients)];
  const labels = useDatabase(
    useShallow(() =>
      paths.map((value) => {
        const target = consoleSource(value);
        const name = basename(value);
        return target && sourceById(target) ? `${name} · ${targetLabel(target)}` : name;
      }),
    ),
  );
  const choices = paths.map((value, index) => {
    const label = labels[index]!;
    return {
      value,
      label: labels.indexOf(label) === labels.lastIndexOf(label) ? label : value,
      detail: value,
      verbatim: true,
      verbatimDetail: true,
    };
  });
  return (
    <ResultsContent
      path={path ?? ""}
      clientSelector={
        <>
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
          <IconButton
            icon="edit-source"
            title="Open Client in Editor"
            size="small"
            disabled={!path}
            onClick={() => {
              if (path) void editorService().openFile(path, { focus: true });
            }}
          />
        </>
      }
    />
  );
}
