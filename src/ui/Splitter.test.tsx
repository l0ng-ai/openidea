import { afterEach, expect, it } from "vitest";
import { createRef } from "react";
import { render } from "@testing-library/react";
import type { GroupImperativeHandle } from "react-resizable-panels";
import { SplitGroup, SplitHandle, SplitPanel } from "./Splitter";

afterEach(() => localStorage.clear());

function Split({ storageKey, preview }: { storageKey: string; preview: boolean }) {
  return (
    <SplitGroup orientation="horizontal" storageKey={storageKey} groupRef={ref}>
      <SplitPanel id="tree" defaultSize="60%" />
      {preview && (
        <>
          <SplitHandle />
          <SplitPanel id="preview" defaultSize="40%" />
        </>
      )}
    </SplitGroup>
  );
}
const ref = createRef<GroupImperativeHandle>();

it("starts from the sizes saved under its key", () => {
  localStorage.setItem("split.preview", JSON.stringify({ tree: 30, preview: 70 }));
  render(<Split storageKey="split.preview" preview />);
  expect(ref.current!.getLayout()).toEqual({ tree: 30, preview: 70 });
});

it("applies the saved sizes of a panel set that appears later", () => {
  localStorage.setItem("split.preview", JSON.stringify({ tree: 25, preview: 75 }));
  const view = render(<Split storageKey="split.plain" preview={false} />);
  view.rerender(<Split storageKey="split.preview" preview />);
  expect(ref.current!.getLayout()).toEqual({ tree: 25, preview: 75 });
});

it("ignores saved sizes for other panels", () => {
  localStorage.setItem("split.preview", JSON.stringify({ other: 25, preview: 75 }));
  const view = render(<Split storageKey="split.plain" preview={false} />);
  view.rerender(<Split storageKey="split.preview" preview />);
  expect(Object.keys(ref.current!.getLayout()).sort()).toEqual(["preview", "tree"]);
  expect(ref.current!.getLayout().tree).not.toBe(25);
});
