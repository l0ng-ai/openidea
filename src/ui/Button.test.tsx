import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { registerAction } from "@/platform/actions";
import { IconButton } from "./Button";

afterEach(cleanup);

describe("IconButton bound to an action that indicates running", () => {
  const setup = () => {
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const dispose = registerAction({ id: "test.generate", title: "Generate", indicatesRunning: true, run });
    return { run, finish: () => finish(), dispose };
  };

  it("shows a spinner and ignores clicks until the run settles, then goes back to its icon", async () => {
    const { run, finish, dispose } = setup();
    render(<IconButton icon="plugin" action="test.generate" />);
    const button = screen.getByRole("button", { name: "Generate" });
    expect(button).not.toHaveAttribute("aria-busy");
    expect(button.querySelector('[role="status"]')).toBeNull();

    fireEvent.click(button);
    expect(await screen.findByRole("status")).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();

    fireEvent.click(button);
    fireEvent.click(button);
    expect(run).toHaveBeenCalledTimes(1);

    await act(async () => finish());
    expect(button).not.toHaveAttribute("aria-busy");
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(button);
    expect(run).toHaveBeenCalledTimes(2);
    await act(async () => finish());
    dispose();
  });

  it("also shows the run started from elsewhere, such as a shortcut", async () => {
    const { finish, dispose } = setup();
    render(<IconButton icon="plugin" action="test.generate" />);
    const { executeAction } = await import("@/platform/actions");
    void executeAction("test.generate");
    expect(await screen.findByRole("status")).toBeInTheDocument();
    await act(async () => finish());
    expect(screen.queryByRole("status")).toBeNull();
    dispose();
  });

  it("leaves other buttons alone", () => {
    const dispose = registerAction({ id: "test.plainAction", title: "Plain", run: () => {} });
    render(<IconButton icon="plugin" action="test.plainAction" />);
    fireEvent.click(screen.getByRole("button", { name: "Plain" }));
    expect(screen.queryByRole("status")).toBeNull();
    dispose();
  });
});
