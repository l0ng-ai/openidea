import { StrictMode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";
import { Dialog } from "./Dialog";

const ghosts = () => [...document.body.children].filter((el) => el.getAttribute("aria-hidden") === "true");

function Host({ initial = true }: { initial?: boolean }) {
  const [open, setOpen] = useState(initial);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      {/* Unmounted outright, like most call sites. */}
      {open && (
        <Dialog open onClose={() => setOpen(false)} title="Rename">
          <input id="name" defaultValue="old" />
          <div data-testid="list" style={{ overflow: "auto" }} />
        </Dialog>
      )}
    </>
  );
}

describe("exit ghost", () => {
  beforeEach(() => {
    MotionGlobalConfig.skipAnimations = false;
  });
  afterEach(() => {
    MotionGlobalConfig.skipAnimations = true;
    for (const g of ghosts()) g.remove();
  });

  it("leaves an inert copy that fades out while the dialog itself is gone", async () => {
    render(<Host initial={false} />);
    const opener = screen.getByText("Open");
    opener.focus();
    fireEvent.click(opener);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "typed" } });
    screen.getByTestId("list").scrollTop = 40;

    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    const [ghost] = ghosts();
    expect(ghost).toBeDefined();
    expect((ghost as HTMLElement).inert).toBe(true);
    expect(ghost!.querySelector("[id]")).toBeNull();
    expect(ghost!.querySelector("input")!.value).toBe("typed");
    expect(ghost!.textContent).toContain("Rename");
    await waitFor(() => expect(ghosts()).toHaveLength(0));
  });

  it("leaves no copy behind for StrictMode's effect re-run", async () => {
    await act(async () => {
      render(
        <StrictMode>
          <Host />
        </StrictMode>,
      );
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(ghosts()).toHaveLength(0);
  });

  it("is skipped when animations are off", async () => {
    MotionGlobalConfig.skipAnimations = true;
    render(<Host />);
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    });
    expect(ghosts()).toHaveLength(0);
  });
});
