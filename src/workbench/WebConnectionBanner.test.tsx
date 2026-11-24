import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as webBridge from "@/platform/webBridge";
import { useWebConnection } from "@/platform/webBridge";
import { WebConnectionBanner } from "./WebConnectionBanner";

describe("WebConnectionBanner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useWebConnection.setState({
      active: false,
      status: "idle",
      windowLabel: "main",
      serverHome: "",
      serverOs: "linux",
    });
  });

  it("renders nothing outside web mode or while connected", () => {
    const { container } = render(<WebConnectionBanner />);
    expect(container.firstChild).toBeNull();

    act(() => useWebConnection.setState({ active: true, status: "connected" }));
    expect(container.firstChild).toBeNull();
  });

  it("shows a reconnecting status banner while the web socket is reconnecting", () => {
    act(() => useWebConnection.setState({ active: true, status: "reconnecting" }));
    render(<WebConnectionBanner />);
    const banner = screen.getByRole("status");
    expect(banner.hasAttribute("data-web-reconnecting")).toBe(true);
    expect(banner.textContent).toContain("Reconnecting");
  });

  it("shows a superseded status banner with a Take Over button", () => {
    const takeOverSpy = vi.spyOn(webBridge, "takeOverWebSession").mockImplementation(() => {});
    act(() => useWebConnection.setState({ active: true, status: "superseded" }));
    render(<WebConnectionBanner />);

    const banner = screen.getByRole("status");
    expect(banner.hasAttribute("data-web-superseded")).toBe(true);
    expect(banner.textContent).toContain("This OpenIDEA session is open in another browser tab.");

    fireEvent.click(screen.getByRole("button", { name: "Take Over" }));
    expect(takeOverSpy).toHaveBeenCalledTimes(1);
  });
});
