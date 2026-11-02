import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SourceDialog } from "./SourceDialog";

const savePassword = () => screen.getByRole("checkbox", { name: "Save password" }) as HTMLInputElement;

describe("new data source", () => {
  it("does not save the database password unless asked to", () => {
    render(<SourceDialog initial={null} />);
    expect(savePassword().checked).toBe(false);
  });

  it("does not save the SSH tunnel password unless asked to", () => {
    render(<SourceDialog initial={null} />);
    fireEvent.click(screen.getByRole("tab", { name: "SSH/SSL" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Use SSH tunnel" }));
    fireEvent.click(screen.getByRole("button", { name: "SSH authentication type" }));
    fireEvent.click(within(screen.getByRole("listbox")).getByText("Password"));
    expect(savePassword().checked).toBe(false);
  });
});
