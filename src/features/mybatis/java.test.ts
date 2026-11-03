import { describe, expect, it } from "vitest";
import { parseJavaMapper } from "./java";

/** Method names of a mapper, in declaration order. */
const names = (text: string) => parseJavaMapper(text)?.methods.map((m) => m.name) ?? [];
const first = (text: string) => parseJavaMapper(text)?.methods[0];

const MAPPER = `package com.example.mapper;

import java.util.List;

public interface UserMapper {
  User findById(Long id);
  List<User> selectAll();
}`;

describe("parseJavaMapper", () => {
  it("reads the package and the qualified interface name", () => {
    const mapper = parseJavaMapper(MAPPER);
    expect(mapper?.qualifiedName).toBe("com.example.mapper.UserMapper");
    expect(mapper?.name).toBe("UserMapper");
    expect(mapper?.isInterface).toBe(true);
  });

  it("lists the declared methods in order", () => {
    expect(names(MAPPER)).toEqual(["findById", "selectAll"]);
  });

  it("treats a class as a mapper too", () => {
    expect(parseJavaMapper("package p; abstract class BaseMapper { int count(); }")?.isInterface).toBe(false);
  });

  it("returns nothing for a file without a type", () => {
    expect(parseJavaMapper("package p;")).toBeNull();
  });

  it("does not mistake an @interface annotation declaration for a type", () => {
    expect(parseJavaMapper("package p; public @interface Table { String value(); }")).toBeNull();
  });

  it("strips modifiers from the return type", () => {
    expect(first(MAPPER)?.returnType).toBe("User");
    expect(parseJavaMapper("interface I { public abstract List<User> all(); }")?.methods[0]?.returnType).toBe(
      "List<User>",
    );
  });

  it("keeps overloads as separate methods", () => {
    expect(names("interface I { User find(Long id); User find(Long id, String name); }")).toEqual(["find", "find"]);
  });

  it("ignores declarations inside comments", () => {
    expect(names("interface I { /* User ghost(); */\n // Other fake(); \n User real(); }")).toEqual(["real"]);
  });

  it("ignores a method-shaped text inside a string or text block", () => {
    expect(names('interface I { String Q = "Ghost ghost();"; User real(); }')).toEqual(["real"]);
    expect(names('interface I { String B = """\n  Ghost ghost();\n  """;\n User real(); }')).toEqual(["real"]);
  });

  it("skips constants and nested types", () => {
    expect(names("interface I { int LIMIT = 10; User real(); }")).toEqual(["real"]);
  });

  it("parses a default method with a body", () => {
    const method = first("interface I { default User byId(Long id) { return findById(id); } }");
    expect(method?.name).toBe("byId");
    expect(method?.returnType).toBe("User");
    expect(method?.parameters.map((p) => p.name)).toEqual(["id"]);
  });

  it("accepts a throws clause", () => {
    expect(names("interface I { int insert(User u) throws SQLException; }")).toEqual(["insert"]);
  });

  it("reads parameter names through generics and varargs", () => {
    const method = first("interface I { long count(Map<String, Object> params, String... like); }");
    expect(method?.parameters.map((p) => p.name)).toEqual(["params", "like"]);
  });

  it("reads @Param values from the original text", () => {
    const method = first('interface I { User find(@Param("id") Long id, @Param("name") String name); }');
    expect(method?.parameters.map((p) => p.paramAnnotation)).toEqual(["id", "name"]);
    expect(method?.fullyAnnotated).toBe(true);
  });

  it("reports parameters that MyBatis cannot bind by name", () => {
    const method = first("interface I { User find(Long id, String name); }");
    expect(method?.fullyAnnotated).toBe(false);
    expect(first("interface I { User find(Long id); }")?.fullyAnnotated).toBe(true);
  });

  it("does not mistake an annotation's own arguments for the parameter list", () => {
    const method = first("interface I { @Options(timeout = 5, fetchSize = 20) List<User> scan(String filter); }");
    expect(method?.name).toBe("scan");
    expect(method?.parameters.map((p) => p.name)).toEqual(["filter"]);
  });

  it("detects the SQL annotations", () => {
    expect(first('interface I { @Select("SELECT 1") int ping(); }')?.sqlAnnotation).toBe("Select");
    expect(first('interface I { @SelectProvider(type = P.class, method = "m") int ping(); }')?.sqlAnnotation).toBe(
      "SelectProvider",
    );
    expect(first('interface I { @Param("x") int ping(int x);')?.sqlAnnotation).toBeNull();
  });

  it("parses members while the body is still unterminated", () => {
    // The normal state while typing: no closing brace yet, so the last `;` is
    // also the last character of the file.
    expect(names("interface I { User one(); List<User> two();")).toEqual(["one", "two"]);
    expect(first('interface I { @Param("x") int ping(int x);')?.sqlAnnotation).toBeNull();
  });

  it("reads a method annotated with escaped quotes", () => {
    const method = first('interface I { @Select("SELECT 1 WHERE a = \\"x\\"") int ping(); }');
    expect(method?.name).toBe("ping");
    expect(method?.sqlAnnotation).toBe("Select");
  });

  it("anchors each parameter on the start of its declaration", () => {
    const text = "interface I { User find(Long id, @NotNull String name); }";
    const [id, name] = parseJavaMapper(text)!.methods[0]!.parameters;
    expect(text.slice(id!.at, text.indexOf(",", id!.at))).toBe("Long id");
    expect(text.slice(name!.at, text.indexOf(")", name!.at))).toBe("@NotNull String name");
  });

  it("anchors each method on its own line", () => {
    const methods = parseJavaMapper(MAPPER)!.methods;
    expect(methods.map((m) => m.line)).toEqual([5, 6]);
    expect(MAPPER.split("\n")[methods[1]!.line]).toContain("selectAll");
  });
});
