/** Project Quick Preview: a read-only source popup, never an editor tab or document attachment. */
import { useEffect, useRef, useState } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, highlightSpecialChars, lineNumbers } from "@codemirror/view";
import { syntaxHighlighting } from "@codemirror/language";
import clsx from "clsx";
import { editorsFor } from "@/editor/api";
import { fontExtension } from "@/editor/core/cm/setup";
import { openideaHighlightStyle } from "@/editor/core/cm/highlight";
import { languageDescriptionFor, loadSupport } from "@/editor/core/cm/languages";
import { openideaTheme } from "@/editor/core/cm/theme";
import { readFileText } from "@/editor/lineTokens";
import { useTx } from "@/platform/i18n";
import { basename, relativePath, useProject } from "@/platform/project";
import { Icon, Popup, Spinner, fileIconName, selectableText } from "@/ui";
import { closeFilePreview, type LspPopup } from "./popupStore";
import styles from "./Popups.module.css";

type FilePreview = Extract<LspPopup, { kind: "filePreview" }>;

export function FilePreviewPopup({ popup }: { popup: FilePreview }) {
  const host = useRef<HTMLDivElement>(null);
  const t = useTx();
  const root = useProject((s) => s.project?.root ?? "");
  const editorSettings = useProject((s) => s.settings?.editor);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let view: EditorView | null = null;
    const language = new Compartment();
    void (async () => {
      try {
        const open = editorsFor(popup.path)[0];
        const text = open ? open.view.state.doc.toString() : await readFileText(popup.path);
        if (!alive || !host.current) return;
        view = new EditorView({
          parent: host.current,
          state: EditorState.create({
            doc: text,
            extensions: [
              openideaTheme,
              syntaxHighlighting(openideaHighlightStyle),
              lineNumbers(),
              highlightSpecialChars(),
              fontExtension(editorSettings),
              language.of([]),
              EditorState.readOnly.of(true),
              EditorView.editable.of(false),
              EditorView.contentAttributes.of({
                "aria-label": t("Quick Preview"),
                class: selectableText,
                tabindex: "0",
              }),
            ],
          }),
        });
        setLoading(false);
        const firstLine = text.split(/\r\n?|\n/, 1)[0] ?? "";
        void languageDescriptionFor(popup.path, firstLine).then(async (desc) => {
          const support = desc ? await loadSupport(desc) : null;
          if (alive && support && view) view.dispatch({ effects: language.reconfigure(support) });
        });
      } catch (e) {
        if (alive) {
          setLoading(false);
          setError(String((e as Error)?.message ?? e));
        }
      }
    })();
    return () => {
      alive = false;
      view?.destroy();
    };
  }, [popup.path, editorSettings, t]);

  const name = basename(popup.path);
  return (
    <Popup
      open
      anchor={popup.anchor}
      placement="right-start"
      onClose={closeFilePreview}
      aria-label={t("Quick Preview")}
      className={styles.filePreviewPopup}
      autoFocus={false}
      resizable="both"
      initialSize={{ w: 720, h: 480 }}
      minWidth={320}
      minHeight={200}
    >
      <div className={styles.filePreviewFrame} data-testid="file-preview">
        <div className={styles.filePreviewHeader}>
          <Icon name={fileIconName(name, popup.path)} size={14} />
          <span className={styles.filePreviewPath} title={popup.path}>
            {relativePath(root, popup.path)}
          </span>
        </div>
        <div className={styles.filePreviewBody} aria-busy={loading || undefined}>
          <div ref={host} className={styles.filePreviewEditor} />
          {loading && (
            <div className={styles.filePreviewStatus}>
              <Spinner size={14} />
              <span>{t("Loading…")}</span>
            </div>
          )}
          {error && (
            <div className={clsx(styles.filePreviewStatus, styles.filePreviewError)} role="alert">
              {error}
            </div>
          )}
        </div>
      </div>
    </Popup>
  );
}
