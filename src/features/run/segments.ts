/** Splits a console line's styled spans at link and find-match boundaries for rendering. */
import type { Span, SpanStyle } from "./console";
import type { OutputLink } from "./links";

/** A find match on one line, in UTF-16 offsets. */
export interface SegmentMark {
  start: number;
  end: number;
  current?: boolean;
}

export interface Segment {
  text: string;
  style: SpanStyle;
  link?: OutputLink;
  mark?: boolean;
  current?: boolean;
}

export function segmentLine(
  spans: readonly Span[],
  links: readonly OutputLink[],
  marks: readonly SegmentMark[] = [],
): Segment[] {
  const out: Segment[] = [];
  let pos = 0;
  let li = 0;
  let mi = 0;
  for (const span of spans) {
    const { text, ...style } = span;
    let offset = 0;
    while (offset < text.length) {
      const abs = pos + offset;
      while (li < links.length && links[li]!.end <= abs) li++;
      while (mi < marks.length && marks[mi]!.end <= abs) mi++;
      const link = links[li];
      const mark = marks[mi];
      let take = text.length - offset;
      let currentLink: OutputLink | undefined;
      let currentMark: SegmentMark | undefined;
      if (link && link.start <= abs) {
        currentLink = link;
        take = Math.min(take, link.end - abs);
      } else if (link) {
        take = Math.min(take, link.start - abs);
      }
      if (mark && mark.start <= abs) {
        currentMark = mark;
        take = Math.min(take, mark.end - abs);
      } else if (mark) {
        take = Math.min(take, mark.start - abs);
      }
      const piece = text.slice(offset, offset + take);
      const prev = out[out.length - 1];
      const current = !!currentMark?.current;
      if (
        prev &&
        prev.link === currentLink &&
        !!prev.mark === !!currentMark &&
        !!prev.current === current &&
        sameStyle(prev.style, style)
      ) {
        prev.text += piece;
      } else {
        out.push({
          text: piece,
          style,
          link: currentLink,
          ...(currentMark ? { mark: true, current } : {}),
        });
      }
      offset += take;
    }
    pos += text.length;
  }
  return out;
}

function sameStyle(a: SpanStyle, b: SpanStyle) {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    !!a.bold === !!b.bold &&
    !!a.dim === !!b.dim &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.strike === !!b.strike
  );
}
