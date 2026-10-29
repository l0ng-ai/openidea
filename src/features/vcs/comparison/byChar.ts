/**
 * Character-level comparison of punctuation (IntelliJ's ByCharRt
 * .comparePunctuation, ported; Apache-2.0, Copyright JetBrains s.r.o. and
 * contributors): only punctuation is matched, everything else stays changed.
 */
import { ChangeBuilder, type DiffIterable, unchanged, diffSequences } from "./iterables";
import { isPunctuation } from "./text";

export function comparePunctuation(text1: string, text2: string): DiffIterable {
  const chars = (text: string) => {
    const codes: number[] = [];
    const offsets: number[] = [];
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (isPunctuation(c)) {
        codes.push(c);
        offsets.push(i);
      }
    }
    return { codes, offsets };
  };
  const chars1 = chars(text1);
  const chars2 = chars(text2);
  const changes = diffSequences(chars1.codes, chars2.codes);
  const builder = new ChangeBuilder(text1.length, text2.length);
  for (const r of unchanged(changes))
    for (let i = 0; i < r.end1 - r.start1; i++)
      builder.markEqual(chars1.offsets[r.start1 + i]!, chars2.offsets[r.start2 + i]!);
  return builder.finish();
}
