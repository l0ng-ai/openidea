/** "New ▸ <template>" dialog: template chooser, then name + kind (IDEA's New Class dialog). */
import { useEffect, useEffectEvent, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { create } from "zustand";
import clsx from "clsx";
import { relativePath, useProject } from "@/platform/project";
import { isImeKey } from "@/platform/ime";
import { notifications } from "@/workbench/contributions";
import { Dialog, Icon, Input, List, listNavigate } from "@/ui";
import { createFromTemplate, packageFor, packageStyleFor } from "./create";
import { planFile, withKind, type FileTemplate } from "./model";
import { useFileTemplates } from "./store";
import styles from "./NewFileDialog.module.css";
import { tx, VerbatimTextContext } from "@/platform/i18n";

interface Request {
  directory: string;
  templateId?: string;
  /** Prefilled name (e.g. Go to Test › Create New Test…). */
  name?: string;
  /** Preselected kind id. */
  kindId?: string;
  /** An ad-hoc template contributed by another feature (New › HTTP Request). */
  template?: FileTemplate;
}

const useNewFile = create<{ request: Request | null; seq: number }>(() => ({ request: null, seq: 0 }));

export function openNewFileDialog(r: Request) {
  useNewFile.setState((s) => ({ request: r, seq: s.seq + 1 }));
}

const close = () => useNewFile.setState({ request: null });

export function NewFileDialogHost() {
  const { request, seq } = useNewFile();
  const templates = useFileTemplates((s) => s.templates);
  const enabled = useMemo(() => templates.filter((t) => t.enabled !== false), [templates]);
  const [picked, setPicked] = useState<{ seq: number; id: string } | null>(null);
  if (!request) return null;
  const id = request.templateId ?? (picked?.seq === seq ? picked.id : undefined);
  const template = request.template ?? (id ? templates.find((t) => t.id === id) : undefined);
  if (template)
    return (
      <NameStep
        key={`${seq}:${template.id}`}
        template={template}
        directory={request.directory}
        initialName={request.name ?? template.defaultName}
        initialKind={request.kindId}
      />
    );
  return (
    <TemplateStep
      key={seq}
      templates={enabled}
      directory={request.directory}
      onPick={(t) => setPicked({ seq, id: t.id })}
    />
  );
}

function TemplateStep({
  templates,
  directory,
  onPick,
}: {
  templates: FileTemplate[];
  directory: string;
  onPick: (t: FileTemplate) => void;
}) {
  const [active, setActive] = useState(0);
  const root = useProject((s) => s.project?.root ?? "");
  const onKeyDown = (e: KeyboardEvent) => {
    if (isImeKey(e.nativeEvent)) return;
    const next = listNavigate(e.key, { items: templates, active, wrap: true });
    if (next !== null) {
      e.preventDefault();
      setActive(next);
    } else if (e.key === "Enter" && templates[active]) {
      e.preventDefault();
      onPick(templates[active]);
    }
  };
  return (
    <Dialog open onClose={close} title="New" width={320} position="top" aria-label="New file from template">
      <div className={styles.chooser} tabIndex={0} data-autofocus onKeyDown={onKeyDown}>
        <div className={styles.target}>{relativePath(root, directory) || "/"}</div>
        <List
          items={templates}
          getKey={(t) => t.id}
          activeIndex={active}
          onActiveChange={setActive}
          onActivate={(t) => onPick(t)}
          focusable={false}
          hoverSelects
          rowHeight={24}
          className={styles.templateList}
          aria-label="File templates"
          renderItem={(t) => (
            <span className={styles.templateRow}>
              <Icon name={t.icon} size={16} className={styles.icon} />
              {t.name}
            </span>
          )}
        />
      </div>
    </Dialog>
  );
}

function NameStep({
  template,
  directory,
  initialName,
  initialKind,
}: {
  template: FileTemplate;
  directory: string;
  initialName?: string;
  initialKind?: string;
}) {
  const [name, setName] = useState(template.fileName ?? initialName ?? "");
  const variables = template.variables ?? [];
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(variables.map((v) => [v.name, ""])),
  );
  const active = useRef(true);
  const submitting = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const [kind, setKind] = useState(() =>
    Math.max(
      0,
      template.kinds.findIndex((k) => k.id === initialKind),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pkg, setPkg] = useState("");
  const root = useProject((s) => s.project?.root ?? "");
  const effective = withKind(template, template.kinds[kind]);
  const plan = planFile(effective, directory, name);
  const packageStyle = packageStyleFor(effective);

  useEffect(() => {
    if (!packageStyle) return;
    let live = true;
    void packageFor(withKind(template, template.kinds[kind]), plan?.directory ?? directory).then(
      (p) => live && setPkg(p),
    );
    return () => {
      live = false;
    };
  }, [template, kind, directory, plan?.directory, packageStyle]);

  const submit = async () => {
    if (submitting.current) return;
    if (!plan) {
      setError(tx(name.trim() ? "Invalid name" : "Enter a name"));
      return;
    }
    if (variables.some((v) => !values[v.name]?.trim())) {
      setError(tx("Enter a value for each variable"));
      return;
    }
    submitting.current = true;
    setBusy(true);
    let created = false;
    try {
      await createFromTemplate(
        template,
        template.kinds[kind] ?? template.kinds[0]!,
        directory,
        name,
        () => {
          created = true;
          if (active.current) close();
        },
        values,
        () => !active.current,
      );
    } catch (e) {
      if (created) {
        notifications().notify({
          level: "error",
          title: "Could not fill the new file",
          body: e instanceof Error ? e.message : String(e),
        });
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
      submitting.current = false;
      setBusy(false);
    }
  };

  const autoCreate = useEffectEvent(submit);
  useEffect(() => {
    if (template.fileName === undefined || variables.length) return;
    const timer = setTimeout(() => void autoCreate(), 0);
    return () => clearTimeout(timer);
  }, [template.fileName, variables.length]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isImeKey(e.nativeEvent)) return;
    if (template.kinds.length > 1) {
      const next = listNavigate(e.key === "ArrowUp" || e.key === "ArrowDown" ? e.key : "", {
        items: template.kinds,
        active: kind,
        wrap: true,
      });
      if (next !== null) {
        e.preventDefault();
        setKind(next);
        return;
      }
    }
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    }
  };

  const where = plan ? relativePath(root, plan.path) : relativePath(root, directory) || "/";
  return (
    <Dialog
      open
      onClose={close}
      title={tx`New ${template.name}`}
      width={380}
      position="top"
      aria-label={tx`New ${template.name}`}
      buttons={
        variables.length
          ? [
              { label: "Cancel", role: "cancel" },
              { label: "Create", role: "default", onClick: () => void submit(), disabled: busy },
            ]
          : undefined
      }
    >
      <div className={styles.form}>
        {template.fileName === undefined && (
          <Input
            disabled={busy}
            data-autofocus
            value={name}
            invalid={!!error}
            placeholder={effective.extension ? tx`Name (.${effective.extension})` : "File name with extension"}
            aria-label="Name"
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            onKeyDown={onKeyDown}
          />
        )}
        {variables.map((v, i) => (
          <VerbatimTextContext.Provider key={v.name} value={true}>
            <label className={styles.form}>
              {v.prompt}
              <Input
                data-autofocus={template.fileName !== undefined && i === 0 ? true : undefined}
                aria-label={v.prompt}
                value={values[v.name] ?? ""}
                disabled={busy}
                onChange={(e) => {
                  setValues((s) => ({ ...s, [v.name]: e.target.value }));
                  setError(null);
                }}
                onKeyDown={onKeyDown}
              />
            </label>
          </VerbatimTextContext.Provider>
        ))}
        {template.kinds.length > 1 && (
          <div className={styles.kinds} role="listbox" aria-label={tx("Kind")}>
            {template.kinds.map((k, i) => (
              <div
                key={k.id}
                role="option"
                aria-selected={i === kind}
                className={clsx(styles.kind, i === kind && styles.kindActive)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setKind(i);
                }}
                onDoubleClick={() => void submit()}
              >
                <Icon name={template.icon} size={14} className={styles.icon} />
                {k.label}
              </div>
            ))}
          </div>
        )}
        <div className={clsx(styles.hint, error && styles.error)}>
          {error ?? (
            <>
              {where}
              {packageStyle && pkg ? (packageStyle === "php" ? ` · namespace ${pkg}` : ` · package ${pkg}`) : ""}
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
