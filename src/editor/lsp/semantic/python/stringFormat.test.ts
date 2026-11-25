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
      fString: `f"Hello {name}, you are {int(age)}"`,
      format: `"Hello {}, you are {}".format(name, int(age))`,
    });
    expect(await convert(`'%s' % user.name`)).toEqual({ fString: `f'{user.name}'`, format: `'{}'.format(user.name)` });
  });

  it("maps flags, widths, precisions and conversions", async () => {
    expect((await convert(`"%5s|%-5s|%r|%.2f|%05d|%+x|%-8.3e|%%" % (a, b, c, d, e, f, g)`)).fString).toBe(
      `f"{a!s:>5}|{b!s:<5}|{c!r}|{d:.2f}|{int(e):05d}|{f:+x}|{g:<8.3e}|%"`,
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
    const exprs = [
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
    ];
    const results = await Promise.all(exprs.map(convert));
    for (const [i, expr] of exprs.entries()) expect(results[i], expr).toEqual({});
    expect((await convert(`'{}'.format(d["key"])`)).fString).toBe(`f'{d["key"]}'`);
  });

  it("keeps %d's truncation with int() unless the value is an int already", async () => {
    expect(await convert(`"%d%%" % (ratio * 100)`)).toEqual({
      fString: `f"{int(ratio * 100)}%"`,
      format: `"{}%".format(int(ratio * 100))`,
    });
    expect((await convert(`"%s of %d tasks, %i/%d" % (len(done), len(tasks), 3, int(x))`)).fString).toBe(
      `f"{len(done)} of {len(tasks)} tasks, {3}/{int(x)}"`,
    );
    expect(await convert(`"%(n)d is %(n)s" % {"n": x}`)).toEqual({ fString: `f"{int(x)} is {x}"` });
  });

  it("leaves \\N{...} escapes alone, except in raw strings", async () => {
    expect(await convert(`"\\N{BULLET} %s" % x`)).toEqual({
      fString: `f"\\N{BULLET} {x}"`,
      format: `"\\N{BULLET} {}".format(x)`,
    });
    expect((await convert(`"\\N{BULLET} {}".format(x)`)).fString).toBe(`f"\\N{BULLET} {x}"`);
    expect((await convert(`"\\\\N{x} %s" % y`)).fString).toBe(`f"\\\\N{{x}} {y}"`);
    expect((await convert(`r"\\N{x} %s" % y`)).fString).toBe(`rf"\\N{{x}} {y}"`);
  });

  it("declines integer precisions and keyword names in .format()", async () => {
    expect(await convert(`"%.2d" % h`)).toEqual({});
    expect(await convert(`"%(class)s" % {"class": c}`)).toEqual({ fString: `f"{c}"` });
  });

  it("does not rewrite format expressions with missing or inconsistent field references", async () => {
    const exprs = [
      `"%(name)s" % {"other": value}`,
      `"%(name)s" % {}`,
      `"{}{0}".format(a)`,
      `"{0}{}".format(a, b)`,
      `"{name}".format(name=)`,
    ];
    const results = await Promise.all(exprs.map(convert));
    for (const [i, expr] of exprs.entries()) expect(results[i], expr).toEqual({});
  });

  it("uses valid Python syntax for field accessors", async () => {
    expect(await convert(`"{0[001]}".format(items)`)).toEqual({ fString: `f"{items[1]}"` });
    expect(await convert(`"{0.class}".format(obj)`)).toEqual({});
  });

  it("keeps the order and evaluation count of arguments with side effects", async () => {
    expect(await convert(`"{1}-{0}".format(first(), second())`)).toEqual({});
    expect(await convert(`"{b}-{a}".format(a=first(), b=second())`)).toEqual({});
    expect(await convert(`"%(name)s" % {"name": first(), "name": second()}`)).toEqual({});
    expect(await convert(`"%(b)s-%(a)s" % {"a": first(), "b": second()}`)).toEqual({
      format: `"{b}-{a}".format(a=first(), b=second())`,
    });
  });
});
