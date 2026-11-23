/**
 * IDEA's "Keyboard Shortcut" dialog: records a first (and optional second)
 * stroke and lists conflicts live; OK with conflicts asks whether to remove the
 * other assignments (Remove / Leave / Cancel). With `mouse` it is the "Mouse
 * Shortcut" dialog: the pad records mouse buttons and wheel gestures.
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Checkbox, Dialog, Icon, Kbd, T } from "@/ui";
import type { Action } from "@/platform/actions";
import { useEditorPrefs } from "@/platform/editorSettings";
import {
  formatBinding,
  isWheelBinding,
  mouseStrokeOf,
  normalizeBinding,
  parseDoubleModifier,
  supportsWheelShortcut,
  suspendKeyboardDispatch,
  wheelStrokeOf,
} from "@/platform/keymap";
import { isPageSwipe } from "@/platform/pageSwipe";
import { ask } from "@/workbench/messages";
import { findConflicts, resolveBindings, type Conflict, type KeymapDraft } from "./model";
import { groupPath } from "./groups";
import { StrokeRecorder } from "./StrokeRecorder";
import styles from "./Keymap.module.css";
import { useTx } from "@/platform/i18n";
import { usePlatform } from "@/platform/platformInfo";

export interface RecordShortcutDialogProps {
  action: Pick<Action, "id" | "title" | "category" | "when">;
  actions: readonly Pick<Action, "id" | "title" | "category" | "when">[];
  draft: KeymapDraft;
  onCancel: () => void;
  /** `removeConflicts`: also unbind the conflicting assignments. */
  onSubmit: (binding: string, conflicts: Conflict[], removeConflicts: boolean) => void;
  /** Record a mouse button or wheel shortcut. */
  mouse?: boolean;
}

export function RecordShortcutDialog({ action, actions, draft, onCancel, onSubmit, mouse }: RecordShortcutDialogProps) {
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const [useSecond, setUseSecond] = useState(false);
  const os = usePlatform((s) => s.os);
  const tx = useTx();
  const actionName = tx(action.title);
  const rectangularSelection = action.id === "editor.createRectangularSelectionOnMouseDrag";
  const wheelZoom = useEditorPrefs().general.wheelZoom;

  const allowsSecond = !isPageSwipe(first) && !parseDoubleModifier(first);
  const binding = !mouse && allowsSecond && first && useSecond ? (second ? `${first} ${second}` : "") : first;
  const zoomConflict = wheelZoom && isWheelBinding(binding) && /(?:^|\+)(Ctrl|Meta)\+/.test(binding);
  const conflicts = useMemo(
    () => (binding ? findConflicts(draft, binding, action.id, actions) : []),
    [binding, draft, action.id, actions],
  );
  const already = useMemo(
    () => !!binding && resolveBindings(draft, action.id).includes(normalizeBinding(binding)),
    [binding, draft, action.id],
  );

  const ok = async () => {
    if (!binding || already) return;
    if (!conflicts.length) return onSubmit(binding, conflicts, false);
    const { button } = await ask({
      title: "Warning",
      icon: "warning",
      body: (
        <>
          <T>The shortcut is already assigned to other actions. Do you want to remove other assignments?</T>
          <ConflictList conflicts={conflicts} />
        </>
      ),
      buttons: [
        { id: "remove", label: "Remove", primary: true },
        { id: "leave", label: "Leave" },
      ],
    });
    if (button !== "cancel") onSubmit(binding, conflicts, button === "remove");
  };

  return (
    <Dialog
      open
      onClose={onCancel}
      title={mouse ? "Mouse Shortcut" : "Keyboard Shortcut"}
      aria-label={mouse ? tx`Mouse Shortcut: ${actionName}` : tx`Keyboard Shortcut: ${actionName}`}
      width={352}
      buttons={[
        { label: "OK", role: "default", disabled: !binding || already, onClick: () => void ok() },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.shortcutBody}>
        <div className={styles.actionSummary}>
          <div className={styles.actionName}>{actionName}</div>
          <div className={styles.actionPath}>
            {groupPath(action)
              .map((part) => tx(part))
              .join(" › ")}
          </div>
        </div>
        {mouse ? (
          <MouseRecorder
            value={first}
            onChange={setFirst}
            sideButtons={!rectangularSelection}
            wheel={supportsWheelShortcut(action.id)}
          />
        ) : (
          <KeyStrokes
            first={first}
            second={second}
            useSecond={useSecond && allowsSecond}
            allowsSecond={allowsSecond}
            setFirst={setFirst}
            setSecond={setSecond}
            setUseSecond={setUseSecond}
          />
        )}
        {mouse && os === "linux" && rectangularSelection && /(?:^|\+)Button2$/.test(binding) && (
          <div className={styles.recordHint}>
            <T>On Linux, middle-button rectangular selection conflicts with primary selection paste.</T>
          </div>
        )}
        <div className={styles.shortcutStatus} aria-live="polite">
          {already && (
            <span className={styles.recordHint}>
              <T>The action already has this shortcut</T>
            </span>
          )}
          {!already && binding && !zoomConflict && conflicts.length === 0 && (
            <span className={styles.recordHint}>
              <T>No conflicts</T>
            </span>
          )}
          {conflicts.length > 0 && (
            <>
              <div className={styles.conflictTitle}>
                <Icon name="warning" size={14} className={styles.conflictIcon} />
                <span>
                  <Kbd binding={binding} className={styles.conflictBinding} /> <T>is already assigned to:</T>
                </span>
              </div>
              <ConflictList conflicts={conflicts} />
            </>
          )}
          {zoomConflict && (
            <div className={styles.conflictTitle}>
              <Icon name="warning" size={14} className={styles.conflictIcon} />
              <span>
                <T>
                  This shortcut takes precedence over Ctrl/Command+Mouse Wheel font zoom when the action is available.
                </T>
              </span>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function ConflictList({ conflicts }: { conflicts: readonly Conflict[] }) {
  const tx = useTx();
  return (
    <ul className={styles.conflictList} aria-label={tx("Conflicts:")}>
      {conflicts.map((c) => (
        <li key={`${c.actionId}|${c.binding}`}>
          <div className={styles.conflictAction}>
            <div>{tx(c.title)}</div>
            <span className={styles.actionPath}>
              {groupPath({ id: c.actionId, category: c.category })
                .map((part) => tx(part))
                .join(" › ")}
              {c.kind === "prefix" && (
                <>
                  {" "}
                  · <T>chord prefix</T>
                </>
              )}
            </span>
          </div>
          <Kbd binding={c.binding} className={styles.conflictBinding} />
        </li>
      ))}
    </ul>
  );
}

interface KeyStrokesProps {
  first: string;
  second: string;
  useSecond: boolean;
  allowsSecond: boolean;
  setFirst: (v: string) => void;
  setSecond: (v: string) => void;
  setUseSecond: (v: boolean) => void;
}

function KeyStrokes({ first, second, useSecond, allowsSecond, setFirst, setSecond, setUseSecond }: KeyStrokesProps) {
  const tx = useTx();
  return (
    <>
      <StrokeRecorder
        autoFocus
        className={styles.shortcutField}
        value={first}
        onChange={setFirst}
        aria-label={tx("First stroke")}
      />
      <div className={styles.secondStroke}>
        <Checkbox checked={useSecond} onChange={setUseSecond} disabled={!allowsSecond} label="Second stroke:" />
        <StrokeRecorder
          className={styles.shortcutField}
          value={second}
          onChange={setSecond}
          disabled={!useSecond}
          allowDoubleModifier={false}
          placeholder={useSecond ? "Press a shortcut" : ""}
          aria-label={tx("Second stroke")}
        />
      </div>
      <div className={styles.recordHint}>
        <T>Keys are recorded as pressed, including Tab and Esc. Use the buttons to finish.</T>
      </div>
    </>
  );
}

/** Shortcuts stay off while the dialog records mouse gestures. */
function MouseRecorder({
  value,
  onChange,
  sideButtons,
  wheel,
}: {
  value: string;
  onChange: (binding: string) => void;
  sideButtons: boolean;
  wheel: boolean;
}) {
  const padRef = useRef<HTMLDivElement>(null);
  useEffect(() => suspendKeyboardDispatch(), []);
  useEffect(() => {
    const pad = padRef.current;
    if (!pad || !wheel) return;
    const recordWheel = (e: WheelEvent) => {
      const stroke = wheelStrokeOf(e);
      if (!stroke) return;
      e.preventDefault();
      e.stopPropagation();
      onChange(stroke);
    };
    // React's wheel handler is passive.
    pad.addEventListener("wheel", recordWheel, { passive: false });
    return () => pad.removeEventListener("wheel", recordWheel);
  }, [onChange, wheel]);
  const record = (e: MouseEvent<HTMLDivElement>) => {
    // Rectangular selection only handles left and middle buttons.
    if (!sideButtons && e.button > 1) return;
    const stroke = mouseStrokeOf(e.nativeEvent);
    if (!stroke) return;
    e.preventDefault();
    e.stopPropagation();
    onChange(stroke);
  };
  return (
    <div
      ref={padRef}
      role="textbox"
      aria-readonly="true"
      aria-label="Mouse shortcut"
      className={styles.mousePad}
      onMouseDown={record}
      onAuxClick={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {value ? (
        <span className={styles.recorded}>{formatBinding(value)}</span>
      ) : (
        <span className={styles.recorderPlaceholder}>
          {wheel ? (
            <T>Scroll here, click with Ctrl, Alt or Command held, or use a middle or side mouse button</T>
          ) : sideButtons ? (
            <T>Click here with Ctrl, Alt or Command held, or use a middle or side mouse button</T>
          ) : (
            <T>Click here with Ctrl, Alt or Command held, or use the middle mouse button</T>
          )}
        </span>
      )}
    </div>
  );
}
