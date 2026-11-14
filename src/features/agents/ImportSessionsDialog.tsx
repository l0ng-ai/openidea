/** Import Sessions from Other Apps: pick sessions a scan found now, and import them as tasks. */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Button, Dialog, Icon, List, SearchField, Spinner, T, listNavigate, rowSelectionMode, selectRow } from "@/ui";
import { hasPrimaryModifier } from "@/platform/keymap";
import { relativePath, useProject } from "@/platform/project";
import { useTx } from "@/platform/i18n";
import { age, providerIcon } from "./model";
import { externalKey, hideImportSessions, importExternalSessions, refreshExternalSessions, useAgents } from "./store";
import styles from "./Agents.module.css";

/** The backend lists at most this many sessions, newest first. */
const LISTED_MAX = 50;
const ROW = 24;

interface Row {
  key: string;
  provider: string;
  sessionId: string;
  title: string;
  cwd: string | null;
  folder: string;
  updatedMs: number;
}

interface Selection {
  leadKey: string | null;
  anchorKey: string | null;
  keys: ReadonlySet<string> | null;
}

export function ImportSessionsOverlay() {
  const open = useAgents((s) => s.importOpen);
  return open ? <ImportSessionsDialog /> : null;
}

/** `cwd` shown relative to the project; empty when it is the project root. */
function folderOf(cwd: string | null, root: string | undefined): string {
  if (!cwd || cwd === root) return "";
  return root ? relativePath(root, cwd) : cwd;
}

function ImportSessionsDialog() {
  const tx = useTx();
  const listId = useId();
  const root = useProject((s) => s.project?.root);
  const external = useAgents((s) => s.external);
  const externalError = useAgents((s) => s.externalError);
  const importing = useAgents((s) => s.importing);
  const providers = useAgents((s) => s.providers);
  // Scanned on every open, so sessions started meanwhile show up; no stale rows or "nothing found" first.
  const [loading, setLoading] = useState(true);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    void refreshExternalSessions().finally(() => live.current && setLoading(false));
    return () => {
      live.current = false;
    };
  }, []);
  const [query, setQuery] = useState("");
  // By key, so a filter or rescan never moves the selection onto another session.
  const [sel, setSel] = useState<Selection>({ leadKey: null, anchorKey: null, keys: null });
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  // The batch's rows, listed while it imports (they leave `external` one by one).
  const [frozen, setFrozen] = useState<Row[] | null>(null);
  const abort = useRef<AbortController | null>(null);

  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase();
    return external
      .map((s) => ({
        key: externalKey(s.provider, s.sessionId),
        provider: s.provider,
        sessionId: s.sessionId,
        title: s.title,
        cwd: s.cwd ?? null,
        folder: folderOf(s.cwd ?? null, root),
        updatedMs: s.updatedMs ?? 0,
      }))
      .filter((r) => !importing.has(r.key))
      .filter((r) => !q || r.title.toLowerCase().includes(q) || r.folder.toLowerCase().includes(q));
  }, [external, importing, query, root]);
  const view = frozen ?? rows;

  // The lead is drawn as selected: keep it on a selected row the list still shows, else on none.
  let lead = view.findIndex((r) => r.key === sel.leadKey);
  if (sel.keys) {
    if (lead < 0 || !sel.keys.has(view[lead]!.key)) lead = view.findIndex((r) => sel.keys!.has(r.key));
  } else if (lead < 0) lead = view.length ? 0 : -1;
  const chosen = sel.keys ? view.filter((r) => sel.keys!.has(r.key)) : lead >= 0 ? [view[lead]!] : [];
  const busy = progress !== null;
  const shown = !loading && !externalError;

  const select = (index: number, e?: KeyboardEvent | MouseEvent) => {
    if (busy) return;
    const anchor = view.findIndex((r) => r.key === sel.anchorKey);
    const next = selectRow(
      view,
      { lead, anchor: anchor < 0 ? lead : anchor, keys: sel.keys },
      index,
      rowSelectionMode(e),
    );
    setSel({ leadKey: view[next.lead]?.key ?? null, anchorKey: view[next.anchor]?.key ?? null, keys: next.keys });
  };
  const selectAll = () => {
    if (busy || !view.length) return;
    setSel({
      leadKey: view[Math.max(lead, 0)]!.key,
      anchorKey: view[0]!.key,
      keys: new Set(view.map((r) => r.key)),
    });
  };
  const importChosen = () => {
    if (busy || !shown || !chosen.length) return;
    const batch = chosen.map((r) => ({ provider: r.provider, sessionId: r.sessionId, title: r.title }));
    setFrozen(chosen);
    setSel({ leadKey: chosen[0]!.key, anchorKey: chosen[0]!.key, keys: new Set(chosen.map((r) => r.key)) });
    setProgress({ done: 0, total: batch.length });
    const controller = new AbortController();
    abort.current = controller;
    void importExternalSessions(
      batch,
      (done) => live.current && setProgress({ done, total: batch.length }),
      controller.signal,
    ).finally(() => live.current && hideImportSessions());
  };
  // Cancel, Esc and the close button stop a running batch after the import in flight.
  const close = () => {
    abort.current?.abort();
    hideImportSessions();
  };
  const onFilterKey = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      importChosen();
      return;
    }
    // Home / End move the caret in the filter text.
    if (e.key === "Home" || e.key === "End") return;
    const next = listNavigate(e.key, { items: view, active: lead, pageSize: 10 });
    if (next === null) return;
    e.preventDefault();
    select(next, e);
  };
  const onListKey = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      importChosen();
    } else if (e.key.toLowerCase() === "a" && hasPrimaryModifier(e)) {
      e.preventDefault();
      selectAll();
    }
  };
  const providerName = (id: string) => providers.find((p) => p.id === id)?.name ?? id;
  const importLabel = chosen.length > 1 ? tx`Import ${chosen.length}` : tx("Import");

  return (
    <Dialog
      open
      onClose={close}
      title="Import Sessions from Other Apps"
      width={560}
      footerStart={
        <span className={styles.chooserFooter}>
          <Button onClick={selectAll} disabled={busy || !shown || !view.length}>
            <T>Select All</T>
          </Button>
          {progress ? (
            <span className={styles.chooserHint}>
              {tx`Importing ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`}
            </span>
          ) : shown && external.length >= LISTED_MAX ? (
            <span className={styles.chooserHint}>
              <T>Only the 50 most recent sessions are shown.</T>
            </span>
          ) : null}
        </span>
      }
      buttons={[
        { label: "Cancel", role: "cancel" },
        { label: importLabel, role: "default", onClick: importChosen, disabled: busy || !shown || !chosen.length },
      ]}
    >
      <div className={styles.chooser}>
        <SearchField
          value={query}
          onChange={setQuery}
          clearable
          placeholder={tx("Filter sessions")}
          aria-label={tx("Filter sessions")}
          role="combobox"
          aria-expanded
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={shown && lead >= 0 ? `${listId}-${lead}` : undefined}
          onKeyDown={onFilterKey}
        />
        <div
          className={styles.chooserList}
          onKeyDown={onListKey}
          onDoubleClick={(e) => {
            if ((e.target as Element).closest('[role="option"]')) importChosen();
          }}
        >
          {loading ? (
            <div className={styles.loading}>
              <Spinner />
            </div>
          ) : externalError ? (
            <div className={styles.empty}>{externalError}</div>
          ) : (
            <List<Row>
              id={listId}
              items={view}
              getKey={(r) => r.key}
              activeIndex={lead}
              onSelect={select}
              isSelected={(r) => !!sel.keys?.has(r.key)}
              rowHeight={ROW}
              aria-label={tx("Sessions from other apps")}
              empty={
                <div className={styles.empty}>
                  {query.trim() ? <T>No matching sessions</T> : <T>No sessions from other apps</T>}
                </div>
              }
              renderItem={(r) => (
                <span className={styles.chooserRow} title={r.cwd ? `${r.title}\n${r.cwd}` : r.title}>
                  <Icon name={providerIcon(r.provider)} size={16} label={providerName(r.provider)} />
                  <span className={styles.title}>{r.title}</span>
                  {r.folder && <span className={styles.chooserFolder}>{r.folder}</span>}
                  <span className={styles.age}>{age(r.updatedMs)}</span>
                </span>
              )}
            />
          )}
        </div>
      </div>
    </Dialog>
  );
}
