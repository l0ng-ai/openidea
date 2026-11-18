import { afterEach, expect, it } from "vitest";
import { createRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { GroupImperativeHandle } from "react-resizable-panels";
import { SplitGroup, SplitHandle, SplitPanel } from "./Splitter";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

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

it("resets the two adjacent panels to 50/50 on double-click and persists the reset", () => {
  localStorage.setItem("split.even", JSON.stringify({ left: 30, right: 70 }));
  render(
    <SplitGroup orientation="horizontal" storageKey="split.even" groupRef={ref}>
      <SplitPanel id="left" minSize="10%" maxSize="90%" />
      <SplitHandle aria-label="Resize panes" />
      <SplitPanel id="right" minSize="10%" maxSize="90%" />
    </SplitGroup>,
  );
  expect(ref.current!.getLayout()).toEqual({ left: 30, right: 70 });

  fireEvent.doubleClick(screen.getByRole("separator", { name: "Resize panes" }));
  expect(ref.current!.getLayout()).toEqual({ left: 50, right: 50 });
  expect(JSON.parse(localStorage.getItem("split.even")!)).toEqual({ left: 50, right: 50 });
});

it("equalizes only the two panels beside a double-clicked handle in a three-panel split", () => {
  localStorage.setItem("split.three", JSON.stringify({ a: 20, b: 60, c: 20 }));
  render(
    <SplitGroup orientation="horizontal" storageKey="split.three" groupRef={ref}>
      <SplitPanel id="a" />
      <SplitHandle aria-label="First handle" />
      <SplitPanel id="b" />
      <SplitHandle aria-label="Second handle" />
      <SplitPanel id="c" />
    </SplitGroup>,
  );
  fireEvent.doubleClick(screen.getByRole("separator", { name: "First handle" }));
  expect(ref.current!.getLayout()).toEqual({ a: 40, b: 40, c: 20 });
});
