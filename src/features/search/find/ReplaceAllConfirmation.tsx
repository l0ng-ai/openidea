import { tx } from "@/platform/i18n";
import { T } from "@/ui";
import { confirm } from "@/workbench/messages";
import { confirmText, type ReplaceCounts } from "./replaceFlow";
import styles from "./ReplaceAllConfirmation.module.css";

export function confirmReplacement({
  counts,
  pattern,
  replacement,
  hasExclusions,
}: {
  counts: ReplaceCounts | null;
  pattern: string;
  replacement: string;
  hasExclusions: boolean;
}): Promise<boolean> {
  return confirm({
    title: "Replace All",
    ok: "Replace",
    message: (
      <div className={styles.content}>
        <p>{counts ? confirmText(counts) : <T>Replace every occurrence in the scope?</T>}</p>
        <dl className={styles.values}>
          <dt>
            <T>Text to find</T>
          </dt>
          <dd>
            <pre role="region" aria-label={tx("Text to find")} tabIndex={0}>
              {pattern}
            </pre>
          </dd>
          <dt>
            <T>Replace with</T>
          </dt>
          <dd>
            <pre role="region" aria-label={tx("Replace with")} tabIndex={0}>
              {replacement || (
                <span className={styles.empty}>
                  <T>Empty text</T>
                </span>
              )}
            </pre>
          </dd>
        </dl>
        {!counts && (
          <p className={styles.note}>
            <T>The search hit its limit, so it runs again to find any additional matches.</T>
          </p>
        )}
        {hasExclusions && (
          <p className={styles.note}>
            <T>Excluded usages are skipped.</T>
          </p>
        )}
      </div>
    ),
  });
}
