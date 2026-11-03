import { describe, expect, it } from "vitest";
import { parseJavaMapper, type MapperMethod } from "./java";
import { parseMapperXml, type MapperXml } from "./xml";
import type { Found } from "./mapperStore";
import {
  generations,
  mapperXmlPath,
  newMapperXml,
  paramEdits,
  resultTypeOf,
  statementInsertion,
  statementTag,
  statementXml,
  tableName,
  type Edit,
} from "./generate";

/** Applies one edit the way the editor would. */
const apply = (text: string, edit: Edit) => text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
/** Every edit at once, last one first, so each offset still refers to `text`. */
const applyAll = (text: string, edits: readonly Edit[]) =>
  [...edits].sort((a, b) => b.from - a.from).reduce(apply, text);

/** A one-interface source, for taking a method out of it. */
const source = (params: string, returnType = "User", name = "work") =>
  `interface I { ${returnType} ${name}(${params}); }`;

function method(text: string, name: string): MapperMethod {
  const found = parseJavaMapper(text)?.methods.find((m) => m.name === name);
  if (!found) throw new Error(`no such method: ${name}`);
  return found;
}

/** The method a one-interface source declares. */
const methodOf = (params: string, returnType = "User", name = "work") => method(source(params, returnType, name), name);

const mapperOf = (text: string) => parseJavaMapper(text)!;

const foundOf = (text: string): Found<MapperXml> => ({
  path: "/p/UserMapper.xml",
  text,
  parsed: parseMapperXml(text)!,
});

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="com.example.mapper.UserMapper">
    <select id="findById" resultType="com.example.User">
        SELECT * FROM sys_user WHERE id = #{id}
    </select>
</mapper>
`;

describe("statementTag", () => {
  it.each([
    ["findById", "select"],
    ["selectAll", "select"],
    ["countByDept", "select"],
    ["batchInsert", "insert"],
    ["saveAll", "insert"],
    ["updateName", "update"],
    ["deleteById", "delete"],
    ["removeByDept", "delete"],
    ["wipe", "select"],
  ] as const)("%s → %s", (name, tag) => expect(statementTag(name)).toBe(tag));
});

describe("tableName", () => {
  it.each([
    ["UserMapper", "user"],
    ["SysUserMapper", "sys_user"],
    ["OrderDao", "order"],
    ["XMLParserMapper", "xml_parser"],
    ["Mapper", "table_name"],
  ] as const)("%s → %s", (name, table) => expect(tableName(name)).toBe(table));
});

describe("resultTypeOf", () => {
  it.each([
    ["User", "User"],
    ["List<User>", "User"],
    ["Optional<User>", "User"],
    ["IPage<User>", "User"],
    ["User[]", "User"],
    ["Map<String, Object>", "map"],
    ["int", "int"],
    ["void", null],
    ["", null],
  ] as const)("%s → %s", (type, result) => expect(resultTypeOf(type)).toBe(result));
});

describe("statementXml", () => {
  it("selects by the element of the return type, one condition per parameter", () => {
    const text = source("String name, int offset", "List<User>", "search");
    expect(statementXml(method(text, "search"), "  ", "sys_user")).toBe(
      [
        '  <select id="search" resultType="User">',
        "    SELECT * FROM sys_user WHERE name = #{name} AND offset = #{offset}",
        "  </select>",
      ].join("\n"),
    );
  });

  it("binds a parameter by its @Param value", () => {
    const text = 'interface I { int insert(@Param("userName") String name); }';
    expect(statementXml(method(text, "insert"), "", "user")).toBe(
      ['<insert id="insert">', "  INSERT INTO user (userName) VALUES (#{userName})", "</insert>"].join("\n"),
    );
  });

  it("spreads an update over the parameters: one SET, the rest as the condition", () => {
    const text = source("String name, Long id", "int", "updateName");
    expect(statementXml(method(text, "updateName"), "", "user")).toContain(
      "UPDATE user SET name = #{name} WHERE id = #{id}",
    );
  });

  it("keeps a shape that is editable when the method has no parameters", () => {
    expect(statementXml(methodOf("", "int", "deleteAll"), "", "user")).toContain("DELETE FROM user");
    expect(statementXml(methodOf("", "int", "insert"), "", "user")).toContain(
      "INSERT INTO user (column) VALUES (#{column})",
    );
  });

  it("leaves the result type out of a void method", () => {
    expect(statementXml(methodOf("Long id", "void", "selectById"), "  ", "user")).toBe(
      ['  <select id="selectById">', "    SELECT * FROM user WHERE id = #{id}", "  </select>"].join("\n"),
    );
  });
});

describe("statementInsertion", () => {
  it("puts the statement before the closing tag, at the indent of the children", () => {
    const placement = statementInsertion(XML, parseMapperXml(XML)!, methodOf("String name"), "sys_user")!;
    expect(apply(XML, placement.edit)).toBe(
      XML.replace(
        "</mapper>",
        [
          '    <select id="work" resultType="User">',
          "      SELECT * FROM sys_user WHERE name = #{name}",
          "    </select>",
          "</mapper>",
        ].join("\n"),
      ),
    );
    expect(apply(XML, placement.edit).slice(placement.from, placement.to)).toBe(
      "SELECT * FROM sys_user WHERE name = #{name}",
    );
  });

  it("breaks the line when the closing tag shares it with the root", () => {
    const text = '<mapper namespace="N"></mapper>';
    const placement = statementInsertion(text, parseMapperXml(text)!, methodOf("", "List<User>", "all"), "user")!;
    expect(apply(text, placement.edit)).toBe(
      [
        '<mapper namespace="N">',
        '    <select id="all" resultType="User">',
        "      SELECT * FROM user",
        "    </select>",
        "</mapper>",
      ].join("\n"),
    );
  });

  it("opens a self-closed root and closes it again", () => {
    const text = '<mapper namespace="N"/>';
    const placement = statementInsertion(text, parseMapperXml(text)!, methodOf("", "int", "count"), "user")!;
    expect(apply(text, placement.edit)).toBe(
      [
        '<mapper namespace="N">',
        '    <select id="count" resultType="int">',
        "      SELECT * FROM user",
        "    </select>",
        "</mapper>",
      ].join("\n"),
    );
  });

  it("refuses a root that has no end yet", () => {
    const text = '<mapper namespace="N">';
    expect(statementInsertion(text, parseMapperXml(text)!, methodOf(""), "user")).toBeNull();
  });
});

describe("newMapperXml", () => {
  it("writes the document an interface without XML needs", () => {
    const mapper = mapperOf("package com.example; interface UserMapper { User findById(Long id); }");
    const placement = newMapperXml(mapper, methodOf("Long id", "User", "findById"), "user");
    expect(placement.edit.insert).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">',
        '<mapper namespace="com.example.UserMapper">',
        '    <select id="findById" resultType="User">',
        "      SELECT * FROM user WHERE id = #{id}",
        "    </select>",
        "</mapper>",
        "",
      ].join("\n"),
    );
    expect(placement.edit.insert.slice(placement.from, placement.to)).toBe("SELECT * FROM user WHERE id = #{id}");
  });
});

describe("mapperXmlPath", () => {
  it.each([
    [
      "/p/demo/src/main/java/com/example/UserMapper.java",
      "com.example.UserMapper",
      "/p/demo/src/main/resources/com/example/UserMapper.xml",
    ],
    ["/p/src/main/java/UserMapper.java", "x.y.UserMapper", "/p/src/main/resources/UserMapper.xml"],
    ["/p/src/test/java/UserMapper.java", "x.y.UserMapper", "/p/src/test/java/UserMapper.xml"],
    ["/p/legacy/UserDAO.java", "com.example.UserDAO", "/p/legacy/UserDAO.xml"],
  ])("%s → %s", (java, namespace, xml) => expect(mapperXmlPath(java, namespace)).toBe(xml));
});

describe("paramEdits", () => {
  const twoParams = `package p;

import java.util.List;

public interface UserMapper {
    List<User> search(String name, int offset);
}`;

  it("annotates every parameter and imports Param after the last import", () => {
    const edits = paramEdits(twoParams, method(twoParams, "search"));
    expect(applyAll(twoParams, edits)).toBe(`package p;

import java.util.List;
import org.apache.ibatis.annotations.Param;

public interface UserMapper {
    List<User> search(@Param("name") String name, @Param("offset") int offset);
}`);
  });

  it("does not repeat an import the file already has", () => {
    const text = twoParams.replace("import java.util.List;", "import org.apache.ibatis.annotations.Param;");
    const edits = paramEdits(text, method(text, "search"));
    expect(edits.some((e) => e.insert.includes("import"))).toBe(false);
    expect(applyAll(text, edits)).toContain('(@Param("name") String name, @Param("offset") int offset)');
  });

  it("accepts a wildcard import of the annotations package", () => {
    const text = twoParams.replace("import java.util.List;", "import org.apache.ibatis.annotations.*;");
    expect(paramEdits(text, method(text, "search")).some((e) => e.insert.includes("import"))).toBe(false);
  });

  it("falls back to the package line when the file has no imports", () => {
    const text = "package p;\n\npublic interface UserMapper {\n    int update(String name, int offset);\n}";
    expect(applyAll(text, paramEdits(text, method(text, "update")))).toBe(
      `package p;
import org.apache.ibatis.annotations.Param;

public interface UserMapper {
    int update(@Param("name") String name, @Param("offset") int offset);
}`,
    );
  });

  it("leaves a method whose parameters are all annotated alone", () => {
    const text = 'interface I { User find(@Param("id") Long id, @Param("name") String name); }';
    expect(paramEdits(text, method(text, "find"))).toEqual([]);
  });
});

describe("generations", () => {
  const xml = () => foundOf(XML.replace("com.example.mapper.UserMapper", "p.UserMapper"));

  it("offers the statement a method is missing and the @Param its parameters need", () => {
    const text = `package p; interface UserMapper {
  User findById(Long id);
  List<User> search(String name, int offset);
  int ping();
}`;
    expect(generations(mapperOf(text), xml())).toEqual([
      { line: 2, name: "search", statement: true, params: true },
      { line: 3, name: "ping", statement: true, params: false },
    ]);
  });

  it("offers nothing for a method already bound, or one carrying its SQL in Java", () => {
    const text = `package p; interface UserMapper {
  User findById(Long id);
  @Select("SELECT 1") int ping();
}`;
    expect(generations(mapperOf(text), xml())).toEqual([]);
  });

  it("offers a statement for every method of a Mapper-named interface without XML", () => {
    const text = "package p; interface UserMapper { User find(Long id); }";
    expect(generations(mapperOf(text), null)).toEqual([{ line: 0, name: "find", statement: true, params: false }]);
  });

  it("leaves an ordinary interface alone when there is no XML to bind it", () => {
    const text = "package p; interface Callback { void run(String a, String b); }";
    expect(generations(mapperOf(text), null)).toEqual([]);
  });

  it("counts a @Param as evidence that an interface is a mapper", () => {
    const text = 'package p; interface Cache { int put(@Param("k") String k, String v); }';
    expect(generations(mapperOf(text), null)).toEqual([{ line: 0, name: "put", statement: true, params: true }]);
  });

  it("never offers to generate for a class", () => {
    expect(generations(mapperOf("package p; abstract class UserMapper { int count(); }"), null)).toEqual([]);
  });
});
