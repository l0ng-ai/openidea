import type { Lexer, Marked, MarkedExtension, Token, Tokens } from "marked";

interface Footnote extends Tokens.Generic {
  number: number;
  references: number;
  tokens: Token[];
}

interface Reference extends Tokens.Generic {
  note: Footnote;
  number: number;
}

const DEFINITION = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*(.*)(?:\n|$)/;
const CONTINUATION = /^(?:[ \t]*\n)*(?: {4}|\t)(.*)(?:\n|$)/;
const REFERENCE = /^\[\^([^\]\s]+)\]/;

export function footnoteExtension(anchorPrefix: string): MarkedExtension {
  const documents = new WeakMap<Lexer, { notes: Map<string, Footnote>; count: number }>();
  const noteId = (note: Footnote) => `${anchorPrefix}footnote:${note.number}`;
  const refId = (note: Footnote, index: number) => `${noteId(note)}:${index}`;
  return {
    extensions: [
      {
        name: "footnoteDefinition",
        level: "block",
        start(src) {
          return /^ {0,3}\[\^[^\]\s]+\]:/m.exec(src)?.index;
        },
        tokenizer(src): Footnote | Tokens.Space | undefined {
          const first = DEFINITION.exec(src);
          if (!first) return;
          let end = first[0].length;
          let text = first[2]! + "\n";
          for (let next = CONTINUATION.exec(src.slice(end)); next; next = CONTINUATION.exec(src.slice(end))) {
            end += next[0].length;
            text += next[0].replace(/^(?<blank>(?:[ \t]*\n)*)(?: {4}|\t)/, "$<blank>");
          }
          const raw = src.slice(0, end);
          let doc = documents.get(this.lexer);
          if (!doc) {
            doc = { notes: new Map(), count: 0 };
            documents.set(this.lexer, doc);
          }
          const label = first[1]!.toLowerCase();
          if (doc.notes.has(label)) return { type: "space", raw };
          const note: Footnote = {
            type: "footnoteDefinition",
            raw,
            number: 0,
            references: 0,
            tokens: this.lexer.blockTokens(text),
          };
          doc.notes.set(label, note);
          return note;
        },
        renderer() {
          return "";
        },
      },
      {
        name: "footnoteSection",
        renderer(token) {
          const notes = token.notes as Footnote[];
          const items = notes.map((note) => {
            const links = Array.from(
              { length: note.references },
              (_, i) => `<a href="#${refId(note, i + 1)}" role="doc-backlink">↩${i ? `<sup>${i + 1}</sup>` : ""}</a>`,
            ).join(" ");
            const content = this.parser.parse(note.tokens).trimEnd();
            const withBacklinks = content.endsWith("</p>")
              ? content.replace(/<\/p>$/, ` ${links}</p>`)
              : `${content}<div>${links}</div>`;
            return `<aside id="${noteId(note)}" role="doc-footnote"><sup>${note.number}</sup><div>${withBacklinks}</div></aside>\n`;
          });
          return `<section role="doc-endnotes"><hr>${items.join("")}</section>\n`;
        },
      },
      {
        name: "footnoteReference",
        level: "inline",
        start(src) {
          return /\[\^[^\]\s]+\]/.exec(src)?.index;
        },
        tokenizer(src): Reference | undefined {
          const match = REFERENCE.exec(src);
          const doc = documents.get(this.lexer);
          if (!match || !doc || this.lexer.state.inLink) return;
          const note = doc.notes.get(match[1]!.toLowerCase());
          if (!note) return;
          if (!note.number) note.number = ++doc.count;
          return { type: "footnoteReference", raw: match[0], note, number: ++note.references };
        },
        renderer(token) {
          const { note, number } = token as Reference;
          return `<sup><a id="${refId(note, number)}" href="#${noteId(note)}" role="doc-noteref">[${note.number}]</a></sup>`;
        },
      },
    ],
  };
}

export function renderFootnotes(marked: Marked, tokens: Token[]): string {
  const notes: Footnote[] = [];
  marked.walkTokens(tokens, (token) => {
    if (token.type !== "footnoteDefinition") return;
    const note = token as Footnote;
    if (note.number) notes.push(note);
  });
  if (!notes.length) return "";
  notes.sort((a, b) => a.number - b.number);
  return marked.parser([{ type: "footnoteSection", raw: "", notes }]);
}
