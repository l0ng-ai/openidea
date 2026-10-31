/**
 * Settings › Version Control › GitHub (`GithubSettingsConfigurable`); accounts are gh's, so
 * only the pull request option is here. Applies at once, like the Log page.
 */
import { Checkbox } from "@/ui";
import { setReviewDiffSettings, useReviewDiffSettings } from "./settings";
import styles from "./ReviewDiff.module.css";

export function GithubSettingsPage() {
  const autoMarkViewed = useReviewDiffSettings((s) => s.autoMarkViewed);
  return (
    <div className={styles.page}>
      <Checkbox
        checked={autoMarkViewed}
        onChange={(v) => setReviewDiffSettings({ autoMarkViewed: v })}
        label="Automatically mark opened files as viewed"
      />
    </div>
  );
}
