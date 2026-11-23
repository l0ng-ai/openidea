import type { Commit, LogDetails } from "@/bindings";
import { writeClipboardText } from "@/platform/clipboard";
import { tx } from "@/platform/i18n";
import { Icon } from "@/ui";
import clsx from "clsx";
import { CommitMessageContent } from "../CommitMessageContent";
import styles from "../GitLog.module.css";
import { IssueText } from "../issueLinks";
import { useCommitDetails } from "../logDetails";
import { refLabels, type RefLabel } from "../logOptions";
import { goToRef } from "../logStore";
import { commitRepo } from "../multiRoot";
import { currentRepo } from "../store";

const REF_KIND_CLASS = {
  head: styles.refHead,
  local: styles.refLocal,
  remote: styles.refRemote,
  tag: styles.refTag,
};

const NO_REMOTES: ReadonlySet<string> = new Set();

export function RefLabels({
  refs,
  compact = false,
  tagNames = true,
  remoteNames = NO_REMOTES,
  left = false,
}: {
  refs: string[];
  compact?: boolean;
  tagNames?: boolean;
  remoteNames?: ReadonlySet<string>;
  left?: boolean;
}) {
  return (
    <RefGroup
      labels={refLabels(refs, { compact, tagNames }, remoteNames)}
      className={clsx(styles.refs, compact && styles.refsCompact, left && styles.refsLeft)}
    />
  );
}

function RefGroup({ labels, className }: { labels: RefLabel[]; className: string | undefined }) {
  if (!labels.length) return null;
  return (
    <span className={className}>
      {labels.map((l) => (
        <span key={`${l.kind}:${l.title}`} className={clsx(styles.ref, REF_KIND_CLASS[l.kind])} title={l.title}>
          {l.text && <span className={styles.refText}>{l.text}</span>}
        </span>
      ))}
    </span>
  );
}

function CommitReferences({ refs }: { refs: string[] }) {
  const labels = refLabels(refs, { compact: false, tagNames: true }, NO_REMOTES);
  return (
    <div className={styles.meta}>
      <RefGroup labels={labels.filter((label) => label.kind !== "tag")} className={styles.detailRefGroup} />
      <RefGroup labels={labels.filter((label) => label.kind === "tag")} className={styles.detailRefGroup} />
    </div>
  );
}

/** A commit's message and metadata; `compact` (one of several selected): without the body. */
export function CommitMessage({ commit, compact = false }: { commit: Commit; compact?: boolean }) {
  const { details, error } = useCommitDetails(commit, !compact);
  const repo = commitRepo(commit) ?? currentRepo();
  return (
    <div className={clsx(compact && styles.commitEntry)}>
      <CommitMessageContent
        commit={commit}
        message={details?.message || commit.message}
        compact={compact}
        renderText={(text) => <CommitMessageText text={text} repo={repo} />}
        revision={
          <button
            type="button"
            className={styles.linkButton}
            title={tx("Copy revision number")}
            onClick={() => void writeClipboardText(commit.id)}
          >
            {commit.shortId}
          </button>
        }
      />
      {!compact &&
        commit.committer &&
        (commit.committer !== commit.author ||
          commit.committerEmail !== commit.email ||
          commit.commitTimeMs !== commit.timeMs) && (
          <div className={styles.meta}>
            {tx("Committed by")} {commit.committer} &lt;{commit.committerEmail}&gt;{" "}
            {commit.commitTimeMs ? new Date(commit.commitTimeMs).toLocaleString() : ""}
          </div>
        )}
      {commit.parents.length > 0 && (
        <div className={styles.meta}>
          {tx(commit.parents.length > 1 ? "Merge of" : "Parent")}{" "}
          {commit.parents.map((id, i) => (
            <span key={id}>
              {i > 0 ? ", " : ""}
              <button type="button" className={styles.linkButton} onClick={() => void goToRef(id, repo)}>
                {id.slice(0, 8)}
              </button>
            </span>
          ))}
        </div>
      )}
      {commit.refs.length > 0 && <CommitReferences refs={commit.refs} />}
      {details && (
        <>
          <div className={styles.meta}>
            {tx("Containing branches")}:{" "}
            {details.containingBranches.length
              ? details.containingBranches.map((branch, i) => (
                  <span key={branch}>
                    {i > 0 ? ", " : ""}
                    <button type="button" className={styles.linkButton} onClick={() => void goToRef(branch, repo)}>
                      {branch}
                    </button>
                  </span>
                ))
              : tx("None")}
          </div>
          <div className={styles.meta} title={signatureDescription(details)}>
            {tx("Signature")}: {signatureLabel(details.signature)}
            {details.signer ? ` · ${details.signer}` : ""}
          </div>
        </>
      )}
      {error && (
        <div role="status" className={styles.meta}>
          {tx("Could not load containing branches or signature details")}
        </div>
      )}
    </div>
  );
}

function signatureLabel(code: string) {
  return tx(
    (
      {
        G: "Verified",
        U: "Good signature with unknown trust",
        B: "Bad signature",
        E: "Could not verify",
        N: "Unsigned",
        X: "Expired signature",
        Y: "Expired signing key",
        R: "Revoked signing key",
      } as Record<string, string>
    )[code] ?? "Could not verify",
  );
}

function signatureDescription({ signature, signer, fingerprint, key }: LogDetails) {
  return [
    signatureLabel(signature),
    signer && tx`Signed by ${signer}`,
    fingerprint ? tx`Key fingerprint ${fingerprint}` : key && tx`Signing key ${key}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function CommitSignature({ commit }: { commit: Commit }) {
  const { details, error } = useCommitDetails(commit);
  if (details?.signature === "N" || (!details && !error)) return null;
  const code = details?.signature ?? "E";
  const label = signatureLabel(code);
  return (
    <span className={styles.signatureIndicator} title={details ? signatureDescription(details) : label}>
      <Icon name={code === "G" ? "success" : code === "B" ? "error" : "warning"} size={14} label={label} />
    </span>
  );
}

function CommitMessageText({ text, repo }: { text: string; repo: string | null | undefined }) {
  return text.split(/\b([a-fA-F0-9]{7,64})\b/g).map((part, i) =>
    i % 2 ? (
      <button type="button" className={styles.linkButton} key={i} onClick={() => void goToRef(part, repo)}>
        {part}
      </button>
    ) : (
      <IssueText key={i} text={part} />
    ),
  );
}
