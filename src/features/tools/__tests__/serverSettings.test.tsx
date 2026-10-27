import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useProject } from "@/platform/project";
import { provideNotificationService } from "@/workbench/contributions";
import { MemoryToolsBackend, sampleTools, setToolsBackend } from "../backend";
import { LanguageServersPage } from "../LanguageServersPage";
import { useTools } from "../store";
import { formatArgs, parseArgs, parseEnv, parseJsonObject, parseList } from "../serverConfig";

describe("server settings text fields", () => {
  it("splits arguments like a shell and formats them back", () => {
    expect(parseArgs(`--stdio  --log "a b" 'c"d' e\\ f`)).toEqual(["--stdio", "--log", "a b", 'c"d', "e f"]);
    expect(parseArgs("   ")).toBeNull();
    expect(parseArgs('""')).toEqual([""]);
    expect(() => parseArgs('"open')).toThrow(/Unclosed/);
    const args = ["--x", "a b", 'q"t', ""];
    expect(parseArgs(formatArgs(args))).toEqual(args);
  });

  it("parses environment lines", () => {
    expect(parseEnv("# comment\nA=1\n\nB_2 = x=y\n")).toEqual({ A: "1", B_2: " x=y" });
    expect(parseEnv("")).toBeNull();
    expect(() => parseEnv("A=1\nnope")).toThrow("Line 2: expected NAME=value");
  });

  it("accepts JSON objects without nulls", () => {
    expect(parseJsonObject('{ "a": { "b": [1] } }')).toEqual({ a: { b: [1] } });
    expect(parseJsonObject(" ")).toBeNull();
    expect(() => parseJsonObject("[1]")).toThrow("Expected a JSON object");
    expect(() => parseJsonObject('{ "a": { "b": null } }')).toThrow("at a.b");
    expect(() => parseJsonObject("{")).toThrow();
  });

  it("splits lists", () => {
    expect(parseList("python, typescript  python")).toEqual(["python", "typescript"]);
    expect(parseList(",")).toBeNull();
  });
});

describe("Language Servers page settings", () => {
  let backend: MemoryToolsBackend;
  const listItem = (name: string) =>
    screen.getByRole("list", { name: /language servers/i }).querySelector<HTMLElement>(`[data-tool="${name}"]`)!;
  const settingsOf = (name: string) => screen.getByRole("region", { name: `${name} settings` });

  beforeEach(() => {
    provideNotificationService({ notify: () => {} });
    backend = new MemoryToolsBackend(sampleTools(), 1);
    setToolsBackend(backend);
    useTools.setState({ tools: [], loaded: false, loading: false, error: null, jobs: {}, logs: {} });
    useProject.setState({ project: null, settings: null });
  });

  afterEach(() => setToolsBackend(null));

  it("saves arguments, options and the on/off switch per field", async () => {
    const user = userEvent.setup();
    render(<LanguageServersPage />);
    await screen.findByLabelText("rust-analyzer details");
    await user.click(listItem("rust-analyzer"));
    const section = await waitFor(() => settingsOf("rust-analyzer"));
    // Without a project only the global layer can be edited.
    expect(within(section).getByRole("radio", { name: "This project" })).toBeDisabled();

    await user.type(within(section).getByLabelText("Arguments"), '--log "a b"{Enter}');
    await waitFor(() => expect(backend.layers.global["rust-analyzer"]?.args).toEqual(["--log", "a b"]));

    const init = within(section).getByLabelText("Initialization options");
    await user.click(init);
    await user.paste('{ "check": null }');
    await user.tab();
    expect(await within(section).findByRole("alert")).toHaveTextContent("null is not supported");
    expect(backend.layers.global["rust-analyzer"]?.initializationOptions).toBeUndefined();
    await user.clear(init);
    await user.paste('{ "check": { "command": "clippy" } }');
    await user.tab();
    await waitFor(() =>
      expect(backend.layers.global["rust-analyzer"]?.initializationOptions).toEqual({ check: { command: "clippy" } }),
    );

    await user.click(within(section).getByRole("switch", { name: "Use rust-analyzer" }));
    await waitFor(() => expect(backend.layers.global["rust-analyzer"]?.enabled).toBe(false));
    expect(listItem("rust-analyzer")).toHaveTextContent("Off");

    await user.click(within(section).getByRole("button", { name: "Reset to defaults" }));
    await waitFor(() => expect(backend.layers.global["rust-analyzer"]).toBeUndefined());
    expect(listItem("rust-analyzer")).not.toHaveTextContent("Off");
  });

  it("adds a server of one's own and removes it", async () => {
    const user = userEvent.setup();
    render(<LanguageServersPage />);
    await screen.findByText("gopls");
    await user.click(screen.getByRole("button", { name: "Add Language Server…" }));
    const form = screen.getByRole("form", { name: "Add language server" });
    await user.type(within(form).getByLabelText("Name"), "ruff");
    await user.type(within(form).getByLabelText("Command"), "ruff");
    await user.type(within(form).getByLabelText("Arguments"), "server");
    await user.type(within(form).getByLabelText("Languages"), "pythn");
    await user.click(within(form).getByRole("button", { name: "Add" }));
    expect(within(form).getByRole("alert")).toHaveTextContent("Unknown language: pythn");

    await user.clear(within(form).getByLabelText("Languages"));
    await user.type(within(form).getByLabelText("Languages"), "python");
    await user.click(within(form).getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(backend.layers.global["ruff"]).toEqual({ command: "ruff", languages: ["python"], args: ["server"] }),
    );
    expect(await screen.findByLabelText("ruff details")).toBeInTheDocument();
    expect(listItem("ruff")).toHaveAttribute("aria-current", "true");
    expect(within(settingsOf("ruff")).getByLabelText("Command")).toHaveValue("ruff");

    await user.click(within(settingsOf("ruff")).getByRole("button", { name: "Remove server" }));
    await waitFor(() => expect(backend.layers.global["ruff"]).toBeUndefined());
    await waitFor(() => expect(screen.queryByText("ruff")).not.toBeInTheDocument());
  });
});
