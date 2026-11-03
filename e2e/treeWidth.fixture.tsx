import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Tree } from "../src/ui/Tree";

interface Node {
  key: string;
  label: string;
  children?: Node[];
}
const longLabel = `z_${"long_file_name_".repeat(16)}.ts`;
const initial: Node[] = [
  { key: "src", label: "src", children: [{ key: "child", label: "child.ts" }] },
  ...Array.from({ length: 160 }, (_, i) => ({ key: `file-${i}`, label: `file_${i}.ts` })),
  { key: "wide", label: longLabel },
];
const shorten = (nodes: Node[]): Node[] =>
  nodes.map((node) => ({
    ...node,
    label: node.key === "wide" ? "short.ts" : node.label,
    children: node.children ? shorten(node.children) : undefined,
  }));
const getKey = (node: Node) => node.key;
const getLabel = (node: Node) => node.label;
const getChildren = (node: Node) => node.children;
const isExpandable = (node: Node) => !!node.children;

function Fixture() {
  const [roots, setRoots] = useState(initial);
  const [width, setWidth] = useState(240);
  const [font, setFont] = useState(14);
  const [indent, setIndent] = useState(16);
  const [hidden, setHidden] = useState(false);
  const [horizontal, setHorizontal] = useState(true);
  return (
    <>
      <style>{`* { box-sizing: border-box; } body { font-family: monospace; } button { margin: 4px; }`}</style>
      <button onClick={() => setRoots((nodes) => nodes.filter((node) => node.key !== "wide"))}>Delete widest</button>
      <button onClick={() => setRoots(shorten)}>Shorten same key</button>
      <button onClick={() => setRoots((nodes) => [{ key: "folder", label: "folder", children: nodes }])}>
        Nest rows
      </button>
      <button onClick={() => setWidth((value) => (value === 240 ? 2400 : 240))}>Resize panel</button>
      <button onClick={() => setFont((value) => (value === 14 ? 20 : 14))}>Change font</button>
      <button onClick={() => setIndent((value) => (value === 16 ? 40 : 16))}>Change indent</button>
      <button onClick={() => setHorizontal((value) => !value)}>Toggle horizontal</button>
      <button onClick={() => setHidden((value) => !value)}>Toggle visibility</button>
      <div hidden={hidden} style={{ width, height: 300, fontSize: font }}>
        <Tree
          aria-label="Width fixture"
          roots={roots}
          getKey={getKey}
          getLabel={getLabel}
          getChildren={getChildren}
          isExpandable={isExpandable}
          defaultExpanded={["folder"]}
          horizontalScroll={horizontal}
          indent={indent}
          speedSearchMode="filter"
        />
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
