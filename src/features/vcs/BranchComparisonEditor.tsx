import { useEffect } from "react";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { Button, SplitGroup, SplitHandle, SplitPanel } from "@/ui";
import type { EditorInput } from "@/workbench/contributions";
import { comparisonPaneIds, type BranchComparisonData } from "./CompareBranches";
import styles from "./CompareBranches.module.css";
import { LogView } from "./GitLog";
import { useDropdownMenu } from "./log/logHooks";
import { LogScope } from "./LogScope";
import { ensureEditorLog, focusLogView, useRootGitLog } from "./logStore";
import { repoName, useVcs } from "./store";

export function BranchComparisonEditor({ input }: { input: EditorInput }) {
  const data = input.data as BranchComparisonData;
  const { branch, current, repositories } = data;
  const [incoming, outgoing] = comparisonPaneIds(input.key);
  const root = useVcs((s) => s.root);
  const ready = useRootGitLog(
    (s) => s.logTabs.some((t) => t.id === incoming) && s.logTabs.some((t) => t.id === outgoing),
  );
  useEffect(() => {
    ensureEditorLog(incoming, branch.name, { comparison: { from: current.rev, to: branch.rev }, repositories });
    ensureEditorLog(outgoing, current.name, { comparison: { from: branch.rev, to: current.rev }, repositories });
    if (useRootGitLog.getState().shownLog !== outgoing) focusLogView(incoming);
  }, [root, incoming, outgoing, branch, current, repositories]);
  const [menu, dropdown] = useDropdownMenu();
  const diff = (repo: string) => void executeAction("vcs.log.compareBranchTrees", { ...data, repo });
  return (
    <div className={styles.editor}>
      <div className={styles.header}>
        <Button
          variant="ghost"
          icon="diff"
          onClick={(e) => {
            if (repositories.length === 1) diff(repositories[0]!);
            else
              menu(
                e,
                repositories.map((repo) => ({ label: repoName(repo), verbatim: true, run: () => diff(repo) })),
              );
          }}
        >
          Show Branch Diff
        </Button>
        {dropdown}
      </div>
      {ready && (
        <SplitGroup orientation="vertical" storageKey="openidea.vcs.branchComparison.split" className={styles.ranges}>
          <ComparisonPane id={incoming} label={tx`In ${branch.name}, not in ${current.name}`} />
          <SplitHandle aria-label={tx("Resize branch comparison panes")} />
          <ComparisonPane id={outgoing} label={tx`In ${current.name}, not in ${branch.name}`} />
        </SplitGroup>
      )}
    </div>
  );
}

function ComparisonPane({ id, label }: { id: string; label: string }) {
  return (
    <SplitPanel id={id} defaultSize="50%" minSize="23%">
      <section className={styles.range} aria-label={label}>
        <h3 className={styles.rangeTitle}>{label}</h3>
        <LogScope id={id}>
          <LogView />
        </LogScope>
      </section>
    </SplitPanel>
  );
}
