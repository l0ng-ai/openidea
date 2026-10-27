import { describe, expect, it } from "vitest";
import { PRESETS } from "@/platform/keymap";
import { exOfRhs, IDEA_ACTIONS, parseVimrc, resolveActionId } from "../rc";

const RC = `
" OpenIDEA vimrc
set textwidth=100 nopcre
set ideajoin surround
let mapleader = " "
nnoremap <leader>f :action FindInPath<CR>
nmap <silent> gd <Action>(GotoDeclaration)
map <leader>r <Action>(ReformatCode)
imap jk <Esc>
vnoremap < <gv
noremap H ^
xmap <leader>c <Action>(code.commentLine)
let g:mapleader = ","
nmap <leader>w :w<CR>
source ~/.vimrc
nnoremap
Plug 'tpope/vim-surround'
`;

describe("ideavimrc parsing", () => {
  const { commands, ignored } = parseVimrc(RC);

  it("parses set options, keeping only ones the engine supports", () => {
    expect(commands.filter((c) => c.kind === "set")).toEqual([
      { kind: "set", name: "textwidth", value: "100" },
      { kind: "set", name: "pcre", value: false },
    ]);
    expect(ignored.map((i) => i.reason)).toEqual(
      expect.arrayContaining(["option not supported: ideajoin", "option not supported: surround"]),
    );
  });

  it("parses map variants with modes, noremap and the leader in effect at that line", () => {
    const maps = commands.filter((c) => c.kind !== "set");
    expect(maps).toEqual([
      { kind: "mapEx", mode: "normal", lhs: "<Space>f", ex: "action FindInPath" },
      { kind: "mapEx", mode: "normal", lhs: "gd", ex: "action GotoDeclaration" },
      { kind: "mapEx", mode: undefined, lhs: "<Space>r", ex: "action ReformatCode" },
      { kind: "map", mode: "insert", noremap: false, lhs: "jk", rhs: "<Esc>" },
      { kind: "map", mode: "visual", noremap: true, lhs: "<", rhs: "<gv" },
      { kind: "map", mode: undefined, noremap: true, lhs: "H", rhs: "^" },
      { kind: "mapEx", mode: "visual", lhs: "<Space>c", ex: "action code.commentLine" },
      { kind: "mapEx", mode: "normal", lhs: ",w", ex: "w" },
    ]);
  });

  it("reports everything else as ignored, never executed", () => {
    const reasons = ignored.map((i) => `${i.line}:${i.reason}`);
    expect(reasons).toContain("15:unsupported command: source");
    expect(reasons).toContain("16:mapping needs a left and right side");
    expect(reasons).toContain("17:unsupported command: Plug");
  });

  it("recognises :action and <Action>() right-hand sides", () => {
    expect(exOfRhs("<Action>(GotoDeclaration)")).toBe("action GotoDeclaration");
    expect(exOfRhs(":action ReformatCode<CR>")).toBe("action ReformatCode");
    expect(exOfRhs(":<C-u>action Back<cr>")).toBe("action Back");
    expect(exOfRhs("dd")).toBeNull();
    expect(exOfRhs(":action A<CR>j")).toBeNull();
  });

  it("parses a leader written as \\<Space> and a comma", () => {
    const space = parseVimrc('let mapleader="\\<Space>"\nnmap <Leader>a b');
    expect(space.commands).toEqual([{ kind: "map", mode: "normal", noremap: false, lhs: "<Space>a", rhs: "b" }]);
    const def = parseVimrc("nmap <leader>a b");
    expect(def.commands[0]).toMatchObject({ lhs: "\\a" });
  });
});

describe(":action ids", () => {
  it("maps IdeaVim ids to OpenIDEA ids and passes our own ids through", () => {
    expect(resolveActionId("GotoDeclaration")).toBe("navigate.declaration");
    expect(resolveActionId("ReformatCode")).toBe("code.reformat");
    expect(resolveActionId("FindInPath")).toBe("find.inPath");
    expect(resolveActionId("code.commentLine")).toBe("code.commentLine");
  });

  it("targets actions that exist", () => {
    const known = new Set([
      ...Object.values(PRESETS).flatMap((k) => Object.keys(k)),
      "editor.closeAllTabs",
      "editor.unsplit",
      "editor.splitDown",
      "vcs.update",
    ]);
    const missing = Object.entries(IDEA_ACTIONS).filter(([, id]) => !known.has(id));
    expect(missing).toEqual([]);
  });
});
