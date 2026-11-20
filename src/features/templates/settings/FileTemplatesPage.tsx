/** Settings › Editor › File and Code Templates: Files, Includes and Code tabs per scheme. */
import { useEffect, useId, useState, type ReactNode } from "react";
import clsx from "clsx";
import { tx, useTx } from "@/platform/i18n";
import { Button, Checkbox, Icon, IconButton, Input, Select, SplitGroup, SplitHandle, SplitPanel, T, Tabs } from "@/ui";
import { reformatsOnCreate, type FileTemplate, type NameStyle, type TemplateFragment } from "../files/model";
import {
  isBuiltinFileTemplate,
  isBuiltinInclude,
  isModifiedCodeTemplate,
  isModifiedFileTemplate,
  isModifiedInclude,
  reloadFileTemplates,
  removeFileTemplate,
  removeInclude,
  resetCodeTemplate,
  resetFileTemplate,
  resetInclude,
  saveCodeTemplate,
  saveFileTemplate,
  saveInclude,
  setTemplateScheme,
  useFileTemplates,
  type TemplateScheme,
} from "../files/store";
import styles from "./Settings.module.css";
import layout from "./FileTemplatesPage.module.css";

const NAME_STYLES: Array<{ value: NameStyle; label: string }> = [
  { value: "asis", label: "As typed" },
  { value: "snake", label: "snake_case" },
  { value: "pascal", label: "PascalCase" },
  { value: "kebab", label: "kebab-case" },
];

const SCHEMES: Array<{ value: TemplateScheme; label: string }> = [
  { value: "default", label: "Default" },
  { value: "project", label: "Project" },
];

const TABS = [
  { id: "files", label: "Files" },
  { id: "includes", label: "Includes" },
  { id: "code", label: "Code" },
];

export function FileTemplatesPage() {
  const scheme = useFileTemplates((s) => s.scheme);
  const root = useFileTemplates((s) => s.root);
  const [tab, setTab] = useState("files");
  const tabsId = useId();
  useEffect(() => reloadFileTemplates(), []);

  return (
    <div className={styles.page}>
      <div className={clsx(styles.row, layout.scheme)}>
        <span className={styles.label}>
          <T>Scheme</T>
        </span>
        <Select value={scheme} options={SCHEMES} disabled={!root} onChange={setTemplateScheme} aria-label="Scheme" />
        {scheme === "project" && (
          <span className={styles.hint}>
            <T>Templates of this project only</T>
          </span>
        )}
      </div>
      <Tabs
        items={TABS}
        activeId={tab}
        onSelect={setTab}
        variant="compact"
        aria-label="Template kinds"
        panelIdPrefix={tabsId}
      />
      <div
        className={layout.tabPanel}
        role="tabpanel"
        id={tabsId + "-panel-" + tab}
        aria-labelledby={tabsId + "-tab-" + tab}
      >
        {tab === "files" && <FilesTab key={scheme} />}
        {tab === "includes" && <IncludesTab key={scheme} />}
        {tab === "code" && <CodeTab key={scheme} />}
      </div>
    </div>
  );
}

function TemplateSplit({ list, children }: { list: ReactNode; children: ReactNode }) {
  return (
    <SplitGroup className={layout.split} orientation="horizontal" storageKey="openidea.settings.fileTemplates.panes.v1">
      <SplitPanel id="file-template-list" defaultSize="30%" minSize="22%" maxSize="42%" className={layout.list}>
        {list}
      </SplitPanel>
      <SplitHandle aria-label={tx("Resize file template panes")} />
      <SplitPanel id="file-template-editor" minSize="58%" className={clsx(styles.editor, layout.editor)}>
        {children}
      </SplitPanel>
    </SplitGroup>
  );
}

function FilesTab() {
  const templates = useFileTemplates((s) => s.templates);
  useFileTemplates((s) => s.custom);
  const [selectedId, setSelectedId] = useState<string | null>(templates[0]?.id ?? null);
  const selected = templates.find((t) => t.id === selectedId) ?? null;

  const add = () => {
    const t: FileTemplate = {
      id: `user.${Date.now().toString(36)}`,
      name: "New Template",
      icon: "file",
      extension: "txt",
      nameStyle: "asis",
      kinds: [{ id: "default", label: "Default", body: "$END$\n" }],
    };
    saveFileTemplate(t);
    setSelectedId(t.id);
  };

  return (
    <TemplateSplit
      list={
        <>
          <div className={styles.toolbar}>
            <IconButton icon="plus" size="small" title="Add Template" onClick={add} />
            <IconButton
              icon="minus"
              size="small"
              title="Remove Template"
              disabled={!selected}
              onClick={() => {
                if (!selected) return;
                removeFileTemplate(selected.id);
                setSelectedId(null);
              }}
            />
          </div>
          <div className={styles.items} role="listbox" aria-label={tx("File templates")}>
            {templates.map((t) => (
              <div
                key={t.id}
                role="option"
                aria-selected={t.id === selectedId}
                className={clsx(
                  styles.item,
                  layout.item,
                  t.id === selectedId && styles.itemSelected,
                  t.enabled === false && styles.disabledItem,
                )}
                onClick={() => setSelectedId(t.id)}
              >
                <Checkbox
                  checked={t.enabled !== false}
                  onChange={(v) => saveFileTemplate({ ...t, enabled: v })}
                  aria-label={tx`Enable ${t.name}`}
                />
                <Icon name={t.icon} size={14} className={layout.itemIcon} />
                <span className={clsx(layout.itemName, isModifiedFileTemplate(t.id) && styles.modified)} title={t.name}>
                  {t.name}
                </span>
              </div>
            ))}
          </div>
        </>
      }
    >
      {selected ? (
        <FileTemplateEditor key={selected.id} template={selected} />
      ) : (
        <div className={styles.empty}>
          <T>Select a template to edit it</T>
        </div>
      )}
    </TemplateSplit>
  );
}

function FileTemplateEditor({ template: t }: { template: FileTemplate }) {
  const [kindIdx, setKindIdx] = useState(0);
  const kind = t.kinds[Math.min(kindIdx, t.kinds.length - 1)]!;
  const update = (patch: Partial<FileTemplate>) => saveFileTemplate({ ...t, ...patch });
  const updateKind = (patch: Partial<typeof kind>) =>
    update({ kinds: t.kinds.map((k) => (k.id === kind.id ? { ...k, ...patch } : k)) });

  return (
    <>
      <div className={layout.identity}>
        <label className={layout.field}>
          <span className={styles.label}>
            <T>Name</T>
          </span>
          <Input
            className={styles.grow}
            value={t.name}
            onChange={(e) => update({ name: e.target.value })}
            aria-label="Template name"
          />
        </label>
        <label className={clsx(layout.field, layout.extension)}>
          <span className={styles.label}>
            <T>Extension</T>
          </span>
          <Input
            className={styles.grow}
            mono
            value={t.extension}
            onChange={(e) => update({ extension: e.target.value.replace(/^\./, "").trim() })}
            aria-label="Extension"
            placeholder="none"
          />
        </label>
      </div>
      <div className={layout.field}>
        <span className={styles.label}>
          <T>File name</T>
        </span>
        <Select
          className={styles.grow}
          value={t.nameStyle}
          options={NAME_STYLES}
          onChange={(v) => update({ nameStyle: v })}
          aria-label="File name style"
        />
      </div>
      <div className={layout.field}>
        <span className={styles.label}>
          <T>Kinds</T>
        </span>
        <div className={clsx(styles.tabs, styles.grow)} role="tablist" aria-label={tx("Kinds")}>
          {t.kinds.map((k, i) => (
            <button
              key={k.id}
              type="button"
              role="tab"
              aria-selected={k.id === kind.id}
              className={clsx(styles.tab, layout.kind, k.id === kind.id && styles.tabActive)}
              title={k.label}
              onClick={() => setKindIdx(i)}
            >
              {k.label}
            </button>
          ))}
        </div>
        <IconButton
          icon="plus"
          size="small"
          title="Add Kind"
          onClick={() => {
            update({
              kinds: [...t.kinds, { id: `kind${Date.now().toString(36)}`, label: "New kind", body: "$END$\n" }],
            });
            setKindIdx(t.kinds.length);
          }}
        />
        <IconButton
          icon="minus"
          size="small"
          title="Remove Kind"
          disabled={t.kinds.length < 2}
          onClick={() => {
            update({ kinds: t.kinds.filter((k) => k.id !== kind.id) });
            setKindIdx(0);
          }}
        />
      </div>
      <label className={layout.field}>
        <span className={styles.label}>
          <T>Kind label</T>
        </span>
        <Input
          className={styles.grow}
          value={kind.label}
          onChange={(e) => updateKind({ label: e.target.value })}
          aria-label="Kind label"
        />
      </label>
      <TemplateText label="Template body" value={kind.body} onChange={(body) => updateKind({ body })} />
      <Checkbox
        checked={reformatsOnCreate(t)}
        onChange={(v) => update({ reformat: v })}
        label="Reformat according to style"
      />
      <div className={clsx(styles.hint, layout.notes)}>
        <T>Variables:</T> <code>$NAME$</code> <code>$PACKAGE$</code> <code>$FILE_NAME$</code>{" "}
        <code>$PROJECT_NAME$</code> <code>$USER$</code> <code>$DATE$</code> <code>$TIME$</code> <code>$YEAR$</code>{" "}
        <T>(or</T> <code>{"${NAME}"}</code>…); <code>$END$</code> <T>places the caret. A line with</T>{" "}
        <code>$PACKAGE$</code> <T>is omitted (with one following blank line) when there is no package.</T>{" "}
        <code>#parse("File Header")</code> <T>inserts a template from the Includes or Code tab.</T>
      </div>
      {isBuiltinFileTemplate(t.id) && isModifiedFileTemplate(t.id) && (
        <div className={styles.buttons}>
          <Button size="small" onClick={() => resetFileTemplate(t.id)}>
            <T>Restore Default</T>
          </Button>
        </div>
      )}
    </>
  );
}

function FragmentList({
  label,
  items,
  selected,
  onSelect,
  modified,
}: {
  label: string;
  items: TemplateFragment[];
  selected: string | null;
  onSelect: (name: string) => void;
  modified: (name: string) => boolean;
}) {
  return (
    <div className={styles.items} role="listbox" aria-label={label}>
      {items.map((f) => (
        <div
          key={f.name}
          role="option"
          aria-selected={f.name === selected}
          className={clsx(styles.item, layout.item, f.name === selected && styles.itemSelected)}
          onClick={() => onSelect(f.name)}
        >
          <Icon name="file" size={14} className={layout.itemIcon} />
          <span className={clsx(layout.itemName, modified(f.name) && styles.modified)} title={f.name}>
            {f.name}
          </span>
        </div>
      ))}
    </div>
  );
}

function IncludesTab() {
  const includes = useFileTemplates((s) => s.includes);
  useFileTemplates((s) => s.custom);
  const [selectedName, setSelectedName] = useState<string | null>(includes[0]?.name ?? null);
  const selected = includes.find((f) => f.name === selectedName) ?? null;

  const add = () => {
    let name = "New Include";
    for (let i = 2; includes.some((f) => f.name === name); i++) name = `New Include ${i}`;
    saveInclude({ name, body: "" });
    setSelectedName(name);
  };

  return (
    <TemplateSplit
      list={
        <>
          <div className={styles.toolbar}>
            <IconButton icon="plus" size="small" title="Add Include" onClick={add} />
            <IconButton
              icon="minus"
              size="small"
              title="Remove Include"
              disabled={!selected}
              onClick={() => {
                if (!selected) return;
                removeInclude(selected.name);
                setSelectedName(null);
              }}
            />
          </div>
          <FragmentList
            label="Includes"
            items={includes}
            selected={selectedName}
            onSelect={setSelectedName}
            modified={isModifiedInclude}
          />
        </>
      }
    >
      {selected ? (
        <IncludeEditor key={selected.name} include={selected} onRename={setSelectedName} taken={includes} />
      ) : (
        <div className={styles.empty}>
          <T>Select a template to edit it</T>
        </div>
      )}
    </TemplateSplit>
  );
}

function IncludeEditor({
  include: f,
  onRename,
  taken,
}: {
  include: TemplateFragment;
  onRename: (name: string) => void;
  taken: TemplateFragment[];
}) {
  const [name, setName] = useState(f.name);
  const builtin = isBuiltinInclude(f.name);
  const commitName = () => {
    const next = name.trim();
    if (!next || next === f.name || taken.some((x) => x.name === next)) return setName(f.name);
    saveInclude({ ...f, name: next }, f.name);
    onRename(next);
  };
  return (
    <>
      <label className={layout.field}>
        <span className={styles.label}>
          <T>Name</T>
        </span>
        <Input
          className={styles.grow}
          value={name}
          disabled={builtin}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => e.key === "Enter" && commitName()}
          aria-label="Include name"
        />
      </label>
      <TemplateText label="Include body" value={f.body} onChange={(body) => saveInclude({ ...f, body })} />
      <div className={clsx(styles.hint, layout.notes)}>
        <WithCode
          text="File templates insert this with {code}, indented like the directive; a directive line whose include is empty is dropped. The file template variables apply."
          code={`#parse("${f.name}")`}
        />
      </div>
      {builtin && isModifiedInclude(f.name) && (
        <div className={styles.buttons}>
          <Button size="small" onClick={() => resetInclude(f.name)}>
            <T>Restore Default</T>
          </Button>
        </div>
      )}
    </>
  );
}

function CodeTab() {
  const code = useFileTemplates((s) => s.codeTemplates);
  useFileTemplates((s) => s.custom);
  const [selectedName, setSelectedName] = useState<string | null>(code[0]?.name ?? null);
  const selected = code.find((f) => f.name === selectedName) ?? null;
  return (
    <TemplateSplit
      list={
        <>
          <FragmentList
            label="Code templates"
            items={code}
            selected={selectedName}
            onSelect={setSelectedName}
            modified={isModifiedCodeTemplate}
          />
        </>
      }
    >
      {selected ? (
        <>
          {selected.description && (
            <div className={styles.hint}>
              <T>Used by</T> <T>{selected.description}</T>
            </div>
          )}
          <TemplateText
            label="Code template body"
            value={selected.body}
            onChange={(body) => saveCodeTemplate(selected.name, body)}
          />
          <div className={clsx(styles.hint, layout.notes)}>
            <WithCode text="Inserted where a file template says {code}." code={`#parse("${selected.name}")`} />
          </div>
          {isModifiedCodeTemplate(selected.name) && (
            <div className={styles.buttons}>
              <Button size="small" onClick={() => resetCodeTemplate(selected.name)}>
                <T>Restore Default</T>
              </Button>
            </div>
          )}
        </>
      ) : (
        <div className={styles.empty}>
          <T>Select a template to edit it</T>
        </div>
      )}
    </TemplateSplit>
  );
}

function TemplateText({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className={layout.text}>
      <span>
        <T>{label}</T>
      </span>
      <textarea className={styles.body} value={value} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** Translated `text` with its `{code}` placeholder rendered as `<code>`. */
function WithCode({ text, code }: { text: string; code: string }) {
  const [before, after = ""] = useTx()(text).split("{code}");
  return (
    <>
      {before}
      <code>{code}</code>
      {after}
    </>
  );
}
