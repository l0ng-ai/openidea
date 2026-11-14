import { describe, expect, it } from "vitest";
import { PRESETS } from "@/platform/keymap";
import { exOfRhs, parseVimrc, resolveActionId } from "../rc";
import { IDEA_ACTIONS } from "@/platform/ideaActions";
import { readSourcedFiles } from "../rcFile";

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

  it("canonicalises special-key names in mappings, whatever their case", () => {
    const { commands } = parseVimrc("inoremap jk <esc>\nmap <c-c> <C-C>\nimap <CR> <cr>");
    expect(commands).toEqual([
      { kind: "map", mode: "insert", noremap: true, lhs: "jk", rhs: "<Esc>" },
      { kind: "map", mode: undefined, noremap: false, lhs: "<C-c>", rhs: "<C-C>" },
      { kind: "map", mode: "insert", noremap: false, lhs: "<CR>", rhs: "<CR>" },
    ]);
  });

  it.each([
    ["esc", "<Esc>"],
    ["cr", "<CR>"],
    ["enter", "<CR>"],
    ["return", "<CR>"],
    ["tab", "<Tab>"],
    ["bs", "<BS>"],
    ["backspace", "<BS>"],
    ["space", "<Space>"],
    ["del", "<Del>"],
    ["delete", "<Del>"],
    ["up", "<Up>"],
    ["down", "<Down>"],
    ["left", "<Left>"],
    ["right", "<Right>"],
    ["home", "<Home>"],
    ["end", "<End>"],
    ["pageup", "<PageUp>"],
    ["pagedown", "<PageDown>"],
    ["ins", "<Ins>"],
    ["insert", "<Ins>"],
    ["bar", "|"],
    ["bslash", "\\"],
    ...Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `<F${i + 1}>`]),
  ])("normalizes %s on both sides in any case", (name, canonical) => {
    for (const spelling of [name!, name!.toUpperCase(), name![0]!.toUpperCase() + name!.slice(1)]) {
      expect(parseVimrc(`nmap <${spelling}> <${spelling}>`).commands[0]).toMatchObject({
        lhs: canonical,
        rhs: canonical,
      });
    }
  });

  it.each([
    ["<c-f>", "<C-f>"],
    ["<s-tab>", "<S-Tab>"],
    ["<s-cr>", "<S-CR>"],
    ["<a-x>", "<A-x>"],
    ["<m-x>", "<A-x>"],
    ["<d-x>", "<M-x>"],
    ["<s-c-x>", "<C-S-X>"],
    ["<C-S-x>", "<C-S-X>"],
    ["<s-x>", "X"],
    ["<d-a-c-s-x>", "<C-A-M-S-X>"],
    ["<c-C>", "<C-C>"],
    ["<frob>", "<frob>"],
    ["<c-Frob>", "<c-Frob>"],
    ["<z-esc>", "<z-esc>"],
    ["<constructor>", "<constructor>"],
    ["<toString>", "<toString>"],
    ["<", "<"],
    ["<<esc>", "<<Esc>"],
    ["<c->", "<c->"],
  ])("normalizes modifiers and preserves unknown tokens: %s", (keys, canonical) => {
    expect(parseVimrc(`nmap ${keys} ${keys}`).commands[0]).toMatchObject({ lhs: canonical, rhs: canonical });
  });

  it("keeps escaped less-than separate from following key names", () => {
    expect(parseVimrc("nmap <LT> <Lt>Esc>").commands[0]).toMatchObject({ lhs: "<", rhs: "<lt>Esc>" });
    expect(parseVimrc("nmap <c-f> <pageup><lt>x").commands[0]).toMatchObject({
      lhs: "<C-f>",
      rhs: "<PageUp><lt>x",
    });
  });

  it("expands mixed-case leaders on both sides without replacement-string interpolation", () => {
    expect(parseVimrc('let mapleader="$&"\nnmap <LeAdEr>a <LEADER>b').commands[0]).toMatchObject({
      lhs: "$&a",
      rhs: "$&b",
    });
    expect(parseVimrc('let mapleader="\\<tAb>"\nnmap <LEADER>a <leader>b').commands[0]).toMatchObject({
      lhs: "<Tab>a",
      rhs: "<Tab>b",
    });
  });

  it("normalizes Ex mapping lhs while preserving command and action text", () => {
    expect(parseVimrc("nmap <f1> <Action>(GotoDeclaration)\nnmap <s-tab> :echo <cr>").commands).toEqual([
      { kind: "mapEx", mode: "normal", lhs: "<F1>", ex: "action GotoDeclaration" },
      { kind: "mapEx", mode: "normal", lhs: "<S-Tab>", ex: "echo" },
    ]);
  });

  it.each(["cr", "CR", "enter", "ENTER", "return", "RETURN"])("recognizes Ex terminator <%s>", (enter) => {
    expect(parseVimrc(`nmap <f1> :w<${enter}>`).commands[0]).toEqual({
      kind: "mapEx",
      mode: "normal",
      lhs: "<F1>",
      ex: "w",
    });
  });

  it("reports everything else as ignored, never executed", () => {
    const reasons = ignored.map((i) => `${i.line}:${i.reason}`);
    expect(reasons).toContain("15:cannot read file");
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

describe("source", () => {
  it("applies the sourced file in place, sharing the leader", () => {
    const sources = new Map([["~/.vimrc", 'let mapleader = ","\nset textwidth=80\nset number\nnmap <leader>a b']]);
    const { commands, ignored } = parseVimrc("nmap x y\nsource ~/.vimrc\nnmap <leader>c d", sources);
    expect(commands).toEqual([
      { kind: "map", mode: "normal", noremap: false, lhs: "x", rhs: "y" },
      { kind: "set", name: "textwidth", value: "80" },
      { kind: "map", mode: "normal", noremap: false, lhs: ",a", rhs: "b" },
      { kind: "map", mode: "normal", noremap: false, lhs: ",c", rhs: "d" },
    ]);
    expect(ignored).toEqual([
      { file: "~/.vimrc", line: 3, text: "set number", reason: "option not supported: number" },
    ]);
  });

  it("reports unreadable files and files that source themselves", () => {
    const sources = new Map([
      ["a", "source b"],
      ["b", "source a"],
      ["gone", null],
    ]);
    expect(parseVimrc("so gone\nsource a", sources).ignored).toEqual([
      { line: 1, text: "so gone", reason: "cannot read file" },
      { file: "b", line: 1, text: "source a", reason: "file sources itself" },
    ]);
  });

  it("reads nested files once, expanding ~ only at the start", async () => {
    const files: Record<string, string> = { "/home/me/.vimrc": "source /etc/extra\nsource ~/.vimrc", "/etc/extra": "" };
    const read = async (path: string) => {
      const text = files[path];
      if (text === undefined) throw new Error("missing");
      return text;
    };
    const sources = await readSourcedFiles("source ~/.vimrc\nsource ~other/x", read, "/home/me");
    expect([...sources]).toEqual([
      ["~/.vimrc", files["/home/me/.vimrc"]],
      ["~other/x", null],
      ["/etc/extra", ""],
    ]);
  });
});
