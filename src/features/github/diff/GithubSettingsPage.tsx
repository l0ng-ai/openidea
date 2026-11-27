/**
 * Settings › Version Control › GitHub (`GithubSettingsConfigurable`): per-project GitHub CLI
 * account selection (`vcs.github.account`) and pull request review options. Applies at once,
 * like the Log page.
 */
import { useEffect, useId } from "react";
import { tx } from "@/platform/i18n";
import { Button, Checkbox, Select, T } from "@/ui";
import {
  loadProjectGithubAccount,
  projectAccountOptions,
  setProjectGithubAccount,
  useGhProjectAccount,
} from "../data/account";
import { setReviewDiffSettings, useReviewDiffSettings } from "./settings";
import styles from "./ReviewDiff.module.css";

export function GithubSettingsPage() {
  const autoMarkViewed = useReviewDiffSettings((s) => s.autoMarkViewed);
  const status = useGhProjectAccount((s) => s.status);
  const saving = useGhProjectAccount((s) => s.saving);
  const accountHeading = useId();
  const prHeading = useId();
  const selectId = useId();

  useEffect(() => {
    void loadProjectGithubAccount();
  }, []);

  const options = projectAccountOptions(status);
  const value = status?.configuredAccount ?? "";
  const suggested = !value ? (status?.suggestedAccount ?? null) : null;

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
              {suggested && (
                <Button size="small" disabled={saving} onClick={() => void setProjectGithubAccount(suggested)}>
                  {tx`Use ${suggested} for this project`}
                </Button>
              )}
            </div>
            <p className={styles.accountHint}>
              {value ? (
                <T>
                  Passes this account&apos;s GH_TOKEN to processes started in this project (terminals, agents, Git, and
                  run configurations).
                </T>
              ) : (
                <T>Uses GitHub CLI&apos;s active account without setting GH_TOKEN in the project environment.</T>
              )}
            </p>
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
    </div>
  );
}
