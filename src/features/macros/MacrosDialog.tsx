/** The "Macro recording" status bar item and the Edit Macros dialog. */
import { useState } from "react";
import { create } from "zustand";
import { executeAction, getAction } from "@/platform/actions";
import { t, tx } from "@/platform/i18n";
import { BarButton, Dialog, Icon, IconButton, List, SplitGroup, SplitHandle, SplitPanel, T } from "@/ui";
import { confirm } from "@/workbench/messages";
import { promptInput } from "@/workbench/inputDialogs";
import { deleteMacro, describeStep, renameMacro, useMacros } from "./model";
import styles from "./macros.module.css";

const useEditOpen = create<{ open: boolean }>(() => ({ open: false }));
export const showEditMacros = () => useEditOpen.setState({ open: true });

const actionTitle = (id: string) => getAction(id)?.title ?? id;

/** Shown while recording (IDEA: "Macro recording started" in the status bar); click stops. */
export function MacroStatus() {
  const steps = useMacros((s) => s.recording?.length);
  if (steps === undefined) return null;
  return (
    <BarButton
      className={styles.status}
      tooltip="Stop Macro Recording"
      aria-label="Stop Macro Recording"
      onClick={() => void executeAction("macro.stopRecording")}
    >
      <span className={styles.dot} aria-hidden="true" />
      <T>Recording macro…</T>
      <Icon name="stop" size={14} />
    </BarButton>
  );
}

export function MacrosDialogHost() {
  const open = useEditOpen((s) => s.open);
  return open ? <EditMacrosDialog onClose={() => useEditOpen.setState({ open: false })} /> : null;
}

function EditMacrosDialog({ onClose }: { onClose: () => void }) {
  const saved = useMacros((s) => s.saved);
  const [active, setActive] = useState(0);
  const macro = saved[Math.min(active, saved.length - 1)];

  const rename = async () => {
    if (!macro) return;
    const name = await promptInput({
      title: "Rename Macro",
      label: "New name:",
      initial: macro.name,
      okLabel: "Rename",
      validate: (v) =>
        !v.trim()
          ? "Enter a macro name"
          : v.trim() !== macro.name && saved.some((m) => m.name === v.trim())
            ? "A macro with this name exists"
            : null,
    });
    if (name) renameMacro(macro.name, name);
  };
  const remove = async () => {
    if (!macro) return;
    if (
      await confirm({
        title: "Delete Macro",
        message: tx`Delete the macro '${macro.name}'?`,
        ok: "Delete",
        icon: "warning",
      })
    )
      deleteMacro(macro.name);
  };

  return (
    <Dialog
      open
      title="Edit Macros"
      onClose={onClose}
      width={620}
      buttons={[{ label: t("common.close"), role: "cancel" }]}
    >
      <div className={styles.edit}>
        <SplitGroup orientation="horizontal" storageKey="openidea.macros.split" className={styles.panes}>
          <SplitPanel id="macro-list" defaultSize="50%" minSize="25%">
            <div className={styles.toolbar} role="toolbar" aria-label={tx("Macros")}>
              <IconButton
                icon="minus"
                title="Delete Macro"
                size="small"
                disabled={!macro}
                onClick={() => void remove()}
              />
              <IconButton
                icon="edit"
                title="Rename Macro"
                size="small"
                disabled={!macro}
                onClick={() => void rename()}
              />
            </div>
            <List
              items={saved}
              getKey={(m) => m.name}
              activeIndex={Math.min(active, saved.length - 1)}
              onActiveChange={setActive}
              autoFocus
              className={styles.list}
              aria-label="Macros"
              empty={
                <div className={styles.empty}>
                  <T>No saved macros</T>
                </div>
              }
              renderItem={(m) => (
                <div className={styles.row} title={m.name}>
                  {m.name}
                </div>
              )}
            />
          </SplitPanel>
          <SplitHandle aria-label={tx("Macros")} />
          <SplitPanel id="macro-steps" defaultSize="50%" minSize="25%">
            <ol className={styles.steps} aria-label={tx("Recorded steps")}>
              {macro?.steps.map((step, i) => (
                <li key={i} className={styles.step}>
                  {describeStep(step, actionTitle)}
                </li>
              ))}
            </ol>
          </SplitPanel>
        </SplitGroup>
      </div>
    </Dialog>
  );
}
