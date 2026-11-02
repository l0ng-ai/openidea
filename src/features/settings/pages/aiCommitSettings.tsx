import { invoke } from "@tauri-apps/api/core";
import { useEffect, useId, useState } from "react";
import { Button, Input, T } from "@/ui";
import { Row } from "../components/Form";
import type { PageSpec } from "./spec";
import { TOOLS_GROUP } from "./tools";
import styles from "./AiCommitSettings.module.css";

/** Non-secret connection settings returned by the backend. */
interface AiCommitSettingsValue {
  baseUrl: string;
  model: string;
  temperature: number;
  systemPrompt: string;
  hasApiKey: boolean;
}

interface ProjectPrompt {
  available: boolean;
  prompt: string;
}

/** Convert a Tauri error into a message without exposing request contents. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return "Unable to update settings.";
}

/** Configure the endpoint used for plugin-generated commit messages. Secrets are never read back. */
export function AiCommitSettings() {
  const [saved, setSaved] = useState<AiCommitSettingsValue | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [temperature, setTemperature] = useState("0.2");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [projectPrompt, setProjectPrompt] = useState<ProjectPrompt | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const baseUrlId = useId();
  const modelId = useId();
  const temperatureId = useId();
  const promptId = useId();
  const keyId = useId();
  const projectPromptId = useId();

  useEffect(() => {
    let active = true;
    void invoke<AiCommitSettingsValue>("plugin_ai_settings_get")
      .then((settings) => {
        if (!active) return;
        setSaved(settings);
        setBaseUrl(settings.baseUrl);
        setModel(settings.model);
        setTemperature(String(settings.temperature));
        setSystemPrompt(settings.systemPrompt);
      })
      .catch((reason: unknown) => {
        if (active) setError(errorMessage(reason));
      });
    void invoke<ProjectPrompt>("plugin_ai_project_prompt_get")
      .then((settings) => {
        if (active) setProjectPrompt(settings);
      })
      .catch((reason: unknown) => {
        if (active) setError(errorMessage(reason));
      });
    return () => {
      active = false;
    };
  }, []);

  /** Persist ordinary fields; null preserves the existing key and an empty string deletes it. */
  async function save(removeKey = false) {
    if (!saved || busy) return;
    const numericTemperature = Number(temperature);
    if (
      !removeKey &&
      (!temperature.trim() || !Number.isFinite(numericTemperature) || numericTemperature < 0 || numericTemperature > 2)
    ) {
      setError("Temperature must be between 0 and 2.");
      return;
    }
    if (!removeKey && (!baseUrl.trim() || !model.trim())) {
      setError("Base URL and model are required.");
      return;
    }
    setError("");
    setMessage("");
    setBusy(true);
    try {
      // Removing a key must not silently save unrelated in-progress form edits.
      const settings = removeKey
        ? {
            baseUrl: saved.baseUrl,
            model: saved.model,
            temperature: saved.temperature,
            systemPrompt: saved.systemPrompt,
          }
        : { baseUrl: baseUrl.trim(), model: model.trim(), temperature: numericTemperature, systemPrompt };
      const result = await invoke<AiCommitSettingsValue>("plugin_ai_settings_set", {
        settings,
        apiKey: removeKey ? "" : apiKey || null,
      });
      setSaved(result);
      setApiKey("");
      setMessage(removeKey ? "Saved key removed." : "Settings saved.");
    } catch (reason: unknown) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  /** Project-specific prompt is saved separately; it never contains provider credentials. */
  async function saveProjectPrompt() {
    if (!projectPrompt?.available || busy) return;
    setError("");
    setMessage("");
    setBusy(true);
    try {
      const result = await invoke<ProjectPrompt>("plugin_ai_project_prompt_set", { prompt: projectPrompt.prompt });
      setProjectPrompt(result);
      setMessage("Project prompt saved.");
    } catch (reason: unknown) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <p>
        <T>Configure the OpenAI-compatible service used by commit message plugins.</T>
      </p>
      {error && (
        <p role="alert">
          <T>{error}</T>
        </p>
      )}
      {message && (
        <p role="status">
          <T>{message}</T>
        </p>
      )}
      {saved && (
        <>
          <Row label="Base URL" htmlFor={baseUrlId}>
            <Input id={baseUrlId} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </Row>
          <Row label="Model" htmlFor={modelId}>
            <Input id={modelId} value={model} onChange={(e) => setModel(e.target.value)} />
          </Row>
          <Row label="Temperature" htmlFor={temperatureId}>
            <Input
              id={temperatureId}
              value={temperature}
              inputMode="decimal"
              onChange={(e) => setTemperature(e.target.value)}
            />
          </Row>
          <Row label="System prompt" htmlFor={promptId}>
            <textarea
              id={promptId}
              className={styles.prompt}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
            />
          </Row>
          <Row label="API key" htmlFor={keyId}>
            <Input
              id={keyId}
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </Row>
          {saved.hasApiKey && (
            <p>
              <T>A key is saved. Leave blank to keep it.</T>
            </p>
          )}
          <div className={styles.actions}>
            <Button disabled={busy} onClick={() => void save()}>
              Save
            </Button>
            {saved.hasApiKey && (
              <Button disabled={busy} onClick={() => void save(true)}>
                Remove saved key
              </Button>
            )}
          </div>
          {projectPrompt?.available && (
            <>
              <Row label="Project prompt" htmlFor={projectPromptId}>
                <textarea
                  id={projectPromptId}
                  className={styles.prompt}
                  value={projectPrompt.prompt}
                  onChange={(e) => setProjectPrompt({ ...projectPrompt, prompt: e.target.value })}
                />
              </Row>
              <p>
                <T>Leave the project prompt blank to use the global prompt.</T>
              </p>
              <div className={styles.actions}>
                <Button disabled={busy} onClick={() => void saveProjectPrompt()}>
                  Save project prompt
                </Button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

export const AI_COMMIT_SETTINGS_PAGE: PageSpec = {
  id: "tools.aiCommitMessages",
  title: "AI Commit Messages",
  group: TOOLS_GROUP,
  order: 604,
  keywords: ["commit", "AI", "model", "OpenAI", "API key", "prompt"],
  component: AiCommitSettings,
};
