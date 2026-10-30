import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { Select, type SelectOption } from "./Select";

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
