import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentProvider, AgentTask, ProjectInfo } from "@/bindings";
import { useProject } from "@/platform/project";
import { HomeEditor } from "./HomeEditor";
import { SessionEditor } from "./SessionEditor";
import { emptyDraft, type ComposerDraft } from "./composerModel";
import { setCaret, textOf, typeIn } from "./composerTesting";
import { HOME_KEY, SESSION_KIND, sessionKey } from "./model";
import {
  HOME,
  composerDraft,
  connect,
  disconnect,
  sendMessage,
  startTask,
  updateComposer,
  updateDraft,
  useAgents,
} from "./store";

const backend = vi.hoisted(() => ({
  tauri: false,
  create: vi.fn(),
  prompt: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage = () => {};
  },
}));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  isTauri: () => backend.tauri,
  commands: {
    agentCreate: backend.create,
    agentPrompt: backend.prompt,
    agentSubscribe: async () => ({ status: "ok", data: [] }),
    agentProviders: async () => ({ status: "ok", data: [provider] }),
    agentRefreshModels: async (id: string) => ({
      status: "ok",
      data: {
        provider: id,
        config: provider.config,
        thoughtLevels: {},
        refreshing: false,
        refreshedAtMs: Date.now(),
        retryAtMs: null,
        error: null,
      },
    }),
    agentProbe: async () => ({ status: "ok", data: null }),
    agentEntries: async () => ({ status: "ok", data: [] }),
    agentChanges: async () => ({ status: "ok", data: [] }),
    vcsBranchInfo: async () => ({ status: "ok", data: { head: "main" } }),
    vcsBranches: async () => ({ status: "ok", data: [] }),
  },
}));
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  editorService: () => ({ openInput: backend.open, closeInput: backend.close }),
  maybeEditorService: () => ({ activePath: () => null }),
  toolWindowService: () => ({ show: vi.fn() }),
}));

const ok = <T,>(data: T) => ({ status: "ok" as const, data });
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const task = (id: string): AgentTask => ({
  id,
  title: id,
  provider: "codex",
  status: "ready",
  isolation: "local",
  model: null,
  cwd: "/project-a",
  branch: null,
  base: null,
  baseCommit: null,
  error: null,
  createdMs: 0,
  updatedMs: 0,
  config: [],
  commands: [],
  usage: null,
  queue: [],
});
const provider: AgentProvider = {
  id: "codex",
  name: "Codex",
  command: "codex",
  program: "codex",
  args: [],
  defaultProgram: null,
  defaultArgs: [],
  loginHint: null,
  commandOverridden: false,
  commandEditable: true,
  commandReadOnlyReason: null,
  installed: true,
  env: {},
  commands: [],
  source: { kind: "custom" },
  config: [],
  thoughtLevels: {},
};
const file = (name: string) => ({ path: `/project-a/${name}`, rel: name, attached: true });
const image = (name: string) => ({ mimeType: "image/png", data: name, name });
const mixed = (): ComposerDraft => ({
  text: "  submitted prompt  ",
  files: [file("sent.ts")],
  images: [image("sent.png")],
});
const setProject = (root: string) => useProject.setState({ project: { root, trusted: true } as ProjectInfo });

beforeEach(() => {
  disconnect();
  vi.resetAllMocks();
  backend.tauri = false;
  backend.close.mockResolvedValue(false);
  setProject("/project-a");
  useProject.setState({ settings: null });
  useAgents.setState({
    loaded: true,
    tasks: new Map([["A", task("A")]]),
    entries: new Map([["A", []]]),
    providers: [provider],
    draft: { provider: "codex", config: {}, isolation: "local", base: null },
    composers: new Map(),
    sessionLocation: "editor",
    lastComposer: HOME,
    history: [],
    focus: null,
  });
});
afterEach(() => {
  cleanup();
  disconnect();
});

const paths = [
  { name: "queued message", key: "A", send: () => sendMessage("A", false), mock: backend.prompt },
  { name: "send now", key: "A", send: () => sendMessage("A", true), mock: backend.prompt },
  { name: "new task", key: HOME, send: () => startTask(), mock: backend.create },
];

describe.each(paths)("$name acknowledgement", (path) => {
  function begin() {
    const response = deferred();
    path.mock.mockReturnValueOnce(response.promise);
    const pending = path.send();
    return { ...response, pending };
  }
  const success = () => ok(path.key === HOME ? task("created") : null);

  it.each([
    { name: "text", draft: { ...emptyDraft(), text: "hello" } },
    { name: "file only", draft: { ...emptyDraft(), files: [file("sent.ts")] } },
    { name: "image only", draft: { ...emptyDraft(), images: [image("sent.png")] } },
    { name: "text, files and images", draft: mixed() },
  ])("clears unchanged $name after success", async ({ draft }) => {
    updateComposer(path.key, draft);
    const response = begin();
    expect(path.mock).toHaveBeenCalledTimes(1);
    expect(composerDraft(path.key)).toEqual(draft);
    response.resolve(success());
    await response.pending;
    expect(composerDraft(path.key)).toEqual(emptyDraft());
  });

  it.each(["", " \n\t "])("does not send an empty draft (%j)", async (text) => {
    updateComposer(path.key, { text });
    await path.send();
    expect(path.mock).not.toHaveBeenCalled();
    expect(composerDraft(path.key).text).toBe(text);
  });

  it.each([
    { name: "replace text", patch: { text: "next prompt" } },
    { name: "append text", patch: { text: mixed().text + "and another instruction" } },
    { name: "delete text", patch: { text: "" } },
    { name: "whitespace edit", patch: { text: mixed().text + " " } },
    { name: "add file", patch: { files: [...mixed().files, file("next.ts")] } },
    { name: "remove file", patch: { files: [] } },
    { name: "replace file", patch: { files: [file("next.ts")] } },
    { name: "add image", patch: { images: [...mixed().images, image("next.png")] } },
    { name: "remove image", patch: { images: [] } },
    { name: "replace image", patch: { images: [image("next.png")] } },
    {
      name: "replace everything",
      patch: { text: "next prompt", files: [file("next.ts")], images: [image("next.png")] },
    },
  ])("keeps the newer draft after $name", async ({ patch }) => {
    updateComposer(path.key, mixed());
    const response = begin();
    updateComposer(path.key, patch);
    const next = structuredClone(composerDraft(path.key));
    response.resolve(success());
    await response.pending;
    expect(composerDraft(path.key)).toEqual(next);
  });

  it("keeps a new revision even when edits restore the submitted content", async () => {
    const submitted = mixed();
    updateComposer(path.key, submitted);
    const response = begin();
    updateComposer(path.key, { text: "temporary change" });
    updateComposer(path.key, submitted);
    response.resolve(success());
    await response.pending;
    expect(composerDraft(path.key)).toEqual(submitted);
  });

  it.each([false, true])("keeps current content after a command error (edited=%s)", async (edited) => {
    updateComposer(path.key, mixed());
    const response = begin();
    if (edited) updateComposer(path.key, { text: "unsent changes", images: [image("new.png")] });
    const next = structuredClone(composerDraft(path.key));
    const rejected = expect(response.pending).rejects.toThrow("send failed");
    response.resolve({ status: "error", error: { kind: "internal", message: "send failed" } });
    await rejected;
    expect(composerDraft(path.key)).toEqual(next);
  });

  it.each([false, true])("keeps current content after a transport error (edited=%s)", async (edited) => {
    updateComposer(path.key, mixed());
    const response = begin();
    if (edited) updateComposer(path.key, { files: [file("new.ts")] });
    const next = structuredClone(composerDraft(path.key));
    const rejected = expect(response.pending).rejects.toThrow("connection lost");
    response.reject(new Error("connection lost"));
    await rejected;
    expect(composerDraft(path.key)).toEqual(next);
  });

  it("clears only the submitted composer and keeps the last edited destination", async () => {
    updateComposer(path.key, mixed());
    const response = begin();
    updateComposer("B", { text: "another session", files: [file("other.ts")] });
    response.resolve(success());
    await response.pending;
    expect(composerDraft(path.key)).toEqual(emptyDraft());
    expect(composerDraft("B")).toEqual({ text: "another session", files: [file("other.ts")], images: [] });
    expect(useAgents.getState().lastComposer).toBe("B");
  });

  it("still clears when task status, provider or model settings change", async () => {
    updateComposer(path.key, mixed());
    const response = begin();
    updateDraft({ provider: "other", config: { model: "new-model", mode: "plan", effort: "high" } });
    useAgents.setState({
      providers: [],
      tasks: new Map([["A", { ...task("A"), status: "running", model: "new-model" }]]),
    });
    response.resolve(success());
    await response.pending;
    expect(composerDraft(path.key)).toEqual(emptyDraft());
  });

  it.each(["disconnect", "reconnect", "switch project", "switch away and back"])(
    "does not consume a retained draft after %s",
    async (change) => {
      updateComposer(path.key, mixed());
      const response = begin();
      disconnect();
      if (change.startsWith("switch")) setProject("/project-b");
      if (change === "switch away and back") {
        disconnect();
        setProject("/project-a");
      }
      if (change !== "disconnect") {
        backend.tauri = true;
        await connect();
      }
      response.resolve(success());
      await response.pending;
      expect(composerDraft(path.key)).toEqual(mixed());
    },
  );

  it("does not recreate a deleted composer", async () => {
    updateComposer(path.key, mixed());
    const response = begin();
    useAgents.setState({ composers: new Map() });
    response.resolve(success());
    await response.pending;
    expect(useAgents.getState().composers.has(path.key)).toBe(false);
  });

  it("does not consume a retained draft after replacing the connection without disconnecting", async () => {
    updateComposer(path.key, mixed());
    const response = begin();
    backend.tauri = true;
    await connect();
    response.resolve(success());
    await response.pending;
    expect(composerDraft(path.key)).toEqual(mixed());
  });

  it.each(["old first", "new first"])("handles overlapping submissions with %s", async (order) => {
    updateComposer(path.key, { text: "first" });
    const first = begin();
    updateComposer(path.key, { text: "second" });
    const second = begin();
    if (order === "old first") {
      first.resolve(success());
      await first.pending;
      expect(composerDraft(path.key).text).toBe("second");
      second.resolve(success());
      await second.pending;
    } else {
      second.resolve(success());
      await second.pending;
      updateComposer(path.key, { text: "third" });
      first.resolve(success());
      await first.pending;
    }
    expect(composerDraft(path.key).text).toBe(order === "old first" ? "" : "third");
  });

  it("keeps a third draft when both earlier acknowledgements arrive", async () => {
    updateComposer(path.key, { text: "first" });
    const first = begin();
    updateComposer(path.key, { text: "second" });
    const second = begin();
    updateComposer(path.key, { text: "third", images: [image("third.png")] });
    first.resolve(success());
    second.resolve(success());
    await Promise.all([first.pending, second.pending]);
    expect(composerDraft(path.key)).toEqual({ text: "third", files: [], images: [image("third.png")] });
  });

  it("sends the submitted payload and remembers only the submitted Home prompt", async () => {
    updateComposer(path.key, mixed());
    const response = begin();
    const prompt = { text: "submitted prompt", files: [file("sent.ts").path], images: mixed().images };
    if (path.key === HOME) expect(backend.create).toHaveBeenCalledWith(expect.objectContaining({ prompt }));
    else expect(backend.prompt).toHaveBeenCalledWith("A", prompt, path.name === "send now");
    updateComposer(path.key, { text: "not submitted", images: [] });
    response.resolve(success());
    await response.pending;
    expect(useAgents.getState().history).toEqual(path.key === HOME ? ["submitted prompt"] : []);
  });
});

describe("composer UI during submission", () => {
  it("keeps typing and attachments in the session after Send completes", async () => {
    const response = deferred();
    backend.prompt.mockReturnValue(response.promise);
    render(<SessionEditor input={{ kind: SESSION_KIND, key: sessionKey("A"), data: { task: "A" } }} />);
    const box = screen.getByRole("textbox", { name: "Message" });
    typeIn(box, "sent message");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(backend.prompt).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(box).toHaveAttribute("contenteditable", "true");
    typeIn(box, "next unsent message");
    act(() => updateComposer("A", { files: [file("next.ts")], images: [image("next.png")] }));
    await act(async () => response.resolve(ok(null)));
    expect(textOf(box)).toBe("next unsent message");
    expect(composerDraft("A").files).toEqual([file("next.ts")]);
    expect(composerDraft("A").images).toEqual([image("next.png")]);
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  it("clears an unchanged session draft after only moving the caret", async () => {
    const response = deferred();
    backend.prompt.mockReturnValue(response.promise);
    render(<SessionEditor input={{ kind: SESSION_KIND, key: sessionKey("A"), data: { task: "A" } }} />);
    const box = screen.getByRole("textbox", { name: "Message" });
    typeIn(box, "sent message");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    setCaret(box, 2);
    await act(async () => response.resolve(ok(null)));
    expect(textOf(box)).toBe("");
  });

  it("keeps the next Home draft when task creation succeeds and opens the created task", async () => {
    const response = deferred();
    backend.create.mockReturnValue(response.promise);
    backend.close.mockResolvedValue(true);
    const home = render(<HomeEditor />);
    const box = screen.getByRole("textbox");
    typeIn(box, "submitted task");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(backend.create).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Starting…" })).toBeDisabled();
    typeIn(box, "next unsent task");
    await act(async () => response.resolve(ok(task("created"))));
    expect(backend.close).toHaveBeenCalledWith(HOME_KEY);
    expect(backend.open).toHaveBeenCalledWith(
      { kind: SESSION_KIND, key: sessionKey("created"), data: { task: "created", title: "created" } },
      { focus: true },
    );
    home.unmount();
    render(<HomeEditor />);
    expect(textOf(screen.getByRole("textbox"))).toBe("next unsent task");
    expect(useAgents.getState().history).toEqual(["submitted task"]);
  });
});
