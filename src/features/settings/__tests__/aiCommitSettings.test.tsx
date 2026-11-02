import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiCommitSettings } from "../pages/aiCommitSettings";
import chinese from "@/platform/locales/text/zh.json";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const saved = {
  baseUrl: "https://api.example.test",
  model: "example-model",
  temperature: 0.2,
  systemPrompt: "Write a commit message",
  hasApiKey: true,
};

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) =>
    command.startsWith("plugin_ai_project_prompt_") ? { available: true, prompt: "Project prompt" } : saved,
  );
});
afterEach(cleanup);

describe("AI commit settings", () => {
  it("provides Chinese translations for the new commit configuration and permission", () => {
    const catalog = chinese as Record<string, string>;
    for (const text of [
      "AI Commit Messages",
      "Generate Commit Message",
      "Project prompt",
      "Send selected changes to the configured AI provider to generate a commit message",
    ]) {
      expect(catalog[text]).toBeTruthy();
    }
  });
  it("loads settings without exposing a stored API key and preserves it when unchanged", async () => {
    render(<AiCommitSettings />);
    await screen.findByDisplayValue("example-model");
    expect(screen.getByLabelText("API key")).toHaveValue("");
    expect(screen.getByText("A key is saved. Leave blank to keep it.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "new-model" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("plugin_ai_settings_set", {
        settings: { baseUrl: saved.baseUrl, model: "new-model", temperature: 0.2, systemPrompt: saved.systemPrompt },
        apiKey: null,
      }),
    );
  });

  it("replaces or explicitly removes the saved key", async () => {
    render(<AiCommitSettings />);
    await screen.findByDisplayValue("example-model");
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "new-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("plugin_ai_settings_set", expect.objectContaining({ apiKey: "new-secret" })),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove saved key" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("plugin_ai_settings_set", expect.objectContaining({ apiKey: "" })),
    );
  });

  it("rejects an invalid temperature before sending it to the backend", async () => {
    render(<AiCommitSettings />);
    await screen.findByDisplayValue("example-model");
    fireEvent.change(screen.getByLabelText("Temperature"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Temperature must be between 0 and 2.");
    expect(invoke).not.toHaveBeenCalledWith("plugin_ai_settings_set", expect.anything());
  });

  it("does not save unrelated unsaved form edits when removing the saved key", async () => {
    render(<AiCommitSettings />);
    await screen.findByDisplayValue("example-model");
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "unsaved-model" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove saved key" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("plugin_ai_settings_set", {
        settings: {
          baseUrl: saved.baseUrl,
          model: saved.model,
          temperature: saved.temperature,
          systemPrompt: saved.systemPrompt,
        },
        apiKey: "",
      }),
    );
    expect(screen.getByLabelText("Model")).toHaveValue("unsaved-model");
  });

  it("shows an error if settings cannot be loaded", async () => {
    invoke.mockRejectedValueOnce({ message: "Unable to load settings" });
    render(<AiCommitSettings />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load settings");
  });

  it("saves the current project's prompt independently of global settings and the API key", async () => {
    render(<AiCommitSettings />);
    await screen.findByDisplayValue("Project prompt");
    fireEvent.change(screen.getByLabelText("Project prompt"), { target: { value: "Use project conventions" } });
    fireEvent.click(screen.getByRole("button", { name: "Save project prompt" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("plugin_ai_project_prompt_set", { prompt: "Use project conventions" }),
    );
    expect(invoke).not.toHaveBeenCalledWith("plugin_ai_settings_set", expect.anything());
  });

  it("does not offer project settings when no project is open", async () => {
    invoke.mockImplementation(async (command: string) =>
      command === "plugin_ai_project_prompt_get" ? { available: false, prompt: "" } : saved,
    );
    render(<AiCommitSettings />);
    await screen.findByDisplayValue("example-model");
    expect(screen.queryByLabelText("Project prompt")).not.toBeInTheDocument();
  });
});
