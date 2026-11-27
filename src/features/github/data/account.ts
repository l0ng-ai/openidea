/**
 * Per-project GitHub CLI (`gh`) account selection (`vcs.github.account` in `.openidea/settings.toml`).
 * Kept free of editor/markdown imports so `GithubSettingsPage` stays within `settingsWindowBoot`.
 */
import { create } from "zustand";
import type { GhProjectAccountStatus } from "@/bindings";
import { tx } from "@/platform/i18n";
import { call, commands, isTauri } from "@/platform/ipc";
import type { SelectOption } from "@/ui";

interface GhProjectAccountState {
  status: GhProjectAccountStatus | null;
  loading: boolean;
  saving: boolean;
  /** Incremented whenever the user changes the project GitHub account so open views reconnect. */
  revision: number;
}

export const useGhProjectAccount = create<GhProjectAccountState>(() => ({
  status: null,
  loading: false,
  saving: false,
  revision: 0,
}));

export async function loadProjectGithubAccount(): Promise<GhProjectAccountStatus | null> {
  if (!isTauri()) return useGhProjectAccount.getState().status;
  useGhProjectAccount.setState({ loading: true });
  try {
    const status = await call(commands.ghProjectAccountStatus());
    useGhProjectAccount.setState({ status, loading: false });
    return status;
  } catch {
    useGhProjectAccount.setState({ loading: false });
    return null;
  }
}

export async function setProjectGithubAccount(account: string): Promise<GhProjectAccountStatus | null> {
  if (!isTauri()) {
    useGhProjectAccount.setState((s) => ({
      status: s.status
        ? {
            ...s.status,
            configuredAccount: account,
            effectiveAccount: account || s.status.accounts.find((a) => a.active)?.login || null,
            suggestedAccount: account ? null : s.status.suggestedAccount,
          }
        : null,
      revision: s.revision + 1,
    }));
    return useGhProjectAccount.getState().status;
  }
  useGhProjectAccount.setState({ saving: true });
  try {
    const status = await call(commands.ghSetProjectAccount(account));
    useGhProjectAccount.setState((s) => ({ status, saving: false, revision: s.revision + 1 }));
    return status;
  } catch {
    useGhProjectAccount.setState({ saving: false });
    return null;
  }
}

export function projectAccountOptions(status: GhProjectAccountStatus | null): SelectOption[] {
  const accounts = status?.accounts ?? [];
  const configured = status?.configuredAccount ?? "";
  const activeLogin =
    accounts.find((a) => a.active)?.login ?? (!configured ? (status?.effectiveAccount ?? null) : null);
  const automaticLabel = activeLogin ? tx`Automatic (${activeLogin})` : tx("Automatic");

  return [
    { value: "", label: automaticLabel, verbatim: true },
    ...accounts.map((a) => ({ value: a.login, label: a.login, verbatim: true })),
    ...(configured && !accounts.some((a) => a.login === configured)
      ? [{ value: configured, label: tx`${configured} (not signed in)`, verbatim: true }]
      : []),
  ];
}
