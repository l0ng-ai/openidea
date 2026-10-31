/**
 * "Add Service" of a configuration type with several configurations: pick the
 * ones to show in Services (removed ones are restored the same way).
 * Rendered by one overlay, like the Services view's dialogs.
 */
import { Fragment, useState, type ReactNode } from "react";
import { create } from "zustand";
import type { RunConfig } from "@/platform/ipc";
import { Checkbox, Dialog } from "@/ui";
import { kindLabel } from "./configs";
import styles from "./RunServices.module.css";

interface Entry {
  id: number;
  node: ReactNode;
}

const useDialogs = create<{ stack: Entry[] }>(() => ({ stack: [] }));
let seq = 0;

export function ServiceImportHost() {
  const stack = useDialogs((s) => s.stack);
  return (
    <>
      {stack.map((e) => (
        <Fragment key={e.id}>{e.node}</Fragment>
      ))}
    </>
  );
}

/** The configurations of `kind` to show; `null` when the dialog was cancelled. */
export function pickServices(
  kind: string,
  configs: readonly RunConfig[],
  shown: ReadonlySet<string>,
): Promise<Set<string> | null> {
  return new Promise((resolve) => {
    const id = ++seq;
    const close = () => useDialogs.setState((s) => ({ stack: s.stack.filter((e) => e.id !== id) }));
    useDialogs.setState((s) => ({
      stack: [
        ...s.stack,
        {
          id,
          node: (
            <ImportDialog
              kind={kind}
              configs={configs}
              shown={shown}
              onDone={(picked) => {
                close();
                resolve(picked);
              }}
            />
          ),
        },
      ],
    }));
  });
}

function ImportDialog(props: {
  kind: string;
  configs: readonly RunConfig[];
  shown: ReadonlySet<string>;
  onDone: (picked: Set<string> | null) => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(props.shown));
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <Dialog
      open
      title={`Add Service (${kindLabel(props.kind)})`}
      onClose={() => props.onDone(null)}
      width={420}
      buttons={[
        { label: "OK", role: "default", disabled: picked.size === 0, onClick: () => props.onDone(picked) },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.importList}>
        {props.configs.map((c) => (
          <Checkbox key={c.id} checked={picked.has(c.id)} onChange={() => toggle(c.id)} label={c.name} />
        ))}
      </div>
    </Dialog>
  );
}
