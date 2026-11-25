import type { Chunk } from "@codemirror/merge";
import type { Text } from "@codemirror/state";
import type { StagedText } from "@/bindings";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { diffDocument } from "./diffControls";
import { transferChunk } from "./diffOptions";

export function staleDiff() {
  return new Error(tx("The displayed versions have changed. Refresh the diff and try again."));
}

export function requireDisplayedText(text: string | null, displayed: Text) {
  if (text === null || !diffDocument(text).eq(displayed)) throw staleDiff();
}

/** Apply one displayed change to the index, using the version of that display. */
export async function writeIndexChunk(
  path: string,
  index: StagedText,
  chunk: Chunk,
  from: "a" | "b",
  source: Text,
  ranges?: Parameters<typeof transferChunk>[4],
) {
  const staged = diffDocument(index.text);
  const edit = transferChunk(chunk, from, source, staged, ranges);
  const text = staged.replace(edit.from, edit.to, diffDocument(edit.insert)).toString();
  await call(commands.vcsSaveStagedText(path, index.version, text));
}
