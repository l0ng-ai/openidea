import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const { choose, tauri } = vi.hoisted(() => ({ choose: vi.fn(), tauri: { on: true } }));
vi.mock("@/platform/choosePath", () => ({ choosePath: choose }));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  isTauri: () => tauri.on,
}));
import { GlobListEditor } from "../components/Form";

beforeEach(() => {
  choose.mockReset();
  tauri.on = true;
});

const browse = { directory: true, title: "Choose Include Path" };

it("adds the folder picked in the chooser and leaves the list alone when it is cancelled", async () => {
  const onChange = vi.fn();
  choose.mockResolvedValueOnce("/opt/platform").mockResolvedValueOnce(null);
  render(<GlobListEditor value={["/a"]} onChange={onChange} browse={browse} aria-label="Include paths" />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add" })));
  expect(choose).toHaveBeenCalledWith({ directory: true, title: "Choose Include Path" });
  expect(onChange).toHaveBeenCalledWith(["/a", "/opt/platform"]);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add" })));
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});

it("types the path inline without a chooser", async () => {
  tauri.on = false;
  render(<GlobListEditor value={[]} onChange={vi.fn()} browse={browse} itemLabel="Include path" />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add" })));
  expect(choose).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "Include path" })).toBeInTheDocument();
});
