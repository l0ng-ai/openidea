/**
 * The "Create Mapper XML" confirmation: shows the computed target path and
 * asks before the file is written (creating a file is not an editor-undoable
 * operation). Hosted as a workbench overlay.
 */
import { create } from "zustand";
import { Dialog } from "@/ui";
import { tx } from "@/platform/i18n";
import styles from "./Mybatis.module.css";

interface CreateXmlState {
  path: string;
  title: string;
  resolve: ((ok: boolean) => void) | null;
}

const useCreateXml = create<CreateXmlState>(() => ({ path: "", title: "", resolve: null }));

export function askCreateXml(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    useCreateXml.setState({ path, title: tx("Create Mapper XML"), resolve });
  });
}

function finish(ok: boolean) {
  const { resolve } = useCreateXml.getState();
  useCreateXml.setState({ path: "", title: "", resolve: null });
  resolve?.(ok);
}

export function CreateXmlDialogHost() {
  const { path, title } = useCreateXml();
  return (
    <Dialog
      open={path !== ""}
      onClose={() => finish(false)}
      title={title}
      width={460}
      buttons={[
        { label: tx("Create"), role: "default", onClick: () => finish(true), autoFocus: true },
        { label: tx("Cancel"), role: "cancel" },
      ]}
    >
      <p>{tx("Create this MyBatis mapper XML?")}</p>
      <p className={styles.path}>{path}</p>
    </Dialog>
  );
}
