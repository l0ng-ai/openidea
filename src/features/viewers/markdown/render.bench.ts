// pnpm vitest bench --run --reporter=verbose src/features/viewers/markdown/render.bench.ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "vitest";
import { createMarkdownRenderer, renderMarkdown } from "./render";

// A large real document: plugins/README.md twice, about 6,200 lines. As written, a bare
// `<title>` in one of its tables swallows everything after it (an unclosed tag the preview keeps
// as the whole-document pass reads it); in backticks the whole document is shown.
const readme = readFileSync(resolve(import.meta.dirname, "../../../../plugins/README.md"), "utf8");
const asWritten = `${readme}\n\n${readme}`;
const doc = asWritten.replaceAll('"<title> failed', '"`<title>` failed');

/** `text` after one more keystroke in a paragraph in the middle. */
const typing = (text: string) => {
  const at = text.indexOf("\n\n", text.length >> 1);
  let typed = 0;
  return () => `${text.slice(0, at)} x${typed++ % 1000}${text.slice(at)}`;
};

test("Markdown preview: a keystroke in a 6,200-line document", async ({ bench }) => {
  const edited = typing(doc);
  const render = createMarkdownRenderer();
  render(doc);
  await bench.compare(
    bench("whole document", () => {
      renderMarkdown(edited());
    }),
    bench("changed blocks", () => {
      render(edited());
    }),
  );
});

test("Markdown preview: opening a 6,200-line document", async ({ bench }) => {
  await bench.compare(
    bench("whole document", () => {
      renderMarkdown(doc);
    }),
    bench("changed blocks", () => {
      createMarkdownRenderer()(doc);
    }),
  );
});

test("Markdown preview: a keystroke in a document with an unclosed tag", async ({ bench }) => {
  const edited = typing(asWritten);
  const render = createMarkdownRenderer();
  render(asWritten);
  await bench.compare(
    bench("whole document", () => {
      renderMarkdown(edited());
    }),
    bench("changed blocks", () => {
      render(edited());
    }),
  );
});
