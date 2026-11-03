import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useProject } from "@/platform/project";
import { provideNotificationService } from "@/workbench/contributions";
import { MemoryToolsBackend, sampleTools, setToolsBackend } from "../backend";
import { LanguageServersPage } from "../LanguageServersPage";
import { resetLanguageChoices } from "../ServerSettings";
import { useTools } from "../store";
import { formatArgs, nameFromCommand, parseArgs, parseEnv, parseJsonObject, parseList } from "../serverConfig";
import { resetTestForm, stagedFor, TestSettingsForm, useTestForm } from "./settingsForm";

describe("server settings text fields", () => {
  it("splits arguments like a shell and formats them back", () => {
    expect(parseArgs(`--stdio  --log "a b" 'c"d' e\\ f`)).toEqual(["--stdio", "--log", "a b", 'c"d', "e f"]);
    expect(parseArgs("   ")).toBeNull();
    expect(parseArgs('""')).toEqual([""]);
    expect(() => parseArgs('"open')).toThrow(/Unclosed/);
    const args = ["--x", "a b", 'q"t', ""];
    expect(parseArgs(formatArgs(args))).toEqual(args);
  });

  it("parses environment variables separated by semicolons", () => {
    expect(parseEnv("A=1; B_2 = x=y;\n C=")).toEqual({ A: "1", B_2: "x=y", C: "" });
    expect(parseEnv(" ; ")).toBeNull();
    expect(() => parseEnv("A=1; nope")).toThrow("Expected NAME=value: nope");
  });

  it("accepts JSON objects without nulls", () => {
    expect(parseJsonObject('{ "a": { "b": [1] } }')).toEqual({ a: { b: [1] } });
    expect(parseJsonObject(" ")).toBeNull();
    expect(() => parseJsonObject("[1]")).toThrow("Expected a JSON object");
    expect(() => parseJsonObject('{ "a": { "b": null } }')).toThrow("at a.b");
    expect(() => parseJsonObject("{")).toThrow();
  });

  it("splits lists and names servers after their executable", () => {
    expect(parseList("python, typescript  python")).toEqual(["python", "typescript"]);
    expect(parseList(",")).toBeNull();
    expect(nameFromCommand("/opt/bin/ruff")).toBe("ruff");
    expect(nameFromCommand("C:\\tools\\my server.exe")).toBe("my-server");
  });
});

describe("Language Servers page settings", () => {
  let backend: MemoryToolsBackend;
  const listItem = (name: string) =>
    screen.getByRole("list", { name: /language servers/i }).querySelector<HTMLElement>(`[data-tool="${name}"]`);
  const details = (name: string) => screen.getByLabelText(`${name} details`);
  const renderPage = () =>
    render(
      <TestSettingsForm>
        <LanguageServersPage />
      </TestSettingsForm>,
    );

  beforeEach(() => {
    provideNotificationService({ notify: () => {} });
    backend = new MemoryToolsBackend(
      sampleTools().map((t) =>
        t.name === "rust-analyzer"
          ? { ...t, defaultArgs: ["--stdio"], defaultInitializationOptions: '{"checkOnSave":true}' }
          : t,
      ),
      1,
    );
    setToolsBackend(backend);
    resetLanguageChoices();
    resetTestForm();
    useTools.setState({ tools: [], loaded: false, loading: false, error: null, jobs: {}, logs: {} });
    useProject.setState({ project: null, settings: null });
  });

  afterEach(() => setToolsBackend(null));

  const pythonPicker = async (user: ReturnType<typeof userEvent.setup>) => {
    await waitFor(() => expect(listItem("pyright")).not.toBeNull());
    await user.click(listItem("pyright")!);
    // No on/off box: the group's picker replaces it.
    expect(within(details("Pyright")).queryByRole("checkbox", { name: /^Use Pyright/ })).toBeNull();
    return within(details("Pyright")).getByRole("button", { name: "Language server for Python" });
  };

  it("lists one picker per group of interchangeable servers, on each member", async () => {
    const user = userEvent.setup();
    renderPage();
    await pythonPicker(user);
    await user.click(listItem("ty")!);
    const ty = details("ty (Python)");
    expect(within(ty).getByRole("button", { name: "Language server for Python" })).toHaveTextContent("Automatic");
    // The language is in the label already, so names drop a "(Python)" suffix.
    expect(within(ty).getByText(/basedpyright → Pyright → ty\.$/)).toBeInTheDocument();
    await user.click(listItem("gopls")!);
    expect(within(details("gopls")).getByRole("checkbox", { name: /Use gopls/ })).toBeInTheDocument();
    expect(within(details("gopls")).queryByRole("button", { name: /^Language server for/ })).toBeNull();
  });

  it("selects exactly one Python analyzer and restores automatic fallback without writing defaults", async () => {
    const user = userEvent.setup();
    renderPage();
    const picker = await pythonPicker(user);
    expect(picker).toHaveTextContent("Automatic");
    await user.click(picker);
    await user.click(screen.getByRole("option", { name: /^ty/ }));
    expect(stagedFor("languageServers.basedpyright.enabled")).toBe(false);
    expect(stagedFor("languageServers.pyright.enabled")).toBe(false);
    expect(stagedFor("languageServers.ty.enabled")).toBeNull();
    expect(picker).toHaveTextContent("ty");
    await user.click(picker);
    await user.click(screen.getByRole("option", { name: /Automatic/ }));
    for (const name of ["basedpyright", "pyright", "ty"]) {
      expect(stagedFor(`languageServers.${name}.enabled`)).toBeNull();
      expect(useTestForm.getState().values).not.toHaveProperty(`languageServers.${name}.enabled`);
    }
  });

  it("spells out the chosen Python analyzer in project settings", async () => {
    const user = userEvent.setup();
    render(
      <TestSettingsForm scope="project">
        <LanguageServersPage />
      </TestSettingsForm>,
    );
    const picker = await pythonPicker(user);
    await user.click(picker);
    await user.click(screen.getByRole("option", { name: /^Pyright/ }));
    expect(stagedFor("languageServers.basedpyright.enabled")).toBe(false);
    expect(stagedFor("languageServers.pyright.enabled")).toBe(true);
    expect(stagedFor("languageServers.ty.enabled")).toBe(false);
    expect(picker).toHaveTextContent("Pyright");
    await user.click(picker);
    await user.click(screen.getByRole("option", { name: /Automatic/ }));
    for (const name of ["basedpyright", "pyright", "ty"]) {
      expect(stagedFor(`languageServers.${name}.enabled`)).toBe(true);
    }
  });

  it("stages startup options, showing the defaults they replace", async () => {
    const user = userEvent.setup();
    renderPage();
    const pane = await screen.findByLabelText("rust-analyzer details");
    // Folded while nothing is set there.
    expect(within(pane).queryByRole("textbox", { name: "Arguments" })).toBeNull();
    await user.click(within(pane).getByRole("button", { name: "Startup" }));
    const args = within(pane).getByRole("textbox", { name: "Arguments" });
    expect(args).toHaveAttribute("placeholder", "--stdio");
    expect(within(pane).getByRole("textbox", { name: "Initialization options" })).toHaveAttribute(
      "placeholder",
      JSON.stringify({ checkOnSave: true }, null, 2),
    );

    await user.type(args, '--log "a b"');
    expect(stagedFor("languageServers.rust-analyzer.args")).toEqual(["--log", "a b"]);
    await user.type(within(pane).getByRole("textbox", { name: "Environment variables" }), "RA_LOG=info");
    expect(stagedFor("languageServers.rust-analyzer.env")).toEqual({ RA_LOG: "info" });

    // Invalid JSON is marked and not staged; valid JSON is.
    const init = within(pane).getByRole("textbox", { name: "Initialization options" });
    await user.click(init);
    await user.paste('{ "check": null }');
    expect(within(pane).getByRole("alert")).toHaveTextContent("null is not supported");
    expect(stagedFor("languageServers.rust-analyzer.initializationOptions")).toBeUndefined();
    await user.clear(init);
    await user.paste('{ "check": { "command": "clippy" } }');
    expect(stagedFor("languageServers.rust-analyzer.initializationOptions")).toEqual({ check: { command: "clippy" } });

    // Turned off: marked in the list.
    await user.click(within(pane).getByRole("checkbox", { name: /Use rust-analyzer for Rust files/ }));
    expect(stagedFor("languageServers.rust-analyzer.enabled")).toBe(false);
    expect(listItem("rust-analyzer")).toHaveTextContent("Disabled");

    await user.click(within(pane).getByRole("button", { name: "Restore Defaults" }));
    expect(stagedFor("languageServers.rust-analyzer")).toBeNull();
    expect(listItem("rust-analyzer")).not.toHaveTextContent("Disabled");
    expect(args).toHaveValue("");
  });

  it("adds a server of one's own from its command line, then removes it", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByLabelText("rust-analyzer details");
    await user.click(screen.getByRole("button", { name: "Add Language Server…" }));
    const dialog = screen.getByRole("dialog", { name: "New Language Server" });
    const ok = within(dialog).getByRole("button", { name: "OK" });
    await user.type(within(dialog).getByRole("textbox", { name: "Command" }), "/opt/bin/ruff server");
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveValue("ruff");
    expect(ok).toBeDisabled();
    expect(dialog).toHaveTextContent("Choose the languages it serves.");

    const picker = within(dialog).getByRole("button", { name: "Languages" });
    expect(picker).toHaveTextContent("Choose languages…");
    await user.click(picker);
    await user.click(await screen.findByRole("checkbox", { name: "Python" }));
    await user.keyboard("{Escape}");
    expect(picker).toHaveTextContent("Python");
    await user.click(ok);

    expect(stagedFor("languageServers.ruff")).toEqual({
      command: "/opt/bin/ruff",
      args: ["server"],
      languages: ["python"],
    });
    // Listed and selected before Apply, as a new server.
    await waitFor(() => expect(listItem("ruff")).toHaveAttribute("aria-current", "true"));
    expect(listItem("ruff")).toHaveTextContent("New");
    const pane = details("ruff");
    expect(within(pane).getByRole("textbox", { name: "Command" })).toHaveValue("/opt/bin/ruff");
    expect(within(pane).getByRole("textbox", { name: "Arguments" })).toHaveValue("server");
    expect(pane).toHaveTextContent("Checked when the settings are applied.");

    // Edits go into the staged entry.
    await user.type(within(pane).getByRole("textbox", { name: "Root markers" }), "pyproject.toml");
    expect(useTestForm.getState().values).toMatchObject({
      languageServers: { ruff: { rootMarkers: ["pyproject.toml"] } },
    });

    await user.click(screen.getByRole("button", { name: "Remove Language Server" }));
    expect(stagedFor("languageServers.ruff")).toBeNull();
    expect(listItem("ruff")).toBeNull();
  });

  it("keeps the remove button for servers of one's own", async () => {
    const user = userEvent.setup();
    resetTestForm({ languageServers: { ruff: { command: "ruff", languages: ["python"] } } });
    renderPage();
    await screen.findByLabelText("rust-analyzer details");
    expect(screen.getByRole("button", { name: "Remove Language Server" })).toBeDisabled();
    await user.click(listItem("ruff")!);
    expect(screen.getByRole("button", { name: "Remove Language Server" })).toBeEnabled();
  });
});
