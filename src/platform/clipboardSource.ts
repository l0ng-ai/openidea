/**
 * Where the text last copied in the IDE came from (an editor's lines, a terminal), so a paste
 * of the same text can say so: the agent composer turns it into a reference or a terminal block.
 */
export type CopySource = { kind: "file"; path: string; from: number; to: number } | { kind: "terminal"; title: string };

const normalize = (text: string) => text.replace(/\r\n?/g, "\n").replace(/\s+$/, "");

let last: { text: string; source: CopySource } | null = null;

export function noteCopySource(text: string, source: CopySource) {
  const normalized = normalize(text);
  last = normalized ? { text: normalized, source } : null;
}

/** The source of `text` when it is what was last copied in the IDE. */
export function copySourceOf(text: string): CopySource | null {
  return last && last.text === normalize(text) ? last.source : null;
}
