/**
 * Names in a signature, for languages without their own rule (Go has `go.ts`): the name is
 * looked up in the documented symbol's declaration, in its source, and the language server's
 * definition of it there is the target. A name the source doesn't spell (an inferred type)
 * or one declared by the declaration itself (a parameter, a type parameter, the symbol's own
 * name) leads nowhere; so does a definition the server finds in several places.
 */
import { commands, type Location } from "@/platform/ipc";
import { readFileLines, withDocument } from "../files";
import { lspRequest } from "../lsp";
import { unique, type DocTarget } from "./symbols";

const NAME = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;
/** Lines the declaration may take in its source beyond the signature's own (wrapped parameters, attributes). */
const SLACK = 10;

/** Where `name`, written in the signature (`lines` long) of the symbol declared at `decl`, is declared. */
export async function signatureNameTarget(decl: Location, name: string, lines: number): Promise<DocTarget | null> {
  if (!NAME.test(name)) return null;
  const text = await readFileLines(decl.path).catch(() => null);
  if (!text) return null;
  const first = decl.range.start.line;
  const last = Math.min(text.length, first + lines + SLACK);
  // A preceding non-name character, not a lookbehind: WebKit before 16.4 can't parse one.
  const word = new RegExp(`(^|[^\\p{L}\\p{N}_$])${name.replace(/\$/g, "\\$")}(?![\\p{L}\\p{N}_$])`, "gu");
  const inside = (l: Location) => l.path === decl.path && l.range.start.line >= first && l.range.start.line < last;
  return withDocument(decl.path, async (doc) => {
    for (let line = first; line < last; line++) {
      for (const m of text[line]!.matchAll(word)) {
        const locs = await lspRequest(() =>
          commands.lspGoto(doc, { line, col: m.index + m[1]!.length }, "definition"),
        ).catch(() => []);
        // Nothing here: a comment or a string; the next occurrence may be the name itself.
        if (!locs.length) continue;
        return locs.some(inside) ? null : unique(locs.map((location) => ({ location })));
      }
    }
    return null;
  });
}
