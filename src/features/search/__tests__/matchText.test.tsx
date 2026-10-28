import { describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

vi.mock(import("@/platform/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  commands: { fsReadText: (path: string) => path } as never,
  call: (async () => '/*\n * lib\n */\nconst lib = "lib";\n') as never,
}));
vi.mock(import("@/editor/api"), async (importOriginal) => ({ ...(await importOriginal()), editorsFor: () => [] }));

const { MatchText } = await import("../find/parts");

describe("MatchText", () => {
  it("colours the line by its file's tokens under the match highlight", async () => {
    const { container } = render(
      <MatchText text={'const lib = "lib";'} ranges={[[6, 9]]} source={{ path: "/p/a.ts", line: 3, col: 0 }} />,
    );
    await waitFor(() => expect(container.querySelector(".tok-keyword")?.textContent).toBe("const"));
    expect(container.querySelector("mark")?.textContent).toBe("lib");
    expect(container.querySelector(".tok-string")?.textContent).toBe('"lib"');
    expect(container.textContent).toBe('const lib = "lib";');
  });

  it("colours a line inside a block comment as a comment", async () => {
    const { container } = render(
      <MatchText text="* lib" ranges={[[2, 5]]} source={{ path: "/p/a.ts", line: 1, col: 1 }} />,
    );
    await waitFor(() => expect(container.querySelector("mark .tok-comment")?.textContent).toBe("lib"));
  });

  it("stays plain without a source", () => {
    const { container } = render(<MatchText text="const lib" ranges={[[6, 9]]} />);
    expect(container.querySelector("[class^=tok-]")).toBeNull();
    expect(container.querySelector("mark")?.textContent).toBe("lib");
  });
});
