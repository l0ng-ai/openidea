import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useWebConnection } from "@/platform/webBridge";
import { WebConnectionBanner } from "./WebConnectionBanner";

describe("WebConnectionBanner", () => {
  afterEach(() => {
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
    expect(screen.getByRole("status").textContent).toContain("Reconnecting");
  });
});
