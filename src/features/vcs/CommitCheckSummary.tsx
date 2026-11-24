import { tx } from "@/platform/i18n";
import { Icon, T } from "@/ui";
import type { CommitCheckRun } from "./commitChecks";
import styles from "./CommitView.module.css";

export function CommitCheckSummary({
  result,
  onInspect,
  onOpenToolWindow,
}: {
  result: CommitCheckRun & { stale?: boolean };
  onInspect?: () => void;
  onOpenToolWindow?: () => void;
}) {
  const passed = !result.problems.length;
  return (
    <div
      className={styles.checkProblems}
      role={result.blocked && !result.stale ? "alert" : "status"}
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest("button")) onInspect?.();
      }}
    >
      <Icon
        name={passed ? "check" : "warning"}
        size={14}
        className={passed ? styles.checkPassedIcon : styles.checkProblemsIcon}
      />
      <div className={styles.checkProblemsList}>
        {passed ? (
          <T>Commit checks passed</T>
        ) : (
          result.problems.map((p, i) => (
            <div key={i}>
              <span className={styles.checkProblemTitle}>{tx(p.title)}</span>
              {" · "}
              {typeof p.text === "string" ? tx(p.text) : p.text}
              {p.details && (
                <>
                  {" "}
                  <button
                    type="button"
                    className={styles.checkProblemLink}
                    onClick={() => {
                      if (p.details?.opensToolWindow) onOpenToolWindow?.();
                      void p.details?.run();
                    }}
                  >
                    {tx(p.details.label)}
                  </button>
                </>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
