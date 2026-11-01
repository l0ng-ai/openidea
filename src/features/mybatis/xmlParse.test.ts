import { describe, expect, it } from "vitest";
import { parseMapperXml } from "./xmlParse";

const MAPPER = `<?xml version="1.0" encoding="UTF-8" ?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="com.example.mapper.UserMapper">

    <resultMap id="userMap" type="com.example.entity.User"/>

    <select id="selectById" resultType="com.example.entity.User">
        <!-- a comment containing <select id="fake"> must not count -->
        SELECT * FROM user WHERE id = #{id}
        <if test="name != null"> AND name = #{name}</if>
    </select>

    <insert id="insertUser" parameterType="com.example.entity.User">
        INSERT INTO user (name) VALUES (#{name})
    </insert>

    <update id="updateName">
        UPDATE user SET name = #{name} WHERE id = #{id}
    </update>

    <delete id="deleteById">
        DELETE FROM user WHERE id = #{id}
    </delete>

    <sql id="columns">id, name</sql>

    <select id="cd" resultType="string">
        <![CDATA[
        SELECT * FROM t WHERE a < b
        ]]>
    </select>

    <select
        id="multiLine"
        resultType="com.example.entity.User">
        SELECT * FROM user
    </select>
</mapper>
`;

describe("parseMapperXml", () => {
  it("reads the namespace and mapper line", () => {
    const xml = parseMapperXml(MAPPER);
    expect(xml.namespace).toBe("com.example.mapper.UserMapper");
    expect(MAPPER.split("\n")[xml.line]).toContain("<mapper namespace");
  });

  it("collects the four statement kinds with positions", () => {
    const xml = parseMapperXml(MAPPER);
    expect(xml.statements.map((s) => `${s.tag}:${s.id}`)).toEqual([
      "select:selectById",
      "insert:insertUser",
      "update:updateName",
      "delete:deleteById",
      "select:cd",
      "select:multiLine",
    ]);
    for (const s of xml.statements) expect(MAPPER.split("\n")[s.line]).toContain(`<${s.tag}`);
  });

  it("ignores resultMap and sql fragments", () => {
    const ids = parseMapperXml(MAPPER).statements.map((s) => s.id);
    expect(ids).not.toContain("columns");
  });

  it("ignores statement-like text inside comments and CDATA", () => {
    const xml = parseMapperXml(`<mapper namespace="x.Y">
    <!-- <select id="fake"> -->
    <![CDATA[ <update id="alsoFake"> ]]>
    <select id="real"></select>
</mapper>`);
    expect(xml.statements.map((s) => s.id)).toEqual(["real"]);
  });

  it("handles a DOCTYPE with an internal subset", () => {
    const xml = parseMapperXml(`<!DOCTYPE mapper [
    <!ENTITY x "y > z">
]>
<mapper namespace="a.B"><select id="s"/></mapper>`);
    expect(xml.namespace).toBe("a.B");
    expect(xml.statements).toHaveLength(1);
  });

  it("ignores statements outside a mapper (mybatis-config mappers entries)", () => {
    const xml = parseMapperXml(`<mappers><mapper resource="mapper/UserMapper.xml"/></mappers>`);
    expect(xml.namespace).toBeNull();
    expect(xml.statements).toHaveLength(0);
  });

  it("returns null namespace for non-mapper XML", () => {
    const xml = parseMapperXml(`<beans xmlns="http://www.springframework.org/schema/beans"><bean id="x"/></beans>`);
    expect(xml.namespace).toBeNull();
    expect(xml.statements).toHaveLength(0);
  });
});
