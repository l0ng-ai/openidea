import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { Select, SelectListbox, type SelectOption } from "./Select";
import { useI18n } from "@/platform/i18n";
import { Dialog } from "./Dialog";

const options: SelectOption[] = [
  { value: "9router", label: "9router", section: true },
  { value: "9router/cmc/Beam", label: "Beam", detail: "cmc/Beam · Fast", keywords: "9router" },
  { value: "9router/blocked", label: "Blocked", disabled: true, keywords: "9router" },
  { value: "other", label: "Other", section: true },
  { value: "other/BlueMoon", label: "Blue Moon", keywords: "other" },
  { value: "__section__:real", label: "Plain" },
];
function setup(searchable = true, rows = options) {
  const onChange = vi.fn();
  render(<Select aria-label="Model" options={rows} value={null} searchable={searchable} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  return onChange;
}
const list = () => screen.getByRole("listbox");
const labels = () =>
  within(list())
    .queryAllByRole("option")
    .map((o) => o.textContent);
const query = (value: string) => fireEvent.change(screen.getByRole("textbox"), { target: { value } });
const key = (key: string, target = list()) => fireEvent.keyDown(target, { key });

describe("Select", () => {
  it("focuses the search input when opened", async () => {
    setup();
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveFocus());
  });
  it("never selects sections by click, Enter or type-ahead, and preserves full model values", () => {
    const changed = setup(false);
    fireEvent.click(within(list()).getByText("9router"));
    expect(changed).not.toHaveBeenCalled();
    key("9");
    key("Enter");
    expect(changed).toHaveBeenCalledExactlyOnceWith("9router/cmc/Beam");
  });
  it("does not select a list containing only headings", () => {
    const changed = setup(false, [{ value: "a", label: "A", section: true }]);
    key("a");
    key("Enter");
    expect(changed).not.toHaveBeenCalled();
  });
  it("skips sections and disabled options with arrows, Home and End", () => {
    const changed = setup(false);
    key("ArrowDown");
    expect(within(list()).getByRole("option", { name: "Blue Moon" })).toHaveAttribute("aria-selected", "true");
    key("End");
    key("Home");
    key("ArrowUp");
    key("Enter");
    expect(changed).toHaveBeenCalledExactlyOnceWith("__section__:real");
  });
  it("renders disabled models as options, retains them in search, and rejects selection", () => {
    const changed = setup();
    query("blocked");
    const blocked = within(list()).getByRole("option", { name: "Blocked" });
    expect(within(list()).getByText("9router")).toBeInTheDocument();
    fireEvent.click(blocked);
    key("Enter");
    expect(changed).not.toHaveBeenCalled();
  });
  it("matches provider, model, nested path, description, and multiple case-insensitive tokens", () => {
    setup();
    for (const search of ["9router Beam", "CMC fast", "9ROUTER bm"]) {
      query(search);
      expect(labels()).toEqual(["Beamcmc/Beam · Fast"]);
      expect(within(list()).getByText("9router")).toBeInTheDocument();
      expect(within(list()).queryByText("Other")).not.toBeInTheDocument();
    }
  });
  it("navigates filtered results and lets search input handle spaces and caret movement", () => {
    const changed = setup();
    query("other");
    const input = screen.getByRole("textbox");
    expect(fireEvent.keyDown(input, { key: " " })).toBe(true);
    expect(fireEvent.keyDown(input, { key: "Home" })).toBe(true);
    key("ArrowDown", input);
    key("Enter", input);
    expect(changed).toHaveBeenCalledExactlyOnceWith("other/BlueMoon");
  });
  it("keeps exact substrings alongside fuzzy matches in original order", () => {
    setup(true, [
      { value: "exact", label: "Beam" },
      { value: "fuzzy", label: "Beta amber" },
    ]);
    query("beam");
    expect(labels()).toEqual(["Beam", "Beta amber"]);
  });
  it("keeps non-searchable type-ahead prefix-only and shows every option", () => {
    const changed = setup(false);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    key("b");
    key("m");
    key("Enter");
    expect(changed).toHaveBeenCalledExactlyOnceWith("other/BlueMoon");
  });
  it("does not confuse a heading value with a real option value", () => {
    const changed = setup(false, [
      { value: "a", label: "Provider", section: true },
      { value: "a", label: "Real" },
    ]);
    key("Enter");
    expect(changed).toHaveBeenCalledExactlyOnceWith("a");
  });
});

describe("Select preview lifecycle", () => {
  const rows = [
    { value: "a", label: "A" },
    { value: "b", label: "B" },
  ];

  it("restores using the newly selected value when closing", () => {
    const preview = vi.fn();
    function Picker() {
      const [value, setValue] = useState("a");
      return (
        <Select
          aria-label="Theme"
          value={value}
          options={rows}
          onChange={setValue}
          onPreview={(next) => preview(next, value)}
        />
      );
    }
    render(<Picker />);
    fireEvent.click(screen.getByRole("button", { name: "Theme" }));
    expect(preview).toHaveBeenLastCalledWith("a", "a");
    key("ArrowDown");
    expect(preview).toHaveBeenLastCalledWith("b", "a");
    key("Enter");
    expect(preview).toHaveBeenLastCalledWith(null, "b");
  });

  it("keeps the initial preview active under Strict Mode and clears it on unmount", () => {
    const preview = vi.fn();
    const { unmount } = render(
      <StrictMode>
        <SelectListbox value="b" options={rows} onChoose={vi.fn()} onPreview={preview} />
      </StrictMode>,
    );
    expect(preview).toHaveBeenLastCalledWith("b");
    unmount();
    expect(preview).toHaveBeenLastCalledWith(null);
  });

  it("closes only the list on Escape inside a dialog and restores trigger focus", () => {
    const close = vi.fn();
    render(
      <Dialog open title="Settings" onClose={close}>
        <Select aria-label="Theme" value="b" options={rows} onChange={vi.fn()} />
      </Dialog>,
    );
    const trigger = screen.getByRole("button", { name: "Theme" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(within(list()).getByRole("option", { name: "B" })).toHaveAttribute("aria-selected", "true");
    key("Escape");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(close).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
  });
});

it("preserves user values when their labels match translated UI text", () => {
  const previous = useI18n.getState().texts;
  useI18n.setState({ texts: { Cancel: "取消" } });
  try {
    const changed = setup(false, [{ value: "Cancel", label: "Cancel", verbatim: true }]);
    expect(within(list()).getByRole("option", { name: "Cancel" })).toBeInTheDocument();
    key("c");
    key("Enter");
    expect(changed).toHaveBeenCalledWith("Cancel");
  } finally {
    useI18n.setState({ texts: previous });
  }
});
