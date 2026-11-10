/** Inspect Code, Locate Duplicates and Search / Replace Structurally dialogs. */
import { useEffect, useMemo, useState } from "react";
import {
  call,
  commands,
  isTauri,
  type DuplicateOptions,
  type StructuralFile,
  type StructuralLanguage,
  type WorkspaceEdit,
} from "@/platform/ipc";
import { executeAction } from "@/platform/actions";
import { activeProfileId, listProfiles, validateInspections, type ProfileId } from "@/platform/inspections";
import { basename, useProject } from "@/platform/project";
import { Button, Checkbox, Dialog, Input, Select, Spinner, T } from "@/ui";
import { ScopeFields, openDialog } from "./dialogs";
import { locateDuplicates, loadDuplicateOptions } from "./duplicates";
import { runInspection } from "./inspect";
import { runCodeCleanup, type CleanupOptions } from "./cleanup";
import { currentFile, defaultScope, type ScopeChoice } from "./scope";
import {
  applyStructuralReplace,
  buildReplaceEdit,
  loadStructuralForm,
  matchKey,
  saveStructuralForm,
  searchStructurally,
  showStructuralResults,
  type StructuralForm,
} from "./structural";
import styles from "./Analysis.module.css";
import { tx } from "@/platform/i18n";
import { notifications } from "@/workbench/contributions";

function InspectCodeDialog({ onClose }: { onClose: () => void }) {
  const [scope, setScope] = useState<ScopeChoice>(() => defaultScope());
  const [profile, setProfile] = useState<ProfileId>(activeProfileId);
  const hasProject = useProject((s) => !!s.project);
  const settings = useProject((s) => s.settings);
  const profiles = useMemo(
    () =>
      listProfiles(validateInspections(settings?.inspections), hasProject).map((p) => ({
        value: p.id,
        label: p.label,
        detail: p.level === "project" ? "Project" : "IDE",
      })),
    [hasProject, settings],
  );
  const ok = () => {
    onClose();
    void runInspection(scope, profile);
  };
  return (
    <Dialog
      open
      title="Specify Inspection Scope"
      onClose={onClose}
      width={440}
      buttons={[
        { label: "Analyze", role: "default", onClick: ok },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.form}>
        <ScopeFields name="inspect-scope" value={scope} onChange={setScope} />
        <div className={styles.fieldRow}>
          <span>
            <T>Inspection profile:</T>
          </span>
          <Select
            className={styles.grow}
            aria-label="Inspection profile"
            value={profile}
            options={profiles}
            onChange={setProfile}
          />
          <Button
            aria-label="Configure inspections"
            onClick={() => void executeAction("file.settings", "editor.inspections")}
          >
            …
          </Button>
        </div>
        <div className={styles.hint}>
          <T>Files are checked by their language servers; files without one are skipped.</T>
        </div>
      </div>
    </Dialog>
  );
}

const CLEANUP_SCOPES = ["project", "directory", "file", "changed"] as const;

function CodeCleanupDialog({ onClose }: { onClose: () => void }) {
  const [scope, setScope] = useState<ScopeChoice>(() => defaultScope(currentFile() ? "file" : "project"));
  const [options, setOptions] = useState<CleanupOptions>({ fixAll: true, optimizeImports: true, reformat: true });
  const any = options.fixAll || options.optimizeImports || options.reformat;
  const ok = () => {
    if (!any) return;
    onClose();
    void runCodeCleanup(scope, options);
  };
  return (
    <Dialog
      open
      title="Run Code Cleanup"
      onClose={onClose}
      width={440}
      buttons={[
        { label: "OK", role: "default", disabled: !any, onClick: ok },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.form}>
        <ScopeFields name="cleanup-scope" value={scope} onChange={setScope} kinds={CLEANUP_SCOPES} />
        <Checkbox
          checked={options.fixAll}
          onChange={(fixAll) => setOptions({ ...options, fixAll })}
          label="Apply the language servers' automatic fixes"
        />
        <Checkbox
          checked={options.optimizeImports}
          onChange={(optimizeImports) => setOptions({ ...options, optimizeImports })}
          label="Optimize imports"
        />
        <Checkbox
          checked={options.reformat}
          onChange={(reformat) => setOptions({ ...options, reformat })}
          label="Reformat code"
        />
        <div className={styles.hint}>
          <T>Files are cleaned up by their language servers and saved; files without one are skipped.</T>
        </div>
      </div>
    </Dialog>
  );
}

function DuplicatesDialog({ onClose }: { onClose: () => void }) {
  const [scope, setScope] = useState<ScopeChoice>(() => defaultScope());
  const [options, setOptions] = useState<DuplicateOptions>(loadDuplicateOptions);
  const [minText, setMinText] = useState(String(options.minTokens));
  const min = Number(minText);
  const valid = Number.isInteger(min) && min >= 10 && min <= 10_000;
  const ok = () => {
    if (!valid) return;
    onClose();
    void locateDuplicates(scope, { ...options, minTokens: min });
  };
  return (
    <Dialog
      open
      title="Locate Duplicates"
      onClose={onClose}
      width={440}
      buttons={[
        { label: "OK", role: "default", disabled: !valid, onClick: ok },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.form}>
        <ScopeFields name="duplicates-scope" value={scope} onChange={setScope} />
        <label className={styles.fieldRow}>
          <span>
            <T>Minimum size</T>
          </span>
          <Input
            className={styles.number}
            type="number"
            min={10}
            value={minText}
            invalid={!valid}
            onChange={(e) => setMinText(e.target.value)}
            aria-label="Minimum duplicate size in tokens"
          />
          <span className={styles.hint}>
            <T>tokens</T>
          </span>
        </label>
        <Checkbox
          checked={options.anonymizeIdentifiers}
          onChange={(v) => setOptions({ ...options, anonymizeIdentifiers: v })}
          label="Anonymize variables, fields, methods and types"
        />
        <Checkbox
          checked={options.anonymizeLiterals}
          onChange={(v) => setOptions({ ...options, anonymizeLiterals: v })}
          label="Anonymize literals"
        />
      </div>
    </Dialog>
  );
}

function useStructuralLanguages(): StructuralLanguage[] | null {
  const [langs, setLangs] = useState<StructuralLanguage[] | null>(() => (isTauri() ? null : []));
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    void call(commands.structuralLanguages()).then(
      (l) => alive && setLangs(l),
      () => alive && setLangs([]),
    );
    return () => {
      alive = false;
    };
  }, []);
  return langs;
}

/** Template validation while typing (debounced). */
function useTemplateError(pattern: string, language: string): string | null {
  const key = `${language}\u0000${pattern}`;
  const [result, setResult] = useState<{ key: string; error: string | null }>({ key: "", error: null });
  const applicable = isTauri() && !!pattern.trim() && !!language;
  useEffect(() => {
    if (!applicable) return;
    let alive = true;
    const t = setTimeout(() => {
      void call(commands.structuralValidate({ pattern, language, replacement: null, maxMatches: 0 })).then(
        () => alive && setResult({ key, error: null }),
        (e) => alive && setResult({ key, error: e instanceof Error ? e.message : String(e) }),
      );
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [applicable, key, pattern, language]);
  return applicable && result.key === key ? result.error : null;
}

function StructuralDialog({ replace, onClose }: { replace: boolean; onClose: () => void }) {
  const [form, setForm] = useState<StructuralForm>(loadStructuralForm);
  const [scope, setScope] = useState<ScopeChoice>(() => defaultScope());
  const [busy, setBusy] = useState(false);
  const languages = useStructuralLanguages();
  // The editor's language when it has a grammar, else the first supported one.
  const language =
    languages && languages.length && !languages.some((l) => l.id === form.language) ? languages[0]!.id : form.language;
  const error = useTemplateError(form.pattern, language);
  const options = useMemo(() => (languages ?? []).map((l) => ({ value: l.id, label: l.name })), [languages]);
  const ready = !!form.pattern.trim() && !!language && !error && !busy;

  const run = async () => {
    if (!ready) return;
    saveStructuralForm({ ...form, language });
    setBusy(true);
    const query = { pattern: form.pattern, language, replacement: replace ? form.replacement : null, maxMatches: 0 };
    const result = await searchStructurally(query, scope);
    setBusy(false);
    if (!result) return;
    onClose();
    if (!replace) {
      await showStructuralResults(form.pattern, result.files, result.summary);
    } else if (!result.files.length) {
      await showStructuralResults(form.pattern, result.files, result.summary);
    } else {
      await showReplacePreview(result.files);
    }
  };

  return (
    <Dialog
      open
      title={replace ? "Structural Replace" : "Structural Search"}
      onClose={onClose}
      width={620}
      footerStart={busy ? <Spinner size={14} label="Searching" /> : undefined}
      buttons={[
        { label: replace ? "Find…" : "Find", role: "default", disabled: !ready, onClick: () => void run() },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.form}>
        <div className={styles.fieldRow}>
          <span>
            <T>Language</T>
          </span>
          <Select
            value={language || null}
            options={options}
            onChange={(language) => setForm({ ...form, language })}
            placeholder={languages ? "No languages" : "Loading…"}
            className={styles.languageSelect}
            aria-label="Language"
          />
        </div>
        <label className={styles.fieldLabel} htmlFor="ssr-template">
          <T>Search template</T>
        </label>
        <textarea
          id="ssr-template"
          className={styles.template}
          spellCheck={false}
          value={form.pattern}
          placeholder="$a$.equals($b$)"
          onChange={(e) => setForm({ ...form, pattern: e.target.value })}
          data-autofocus=""
        />
        {error && <div className={styles.error}>{error}</div>}
        {replace && (
          <>
            <label className={styles.fieldLabel} htmlFor="ssr-replacement">
              <T>Replace template</T>
            </label>
            <textarea
              id="ssr-replacement"
              className={styles.template}
              spellCheck={false}
              value={form.replacement}
              placeholder="Objects.equals($a$, $b$)"
              onChange={(e) => setForm({ ...form, replacement: e.target.value })}
            />
          </>
        )}
        <div className={styles.hint}>
          <T>Placeholders:</T> <code>$name$</code> or <code>$NAME</code> <T>match one node,</T> <code>$$$NAME</code>{" "}
          <T>any number of nodes (arguments, statements). A placeholder used twice must match equal code.</T>
        </div>
        <ScopeFields name="ssr-scope" value={scope} onChange={setScope} />
      </div>
    </Dialog>
  );
}

function ReplacePreviewDialog({
  files,
  preconditions,
  onClose,
}: {
  files: StructuralFile[];
  preconditions: WorkspaceEdit["preconditions"];
  onClose: () => void;
}) {
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const edit = useMemo(() => buildReplaceEdit(files, excluded), [files, excluded]);
  const count = edit.files.reduce((n, f) => n + (f.kind === "edit" ? f.edits.length : 0), 0);
  const toggle = (key: string, on: boolean) =>
    setExcluded((s) => {
      const next = new Set(s);
      if (on) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <Dialog
      open
      title="Replace Structurally: Preview"
      onClose={onClose}
      width={720}
      footerStart={
        <span
          className={styles.hint}
        >{`${count} replacement${count === 1 ? "" : "s"} in ${edit.files.length} file${edit.files.length === 1 ? "" : "s"}`}</span>
      }
      buttons={[
        {
          label: "Replace",
          role: "default",
          disabled: count === 0,
          onClick: () => {
            onClose();
            void applyStructuralReplace({ ...edit, preconditions });
          },
        },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <ul className={styles.previewList} aria-label={tx("Replacements")}>
        {files.flatMap((f) =>
          f.matches.map((m, i) => {
            const key = matchKey(f.path, i);
            return (
              <li key={key} className={styles.previewItem}>
                <Checkbox
                  checked={!excluded.has(key)}
                  onChange={(on) => toggle(key, on)}
                  aria-label={tx`Replace in ${f.relPath}:${m.range.start.line + 1}`}
                />
                <div className={styles.previewBody}>
                  <span className={styles.previewWhere}>
                    {basename(f.path)}:{m.range.start.line + 1} · {f.relPath}
                  </span>
                  <pre className={styles.previewOld}>{m.text}</pre>
                  <pre className={styles.previewNew}>{m.replacement ?? ""}</pre>
                </div>
              </li>
            );
          }),
        )}
      </ul>
    </Dialog>
  );
}

export const showInspectCodeDialog = () => openDialog((close) => <InspectCodeDialog onClose={close} />);
export const showDuplicatesDialog = () => openDialog((close) => <DuplicatesDialog onClose={close} />);
export const showCodeCleanupDialog = () => openDialog((close) => <CodeCleanupDialog onClose={close} />);
export const showStructuralDialog = (replace: boolean) =>
  openDialog((close) => <StructuralDialog replace={replace} onClose={close} />);
export const showReplacePreview = async (files: StructuralFile[]) => {
  try {
    const edit = buildReplaceEdit(files, new Set());
    const prepared = isTauri() ? await call(commands.prepareWorkspaceEdit(edit)) : edit;
    openDialog((close) => (
      <ReplacePreviewDialog files={files} preconditions={prepared.preconditions} onClose={close} />
    ));
  } catch (error) {
    notifications().notify({
      level: "error",
      title: "Cannot preview replacements",
      body: error instanceof Error ? error.message : String(error),
    });
  }
};
