import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { completedSyntaxTree } from "@/test/syntax";
import { findLanguageDescription, loadSupport } from "../../../core/cm/languages";
import { stringConversions } from "./stringFormat";

/** `expr`'s conversions with the caret on its first character, by kind. */
async function convert(expr: string): Promise<Record<string, string>> {
  const support = await loadSupport(findLanguageDescription("Python", "demo.py")!);
  const source = `x = ${expr}\n`;
  const state = EditorState.create({ doc: source, extensions: [support!] });
  const found = stringConversions(completedSyntaxTree(state), state.doc, 4);
  return Object.fromEntries(found.map((c) => [c.kind, c.text]));
}

describe("Python string formatting conversions", () => {
  it("converts %-formatting to an f-string and to str.format()", async () => {
    expect(await convert(`"Hello %s, you are %d" % (name, age)`)).toEqual({
      fString: `f"Hello {name}, you are {age:d}"`,
      format: `"Hello {}, you are {:d}".format(name, age)`,
    });
    expect(await convert(`'%s' % user.name`)).toEqual({ fString: `f'{user.name}'`, format: `'{}'.format(user.name)` });
  });

  it("maps flags, widths, precisions and conversions", async () => {
    expect((await convert(`"%5s|%-5s|%r|%.2f|%05d|%+x|%-8.3e|%%" % (a, b, c, d, e, f, g)`)).fString).toBe(
      `f"{a!s:>5}|{b!s:<5}|{c!r}|{d:.2f}|{e:05d}|{f:+x}|{g:<8.3e}|%"`,
    );
  });

  it("supports a mapping with a dict literal and escapes braces", async () => {
    expect(await convert(`"{%(n)s} %(m)r" % {"n": 1, 'm': x}`)).toEqual({
      fString: `f"{{{1}}} {x!r}"`,
      format: `"{{{n}}} {m!r}".format(n=1, m=x)`,
    });
  });

  it("converts str.format() calls to f-strings", async () => {
    expect((await convert(`"{} in {}".format(count, path)`)).fString).toBe(`f"{count} in {path}"`);
    expect((await convert(`"{1}-{0}-{1}".format(a, b)`)).fString).toBe(`f"{b}-{a}-{b}"`);
    expect((await convert(`"{name!r:>10} {{x}}".format(name=user.name)`)).fString).toBe(`f"{user.name!r:>10} {{x}}"`);
    expect((await convert(`"{0.real} {1[0]}".format(a + b, items)`)).fString).toBe(`f"{(a + b).real} {items[0]}"`);
    expect((await convert(`r'\\d{}'.format(n)`)).fString).toBe(`rf'\\d{n}'`);
    expect((await convert(`u"{}".format({1: 2})`)).fString).toBe(`f"{ {1: 2}}"`);
  });

  it("offers nothing when the result could behave differently or be invalid", async () => {
    for (const expr of [
      `b"%s" % x`,
      `"%s %s" % (a,)`,
      `"%s" % (*a,)`,
      `"%c" % 65`,
      `"%*d" % (3, 4)`,
      `"%(a)s" % mapping`,
      `"{}".format(*args)`,
      `"{}".format(**kw)`,
      `"{}".format(a, b)`,
      `"{0}{0}".format(next(it))`,
      `"{:{w}}".format(a, w=3)`,
      `"{x[key]}".format(x=d)`,
      `"{}".format(d["key"])`,
      `"{}".format("\\n".join(lines))`,
    ])
      expect(await convert(expr), expr).toEqual({});
    expect((await convert(`'{}'.format(d["key"])`)).fString).toBe(`f'{d["key"]}'`);
  });
});
