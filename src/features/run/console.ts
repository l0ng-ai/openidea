/**
 * Console line model for run output: splits streamed chunks into lines,
 * parses ANSI SGR colours (`ui/ansi`, one stateful parser per stream),
 * handles `\r` overwrites (progress bars) and caps the buffer.
 */
import type { OutputChunk } from "@/platform/ipc";
import { AnsiStream, sameStyle, type Span } from "@/ui/ansi";

export { paletteColor, type Span, type SpanStyle } from "@/ui/ansi";

export type ChunkKind = OutputChunk["kind"];

export interface ConsoleLine {
  /** Monotonic id (stable across trimming). */
  id: number;
  kind: ChunkKind;
  spans: Span[];
  /** Plain text without escape sequences. */
  text: string;
}

export const MAX_LINES = 50_000;
/** Very long lines are broken up so a single minified blob can't stall rendering. */
export const MAX_LINE_LENGTH = 8_000;

export interface ConsoleModelOptions {
  maxLines?: number;
  /** Cycle buffer: total characters kept (Settings › Console); unlimited when absent. */
  maxChars?: number | null;
  /** Called for every completed line (plain text), e.g. to feed the test parser. */
  onLine?: (text: string, kind: ChunkKind) => void;
}

export class ConsoleModel {
  lines: ConsoleLine[] = [];
  /** Total lines ever dropped from the front. */
  dropped = 0;
  private nextId = 1;
  private open: ConsoleLine | null = null;
  private pendingCR = false;
  private readonly parsers = { stdout: new AnsiStream(), stderr: new AnsiStream(), system: new AnsiStream() };
  private readonly maxLines: number;
  private maxChars: number | null;
  /** Characters currently buffered (line text + one per line break). */
  private chars = 0;
  private readonly onLine?: (text: string, kind: ChunkKind) => void;

  constructor(options: ConsoleModelOptions = {}) {
    this.maxLines = options.maxLines ?? MAX_LINES;
    this.maxChars = options.maxChars ?? null;
    this.onLine = options.onLine;
  }

  /** Changes the cycle buffer size (applies on the next append). */
  setMaxChars(maxChars: number | null) {
    this.maxChars = maxChars;
    this.trim();
  }

  append(chunk: OutputChunk) {
    const { kind } = chunk;
    // Streams don't share a line; system messages always start on a fresh one.
    if (this.open && (this.open.kind !== kind || kind === "system")) {
      if (this.open.text.length > 0) this.closeLine();
      else this.open.kind = kind;
    }
    const text = this.parsers[kind].clean(chunk.text);
    const segments = text.split("\n");
    segments.forEach((segment, i) => {
      const last = i === segments.length - 1;
      this.appendSegment(kind, last ? segment : segment.replace(/\r$/, ""));
      if (!last) this.closeLine(kind);
    });
    if (kind === "system" && this.open?.text) this.closeLine();
    this.trim();
  }

  private appendSegment(kind: ChunkKind, segment: string) {
    if (!segment) return;
    const pieces = segment.split("\r");
    pieces.forEach((piece, i) => {
      if (i > 0) this.pendingCR = true;
      if (!piece) return;
      const line = this.ensureOpen(kind);
      if (this.pendingCR) {
        this.chars -= line.text.length;
        line.spans = [];
        line.text = "";
        this.pendingCR = false;
      }
      for (const span of this.parsers[kind].spans(piece)) this.pushSpan(kind, span);
    });
  }

  private pushSpan(kind: ChunkKind, span: Span) {
    let rest = span.text;
    while (rest) {
      const line = this.ensureOpen(kind);
      const room = MAX_LINE_LENGTH - line.text.length;
      const text = rest.slice(0, room);
      rest = rest.slice(text.length);
      const prev = line.spans[line.spans.length - 1];
      if (prev && sameStyle(prev, span)) prev.text += text;
      else line.spans.push({ ...span, text });
      line.text += text;
      this.chars += text.length;
      if (rest) this.closeLine(kind);
    }
  }

  private ensureOpen(kind: ChunkKind): ConsoleLine {
    if (!this.open) {
      this.open = { id: this.nextId++, kind, spans: [], text: "" };
      this.lines.push(this.open);
      this.chars += 1;
    }
    return this.open;
  }

  /** Ends the current line (creating an empty one for a bare newline). */
  private closeLine(kind?: ChunkKind) {
    const line = this.open ?? (kind ? this.ensureOpen(kind) : null);
    this.open = null;
    this.pendingCR = false;
    if (line) this.onLine?.(line.text, line.kind);
  }

  /** Completes a trailing partial line (at process exit). */
  flush() {
    if (this.open) this.closeLine();
  }

  private trim() {
    let drop = 0;
    if (this.lines.length > this.maxLines) {
      // Drop in batches so trimming is amortised.
      drop = this.lines.length - this.maxLines + Math.ceil(this.maxLines / 10);
    }
    if (this.maxChars !== null && this.chars > this.maxChars) {
      // Down to 90% of the buffer, never the line still being written.
      let excess = this.chars - Math.floor(this.maxChars * 0.9);
      let n = 0;
      for (const line of this.lines) {
        if (excess <= 0 || line === this.open) break;
        excess -= line.text.length + 1;
        n++;
      }
      drop = Math.max(drop, n);
    }
    if (drop <= 0) return;
    const removed = this.lines.splice(0, drop);
    for (const l of removed) this.chars -= l.text.length + 1;
    this.dropped += drop;
  }

  clear() {
    this.lines = [];
    this.chars = 0;
    this.dropped = 0;
    this.open = null;
    this.pendingCR = false;
  }

  /** The last line while it is still being written (no newline yet), e.g. a prompt. */
  get openLine(): ConsoleLine | null {
    return this.open;
  }

  get size() {
    return this.lines.length;
  }

  /** Whole buffer as plain text (copy / export). */
  text(): string {
    return this.lines.map((l) => l.text).join("\n");
  }
}
