import { describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

vi.mock(import("@/platform/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  commands: { fsReadText: (path: string) => path } as never,
  call: (async () => "/**\n * Uses foo()\n */\n  const x = foo();\n") as never,
}));
vi.mock(import("@/editor/api"), async (importOriginal) => ({ ...(await importOriginal()), editorsFor: () => [] }));

const { UsagePreview } = await import("./UsagesView");

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
