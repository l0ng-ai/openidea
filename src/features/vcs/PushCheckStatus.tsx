import type { Commit } from "@/bindings";
import { T } from "@/ui";
import { CommitCheckSummary } from "./CommitCheckSummary";
import type { CommitProblem } from "./commitChecks";
import { usePostCommitChecks } from "./postCommitChecks";
import { repoName } from "./store";
import styles from "./common.module.css";

export function PushCheckStatus({
  outgoing,
  onReview,
}: {
  outgoing: readonly { repo: string; commits: readonly Pick<Commit, "id">[] }[];
  onReview: () => void;
}) {
  const { repositories: checks, tests } = usePostCommitChecks();
  const relevant = outgoing.flatMap<{ repo: string; check: { problems: CommitProblem[] | null } }>(
    ({ repo, commits }) => {
      const check = checks.get(repo);
      return check && commits.some(({ id }) => check.ids.includes(id)) ? [{ repo, check }] : [];
    },
  );
  if (
    tests &&
    tests.targets.some((target) =>
      outgoing.some(({ repo, commits }) => repo === target.repo && commits.some(({ id }) => id === target.id)),
    )
  )
    relevant.push({ repo: "", check: tests });
  return (
    <>
      {relevant.some(({ check }) => !check.problems) && (
        <div className={`${styles.banner} ${styles.pushWarning}`} role="status">
          <T>Post-commit checks are still running</T>
        </div>
      )}
      {relevant.flatMap(({ repo, check: { problems } }) =>
        problems
          ? [
              <div key={repo} className={`${styles.banner} ${styles.pushWarning}`}>
                <span role="status">
                  {repo && outgoing.length > 1 && <strong>{repoName(repo)} · </strong>}
                  <T>Post-commit checks failed</T>
                </span>
                <CommitCheckSummary result={{ problems, blocked: false }} onInspect={onReview} />
              </div>,
            ]
          : [],
      )}
    </>
  );
}
