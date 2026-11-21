import { useId, useRef, useState, type RefObject } from "react";
import { tx } from "@/platform/i18n";
import { isImeKey } from "@/platform/ime";
import { Button, Checkbox, Icon, Input, Popup, T } from "@/ui";
import styles from "./Database.module.css";

interface Selection {
  all: boolean;
  names: string[];
}

interface Names {
  available: string[];
  visible: string[];
  defaults?: string[];
  current?: string | null;
  restore: () => string[];
}

interface Props {
  title: string;
  kind: "databases" | "schemas";
  names: Names | undefined;
  initial: Selection | null;
  tabIndex: number;
  protectedRules: boolean;
  editableName: (name: string) => boolean;
  loadError?: string;
  onLoad: () => void;
  onApply: (selection: Selection | null) => Promise<void>;
}

/** A database row can inherit its source's schema rules; source rows edit those rules directly. */
export function IntrospectionPicker(props: Props) {
  const { title, names, onLoad, loadError, tabIndex } = props;
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const used = names?.visible.length ?? 0;
  const total = names?.available.length ?? 0;
  const close = () => setOpen(false);
  return (
    <span
      className={styles.introspectionTrigger}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key !== "Escape" && e.key !== "Tab") e.stopPropagation();
      }}
    >
      <button
        ref={anchor}
        type="button"
        className={styles.introspectionCount}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        tabIndex={tabIndex}
        title={title}
        onClick={() => {
          if (open) return;
          setOpen(true);
          if (!names && !loadError) onLoad();
        }}
      >
        {names ? tx`${used} of ${total}` : <Icon name="filter" size={12} />}
      </button>
      {open && <PickerPopup {...props} anchor={anchor} onClose={close} />}
    </span>
  );
}

function PickerPopup({
  title,
  kind,
  names,
  initial,
  loadError,
  onLoad,
  onApply,
  anchor,
  onClose,
  protectedRules,
  editableName,
}: Props & { anchor: RefObject<HTMLButtonElement | null>; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<Selection | null>();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const patternHint = useId();
  const selection = draft === undefined ? initial : draft;
  const marked = new Set(
    draft === undefined
      ? names?.visible
      : draft === null
        ? names?.defaults
        : draft.all
          ? names?.available
          : draft.names,
  );
  if (names?.current) marked.add(names.current);
  const filter = query.trim().toLocaleLowerCase();
  const matches = names?.available.filter((name) => name.toLocaleLowerCase().includes(filter));
  const apply = async () => {
    if (saving) return;
    if (draft === undefined) {
      onClose();
      return;
    }
    try {
      setSaving(true);
      setSaveError(undefined);
      await onApply(draft);
      onClose();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };
  return (
    <Popup
      open
      anchor={anchor}
      placement="bottom-end"
      aria-label={title}
      aria-describedby={names && protectedRules ? patternHint : undefined}
      trapFocus
      closeOnDeactivate={false}
      onClose={(reason) => {
        if (saving) return;
        if (reason === "outside") void apply();
        else onClose();
      }}
    >
      <div
        className={styles.introspectionPopup}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.target instanceof HTMLInputElement && !isImeKey(e.nativeEvent)) {
            e.preventDefault();
            void apply();
          }
        }}
      >
        {names ? (
          <>
            <Input
              autoFocus
              aria-label="Filter names"
              placeholder="Filter names"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className={styles.introspectionModes}>
              {names.defaults && (
                <Checkbox
                  label="Use source settings"
                  checked={selection === null}
                  disabled={saving}
                  onChange={(inherit) => setDraft(inherit ? null : { all: false, names: [...marked] })}
                />
              )}
              <Checkbox
                label={kind === "databases" ? tx("All databases") : tx("All schemas")}
                checked={selection?.all === true}
                disabled={saving}
                onChange={(all) => setDraft({ all, names: all ? [] : names.restore() })}
              />
            </div>
            <div className={styles.introspectionNames}>
              {matches?.length ? (
                matches.map((name) => (
                  <Checkbox
                    key={name}
                    label={
                      <>
                        {name}
                        {name === names.current && (
                          <span className={styles.treeDetail}>
                            {" "}
                            <T>Current database</T>
                          </span>
                        )}
                      </>
                    }
                    checked={marked.has(name)}
                    disabled={saving || name === names.current || !editableName(name)}
                    onChange={(checked) => {
                      if (checked) marked.add(name);
                      else marked.delete(name);
                      setDraft({ all: false, names: names.available.filter((item) => marked.has(item)) });
                    }}
                  />
                ))
              ) : (
                <span className={styles.treeDetail}>
                  <T>No matching names</T>
                </span>
              )}
            </div>
            {protectedRules && (
              <span id={patternHint} className={styles.treeDetail}>
                <T>Edit name patterns in Data Source Properties.</T>
              </span>
            )}
          </>
        ) : loadError ? (
          <div className={styles.introspectionModes}>
            <span role="alert">{loadError}</span>
            <Button onClick={onLoad}>
              <T>Retry</T>
            </Button>
          </div>
        ) : !saveError ? (
          <span role="status">
            <T>Loading…</T>
          </span>
        ) : null}
        {saveError && <span role="alert">{saveError}</span>}
        {names && (
          <span className={styles.treeDetail}>
            <T>Enter or click outside to apply</T>
          </span>
        )}
        <div className={styles.introspectionActions}>
          <Button disabled={saving} onClick={onClose}>
            <T>Cancel</T>
          </Button>
          <Button variant="primary" disabled={saving || (!names && draft === undefined)} onClick={() => void apply()}>
            <T>Apply</T>
          </Button>
        </div>
      </div>
    </Popup>
  );
}
