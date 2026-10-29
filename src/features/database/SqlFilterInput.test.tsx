import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { SqlFilterInput } from "./SqlFilterInput";

describe("table SQL completion", () => {
  it.each(["where", "order"] as const)("suggests the current table columns in %s", (kind) => {
    function Example() {
      const [value, setValue] = useState("");
      return (
        <SqlFilterInput
          value={value}
          onChange={setValue}
          onKeyDown={vi.fn()}
          kind={kind}
          schema="main"
          table="users"
          columns={[
            { name: "email", type: "text" },
            { name: "id", type: "integer" },
          ]}
          driver="sqlite"
        />
      );
    }
    render(<Example />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "ema", selectionStart: 3 } });
    expect(screen.getByRole("option", { name: /email/i })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /^id /i })).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    expect((input as HTMLInputElement).value).toBe("email");
  });
});

describe("SQL filter typing", () => {
  function Example() {
    const [value, setValue] = useState("");
    return (
      <SqlFilterInput
        value={value}
        onChange={setValue}
        onKeyDown={vi.fn()}
        kind="where"
        schema="main"
        table="users"
        columns={[{ name: "email", type: "text" }]}
        driver="sqlite"
      />
    );
  }
  it.each([
    ["'", "''"],
    ['"', '""'],
    ["(", "()"],
  ])("pairs %s without opening completion", (key, paired) => {
    render(<Example />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.keyDown(input, { key });
    expect(input.value).toBe(paired);
    expect(input.selectionStart).toBe(1);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
  it.each([" ", "'", '"', "("])("does not automatically complete after %s", (character) => {
    render(<Example />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: character, selectionStart: 1 } });
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
