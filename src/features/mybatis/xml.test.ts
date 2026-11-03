import { describe, expect, it } from "vitest";
import { parseMapperXml } from "./xml";

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="com.example.mapper.UserMapper">
  <!-- <select id="ghost">nothing</select> -->
  <select id="findById" resultType="com.example.User">
    SELECT * FROM sys_user WHERE id = #{id}
  </select>
  <delete id="wipe"/>
  <sql id="cols">
    id, name
  </sql>
  <select id="tricky" parameterType="java.lang.String">
    SELECT <include refid="cols"/> FROM t WHERE n = 'x>y' AND a &gt; b
  </select>
</mapper>`;

describe("parseMapperXml", () => {
  it("reads the namespace of the root", () => {
    expect(parseMapperXml(XML)?.namespace).toBe("com.example.mapper.UserMapper");
  });

  it("points the namespace offset at its opening quote", () => {
    const mapper = parseMapperXml(XML)!;
    expect(XML[mapper.namespaceAt]).toBe('"');
  });

  it("returns nothing for a file without a mapper root", () => {
    expect(parseMapperXml('<users><select id="a"/></users>')).toBeNull();
  });

  it("collects the statements declared directly under the root", () => {
    const mapper = parseMapperXml(XML)!;
    expect(mapper.statements.map((s) => s.id)).toEqual(["findById", "wipe", "cols", "tricky"]);
    expect(mapper.statements.map((s) => s.tag)).toEqual(["select", "delete", "sql", "select"]);
  });

  it("ignores a statement written inside a comment", () => {
    expect(parseMapperXml(XML)!.statements.some((s) => s.id === "ghost")).toBe(false);
  });

  it("spans each statement from its open tag to its close tag", () => {
    const [findById, wipe, cols] = parseMapperXml(XML)!.statements;
    expect([findById!.line, findById!.endLine]).toEqual([4, 6]);
    expect([wipe!.line, wipe!.endLine]).toEqual([7, 7]);
    expect([cols!.line, cols!.endLine]).toEqual([8, 10]);
  });

  it("marks a self-closed element as ending on its own line", () => {
    expect(parseMapperXml('<mapper namespace="N"><update id="u"/></mapper>')!.statements[0]).toMatchObject({
      id: "u",
      tag: "update",
      line: 0,
      endLine: 0,
    });
  });

  it("keeps <sql> fragments out of the bindable set", () => {
    const byId = Object.fromEntries(parseMapperXml(XML)!.statements.map((s) => [s.id, s.bindable]));
    expect(byId).toMatchObject({ findById: true, wipe: true, cols: false, tricky: true });
  });

  it("survives markup and quotes inside the SQL body", () => {
    const statement = parseMapperXml(XML)!.statements.find((s) => s.id === "tricky")!;
    expect(statement.at).toBe(XML.indexOf(`<select id="tricky"`) + 1);
  });

  it("does not treat an element nested in a statement as a statement", () => {
    const nested = '<mapper namespace="N"><select id="a"><include refid="b"/> WHERE x=1</select></mapper>';
    expect(parseMapperXml(nested)!.statements.map((s) => s.id)).toEqual(["a"]);
  });

  it("takes an id containing a > from the original text", () => {
    const mapper = parseMapperXml('<mapper namespace="N"><select id="a>b"/>\n</mapper>')!;
    expect(mapper.statements.map((s) => s.id)).toEqual(["a>b"]);
  });

  it("skips a statement element without an id", () => {
    expect(parseMapperXml('<mapper namespace="N"><select resultType="U"></select></mapper>')!.statements).toEqual([]);
  });

  it("ignores a statement hidden in CDATA", () => {
    const xml = '<mapper namespace="N"><![CDATA[<select id="ghost"/>]]></mapper>';
    expect(parseMapperXml(xml)!.statements).toEqual([]);
  });

  it("handles a namespace that is an empty string", () => {
    expect(parseMapperXml('<mapper namespace=""><select id="a"/></mapper>')!.namespace).toBe("");
  });
});
