/**
 * Settings › Version Control › GitHub (`GithubSettingsConfigurable`): per-project GitHub CLI
 * account selection (`vcs.github.account`) and pull request review options. Applies at once,
 * like the Log page.
 */
import { useEffect, useId, useRef, useState } from "react";
import { GH_MANUAL_INSTALL_URL, installGhTool } from "@/platform/ghTool";
import { tx } from "@/platform/i18n";
import { isCancelled } from "@/platform/ipc";
import { openExternalUrl } from "@/platform/openUrl";
import { Button, Checkbox, Select, Spinner, T } from "@/ui";
import { CliSignInDialog } from "@/workbench/CliSignInDialog";
import {
  loadProjectGithubAccount,
  projectAccountOptions,
  refreshAfterGithubSignIn,
  setProjectGithubAccount,
  useGhProjectAccount,
} from "../data/account";
import { setReviewDiffSettings, useReviewDiffSettings } from "./settings";
import styles from "./ReviewDiff.module.css";

export function GithubSettingsPage() {
  const autoMarkViewed = useReviewDiffSettings((s) => s.autoMarkViewed);
  const status = useGhProjectAccount((s) => s.status);
  const saving = useGhProjectAccount((s) => s.saving);
  const [signingIn, setSigningIn] = useState(false);
  const [installingGh, setInstallingGh] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const prevLoginsRef = useRef<Set<string>>(new Set());
  const accountHeading = useId();
  const prHeading = useId();
  const selectId = useId();

  useEffect(() => {
    void loadProjectGithubAccount();
  }, []);

  const options = projectAccountOptions(status);
  const value = status?.configuredAccount ?? "";
  const suggested = !value ? (status?.suggestedAccount ?? null) : null;
  const ghMissing = status !== null && !status.ghInstalled;
  const hasAccounts = (status?.accounts.length ?? 0) > 0;

  const startSignIn = () => {
    prevLoginsRef.current = new Set((status?.accounts ?? []).map((entry) => entry.login));
    setSigningIn(true);
  };

  const installGh = () => {
    if (installingGh) return;
    setInstallingGh(true);
    setInstallError(null);
    void installGhTool()
      .promise.then((installed) => {
        if (installed) void loadProjectGithubAccount();
      })
      .catch((e: unknown) => {
        if (!isCancelled(e)) setInstallError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setInstallingGh(false));
  };

  return (
    <div className={styles.page}>
      <section className={styles.section} aria-labelledby={accountHeading}>
        <h2 id={accountHeading} className={styles.heading}>
          <T>Account</T>
        </h2>
        <div className={styles.accountRow}>
          <label htmlFor={selectId} className={styles.accountLabel}>
            <T>GitHub account</T>:
          </label>
          <div className={styles.accountControl}>
            <div className={styles.accountField}>
              <div className={styles.accountSelect}>
                <Select
                  id={selectId}
                  aria-label="GitHub account"
                  value={value}
                  disabled={saving}
                  options={options}
                  onChange={(next) => void setProjectGithubAccount(next)}
                />
              </div>
              {status?.ghInstalled && (
                <Button
                  size="small"
                  variant={hasAccounts ? "secondary" : "primary"}
                  disabled={saving}
                  onClick={startSignIn}
                >
                  <T>{hasAccounts ? "Add account…" : "Sign In…"}</T>
                </Button>
              )}
              {ghMissing && (
                <>
                  <Button size="small" variant="primary" disabled={installingGh} onClick={installGh}>
                    {installingGh ? (
                      <>
                        <Spinner size={12} /> <T>Installing…</T>
                      </>
                    ) : (
                      <T>Install GitHub CLI</T>
                    )}
                  </Button>
                  <Button size="small" onClick={() => void openExternalUrl(GH_MANUAL_INSTALL_URL)}>
                    <T>Download manually…</T>
                  </Button>
                </>
              )}
              {suggested && (
                <Button size="small" disabled={saving} onClick={() => void setProjectGithubAccount(suggested)}>
                  {tx`Use ${suggested} for this project`}
                </Button>
              )}
            </div>
            <p className={styles.accountHint}>
              {ghMissing ? (
                <T>Install GitHub CLI (`gh`) to switch between multiple GitHub accounts.</T>
              ) : value ? (
                <T>
                  Passes this account&apos;s GH_TOKEN to processes started in this project (terminals, agents, Git, and
                  run configurations).
                </T>
              ) : (
                <T>Uses GitHub CLI&apos;s active account without setting GH_TOKEN in the project environment.</T>
              )}
            </p>
            {installError && (
              <p className={styles.accountHint} role="alert">
                {installError}
              </p>
            )}
          </div>
        </div>
      </section>
      <section className={styles.section} aria-labelledby={prHeading}>
        <h2 id={prHeading} className={styles.heading}>
          <T>Pull Requests</T>
        </h2>
        <Checkbox
          checked={autoMarkViewed}
          onChange={(v) => setReviewDiffSettings({ autoMarkViewed: v })}
          label="Automatically mark opened files as viewed"
        />
      </section>
      {signingIn && (
        <CliSignInDialog
          target={{ kind: "gh" }}
          onClose={() => setSigningIn(false)}
          onCompleted={() => void refreshAfterGithubSignIn(prevLoginsRef.current)}
        />
      )}
    </div>
  );
}
