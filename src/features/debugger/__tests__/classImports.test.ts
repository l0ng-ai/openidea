import { describe, expect, it, vi } from "vitest";
import type { Variable } from "@/platform/ipc";
import {
  AmbiguousClassError,
  declaresInaccessible,
  evaluateWithImports,
  forgetImports,
  importingCompletion,
  qualify,
  qualifyIn,
  rememberImport,
  unresolvedNames,
} from "../classImports";

const UNRESOLVED = "Cannot evaluate because of compilation error(s): JSON cannot be resolved.";
const value = (v: string) => ({ value: v }) as Variable;

describe("unresolvedNames", () => {
  it("takes the types java-debug could not resolve, not variables", () => {
    expect(unresolvedNames(UNRESOLVED)).toEqual(["JSON"]);
    expect(unresolvedNames("List cannot be resolved to a type. Foo cannot be resolved to a variable.")).toEqual([
      "List",
    ]);
    expect(unresolvedNames("x cannot be resolved")).toEqual([]);
  });
});

describe("qualify", () => {
  const names = new Map([["JSON", "com.alibaba.fastjson2.JSON"]]);

  it("qualifies a class name where it stands for the type", () => {
    expect(qualify("JSON.toJSONString(u)", names)).toBe("com.alibaba.fastjson2.JSON.toJSONString(u)");
    expect(qualify("(JSON) o", names)).toBe("(com.alibaba.fastjson2.JSON) o");
    expect(qualify("JSON::toJSONString", names)).toBe("com.alibaba.fastjson2.JSON::toJSONString");
  });

  it("leaves members, methods, strings, chars and comments alone", () => {
    expect(qualify("a.JSON", names)).toBe("a.JSON");
    expect(qualify("JSON (1)", names)).toBe("JSON (1)");
    // A constructor call is a type.
    expect(qualify("new JSON()", names)).toBe("new com.alibaba.fastjson2.JSON()");
    expect(qualify("new JSON ()", names)).toBe("new com.alibaba.fastjson2.JSON ()");
    expect(qualify("renew JSON()", names)).toBe("renew JSON()");
    expect(qualify('"JSON \\" JSON"', names)).toBe('"JSON \\" JSON"');
    expect(qualify("/* JSON */ 1 // JSON", names)).toBe("/* JSON */ 1 // JSON");
    expect(qualify("JSONArray", names)).toBe("JSONArray");
  });
});

describe("declaresInaccessible", () => {
  it("tells a class only its package sees from a public one", () => {
    expect(declaresInaccessible("package org.json;\n\nclass JSON {\n}", "JSON")).toBe(true);
    expect(declaresInaccessible("package org.json;\nfinal class JSON {}", "JSON")).toBe(true);
    expect(declaresInaccessible("package a;\npublic abstract class JSON {}", "JSON")).toBe(false);
    expect(declaresInaccessible("package a;\n@Deprecated public interface JSON {}", "JSON")).toBe(false);
    expect(declaresInaccessible("package a;\npublic class JSONArray {}", "JSON")).toBe(false);
  });

  it("hides a private nested class but not one without modifiers", () => {
    const arrays = "public class Arrays {\n    private static class ArrayList<E> extends AbstractList<E> {}\n}";
    expect(declaresInaccessible(arrays, "ArrayList", true)).toBe(true);
    const map = "public interface Map<K, V> {\n    interface Entry<K, V> {}\n}";
    expect(declaresInaccessible(map, "Entry", true)).toBe(false);
  });
});

describe("importingCompletion", () => {
  const item = (text: string, kind: string | null = "class") => ({
    label: text,
    text,
    kind,
    detail: null,
    sortText: null,
  });

  it("inserts a qualified class by its simple name and imports it", async () => {
    expect(importingCompletion(5, item("com.zhangdagou.fight.ai.chat.support.JSONUtil1")).text).toBe("JSONUtil1");
    const run = vi.fn(async (e: string) => value(e));
    await evaluateWithImports(5, "JSONUtil1.aaa(s)", run, async () => []);
    expect(run).toHaveBeenCalledWith("com.zhangdagou.fight.ai.chat.support.JSONUtil1.aaa(s)");
    forgetImports(5);
  });

  it("a later choice of the same simple name replaces the earlier one", () => {
    importingCompletion(7, item("com.x.debug.controller.JSONUtil1"));
    importingCompletion(7, item("com.x.chat.support.JSONUtil1"));
    expect(qualifyIn(7, "JSONUtil1.")).toBe("com.x.chat.support.JSONUtil1.");
    forgetImports(7);
    expect(qualifyIn(7, "JSONUtil1.")).toBe("JSONUtil1.");
  });

  it("leaves members and simple names as they are", () => {
    expect(importingCompletion(6, item("toString", "method")).text).toBe("toString");
    expect(importingCompletion(6, item("user.name", "field")).text).toBe("user.name");
    expect(importingCompletion(6, item("User")).text).toBe("User");
    forgetImports(6);
  });
});

describe("evaluateWithImports", () => {
  it("imports the only class with the name and evaluates again, and keeps the import", async () => {
    const run = vi.fn(async (e: string) => {
      if (e.startsWith("JSON")) throw new Error(UNRESOLVED);
      return value(e);
    });
    const find = vi.fn(async () => ["com.alibaba.fastjson2.JSON"]);
    await expect(evaluateWithImports(1, "JSON.toJSONString(u)", run, find)).resolves.toEqual(
      value("com.alibaba.fastjson2.JSON.toJSONString(u)"),
    );
    await evaluateWithImports(1, "JSON.toJSONString(v)", run, find);
    expect(find).toHaveBeenCalledTimes(1);
    forgetImports(1);
  });

  it("asks which one when several classes have the name, then uses the chosen one", async () => {
    const run = vi.fn(async (e: string) => {
      if (e.startsWith("JSON")) throw new Error(UNRESOLVED);
      return value(e);
    });
    const find = async () => ["com.alibaba.fastjson.JSON", "com.alibaba.fastjson2.JSON"];
    const error = await evaluateWithImports(2, "JSON.toJSONString(u)", run, find).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AmbiguousClassError);
    expect((error as AmbiguousClassError).candidates).toEqual([
      "com.alibaba.fastjson.JSON",
      "com.alibaba.fastjson2.JSON",
    ]);
    rememberImport(2, "com.alibaba.fastjson2.JSON");
    await expect(evaluateWithImports(2, "JSON.toJSONString(u)", run, find)).resolves.toEqual(
      value("com.alibaba.fastjson2.JSON.toJSONString(u)"),
    );
    forgetImports(2);
  });

  it("reports the original error when no class has the name or it is not about a class", async () => {
    const run = async () => {
      throw new Error(UNRESOLVED);
    };
    await expect(evaluateWithImports(3, "JSON.x", run, async () => [])).rejects.toThrow(UNRESOLVED);
    const other = async () => {
      throw new Error("Cannot evaluate because the thread is resumed");
    };
    const find = vi.fn(async () => ["a.JSON"]);
    await expect(evaluateWithImports(3, "x", other, find)).rejects.toThrow("thread is resumed");
    expect(find).not.toHaveBeenCalled();
  });
});
