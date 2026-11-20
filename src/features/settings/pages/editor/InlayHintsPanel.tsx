import { useState } from "react";
import { monoFontFamily } from "@/platform/fonts";
import { useTx } from "@/platform/i18n";
import { List, T } from "@/ui";
import { SearchLabel, Toggle } from "../../components/Form";
import { useSearchQuery, useSetting } from "../../components/context";
import { labelMatches, queryTerms } from "../../model/pages";
import styles from "./InlayHintsPanel.module.css";

const EXAMPLES = [
  {
    id: "types",
    label: "Types",
    language: "rust",
    file: "total.rs",
    parts: ["fn checkout() {\n    let total", { annotation: ": f64" }, ' = 42.0 * 1.05;\n    println!("{total}");\n}'],
  },
  {
    id: "parameters",
    label: "Parameter names",
    language: "rust",
    file: "layout.rs",
    parts: ["fn layout() {\n    resize(", { annotation: "width:" }, "640, ", { annotation: "height:" }, "480);\n}"],
  },
  {
    id: "other",
    label: "Other hints (chaining, closing labels…)",
    language: "go",
    file: "retry.go",
    parts: ["package retry\n\nconst delay = 5 * 60", { annotation: "= 300" }],
  },
] as const;

export const inlayHintLabels = EXAMPLES.map((example) => example.label);

export function InlayHintsPanel() {
  const t = useTx();
  const query = useSearchQuery();
  const [selection, setSelection] = useState({ query: "", index: 0 });
  const terms = queryTerms(query);
  const match = terms.length
    ? EXAMPLES.findIndex((example) => terms.every((term) => labelMatches(example.label, term)))
    : -1;
  const index = match >= 0 && selection.query !== query ? match : selection.index;
  const example = EXAMPLES[index]!;
  const [enabled] = useSetting<boolean>("editor.inlayHints");
  const [shown, setShown] = useSetting<boolean>(`editor.inlay.${example.id}`);
  const [disabledLanguages] = useSetting<string[]>("editor.inlay.disabledLanguages");
  const [family] = useSetting<string>("editor.fontFamily");
  const [fallback] = useSetting<string>("editor.fallbackFont");
  const [size] = useSetting<number>("editor.fontSize");
  const [lineHeight] = useSetting<number>("editor.lineHeight");
  const showHint = enabled && shown && !disabledLanguages.includes(example.language);

  return (
    <div className={styles.split}>
      <List
        className={styles.categories}
        aria-label={t("Inlay hint categories")}
        items={EXAMPLES}
        getKey={(item) => item.id}
        activeIndex={index}
        onActiveChange={(index) => setSelection({ query, index })}
        renderItem={(item) => (
          <span className={styles.category} title={t(item.label)}>
            <SearchLabel text={item.label} />
          </span>
        )}
      />
      <div className={styles.details}>
        <Toggle label={example.label} checked={shown} onChange={setShown} disabled={!enabled} />
        <section className={styles.preview} aria-label={t("Inlay hint preview")}>
          <header className={styles.previewHeader}>
            <T>Preview</T>
            <span>{example.file}</span>
          </header>
          <pre
            className={styles.code}
            style={{
              fontFamily: monoFontFamily(family, fallback, "var(--font-mono)"),
              fontSize: size,
              lineHeight: `${lineHeight}px`,
            }}
          >
            <code>
              {example.parts.map((part, i) =>
                typeof part === "string"
                  ? part
                  : showHint && (
                      <span className={styles.hint} key={i}>
                        {part.annotation}
                      </span>
                    ),
              )}
            </code>
          </pre>
        </section>
      </div>
    </div>
  );
}
