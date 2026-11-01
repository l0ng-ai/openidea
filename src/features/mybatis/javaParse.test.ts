import { describe, expect, it } from "vitest";
import {
  inferKind,
  methodAt,
  parseMapperInterface,
  resolveType,
  resultElement,
  type MapperInterface,
} from "./javaParse";

const MAPPER = `package com.example.mapper;

import com.example.entity.User;
import java.util.List;
import java.util.Optional;

/**
 * @Mapper in a comment must not count.
 */
@Mapper
public interface UserMapper {

    @Select("SELECT * FROM user WHERE id = #{id}")
    User selectById(@Param("id") Long id);

    List<User> selectByStatus(Integer status, String keyword);

    Optional<User> findByName(String name);

    Map<String, User> allUsers();

    int updateName(@Param("userId") Long userId, String newName);

    long count();

    boolean existsByEmail(String email);

    void deleteById(Long id);

    void insertUser(User user);

    default int version() {
        return 1;
    }

    String[] tags(Long userId);
}
`;

const iface = () => parseMapperInterface(MAPPER)!;

describe("parseMapperInterface", () => {
  it("reads the package, name and fqn", () => {
    expect(iface().pkg).toBe("com.example.mapper");
    expect(iface().name).toBe("UserMapper");
    expect(iface().fqn).toBe("com.example.mapper.UserMapper");
    expect(iface().kind).toBe("interface");
  });

  it("detects @Mapper (not the comment mention)", () => {
    expect(iface().hasMapperAnnotation).toBe(true);
  });

  it("collects exact imports and wildcards", () => {
    const i = parseMapperInterface("import com.a.*;\nimport com.b.User;\ninterface X { void f(); }")!;
    expect(i.imports.wildcards).toEqual(["com.a"]);
    expect(i.imports.exact.get("User")).toBe("com.b.User");
  });

  it("parses all methods with their parameters", () => {
    const names = iface().methods.map((m) => m.name);
    expect(names).toEqual([
      "selectById",
      "selectByStatus",
      "findByName",
      "allUsers",
      "updateName",
      "count",
      "existsByEmail",
      "deleteById",
      "insertUser",
      "version",
      "tags",
    ]);
  });

  it("reads the @Param binding of a parameter", () => {
    const m = iface().methods.find((x) => x.name === "selectById")!;
    expect(m.params).toHaveLength(1);
    expect(m.params[0]!.name).toBe("id");
    expect(m.params[0]!.binding).toBe("id"); // @Param("id") == declared name
    expect(m.params[0]!.hasParam).toBe(true);
  });

  it("uses the @Param value as binding when it differs", () => {
    const m = iface().methods.find((x) => x.name === "updateName")!;
    expect(m.params[0]!.binding).toBe("userId");
    expect(m.params[1]!.name).toBe("newName");
    expect(m.params[1]!.hasParam).toBe(false);
  });

  it("records the SQL annotation and its line", () => {
    const m = iface().methods.find((x) => x.name === "selectById")!;
    expect(m.sqlAnnotation).toBe("Select");
    expect(m.kind).toBeNull();
    expect(MAPPER.split("\n")[m.annotationLine]).toContain("@Select");
  });

  it("marks default methods", () => {
    const m = iface().methods.find((x) => x.name === "version")!;
    expect(m.defaultMethod).toBe(true);
  });

  it("finds the method at an offset and the type span", () => {
    const i = iface();
    const m = methodAt(i, MAPPER.indexOf("selectByStatus"));
    expect(m?.name).toBe("selectByStatus");
    expect(i.span.from).toBe(MAPPER.indexOf("interface UserMapper"));
  });

  it("finds the method by its annotation lines (extent)", () => {
    const i = iface();
    const at = MAPPER.indexOf("@Select");
    expect(methodAt(i, at)?.name).toBe("selectById");
  });

  it("detects a @Param written without a value", () => {
    const src = `interface X {
    void f(@Param() String a, @Param Long b);
}`;
    const m = parseMapperInterface(src)!.methods[0]!;
    expect(m.params[0]!.hasParam).toBe(false);
    expect(m.params[0]!.emptyParamAt).not.toBeNull();
    expect(src.slice(m.params[0]!.emptyParamAt!.from, m.params[0]!.emptyParamAt!.to)).toBe("@Param()");
    expect(m.params[1]!.emptyParamAt).not.toBeNull();
    expect(src.slice(m.params[1]!.emptyParamAt!.from, m.params[1]!.emptyParamAt!.to)).toBe("@Param");
  });

  it("ignores call expressions and statements inside method bodies", () => {
    const src = `interface X {
    default void fill() {
        Map<String, Object> map = new HashMap<>();
        map.put("x", "y(x"); // not a method
        int z = (a) + (b);
    }
    void real(String a);
}`;
    const parsed = parseMapperInterface(src)!;
    expect(parsed.methods.map((m) => m.name)).toEqual(["fill", "real"]);
  });

  it("ignores enum constants with arguments", () => {
    const src = `enum Color { RED(1), BLUE(2) }`;
    const parsed = parseMapperInterface(src)!;
    expect(parsed.methods).toHaveLength(0);
  });

  it("handles multi-line signatures, varargs and generics", () => {
    const src = `interface X {
    <T> T select(
        @Param("key") String key,
        final java.util.List<T> items,
        String... names);
}`;
    const parsed = parseMapperInterface(src)!;
    const m = parsed.methods[0]!;
    expect(m.name).toBe("select");
    expect(m.returnType).toBe("T");
    expect(m.params.map((p) => [p.name, p.type])).toEqual([
      ["key", "String"],
      ["items", "java.util.List<T>"],
      ["names", "String"],
    ]);
  });

  it("tolerates CRLF line endings", () => {
    const src = "package a;\r\n\r\n@Mapper\r\ninterface X {\r\n    void f(String a);\r\n}\r\n";
    const parsed = parseMapperInterface(src)!;
    expect(parsed.methods[0]!.name).toBe("f");
    expect(parsed.methods[0]!.params[0]!.name).toBe("a");
  });
});

describe("inferKind (return type first, prefix refinement)", () => {
  const cases: Array<[string, string, string]> = [
    ["selectByStatus", "List<User>", "select"],
    ["selectById", "User", "select"],
    ["findByName", "Optional<User>", "select"],
    ["allUsers", "Map<String, User>", "select"],
    ["count", "long", "select"],
    ["existsByEmail", "boolean", "select"],
    ["deleteById", "void", "delete"],
    ["insertUser", "void", "insert"],
    ["saveAll", "void", "insert"],
    ["removeById", "int", "delete"],
    ["updateName", "int", "update"],
    ["clearCache", "long", "delete"],
    ["doThing", "void", "update"],
    ["doThing", "int", "update"],
    ["doThing", "String", "select"],
    ["tags", "String[]", "select"],
    ["selectById", "User", "null-with-annotation"],
  ];
  it.each(cases)("%s(%s) → %s", (name, rt, kind) => {
    const expected = kind === "null-with-annotation" ? null : kind;
    expect(inferKind(name, rt, kind === "null-with-annotation" ? "Select" : null)).toBe(expected);
  });
});

describe("resultElement", () => {
  it.each([
    ["List<User>", "User"],
    ["java.util.List<com.x.User>", "com.x.User"],
    ["Set<String>", "String"],
    ["Optional<User>", "User"],
    ["User[]", "User"],
    ["User", "User"],
    ["Map<String, User>", null],
    ["void", null],
    ["long", null],
    ["int", null],
  ])("%s → %s", (rt, expected) => expect(resultElement(rt)).toBe(expected));
});

describe("resolveType", () => {
  const base: MapperInterface = {
    name: "X",
    pkg: "com.demo",
    fqn: "com.demo.X",
    kind: "interface",
    line: 0,
    span: { from: 0, to: 0 },
    hasMapperAnnotation: false,
    methods: [],
    imports: { exact: new Map([["User", "com.acme.User"]]), wildcards: [] },
  };
  it("prefers exact imports", () => expect(resolveType("User", base)).toBe("com.acme.User"));
  it("knows java.lang (boxed included)", () => {
    expect(resolveType("String", base)).toBe("java.lang.String");
    expect(resolveType("Long", base)).toBe("java.lang.Long");
  });
  it("falls back to the same package", () => expect(resolveType("Address", base)).toBe("com.demo.Address"));
  it("keeps fully qualified names", () => expect(resolveType("com.other.Thing", base)).toBe("com.other.Thing"));
  it("keeps simple names unresolved under wildcard imports", () => {
    const withWildcard: MapperInterface = { ...base, imports: { exact: new Map(), wildcards: ["com.acme"] } };
    expect(resolveType("User", withWildcard)).toBe("User");
  });
});
