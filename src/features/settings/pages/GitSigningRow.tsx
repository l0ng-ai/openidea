import { useEffect, useId, useState } from "react";
import { tx } from "@/platform/i18n";
import {
  call,
  commands,
  isTauri,
  nextRequestId,
  type GitSigningConfig,
  type GpgSigningKey,
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
  const [initial, setInitial] = useState<GitSigningConfig>();
  const [enabled, setEnabled] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const [keys, setKeys] = useState<GpgSigningKey[]>();
  const [keysError, setKeysError] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    let request: ReturnType<typeof nextRequestId> | undefined;
    void call(commands.vcsSigningConfig(repo)).then(
      (config) => {
        if (!live) return;
        setInitial(config);
        setEnabled(config.enabled);
        setKey(config.key);
        if (config.format !== "openpgp") return;
        request = nextRequestId();
        void call(commands.vcsGpgSigningKeys(repo, request))
          .then(
            (keys) => live && setKeys(keys),
            (error: unknown) => live && setKeysError(message(error)),
          )
          .finally(() => {
            request = undefined;
          });
      },
      (error: unknown) => live && setError(message(error)),
    );
    return () => {
      live = false;
      if (request !== undefined) void commands.cancelRequest(request).catch(() => undefined);
    };
  }, [repo]);

  const supported = initial?.format === "openpgp";
  const changedEnabled = initial && enabled !== initial.enabled;
  const changedKey = enabled && key !== initial?.key;
  const dirty = changedEnabled || changedKey;
  const options: SelectOption<string>[] = (keys ?? []).map((key) => ({
    value: key.fingerprint,
    label: key.userId || key.fingerprint,
    verbatim: true,
    detail: key.userId ? key.fingerprint : undefined,
    verbatimDetail: true,
  }));
  if (initial?.key && !options.some((option) => option.value === initial.key)) {
    options.unshift({ value: initial.key, label: initial.key, verbatim: true });
  }

  async function save() {
    if (!supported || !dirty || saving || (enabled && !key)) return;
    setSaving(true);
    setError(undefined);
    try {
      await call(
        commands.vcsEditSigning(repo, { enabled: changedEnabled ? enabled : null, key: changedKey ? key : null }),
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
              <Toggle label="Sign commits with GPG" checked={enabled} onChange={setEnabled} disabled={saving} />
              <Row
                label="Signing key"
                htmlFor={keyId}
                stacked
                hint={
                  keysError ? (
                    <span className={workflow.error} role="alert">
                      {keysError}
                    </span>
                  ) : keys?.length === 0 ? (
                    <T>No OpenPGP signing keys found.</T>
                  ) : undefined
                }
              >
                <Select
                  id={keyId}
                  className={styles.signingPicker}
                  value={key}
                  placeholder={keys || keysError ? "Select a signing key" : "Loading…"}
                  options={options}
                  disabled={!enabled || saving || !options.length}
                  onChange={setKey}
                  searchable
                />
              </Row>
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
