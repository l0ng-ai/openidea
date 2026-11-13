import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { RemoteSession } from "@/bindings";
import { useRemote } from "@/platform/remote";
import { MessagesHost } from "@/workbench/messages";
import { handleRuntimeEvent } from "./runtimeUi";

const URL_FROM_SERVER = "https://example.com/login?state=abc&redirect=https%3A%2F%2Fexample.org%2Fcallback";
const remote: RemoteSession = {
  target: { kind: "ssh", config: "box" },
  root: "/srv/app",
  host: "box",
  os: "linux",
  commands: [],
};

describe("links and clipboard writes from a remote plugin", () => {
  let open: ReturnType<typeof vi.spyOn>;
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    open = vi.spyOn(window, "open").mockImplementation(() => null);
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    useRemote.setState({ session: remote });
    render(<MessagesHost />);
  });

  afterEach(() => {
    open.mockRestore();
    useRemote.setState({ session: null });
  });

  it("opens a link only after the user confirms its full address", async () => {
    act(() => void handleRuntimeEvent({ type: "openUrl", pluginId: "p", url: URL_FROM_SERVER }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(URL_FROM_SERVER);
    expect(open).not.toHaveBeenCalled();
    await act(async () => void fireEvent.click(within(dialog).getByRole("button", { name: "Open" })));
    expect(open).toHaveBeenCalledWith(URL_FROM_SERVER, "_blank", "noopener");
  });

  it("opens nothing when the user cancels", async () => {
    act(() => void handleRuntimeEvent({ type: "openUrl", pluginId: "p", url: URL_FROM_SERVER }));
    const dialog = await screen.findByRole("dialog");
    await act(async () => void fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" })));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it("does not ask about addresses it would never open", async () => {
    act(() => void handleRuntimeEvent({ type: "openUrl", pluginId: "p", url: "file:///etc/passwd" }));
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it("copies only after the user confirms the text", async () => {
    act(() => void handleRuntimeEvent({ type: "copyToClipboard", pluginId: "p", text: "token-123" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("token-123");
    expect(writeText).not.toHaveBeenCalled();
    await act(async () => void fireEvent.click(within(dialog).getByRole("button", { name: "Copy" })));
    expect(writeText).toHaveBeenCalledWith("token-123");
  });

  it("copies nothing when the user cancels", async () => {
    act(() => void handleRuntimeEvent({ type: "copyToClipboard", pluginId: "p", text: "token-123" }));
    const dialog = await screen.findByRole("dialog");
    await act(async () => void fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" })));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("previews long text shortened, and copies all of it", async () => {
    const text = `${"a".repeat(2000)}TAIL`;
    act(() => void handleRuntimeEvent({ type: "copyToClipboard", pluginId: "p", text }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).not.toHaveTextContent("TAIL");
    expect(dialog).toHaveTextContent(/2,?004 characters in total/);
    await act(async () => void fireEvent.click(within(dialog).getByRole("button", { name: "Copy" })));
    expect(writeText).toHaveBeenCalledWith(text);
  });

  it("acts at once for plugins running on this machine", () => {
    useRemote.setState({ session: null });
    handleRuntimeEvent({ type: "copyToClipboard", pluginId: "p", text: "local" });
    handleRuntimeEvent({ type: "openUrl", pluginId: "p", url: "https://example.com/" });
    expect(writeText).toHaveBeenCalledWith("local");
    expect(open).toHaveBeenCalledWith("https://example.com/", "_blank", "noopener");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
