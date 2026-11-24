/** Git User Name Is Not Defined: before a commit, asks for `user.name` / `user.email` when a repository has none. */
import { useState } from "react";
import { tx, useTx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { Checkbox, Dialog, Input, T } from "@/ui";
import { notifications } from "@/workbench/contributions";
import { openDialog } from "./dialogs";
import { readConfiguredGitIdentity } from "./gitIdentity";
import styles from "./common.module.css";

export interface CommitIdentity {
  name: string;
  email: string;
  /** Written to the user's global Git config instead of each repository's. */
  global: boolean;
}

/** The account name in the project path (`/Users/<name>/…`), as the proposed user name. */
function systemUserName(): string {
  const root = useProject.getState().project?.root ?? "";
  return /^\/(?:Users|home)\/([^/]+)/.exec(root)?.[1] ?? /^[A-Za-z]:[\\/]Users[\\/]([^\\/]+)/.exec(root)?.[1] ?? "";
}

export function identityError(name: string, email: string): string | null {
  if (!name.trim() || !email.trim()) return tx("You need to specify username and email for Git");
  if (!email.includes("@")) return tx("The email address must contain the '@' symbol");
  return null;
}

/**
 * Makes sure every repository the commit writes to has a commit identity: when one lacks
 * `user.name` or `user.email`, asks for them and sets them. False when the user cancelled
 * or they could not be set.
 */
export async function ensureCommitIdentity(roots: readonly (string | null)[], amend: boolean): Promise<boolean> {
  const found = await Promise.all(roots.map(async (root) => ({ root, ...(await readConfiguredGitIdentity(root)) })));
  const missing = found.filter((r) => !r.name || !r.email);
  if (!missing.length) return true;
  // A user that every other repository agrees on is proposed (IDEA does the same).
  const others = found.filter((r) => r.name && r.email);
  const same = others.length > 0 && others.every((r) => r.name === others[0]!.name && r.email === others[0]!.email);
  const initial = {
    name: same ? others[0]!.name! : (missing.find((r) => r.name)?.name ?? systemUserName()),
    email: same ? others[0]!.email! : (missing.find((r) => r.email)?.email ?? ""),
  };
  const identity = await new Promise<CommitIdentity | null>((resolve) =>
    openDialog((close) => (
      <CommitIdentityDialog
        initial={initial}
        roots={roots.length > 1 ? missing.map((r) => r.root ?? "") : []}
        amend={amend}
        done={(v) => {
          close();
          resolve(v);
        }}
      />
    )),
  );
  if (!identity) return false;
  try {
    if (identity.global) await call(commands.vcsSetUserIdentity(missing[0]!.root, identity.name, identity.email, true));
    else
      for (const { root } of missing)
        await call(commands.vcsSetUserIdentity(root, identity.name, identity.email, false));
    return true;
  } catch (e) {
    notifications().notify({
      group: "vcs",
      level: "error",
      title: tx("Could not set the Git user name and email"),
      body: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

function CommitIdentityDialog({
  initial,
  roots,
  amend,
  done,
}: {
  initial: { name: string; email: string };
  /** The repositories without an identity, listed when the commit spans several. */
  roots: readonly string[];
  amend: boolean;
  done: (identity: CommitIdentity | null) => void;
}) {
  const t = useTx();
  const [name, setName] = useState(initial.name);
  const [email, setEmail] = useState(initial.email);
  const [global, setGlobal] = useState(true);
  const [submitted, setSubmitted] = useState(false);
  const error = submitted ? identityError(name, email) : null;
  const n = roots.length;
  const submit = () => {
    setSubmitted(true);
    if (identityError(name, email)) return;
    done({ name: name.trim(), email: email.trim(), global });
  };
  return (
    <Dialog
      open
      title="Git User Name Is Not Defined"
      onClose={() => done(null)}
      width={440}
      buttons={[
        { label: amend ? "Set and Amend Commit" : "Set and Commit", role: "default", onClick: submit },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.form}>
        {roots.length > 0 && (
          <div className={styles.hint}>
            {n === 1
              ? t("Git user.name and user.email properties are not defined in 1 root")
              : t`Git user.name and user.email properties are not defined in ${n} roots`}
            {roots.map((r) => (
              <div key={r}>{r}</div>
            ))}
          </div>
        )}
        <label className={styles.fieldLabel} htmlFor="vcs-identity-name">
          <T>Name:</T>
        </label>
        <Input id="vcs-identity-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        <label className={styles.fieldLabel} htmlFor="vcs-identity-email">
          <T>E-mail:</T>
        </label>
        <Input id="vcs-identity-email" value={email} onChange={(e) => setEmail(e.target.value)} />
        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}
        <Checkbox checked={global} onChange={setGlobal} label="Set properties globally" />
      </div>
    </Dialog>
  );
}
