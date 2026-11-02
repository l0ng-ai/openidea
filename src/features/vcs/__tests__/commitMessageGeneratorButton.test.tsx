import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import type { PluginInfo } from "@/bindings";
import { usePlugins } from "@/features/plugins/store";

const generate = vi.fn();
vi.mock("../commitMessageGeneratorRuntime", () => ({
  generateCommitMessage: (...args: unknown[]) => generate(...args),
}));
import { CommitMessageGeneratorButton } from "../CommitMessageGeneratorButton";

function provider(id: string, status: PluginInfo["status"] = "active"): PluginInfo {
  return {
    id,
    name: id,
    version: "1.0.0",
    description: "",
    authors: [],
    homepage: null,
    changeNotes: null,
    source: "installed",
    path: "/tmp/plugin",
    enabled: true,
    status,
    error: null,
    hasCode: true,
    permissions: ["ai-completions"] as unknown as PluginInfo["permissions"],
    commands: [],
    languages: [],
    themes: [],
  };
}
afterEach(() => {
  cleanup();
  generate.mockReset();
  usePlugins.setState({ plugins: [] });
});

describe("commit message generator button", () => {
  it("hides itself when no active generator is installed", () => {
    usePlugins.setState({ plugins: [provider("inactive", "disabled")] });
    render(<CommitMessageGeneratorButton included={1} />);
    expect(screen.queryByRole("button", { name: /generate commit message/i })).toBeNull();
  });
  it("starts the active provider and prevents duplicate requests", async () => {
    let finish!: () => void;
    generate.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    usePlugins.setState({ plugins: [provider("pushkin")] });
    render(<CommitMessageGeneratorButton included={1} />);
    const button = screen.getByRole("button", { name: /generate commit message/i });
    fireEvent.click(button);
    expect(generate).toHaveBeenCalledWith("pushkin");
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleName(/generating commit message/i);
    finish();
    await waitFor(() => expect(button).not.toBeDisabled());
  });
  it("does not allow generation without included changes", () => {
    usePlugins.setState({ plugins: [provider("pushkin")] });
    render(<CommitMessageGeneratorButton included={0} />);
    expect(screen.getByRole("button", { name: /generate commit message/i })).toBeDisabled();
  });
  it("lets the user choose when several providers are installed", async () => {
    generate.mockResolvedValue(undefined);
    usePlugins.setState({ plugins: [provider("alpha"), provider("beta")] });
    render(<CommitMessageGeneratorButton included={1} />);
    fireEvent.click(screen.getByRole("button", { name: /generate commit message/i }));
    fireEvent.click(await screen.findByText("beta"));
    await waitFor(() => expect(generate).toHaveBeenCalledWith("beta"));
  });
});
