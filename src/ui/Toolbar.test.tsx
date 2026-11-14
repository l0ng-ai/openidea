import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toolbar } from "./Toolbar";

function Bar({ busy = false, extra = false }: { busy?: boolean; extra?: boolean }) {
  return (
    <>
      <button>Before</button>
      <Toolbar aria-label="Actions">
        <button>Run</button>
        <button disabled={busy}>Stop</button>
        {extra && <button>Pin</button>}
        <button tabIndex={-1}>Hidden</button>
        <input aria-label="Filter" />
      </Toolbar>
      <button>After</button>
    </>
  );
}

const tabStops = () => [...document.querySelectorAll('[role="toolbar"] [tabindex="0"]')].map((e) => e.textContent);

describe("Toolbar", () => {
  it("is one Tab stop that remembers the control used last", async () => {
    const user = userEvent.setup();
    render(<Bar />);
    screen.getByRole("button", { name: "Before" }).focus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Run" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("button", { name: "Stop" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "After" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Stop" })).toHaveFocus();
  });

  it("moves with the arrows, Home and End, wrapping, past controls that opt out", async () => {
    const user = userEvent.setup();
    render(<Bar />);
    act(() => screen.getByRole("button", { name: "Run" }).focus());
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("textbox", { name: "Filter" })).toHaveFocus();
    // A text field keeps its caret keys.
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("textbox", { name: "Filter" })).toHaveFocus();
    act(() => screen.getByRole("button", { name: "Stop" }).focus());
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("textbox", { name: "Filter" })).toHaveFocus();
    act(() => screen.getByRole("button", { name: "Stop" }).focus());
    await user.keyboard("{End}");
    expect(screen.getByRole("textbox", { name: "Filter" })).toHaveFocus();
    act(() => screen.getByRole("button", { name: "Stop" }).focus());
    await user.keyboard("{Home}");
    expect(screen.getByRole("button", { name: "Run" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Hidden" })).toHaveAttribute("tabindex", "-1");
  });

  it("keeps one stop when controls are added or the remembered one is disabled", async () => {
    const { rerender } = render(<Bar />);
    act(() => screen.getByRole("button", { name: "Stop" }).focus());
    expect(tabStops()).toEqual(["Stop"]);
    rerender(<Bar extra />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Pin" })).toHaveAttribute("tabindex", "-1"));
    expect(tabStops()).toEqual(["Stop"]);
    rerender(<Bar extra busy />);
    await waitFor(() => expect(tabStops()).toEqual(["Run"]));
    fireEvent.keyDown(screen.getByRole("button", { name: "Run" }), { key: "ArrowRight" });
    expect(screen.getByRole("button", { name: "Pin" })).toHaveFocus();
  });
});
