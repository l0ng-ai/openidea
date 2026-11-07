import { useEffect, useId, useState } from "react";
import type { CommitAiSettings } from "@/bindings";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { Button, Input, T } from "@/ui";
import { useSettingsForm } from "@/workbench/contributions";
import styles from "./CommitAiSettingsPage.module.css";

type Draft = CommitAiSettings & { apiKey: string | null };

export function CommitAiSettingsPage() {
  const [settings, setSettings] = useState<CommitAiSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void call(commands.vcsCommitAiSettings()).then(
      (value) => {
        if (live) setSettings(value);
      },
      () => {
        if (live) setError(tx("Could not load AI settings"));
      },
    );
    return () => {
      live = false;
    };
  }, []);
  if (error) return <div role="alert">{error}</div>;
  if (!settings)
    return (
      <div role="status">
        <T>Loading…</T>
      </div>
    );
  return <SettingsFields initial={settings} />;
}

function SettingsFields({ initial }: { initial: CommitAiSettings }) {
  const form = useSettingsForm();
  const id = useId();
  const { value, set, saving } = form.useExternal<Draft>("provider", { ...initial, apiKey: null }, async (draft) => {
    const saved = await call(commands.vcsCommitAiSaveSettings(draft.config, draft.apiKey));
    return { ...saved, apiKey: null };
  });
  return (
    <div className={styles.page}>
      <p className={styles.hint}>
        <T>
          Generate Chinese commit messages using an OpenAI-compatible service. Configuration applies to this computer.
        </T>
      </p>
      <label className={styles.field} htmlFor={`${id}-url`}>
        <T>Base URL</T>
        <Input
          id={`${id}-url`}
          value={value.config.baseUrl}
          placeholder="https://api.example.com/v1"
          disabled={saving}
          onChange={(e) => set({ ...value, config: { ...value.config, baseUrl: e.target.value } })}
        />
      </label>
      <p className={styles.hint}>
        <T>Include the API prefix, such as /v1. The app appends /chat/completions.</T>
      </p>
      <label className={styles.field} htmlFor={`${id}-model`}>
        <T>Model</T>
        <Input
          id={`${id}-model`}
          value={value.config.model}
          disabled={saving}
          onChange={(e) => set({ ...value, config: { ...value.config, model: e.target.value } })}
        />
      </label>
      <label className={styles.field} htmlFor={`${id}-key`}>
        <T>API key</T>
        <Input
          id={`${id}-key`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value.apiKey ?? ""}
          disabled={saving}
          placeholder={
            value.hasApiKey && value.apiKey !== ""
              ? tx("Stored securely; leave blank to keep")
              : tx("Optional for local services")
          }
          onChange={(e) => set({ ...value, apiKey: e.target.value || null })}
        />
      </label>
      {value.hasApiKey && value.apiKey !== "" && (
        <Button size="small" disabled={saving} onClick={() => set({ ...value, apiKey: "" })}>
          <T>Remove stored API key</T>
        </Button>
      )}
      {value.apiKey === "" && (
        <p className={styles.hint}>
          <T>The stored API key will be removed on Apply.</T>
        </p>
      )}
      <p className={styles.hint}>
        <T>
          The API key is stored in the system credential store. Only checked changes are sent to this service when you
          click Generate; review them for sensitive information before generating.
        </T>
      </p>
    </div>
  );
}
