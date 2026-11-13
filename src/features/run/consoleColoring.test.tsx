import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { useProject } from "@/platform/project";
import { ConsoleModel } from "./console";
import { ConsoleView } from "./ConsoleView";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 20,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 20, key: index })),
    scrollToIndex: () => {},
    measureElement: () => {},
    measure: () => {},
  }),
}));

function setup(
  chunks: { kind: "stdout" | "stderr" | "system"; text: string }[],
  logColors: object = { enabled: true },
) {
  const model = new ConsoleModel();
  for (const c of chunks) model.append(c);
  useProject.setState({ settings: { console: { logColors } } as never });
  render(<ConsoleView model={model} version={1} softWrap={false} follow={false} onFollowChange={() => {}} cwd="/" />);
}

const rowOf = (text: string) =>
  Array.from(screen.getByRole("log").querySelectorAll<HTMLElement>("[data-index]")).find((d) =>
    d.textContent?.includes(text),
  )!;

describe("console log colours", () => {
  it("colours a level line with the level's colour", () => {
    setup([{ kind: "stdout", text: "2026-11-05 10:42:39.123  INFO 4242 --- [nio-8080-exec-1] c.a.S : done\n" }]);
    expect(rowOf("INFO").style.color).toBe("var(--ansi-green)");
  });

  it("keeps ANSI colours printed by the program", () => {
    setup([{ kind: "stdout", text: "[ERROR] \x1b[34mblue part\x1b[0m rest\n" }]);
    const row = rowOf("ERROR");
    expect(row.style.color).toBe("var(--ansi-red)");
    const ansi = Array.from(row.querySelectorAll("span")).find((s) => s.textContent === "blue part")!;
    expect(ansi.style.color).toBe("var(--ansi-blue)");
  });

  it("leaves plain and system lines uncoloured", () => {
    setup([
      { kind: "stdout", text: "plain line\n" },
      { kind: "system", text: "INFO Process finished with exit code 0\n" },
    ]);
    expect(rowOf("plain line").style.color).toBe("");
    expect(rowOf("Process finished").style.color).toBe("");
  });

  it("is off by default", () => {
    setup([{ kind: "stdout", text: "INFO plain\n" }], {});
    expect(rowOf("INFO").style.color).toBe("");
  });

  it("does no colouring when disabled", () => {
    setup([{ kind: "stdout", text: "INFO plain\n" }], { enabled: false });
    expect(rowOf("INFO").style.color).toBe("");
  });
});
