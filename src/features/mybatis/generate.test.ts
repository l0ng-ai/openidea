import { describe, expect, it } from "vitest";
import { parseMapperInterface } from "./javaParse";
import {
  appendStatementEdit,
  applyEdits,
  importEdit,
  mapperLocationDirs,
  mapperXmlContent,
  paramAnnotationEdits,
  statementXml,
} from "./generate";

const JAVA = `package com.example.mapper;

import com.example.entity.User;
import java.util.List;

@Mapper
public interface UserMapper {
    List<User> selectByStatus(Integer status, String keyword);
    User selectById(Long id);
    void insertUser(User user);
    int updateName(@Param("userId") Long userId, String newName);
    long count();
    Map<String, User> allUsers();
}`;

const iface = () => parseMapperInterface(JAVA)!;

const method = (name: string) => iface().methods.find((m) => m.name === name)!;

describe("statementXml", () => {
  it("selects with a collection return: element resultType", () => {
    expect(statementXml(method("selectByStatus"), iface())).toBe(
      `    <select id="selectByStatus" resultType="com.example.entity.User">
        <!-- TODO: write SELECT; params: #{status}, #{keyword} -->
    </select>`,
    );
  });

  it("selects a scalar count: the type itself as resultType", () => {
    expect(statementXml(method("count"), iface())).toContain('id="count" resultType="long"');
  });

  it("insert with a single parameter: parameterType", () => {
    expect(statementXml(method("insertUser"), iface())).toBe(
      `    <insert id="insertUser" parameterType="com.example.entity.User">
        <!-- TODO: write INSERT -->
        <!-- TODO: add useGeneratedKeys="true" keyProperty="id" to return generated keys -->
    </insert>`,
    );
  });

  it("update for a count return with a prefix", () => {
    const xml = statementXml(method("updateName"), iface());
    expect(xml).toContain('<update id="updateName">');
    expect(xml).toContain("params: #{userId}, #{newName}");
    expect(xml).not.toContain("parameterType=");
  });

  it("map returns select without resultType (resultMap territory)", () => {
    const xml = statementXml(method("allUsers"), iface());
    expect(xml).toContain('<select id="allUsers">');
    expect(xml).not.toContain("resultType");
  });

  it("flags unresolved simple type names from wildcard imports", () => {
    const src = `import com.acme.*;
interface X {
    List<User> list();
}`;
    const i = parseMapperInterface(src)!;
    expect(statementXml(i.methods[0]!, i)).toContain("<!-- TODO: use a fully qualified type");
  });
});

describe("mapperXmlContent", () => {
  it("builds a full mapper with header, DOCTYPE and the eligible statements", () => {
    const content = mapperXmlContent(iface());
    expect(content.startsWith('<?xml version="1.0" encoding="UTF-8" ?>')).toBe(true);
    expect(content).toContain('<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN"');
    expect(content).toContain('<mapper namespace="com.example.mapper.UserMapper">');
    expect(content).toContain('<select id="selectByStatus"');
    expect(content).toContain('<insert id="insertUser"');
    expect(content.endsWith("</mapper>\n")).toBe(true);
  });
});

describe("appendStatementEdit", () => {
  it("inserts before </mapper>", () => {
    const text = `<mapper namespace="a.B">\n</mapper>\n`;
    const edit = appendStatementEdit(text, "STMT");
    expect(text.slice(0, edit.from) + edit.insert + text.slice(edit.to)).toBe(
      `<mapper namespace="a.B">\nSTMT\n\n</mapper>\n`,
    );
  });

  it("appends at the end without a closing tag", () => {
    const text = `<mapper namespace="a.B">`;
    const edit = appendStatementEdit(text, "STMT");
    expect(text.slice(0, edit.from) + edit.insert + text.slice(edit.to)).toBe(`<mapper namespace="a.B">\nSTMT\n`);
  });
});

describe("paramAnnotationEdits", () => {
  it("annotates the missing parameters of multi-parameter methods only", () => {
    const edits = paramAnnotationEdits(iface(), null);
    const applied = applyEdits(JAVA, edits);
    expect(applied).toContain('@Param("status") Integer status, @Param("keyword") String keyword');
    expect(applied).toContain('@Param("newName") String newName'); // @Param("userId") already present
    expect(applied).not.toContain('@Param("id")'); // single-parameter method
    expect(applied).not.toContain('@Param("user")');
  });

  it("scopes to a single method", () => {
    const edits = paramAnnotationEdits(iface(), method("selectByStatus"));
    expect(edits).toHaveLength(2);
    expect(applyEdits(JAVA, edits)).toContain('@Param("status") Integer status, @Param("keyword") String keyword');
  });

  it("is a no-op when everything is annotated", () => {
    const src = `interface X { void f(@Param("a") String a, @Param("b") String b); }`;
    const i = parseMapperInterface(src)!;
    expect(paramAnnotationEdits(i, null)).toHaveLength(0);
  });

  it("fills a @Param written without a value", () => {
    const src = `interface X { void f(@Param() String a, @Param Long b); }`;
    const i = parseMapperInterface(src)!;
    expect(applyEdits(src, paramAnnotationEdits(i, null))).toBe(
      `interface X { void f(@Param("a") String a, @Param("b") Long b); }`,
    );
  });

  it("fills an empty @Param even on a single-parameter method", () => {
    const src = `interface X { void g(@Param() String a); }`;
    const i = parseMapperInterface(src)!;
    expect(applyEdits(src, paramAnnotationEdits(i, null))).toBe(`interface X { void g(@Param("a") String a); }`);
  });

  it("leaves single-parameter methods without @Param alone", () => {
    const src = `interface X { void g(String a); }`;
    const i = parseMapperInterface(src)!;
    expect(paramAnnotationEdits(i, null)).toHaveLength(0);
  });
});

describe("importEdit", () => {
  it("is null when the import exists", () => {
    expect(importEdit("import org.apache.ibatis.annotations.Param;\ninterface X {}")).toBeNull();
  });

  it("appends after the last import", () => {
    const text = `package a;\n\nimport java.util.List;\nimport com.x.Y;\n\ninterface X {}`;
    const edit = importEdit(text)!;
    expect(applyEdits(text, [edit])).toBe(
      `package a;\n\nimport java.util.List;\nimport com.x.Y;\nimport org.apache.ibatis.annotations.Param;\n\ninterface X {}`,
    );
  });

  it("inserts after the package without imports", () => {
    const text = `package a;\n\ninterface X {}`;
    const edit = importEdit(text)!;
    expect(applyEdits(text, [edit])).toBe(`package a;\n\nimport org.apache.ibatis.annotations.Param;\ninterface X {}`);
  });

  it("inserts at the top without a package", () => {
    const edit = importEdit("interface X {}")!;
    expect(applyEdits("interface X {}", [edit])).toBe("import org.apache.ibatis.annotations.Param;\n\ninterface X {}");
  });
});

describe("mapperLocationDirs", () => {
  it("parses YAML and properties forms, classpath prefixes and wildcards", () => {
    const yml = `mybatis:\n  mapper-locations: classpath:mapper/*.xml, classpath*:other/**/*.xml\n`;
    const props = `mybatis.mapper-locations=classpath:flat.xml\n`;
    expect(mapperLocationDirs(yml)).toEqual(["mapper", "other"]);
    expect(mapperLocationDirs(props)).toEqual(["flat.xml"]);
  });

  it("normalizes backslashes and strips trailing slashes", () => {
    expect(mapperLocationDirs(`mybatis.mapper-locations=classpath*:mapper\\*.xml`)).toEqual(["mapper"]);
    expect(mapperLocationDirs(`mapper-locations: classpath:/mapper/`)).toEqual(["mapper"]);
  });

  it("keeps the classpath root empty for root-level patterns", () => {
    expect(mapperLocationDirs(`mapper-locations: classpath:*.xml`)).toEqual([""]);
  });
});
