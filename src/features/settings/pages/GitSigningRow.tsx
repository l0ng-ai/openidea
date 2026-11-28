import { useEffect, useId, useState } from "react";
import { tx } from "@/platform/i18n";
import {
  call,
  commands,
  isTauri,
  nextRequestId,
  type GitSigningConfig,
  type GpgSigningKey,
  type SshSigningKey,
  type VcsRoot,
} from "@/platform/ipc";
import { basename, useProject } from "@/platform/project";
import { Button, Dialog, Select, type SelectOption, T } from "@/ui";
import { FormGroup, Row, Toggle } from "../components/Form";
import { useSettingsDialog } from "../model/staging";
import styles from "./GitSettings.module.css";
import workflow from "./Workflow.module.css";

export function GitSigningRow() {
  const project = useProject((s) => s.project);
  const newProjects = useSettingsDialog((s) => s.newProjects);
  const [open, setOpen] = useState(false);
  const canConfigure = !!project?.trusted && !newProjects && isTauri();

  return (
    <Row
      label="GPG signing"
      hint={project?.trusted === false && !newProjects ? "Trust the project to configure GPG signing." : undefined}
    >
      <Button disabled={!canConfigure} onClick={() => setOpen(true)}>
        <T>Configure GPG Signature…</T>
      </Button>
      {open && canConfigure && (
        <SigningDialog key={project.root} projectRoot={project.root} onClose={() => setOpen(false)} />
      )}
    </Row>
  );
}

function SigningDialog({ projectRoot, onClose }: { projectRoot: string; onClose: () => void }) {
  const [roots, setRoots] = useState<VcsRoot[]>();
  const [repo, setRepo] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    void call(commands.vcsRoots()).then(
      (roots) => {
        if (!live) return;
        setRoots(roots);
        setRepo(roots.find((root) => root.root === projectRoot)?.root ?? roots[0]?.root);
      },
      (error: unknown) => live && setError(message(error)),
    );
    return () => {
      live = false;
    };
  }, [projectRoot]);

  if (roots && repo) {
    return <RepositorySigning key={repo} repo={repo} roots={roots} onChooseRepo={setRepo} onClose={onClose} />;
  }
  return (
    <Dialog
      open
      title={<T>Configure GPG Signature</T>}
      onClose={onClose}
      buttons={[{ label: "Close", role: "cancel" }]}
    >
      <div className={styles.signingForm}>
        {error ? (
          <div className={workflow.error} role="alert">
            {error}
          </div>
        ) : roots ? (
          <T>No Git repositories are configured for this project.</T>
        ) : (
          <span role="status">
            <T>Loading…</T>
          </span>
        )}
      </div>
    </Dialog>
  );
}

function RepositorySigning({
  repo,
  roots,
  onChooseRepo,
  onClose,
}: {
  repo: string;
  roots: VcsRoot[];
  onChooseRepo: (repo: string) => void;
  onClose: () => void;
}) {
  const rootId = useId();
  const keyId = useId();
  const formatId = useId();
  const [initial, setInitial] = useState<GitSigningConfig>();
  const [format, setFormat] = useState<string>();
  const [enabled, setEnabled] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const [keys, setKeys] = useState<{
    format: string;
    gpg?: GpgSigningKey[];
    ssh?: SshSigningKey[];
    error?: string;
  }>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    void call(commands.vcsSigningConfig(repo)).then(
      (config) => {
        if (!live) return;
        setInitial(config);
        setFormat(config.format);
        setEnabled(config.enabled);
        setKey(config.key);
      },
      (error: unknown) => live && setError(message(error)),
    );
    return () => {
      live = false;
    };
  }, [repo]);

  const supported = initial?.format === "openpgp" || initial?.format === "ssh";
  useEffect(() => {
    if (!supported || !format) return;
    let live = true;
    let request: ReturnType<typeof nextRequestId> | undefined = nextRequestId();
    const loaded =
      format === "ssh"
        ? call(commands.vcsSshSigningKeys(repo, request)).then((ssh) => ({ format, ssh }))
        : call(commands.vcsGpgSigningKeys(repo, request)).then((gpg) => ({ format, gpg }));
    void loaded
      .then(
        (keys) => live && setKeys(keys),
        (error: unknown) => live && setKeys({ format, error: message(error) }),
      )
      .finally(() => {
        request = undefined;
      });
    return () => {
      live = false;
      if (request !== undefined) void commands.cancelRequest(request).catch(() => undefined);
    };
  }, [repo, format, supported]);

  const ssh = format === "ssh";
  const changedFormat = initial && format !== initial.format;
  const changedEnabled = initial && enabled !== initial.enabled;
  const changedKey = enabled && (key !== initial?.key || changedFormat);
  const dirty = changedFormat || changedEnabled || changedKey;
  const shown = keys?.format === format ? keys : undefined;
  const keysError = shown?.error;
  const options: SelectOption<string>[] = ssh
    ? (shown?.ssh ?? []).map((key) => ({
        value: key.key,
        label: key.comment || key.key,
        verbatim: true,
        detail: [key.key.startsWith("key::") ? undefined : key.key, key.inAgent ? "ssh-agent" : undefined]
          .filter(Boolean)
          .join(" · "),
        verbatimDetail: true,
      }))
    : (shown?.gpg ?? []).map((key) => ({
        value: key.fingerprint,
        label: key.userId || key.fingerprint,
        verbatim: true,
        detail: key.userId ? key.fingerprint : undefined,
        verbatimDetail: true,
      }));
  if (key && !options.some((option) => option.value === key)) {
    options.unshift({ value: key, label: key, verbatim: true });
  }
  const outsideAgent = ssh && !!key && !!shown?.ssh && !shown.ssh.some((k) => k.key === key && k.inAgent);

  function chooseFormat(next: string) {
    setFormat(next);
    setKey(next === initial?.format ? (initial?.key ?? null) : null);
  }

  async function save() {
    if (!supported || !dirty || saving || (enabled && !key)) return;
    setSaving(true);
    setError(undefined);
    try {
      await call(
        commands.vcsEditSigning(repo, {
          enabled: changedEnabled ? enabled : null,
          key: changedKey ? key : null,
          format: changedFormat ? (format ?? null) : null,
        }),
      );
      onClose();
    } catch (error) {
      setError(message(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      title={<T>Configure GPG Signature</T>}
      onClose={() => {
        if (!saving) onClose();
      }}
      width={540}
      buttons={[
        {
          label: "OK",
          role: "default",
          disabled: !supported || !dirty || saving || (enabled && !key),
          onClick: () => void save(),
        },
        { label: "Cancel", role: "cancel", disabled: saving },
      ]}
    >
      <FormGroup className={styles.signingForm}>
        {roots.length > 1 ? (
          <Row label="Repository" htmlFor={rootId} stacked>
            <Select
              id={rootId}
              className={styles.signingPicker}
              title={repo}
              value={repo}
              disabled={saving || !!dirty}
              options={roots.map(({ root }) => ({
                value: root,
                label: basename(root),
                verbatim: true,
                detail: root,
                verbatimDetail: true,
              }))}
              onChange={onChooseRepo}
            />
          </Row>
        ) : (
          <div className={styles.signingRoot} title={repo}>
            {basename(repo)}
          </div>
        )}
        {initial ? (
          supported ? (
            <>
              <Row label="Signing format" htmlFor={formatId} stacked>
                <Select
                  id={formatId}
                  className={styles.signingPicker}
                  value={format ?? null}
                  options={[
                    { value: "openpgp", label: "OpenPGP", verbatim: true },
                    { value: "ssh", label: "SSH", verbatim: true },
                  ]}
                  disabled={saving}
                  onChange={chooseFormat}
                />
              </Row>
              <Toggle
                label={ssh ? "Sign commits with SSH" : "Sign commits with GPG"}
                checked={enabled}
                onChange={setEnabled}
                disabled={saving}
              />
              <Row
                label="Signing key"
                htmlFor={keyId}
                stacked
                hint={
                  keysError ? (
                    <span className={workflow.error} role="alert">
                      {keysError}
                    </span>
                  ) : shown && !options.length ? (
                    ssh ? (
                      <T>No SSH public keys found in ssh-agent or ~/.ssh.</T>
                    ) : (
                      <T>No OpenPGP signing keys found.</T>
                    )
                  ) : outsideAgent && enabled ? (
                    <T>ssh-agent doesn't hold this key. If it has a passphrase, add it with ssh-add first.</T>
                  ) : undefined
                }
              >
                <Select
                  id={keyId}
                  className={styles.signingPicker}
                  value={key}
                  placeholder={shown ? "Select a signing key" : "Loading…"}
                  options={options}
                  disabled={!enabled || saving || !options.length}
                  onChange={setKey}
                  searchable
                />
              </Row>
              {ssh && (
                <div className={styles.signingHint}>
                  <T>
                    To show SSH-signed commits as verified in the log, list the key in the file that
                    gpg.ssh.allowedSignersFile names.
                  </T>
                </div>
              )}
              {dirty && (
                <div className={styles.signingHint}>
                  <T>Changes are saved to this repository's Git config.</T>
                </div>
              )}
            </>
          ) : (
            <span className={styles.signingHint}>{tx`This repository uses ${initial.format} signing.`}</span>
          )
        ) : !error ? (
          <span role="status">
            <T>Loading…</T>
          </span>
        ) : null}
        {error && (
          <div className={workflow.error} role="alert">
            {error}
          </div>
        )}
      </FormGroup>
    </Dialog>
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
