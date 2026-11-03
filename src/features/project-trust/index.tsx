import { useEffect, useState } from "react";
import { create } from "zustand";
import { executeAction, registerActions } from "@/platform/actions";
import { call, commands, onIdeEvent, type TrustDecisions, type TrustStatus } from "@/platform/ipc";
import { dirname, useProject } from "@/platform/project";
import { initializeRemoteTrustMigration } from "@/platform/remote";
import { provideProjectTrustPrompt, type ProjectTrustScope } from "@/platform/projectTrust";
import { invokeLocal } from "@/platform/tauriCore";
import { registerOverlay, registerSettingsPage, registerWorkbenchBanner } from "@/workbench/contributions";
import { Button, Checkbox, Dialog, T } from "@/ui";
import styles from "./trust.module.css";

const usePrompt = create<{
  path: string | null;
  scope: ProjectTrustScope;
  folder: boolean;
  finish: ((open: boolean) => void) | null;
}>(() => ({
  path: null,
  scope: "current",
  folder: false,
  finish: null,
}));

/** One line; a long path loses its middle, so the final folder stays visible. */
function PathLine({ path }: { path: string }) {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return (
    <span className={styles.pathLine} title={path}>
      <span className={styles.pathHead}>{path.slice(0, Math.max(cut, 0))}</span>
      <span className={styles.pathTail}>{path.slice(Math.max(cut, 0))}</span>
    </span>
  );
}

function TrustDialog() {
  const { path, folder } = usePrompt();
  return (
    <Dialog
      open={!!path}
      icon="app"
      width={560}
      title="Trust and Open Project?"
      onClose={() => void executeAction("project.dontOpen")}
      buttons={[
        {
          label: "Preview in Restricted Mode",
          autoFocus: true,
          onClick: () => void executeAction("project.previewRestricted"),
        },
        { label: "Don't Open", onClick: () => void executeAction("project.dontOpen") },
        { label: "Trust Project", role: "default", onClick: () => void executeAction("project.trust") },
      ]}
      footerStart={
        <Checkbox
          checked={folder}
          onChange={(folder) => usePrompt.setState({ folder })}
          className={styles.folderOption}
          label={
            <span className={styles.folderLabel}>
              <span className={styles.folderPrefix}>
                <T>Trust projects in</T>
              </span>{" "}
              <PathLine path={path ? dirname(path) : ""} />
            </span>
          }
        />
      }
    >
      <div className={styles.content}>
        <PathLine path={path ?? ""} />
        <p>
          <T>
            If you don't trust the source, preview the project in Restricted Mode, where project commands and tools
            can't run.
          </T>
        </p>
        <p>
          <T>Loading, running or building a project may execute potentially malicious code from its build scripts.</T>
        </p>
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
  const folder = trusted && pending.folder;
  if (pending.scope === "local") {
    await invokeLocal("project_trust_set", { path, trusted, folder });
  } else {
    await call(commands.projectTrustSet(path, trusted, folder));
    const project = await commands.projectCurrent();
    if (project) useProject.setState({ project, settings: project.settings });
  }
  pending.finish?.(true);
}

export function activate(): () => void {
  initializeRemoteTrustMigration();
  const disposers = [
    provideProjectTrustPrompt(async (path, scope) => {
      const status = await (scope === "local"
        ? invokeLocal<TrustStatus>("project_trust_status", { path })
        : call(commands.projectTrustStatus(path)));
      if (status.decided) return true;
      usePrompt.getState().finish?.(false);
      return new Promise<boolean>((resolve) =>
        usePrompt.setState({
          path: status.root,
          scope,
          folder: false,
          finish: (open) => {
            usePrompt.setState({ path: null, scope: "current", finish: null, folder: false });
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
