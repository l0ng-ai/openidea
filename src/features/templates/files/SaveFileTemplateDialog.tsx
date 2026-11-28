/** File › Save File as Template…: turn the active editor buffer into a file template. */
import { useId, useState } from "react";
import { create } from "zustand";
import { tx } from "@/platform/i18n";
import { basename } from "@/platform/project";
import { Dialog, Input, T } from "@/ui";
import { saveFileTemplate } from "./store";
import styles from "./SaveFileTemplateDialog.module.css";

interface Request {
  path: string;
  /** Snapshot of the editor buffer, including edits that have not been saved to disk. */
  body: string;
}

const useSaveFileTemplate = create<{ request: Request | null; seq: number }>(() => ({ request: null, seq: 0 }));

export function openSaveFileTemplateDialog(request: Request) {
  useSaveFileTemplate.setState((s) => ({ request, seq: s.seq + 1 }));
}

const close = () => useSaveFileTemplate.setState({ request: null });

function templateIdentity(path: string): { name: string; extension: string } {
  const fileName = basename(path);
  const dot = fileName.lastIndexOf(".");
  // A leading dot belongs to a dotfile name, not to its extension.
  return dot > 0
    ? { name: fileName.slice(0, dot), extension: fileName.slice(dot + 1) }
    : { name: fileName, extension: "" };
}

export function SaveFileTemplateDialogHost() {
  const { request, seq } = useSaveFileTemplate();
  if (!request) return null;
  return <SaveFileTemplateDialog key={seq} {...templateIdentity(request.path)} body={request.body} />;
}

function SaveFileTemplateDialog({
  name: initialName,
  extension: initialExtension,
  body: initialBody,
}: {
  name: string;
  extension: string;
  body: string;
}) {
  const [name, setName] = useState(initialName);
  const [extension, setExtension] = useState(initialExtension);
  const [body, setBody] = useState(initialBody);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  const submit = () => {
    const templateName = name.trim();
    if (!templateName) {
      setError(tx("Enter a name"));
      return;
    }
    saveFileTemplate(
      {
        id: `user.${Date.now().toString(36)}`,
        name: templateName,
        icon: "file",
        extension: extension.trim().replace(/^\./, ""),
        nameStyle: "asis",
        kinds: [{ id: "default", label: "Default", body }],
      },
      "default",
    );
    close();
  };

  return (
    <Dialog
      open
      onClose={close}
      title={tx`Save File as Template…`}
      aria-label={tx`Save File as Template…`}
      width={440}
      position="top"
      popup
      buttons={[
        { label: "Cancel", role: "cancel" },
        { label: "Save", role: "default", onClick: submit },
      ]}
    >
      <div className={styles.form}>
        <div className={styles.identity}>
          <label className={styles.field}>
            <span>
              <T>Name</T>
            </span>
            <Input
              data-autofocus
              autoSelect
              required
              value={name}
              invalid={!!error}
              aria-describedby={error ? errorId : undefined}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
            />
          </label>
          <label className={styles.field}>
            <span>
              <T>Extension</T>
            </span>
            <Input
              mono
              value={extension}
              placeholder="none"
              onChange={(e) => setExtension(e.target.value.replace(/^\./, "").trim())}
            />
          </label>
        </div>
        <label className={styles.field}>
          <span>
            <T>Template body</T>
          </span>
          <textarea className={styles.body} value={body} spellCheck={false} onChange={(e) => setBody(e.target.value)} />
        </label>
        {error && (
          <div id={errorId} className={styles.error} role="alert">
            {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}
