import { useEffect, useState } from "react";
import { create } from "zustand";
import { executeAction, registerActions } from "@/platform/actions";
import { call, commands, onIdeEvent, type TrustDecisions } from "@/platform/ipc";
import { dirname, useProject } from "@/platform/project";
import { initializeRemoteTrustMigration } from "@/platform/remote";
import { provideProjectTrustPrompt } from "@/platform/projectTrust";
import { registerOverlay, registerSettingsPage, registerWorkbenchBanner } from "@/workbench/contributions";
import { Button, Checkbox, Dialog, T } from "@/ui";
import styles from "./trust.module.css";

const usePrompt = create<{ path: string | null; folder: boolean; finish: ((open: boolean) => void) | null }>(() => ({
  path: null,
  folder: false,
  finish: null,
}));

function TrustDialog() {
  const { path, folder } = usePrompt();
  return (
    <Dialog
      open={!!path}
      title="Trust this project?"
      onClose={() => void executeAction("project.dontOpen")}
      buttons={[
        { label: "Trust and Open", role: "default", onClick: () => void executeAction("project.trust") },
        { label: "Preview in Restricted Mode", onClick: () => void executeAction("project.previewRestricted") },
        { label: "Don't Open", role: "cancel", onClick: () => void executeAction("project.dontOpen") },
      ]}
    >
      <div className={styles.content}>
        <p>
          <T>Only trust projects from sources you know. Project commands and tools can run code on your computer.</T>
        </p>
        <p className={styles.path}>{path}</p>
        <Checkbox
          checked={folder}
          onChange={(folder) => usePrompt.setState({ folder })}
          label={
            <>
              <T>Trust projects in this folder</T>
              {path ? `: ${dirname(path)}` : ""}
            </>
          }
        />
      </div>
    </Dialog>
  );
}

function RestrictedBanner() {
  const restricted = useProject((s) => s.project?.trusted === false);
  return restricted ? (
    <div className={styles.banner} role="status">
      <span>
        <T>Restricted Mode: project commands and tools are disabled.</T>
      </span>
      <Button onClick={() => void executeAction("project.trust")}>
        <T>Trust Project</T>
      </Button>
    </div>
  ) : null;
}

function TrustSettings() {
  const [decisions, setDecisions] = useState<TrustDecisions | null>(null);
  const [error, setError] = useState("");
  const refresh = () =>
    call(commands.projectTrustList())
      .then(setDecisions)
      .catch((e: unknown) => setError(String(e)));
  useEffect(() => {
    void refresh();
  }, []);
  const revoke = async (action: string, path: string) => {
    try {
      await executeAction(action, path);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <div className={styles.content}>
      <p>
        <T>Trust decisions are saved in your user data and take effect immediately.</T>
      </p>
      {error && <p role="alert">{error}</p>}
      <h3>
        <T>Trusted projects</T>
      </h3>
      {decisions?.projects.map((path) => (
        <div className={styles.row} key={path}>
          <span className={styles.path}>{path}</span>
          <Button onClick={() => void revoke("project.revokeTrust", path)}>
            <T>Revoke Trust</T>
          </Button>
        </div>
      ))}
      <h3>
        <T>Trusted locations</T>
      </h3>
      {decisions?.locations.map((path) => (
        <div className={styles.row} key={path}>
          <span className={styles.path}>{path}</span>
          <Button onClick={() => void revoke("project.removeTrustedLocation", path)}>
            <T>Remove</T>
          </Button>
        </div>
      ))}
    </div>
  );
}

async function decide(trusted: boolean) {
  const pending = usePrompt.getState();
  const path = pending.path ?? useProject.getState().project?.root;
  if (!path) return;
  await call(commands.projectTrustSet(path, trusted, trusted && pending.folder));
  const project = await commands.projectCurrent();
  if (project) useProject.setState({ project, settings: project.settings });
  pending.finish?.(true);
}

export function activate(): () => void {
  initializeRemoteTrustMigration();
  const disposers = [
    provideProjectTrustPrompt(async (path) => {
      const status = await call(commands.projectTrustStatus(path));
      if (status.decided) return true;
      usePrompt.getState().finish?.(false);
      return new Promise<boolean>((resolve) =>
        usePrompt.setState({
          path: status.root,
          folder: false,
          finish: (open) => {
            usePrompt.setState({ path: null, finish: null, folder: false });
            resolve(open);
          },
        }),
      );
    }),
    registerOverlay({ id: "project.trustDialog", component: TrustDialog }),
    registerWorkbenchBanner({ id: "project.restrictedMode", component: RestrictedBanner }),
    registerSettingsPage({ id: "projectTrust", title: "Project Trust", group: "Security", component: TrustSettings }),
    registerActions([
      { id: "project.trust", title: "Trust Project", category: "Project", run: () => decide(true) },
      {
        id: "project.previewRestricted",
        title: "Preview in Restricted Mode",
        category: "Project",
        hidden: true,
        run: () => decide(false),
      },
      {
        id: "project.dontOpen",
        title: "Don't Open",
        category: "Project",
        hidden: true,
        run: () => usePrompt.getState().finish?.(false),
      },
      {
        id: "project.revokeTrust",
        title: "Revoke Trust",
        category: "Project",
        run: async ({ arg }) => {
          const path = typeof arg === "string" ? arg : useProject.getState().project?.root;
          if (path) await call(commands.projectTrustSet(path, false, false));
        },
      },
      {
        id: "project.removeTrustedLocation",
        title: "Remove Trusted Location",
        category: "Project",
        hidden: true,
        run: async ({ arg }) => {
          if (typeof arg === "string") await call(commands.projectTrustRemoveLocation(arg));
        },
      },
    ]),
    onIdeEvent("projectTrustChanged", (e) => {
      const project = useProject.getState().project;
      if (project?.root === e.root) useProject.setState({ project: { ...project, trusted: e.trusted } });
    }),
  ];
  return () => {
    usePrompt.getState().finish?.(false);
    disposers.reverse().forEach((dispose) => dispose());
  };
}
