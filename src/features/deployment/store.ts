/** Session state of the deployment feature: the Sync dialog, the SSH secret prompt and the Remote Host tree. */
import { create } from "zustand";
import type { RemoteEntry, RequestId, SyncEntry } from "@/platform/ipc";
import type { FocusedPart, SyncChoice } from "./model";

export const REMOTE_HOST_WINDOW = "remoteHost";

export interface SyncDialogState {
  server: string;
  serverName: string;
  /** Absolute local path compared (file or folder). */
  path: string;
  request: RequestId | null;
  entries: SyncEntry[] | null;
  error: string | null;
  choices: Record<string, SyncChoice>;
  hideSame: boolean;
  running: boolean;
}

export interface SecretPrompt {
  ssh: string;
  message: string;
  resolve: (answer: { secret: string; save: boolean } | null) => void;
}

/** Remote Host tool window, per server: resolved root, loaded folders, expanded folders. */
export interface RemoteTreeState {
  root: string | null;
  error: string | null;
  listings: Record<string, RemoteEntry[]>;
  folderErrors: Record<string, string>;
  expanded: ReadonlySet<string>;
}

interface DeploymentState {
  sync: SyncDialogState | null;
  secret: SecretPrompt | null;
  /** Which workbench part had focus last (targets of actions run from Find Action). */
  part: FocusedPart;
  /** Server shown in the Remote Host tool window. */
  remoteServer: string | null;
  trees: Record<string, RemoteTreeState>;
}

export const useDeployment = create<DeploymentState>(() => ({
  sync: null,
  secret: null,
  part: null,
  remoteServer: null,
  trees: {},
}));

export const EMPTY_TREE: RemoteTreeState = {
  root: null,
  error: null,
  listings: {},
  folderErrors: {},
  expanded: new Set(),
};

export function patchTree(
  server: string,
  patch: Partial<RemoteTreeState> | ((t: RemoteTreeState) => Partial<RemoteTreeState>),
) {
  useDeployment.setState((s) => {
    const current = s.trees[server] ?? EMPTY_TREE;
    const next = typeof patch === "function" ? patch(current) : patch;
    return { trees: { ...s.trees, [server]: { ...current, ...next } } };
  });
}

export function patchSync(patch: Partial<SyncDialogState>) {
  useDeployment.setState((s) => (s.sync ? { sync: { ...s.sync, ...patch } } : {}));
}

/** Asks for the password / passphrase of SSH configuration `ssh`. */
export function promptSecret(ssh: string, message: string): Promise<{ secret: string; save: boolean } | null> {
  return new Promise((resolve) => {
    useDeployment.getState().secret?.resolve(null);
    useDeployment.setState({
      secret: {
        ssh,
        message,
        resolve: (answer) => {
          useDeployment.setState({ secret: null });
          resolve(answer);
        },
      },
    });
  });
}
