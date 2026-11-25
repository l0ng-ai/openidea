import { describe, expect, it } from "vitest";
import { inMapperSql, isMapper, mapperSql } from "./mapper";

const MAPPER = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="com.example.UserMapper">
  <resultMap id="user" type="User"><id column="id" property="id"/></resultMap>
  <select id="find" resultMap="user">
    select id, name from users
    <where>
      <if test="name != null">and name = #{name}</if>
      <if test="ids != null">and id in
        <foreach collection="ids" item="i" open="(" separator="," close=")">#{i}</foreach>
      </if>
      and age &gt; 18
    </where>
  </select>
  <insert id="add">
    <selectKey keyProperty="id" resultType="int">select last_insert_id()</selectKey>
    insert into users (name) values (#{name})
  </insert>
  <!-- <select id="old">select * from old</select> -->
  <update id="rename"><![CDATA[update users set name = #{name} where age < 3]]></update>
  <update id="touch">update users <set><if test="a">name = #{a},</if></set> where id = #{id}</update>
</mapper>`;

describe("MyBatis mapper SQL", () => {
  it("recognises mapper files", () => {
    expect(isMapper(MAPPER)).toBe(true);
    expect(isMapper("<beans><bean id='a'/></beans>")).toBe(false);
  });

  it("keeps the statements' SQL at its offsets and blanks the rest", () => {
    const { text } = mapperSql(MAPPER);
    expect(text).toHaveLength(MAPPER.length);
    expect(text.split("\n")).toHaveLength(MAPPER.split("\n").length);
    const sql = text.replace(/\s+/g, " ").trim();
    expect(sql).toBe(
      "select id, name from users where name = ? and id in ( ? ) and age > 18 ; " +
        "insert into users (name) values (? ) ; update users set name = ? where age < 3 ; " +
        "update users set name = ? where id = ? ;",
    );
    const at = MAPPER.indexOf("users");
    expect(text.slice(at, at + 5)).toBe("users");
  });

  it("knows which offsets are SQL", () => {
    const sql = mapperSql(MAPPER);
    expect(inMapperSql(sql, MAPPER.indexOf("from users") + 2)).toBe(true);
    expect(inMapperSql(sql, MAPPER.indexOf("resultMap="))).toBe(false);
    expect(inMapperSql(sql, MAPPER.indexOf('test="name'))).toBe(false);
    expect(inMapperSql(sql, MAPPER.indexOf("last_insert_id"))).toBe(false);
    expect(inMapperSql(sql, MAPPER.indexOf("from old"))).toBe(false);
  });
});
