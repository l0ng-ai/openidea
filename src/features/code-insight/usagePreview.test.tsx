import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock(import("@/platform/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  commands: { fsReadText: (path: string) => path } as never,
  call: (async () => "/**\n * Uses foo()\n */\n  const x = foo();\n") as never,
}));
vi.mock(import("@/editor/api"), async (importOriginal) => ({ ...(await importOriginal()), editorsFor: () => [] }));

const { UsagePreview, UsagesView } = await import("./UsagesView");

describe("UsagePreview", () => {
  it("colours the usage line with its file as context", async () => {
    const { container } = render(
      <UsagePreview usage={{ path: "/p/a.ts", line: 3, col: 12, endCol: 15, text: "  const x = foo();" }} />,
    );
    await waitFor(() => expect(container.querySelector(".tok-keyword")?.textContent).toBe("const"));
    expect(container.querySelector("mark")?.textContent).toBe("foo");
    expect(container.textContent).toBe("const x = foo();");
  });

  it("colours a usage inside a doc comment as a comment", async () => {
    const { container } = render(
      <UsagePreview usage={{ path: "/p/a.ts", line: 1, col: 8, endCol: 11, text: " * Uses foo()" }} />,
    );
    await waitFor(() => expect(container.querySelector("mark .tok-comment")?.textContent).toBe("foo"));
  });
});

it("shows a plain count for unclassified searches after a Java access mode was selected", async () => {
  const { useUsages } = await import("./usages");
  const { useUsageAccessOptions } = await import("./UsageAccessFilter");
  const rows = [0, 1].map((line) => ({ path: "/p/a.ts", line, col: 0, endCol: 3, text: "foo()" }));
  useUsageAccessOptions.setState({ read: true, write: false });
  useUsages.setState({
    tabs: [
      {
        id: 123,
        symbol: "foo",
        groups: [{ path: "/p/a.ts", usages: rows }],
        loading: false,
        error: null,
        rerun: null,
        note: null,
        pinned: false,
      },
    ],
    active: 123,
  });
  const view = render(<UsagesView />);
  expect(screen.getByText("2 results")).toBeInTheDocument();
  expect(screen.queryByRole("toolbar", { name: "Usage access filters" })).toBeNull();
  view.unmount();
  useUsageAccessOptions.setState({ read: true, write: true });
  useUsages.setState({ tabs: [], active: null });
});
