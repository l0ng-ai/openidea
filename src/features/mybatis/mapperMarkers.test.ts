import { describe, expect, it } from "vitest";
import { parseJavaMapper, type JavaMapper } from "./java";
import { parseMapperXml, type MapperXml } from "./xml";
import { javaMarkers, xmlMarkers } from "./mapperMarkers";
import type { Found } from "./mapperStore";

const JAVA = `package com.example.mapper;

public interface UserMapper {
  User findById(Long id);
  List<User> selectAll();
  int countAll();
}`;

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mapper-3.0.dtd">
<mapper namespace="com.example.mapper.UserMapper">
  <select id="findById" resultType="User">
    SELECT * FROM users WHERE id = #{id}
  </select>
  <select id="selectAll" databaseId="mysql" resultType="User">SELECT 1</select>
  <select id="selectAll" resultType="User">SELECT 2</select>
  <sql id="countAll">SELECT count(*) FROM users</sql>
</mapper>`;

const mapper = () => parseJavaMapper(JAVA)!;
const xml = () => parseMapperXml(XML)!;

/** The XML half of the interface above, as the index resolves it. */
const xmlHalf = (): Found<MapperXml> => ({
  path: "/p/resources/mapper/UserMapper.xml",
  text: XML,
  parsed: xml(),
});

/** The interface half of the XML above. */
const javaHalf = (): Found<JavaMapper> => ({
  path: "/p/src/main/java/com/example/mapper/UserMapper.java",
  text: JAVA,
  parsed: mapper(),
});

describe("javaMarkers", () => {
  it("marks the methods a statement is bound to", () => {
    const markers = javaMarkers(mapper(), xmlHalf());
    expect(markers.map((m) => [m.line, m.name])).toEqual([
      [3, "findById"],
      [4, "selectAll"],
    ]);
  });

  it("lands on the statement's opening tag", () => {
    const [findById] = javaMarkers(mapper(), xmlHalf());
    expect(findById?.targets).toEqual([
      {
        path: "/p/resources/mapper/UserMapper.xml",
        range: { start: { line: 3, col: 3 }, end: { line: 3, col: 9 } },
      },
    ]);
  });

  it("offers every statement of an id declared more than once", () => {
    const selectAll = javaMarkers(mapper(), xmlHalf())[1];
    expect(selectAll?.targets.map((t) => t.range.start.line)).toEqual([6, 7]);
    expect(selectAll?.chooserTitle).toBe("Choose Statement of selectAll (2 found)");
  });

  it("ignores a `<sql>` fragment of the same name", () => {
    expect(javaMarkers(mapper(), xmlHalf()).map((m) => m.name)).not.toContain("countAll");
  });

  it("says what the icon jumps to", () => {
    expect(javaMarkers(mapper(), xmlHalf())[0]?.tooltip).toBe("Statement in UserMapper.xml");
  });

  it("marks nothing without the XML half", () => {
    expect(javaMarkers(mapper(), null)).toEqual([]);
  });
});

describe("xmlMarkers", () => {
  it("marks the statements whose method exists", () => {
    const markers = xmlMarkers(xml(), javaHalf());
    expect(markers.map((m) => [m.line, m.name])).toEqual([
      [3, "findById"],
      [6, "selectAll"],
      [7, "selectAll"],
    ]);
  });

  it("lands on the method's name", () => {
    expect(xmlMarkers(xml(), javaHalf())[0]?.targets[0]?.range.start).toEqual({ line: 3, col: 7 });
  });

  it("skips a `<sql>` fragment", () => {
    expect(xmlMarkers(xml(), javaHalf()).map((m) => m.line)).not.toContain(8);
  });

  it("merges two statements of one id written on the same line", () => {
    const javaText = "package com.example.mapper;\n\ninterface OrderMapper {\n  List<Order> list();\n}";
    const xmlText = `<mapper namespace="com.example.mapper.OrderMapper">
  <select id="list" databaseId="mysql">SELECT 1</select><select id="list">SELECT 2</select>
</mapper>`;
    const java: Found<JavaMapper> = { path: "/p/OrderMapper.java", text: javaText, parsed: parseJavaMapper(javaText)! };
    const markers = xmlMarkers(parseMapperXml(xmlText)!, java);
    expect(markers).toHaveLength(1);
    expect(markers[0]?.targets).toHaveLength(1);
  });

  it("marks nothing without the interface half", () => {
    expect(xmlMarkers(xml(), null)).toEqual([]);
  });

  it("says what the icon jumps to", () => {
    const [first] = xmlMarkers(xml(), javaHalf());
    expect(first?.tooltip).toBe("Mapper method in UserMapper.java");
    expect(first?.chooserTitle).toBe("Choose Mapper Method of findById (1 found)");
  });
});
