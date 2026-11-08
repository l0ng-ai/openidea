import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { create } from "zustand";
import { EditorState } from "@codemirror/state";
import { EditorView, highlightSpecialChars, lineNumbers } from "@codemirror/view";
import { language, syntaxHighlighting } from "@codemirror/language";
import { tx } from "@/platform/i18n";
import { isImeKey } from "@/platform/ime";
import { executeAction, registerActions } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { bindingsFor, normalizeBinding, strokeOf } from "@/platform/keymap";
import {
  Button,
  Dialog,
  List,
  SearchField,
  SINGLE_FIRST,
  T,
  isRowSelected,
  listNavigate,
  rowSelectionMode,
  selectRow,
  selectableText,
  selectedRows,
} from "@/ui";
import { clipLabel, clipboardHistory, removeClipboardEntries } from "../clipboardHistory";
import { openideaHighlightStyle } from "../cm/highlight";
import { compartments } from "../cm/setup";
import { openideaTheme } from "../cm/theme";
import styles from "./PasteHistoryDialog.module.css";

interface Request {
  view: EditorView;
  paste: (text: string, linewise: boolean) => void;
}

const usePasteHistory = create<{ request: Request | null; seq: number }>(() => ({ request: null, seq: 0 }));
let commands: { paste: (text?: string) => void; remove: () => void } | null = null;

export function registerPasteHistoryActions() {
  return registerActions([
    {
      id: "editor.pasteHistory.paste",
      title: "Paste",
      hidden: true,
      when: "pasteHistoryOpen",
      keyWhen: "pasteHistoryListFocus",
      run: ({ arg }) => commands?.paste(typeof arg === "string" ? arg : undefined),
    },
    {
      id: "editor.pasteHistory.remove",
      title: "Delete",
      hidden: true,
      when: "pasteHistoryOpen",
      keyWhen: "pasteHistoryListFocus",
      run: () => commands?.remove(),
    },
  ]);
}

export function openPasteHistory(view: EditorView, paste: Request["paste"]) {
  usePasteHistory.setState((s) => ({ request: { view, paste }, seq: s.seq + 1 }));
}

export function PasteHistoryDialogHost() {
  const { request, seq } = usePasteHistory();
  if (!request) return null;
  return (
    <PasteHistoryDialog
      key={seq}
      {...request}
      onClose={() => {
        usePasteHistory.setState({ request: null });
        queueMicrotask(() => {
          if (request.view.dom.isConnected) request.view.focus();
        });
      }}
    />
  );
}

function PasteHistoryDialog({ view, paste, onClose }: Request & { onClose: () => void }) {
  const [entries, setEntries] = useState(clipboardHistory);
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState(SINGLE_FIRST);
  const search = useRef<HTMLInputElement>(null);
  const rows = entries
    .filter(({ text }) => text.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .map(({ text, linewise }) => ({ key: text, linewise, ...clipLabel(text) }));
  const selected = selectedRows(rows, selection);
  const preview = rows[selection.lead]?.key ?? "";

  const submit = (only?: string) => {
    const chosen = only === undefined ? selected : rows.filter((row) => row.key === only);
    const text = chosen.map((row) => row.key).join("\n");
    if (!chosen.length || !view.dom.isConnected || view.state.readOnly) return;
    onClose();
    // A single whole-line entry keeps pasting as whole lines; a merge pastes as text.
    paste(text, chosen.length === 1 && chosen[0]!.linewise);
  };
  const remove = () => {
    removeClipboardEntries(selected.map((row) => row.key));
    const remaining = rows.filter((row) => !selected.some((s) => s.key === row.key));
    const lead = Math.max(0, Math.min(selection.lead, remaining.length - 1));
    setEntries(clipboardHistory());
    setSelection({ lead, anchor: lead, keys: null });
    search.current?.focus();
  };
  const filter = (value: string) => {
    setQuery(value);
    setSelection(SINGLE_FIRST);
  };
  useLayoutEffect(() => {
    commands = { paste: submit, remove };
    return () => {
      commands = null;
    };
  });
  useEffect(() => {
    setContext("pasteHistoryOpen", true);
    return () => {
      setContext("pasteHistoryOpen", false);
      setContext("pasteHistoryListFocus", false);
    };
  }, []);
  const runPaste = (text?: string) => void executeAction("editor.pasteHistory.paste", text);
  const runRemove = () => void executeAction("editor.pasteHistory.remove");
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || isImeKey(e.nativeEvent)) return;
    const inSearch = e.target === search.current;
    const inList = e.target instanceof Element && !!e.target.closest('[role="listbox"]');
    if (!inSearch && !inList) return;
    const stroke = strokeOf(e.nativeEvent);
    const bound = (id: string) => bindingsFor(id).some((binding) => normalizeBinding(binding) === stroke);
    if (bound("editor.pasteHistory.paste")) {
      e.preventDefault();
      runPaste();
    } else if (bound("editor.pasteHistory.remove") && (!inSearch || !query || e.key !== "Backspace")) {
      e.preventDefault();
      runRemove();
    } else if (inSearch && ["ArrowUp", "ArrowDown", "PageUp", "PageDown"].includes(e.key)) {
      const next = listNavigate(e.key, { items: rows, active: selection.lead });
      if (next !== null) {
        e.preventDefault();
        setSelection(selectRow(rows, selection, next, rowSelectionMode(e)));
      }
    } else if (inList && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      filter(query + e.key);
      search.current?.focus();
    }
  };

  return (
    <Dialog
      open
      title="Choose Content to Paste"
      onClose={onClose}
      className={styles.dialog}
      width={680}
      resizable="both"
      minWidth={360}
      minHeight={320}
      buttons={[
        {
          label: "Paste",
          role: "default",
          onClick: () => runPaste(),
          disabled: !selected.length || view.state.readOnly,
        },
        { label: "Cancel", role: "cancel" },
      ]}
      footerStart={
        <Button disabled={!selected.length} onClick={runRemove}>
          <T>Delete</T>
        </Button>
      }
    >
      <div
        className={styles.body}
        onKeyDown={onKeyDown}
        onFocusCapture={(e) => setContext("pasteHistoryListFocus", !!e.target.closest('[role="listbox"]'))}
        onBlurCapture={() => setContext("pasteHistoryListFocus", false)}
      >
        <SearchField
          ref={search}
          data-autofocus=""
          aria-label="Filter clipboard history"
          placeholder="Filter clipboard history"
          value={query}
          onChange={filter}
        />
        <List
          items={rows}
          getKey={(row) => row.key}
          activeIndex={selection.lead}
          onSelect={(index, e) => setSelection(selectRow(rows, selection, index, rowSelectionMode(e)))}
          isSelected={(row) => isRowSelected(selection, row.key)}
          onActivate={(row, _index, e) => {
            if (e.type === "keydown") runPaste();
            else if (e.detail === 2) runPaste(row.key);
          }}
          rowHeight={28}
          className={styles.list}
          aria-label={tx("Clipboard history")}
          empty={<T>{entries.length ? "No matches" : "Nothing to paste: the clipboard history is empty"}</T>}
          renderItem={(row) => (
            <>
              <span className={styles.label}>{row.label}</span>
              <span className={styles.detail}>{row.detail ?? tx("1 line")}</span>
            </>
          )}
        />
        <PastePreview source={view} text={preview} />
      </div>
    </Dialog>
  );
}

function PastePreview({ source, text }: { source: EditorView; text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const preview = new EditorView({
      parent: ref.current!,
      state: EditorState.create({
        doc: text,
        extensions: [
          openideaTheme,
          syntaxHighlighting(openideaHighlightStyle),
          source.state.facet(language)?.extension ?? [],
          compartments.font.get(source.state) ?? [],
          EditorState.tabSize.of(source.state.tabSize),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.contentAttributes.of({ "aria-label": tx("Paste preview"), class: selectableText, tabindex: "0" }),
          lineNumbers(),
          highlightSpecialChars(),
        ],
      }),
    });
    return () => preview.destroy();
  }, [source, text]);
  return <div ref={ref} className={styles.preview} />;
}
