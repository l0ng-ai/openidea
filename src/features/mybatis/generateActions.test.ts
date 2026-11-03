import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { parseMapperXml, type MapperXml } from "./xml";
import type { Found } from "./mapperStore";
import { generateParams, generateStatement, type GenerateDeps } from "./generateActions";

const JAVA = "package com.example.mapper;\n\npublic interface UserMapper {\n    int insertUser(String name);\n}";
const NAMESPACE = "com.example.mapper.UserMapper";
const XML_PATH = "/p/demo/src/main/resources/com/example/mapper/UserMapper.xml";
const XML = `<mapper namespace="${NAMESPACE}">\n</mapper>\n`;
const JAVA_PATH = "/p/demo/src/main/java/com/example/mapper/UserMapper.java";

const opened: EditorView[] = [];

function viewOf(doc: string): EditorView {
  const view = new EditorView({ state: EditorState.create({ doc }), parent: document.body });
  opened.push(view);
  return view;
}

afterEach(() => {
  while (opened.length) opened.pop()!.destroy();
});

const halfOf = (path: string, text: string): Found<MapperXml> => ({
  path,
  text,
  parsed: parseMapperXml(text)!,
});

/** A backend-free run of the actions: files are buffers, `xmlOf` is the given half. */
function harness(found: Found<MapperXml> | null, files: Record<string, string> = {}) {
  const views = new Map(Object.entries(files).map(([path, doc]) => [path, viewOf(doc)] as const));
  const created: string[] = [];
  const notices: Array<{ title: string; body: string }> = [];
  const deps: GenerateDeps = {
    editor: async (path) => views.get(path) ?? null,
    create: async (path) => {
      created.push(path);
      if (!views.has(path)) views.set(path, viewOf(""));
    },
    xmlOf: async () => found,
    notify: (title, body) => void notices.push({ title, body }),
  };
  const doc = (path: string) => views.get(path)!.state.doc.toString();
  return { deps, created, notices, doc, view: (path: string) => views.get(path)! };
}

const sql = (view: EditorView) => {
  const { from, to } = view.state.selection.main;
  return view.state.sliceDoc(from, to);
};

describe("generateStatement", () => {
  it("adds the statement to the XML it found, and selects the SQL", async () => {
    const text = `<mapper namespace="${NAMESPACE}">\n</mapper>\n`;
    const h = harness(halfOf(XML_PATH, text), { [XML_PATH]: text });
    await generateStatement(viewOf(JAVA), JAVA_PATH, "insertUser", h.deps);
    expect(h.created).toEqual([]);
    expect(h.doc(XML_PATH)).toBe(
      [
        `<mapper namespace="${NAMESPACE}">`,
        '    <insert id="insertUser">',
        "      INSERT INTO user (name) VALUES (#{name})",
        "    </insert>",
        "</mapper>",
        "",
      ].join("\n"),
    );
    expect(sql(h.view(XML_PATH))).toBe("INSERT INTO user (name) VALUES (#{name})");
  });

  it("creates the XML in the resources twin of the interface folder", async () => {
    const h = harness(null);
    await generateStatement(viewOf(JAVA), JAVA_PATH, "insertUser", h.deps);
    expect(h.created).toEqual([XML_PATH]);
    expect(h.doc(XML_PATH).split("\n").slice(0, 3)).toEqual([
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">',
      `<mapper namespace="${NAMESPACE}">`,
    ]);
    expect(h.doc(XML_PATH)).toContain('    <insert id="insertUser">');
  });

  it("writes into the document the editor is showing, not the one on disk", async () => {
    const onDisk = `<mapper namespace="${NAMESPACE}">\n</mapper>\n`;
    const live = `<mapper namespace="${NAMESPACE}">\n    <sql id="cols">\n        id, name\n    </sql>\n</mapper>\n`;
    const h = harness(halfOf(XML_PATH, onDisk), { [XML_PATH]: live });
    await generateStatement(viewOf(JAVA), JAVA_PATH, "insertUser", h.deps);
    expect(h.doc(XML_PATH)).toBe(
      [
        `<mapper namespace="${NAMESPACE}">`,
        '    <sql id="cols">',
        "        id, name",
        "    </sql>",
        '    <insert id="insertUser">',
        "      INSERT INTO user (name) VALUES (#{name})",
        "    </insert>",
        "</mapper>",
        "",
      ].join("\n"),
    );
  });

  it("refuses a file that is another interface's mapper XML", async () => {
    const other = '<mapper namespace="com.other.OtherMapper">\n</mapper>\n';
    const h = harness(halfOf(XML_PATH, other), { [XML_PATH]: other });
    await generateStatement(viewOf(JAVA), JAVA_PATH, "insertUser", h.deps);
    expect(h.doc(XML_PATH)).toBe(other);
    expect(h.notices[0]?.body).toContain("Not a mapper XML of this interface");
  });

  it("says so when the target cannot be opened", async () => {
    const h = harness(halfOf("/p/Gone.xml", XML));
    await generateStatement(viewOf(JAVA), JAVA_PATH, "insertUser", h.deps);
    expect(h.notices[0]?.body).toContain("Cannot open file");
  });

  it("says so when the method is gone from the document", async () => {
    const h = harness(halfOf(XML_PATH, XML), { [XML_PATH]: XML });
    await generateStatement(viewOf(JAVA), JAVA_PATH, "renamedAway", h.deps);
    expect(h.doc(XML_PATH)).toBe(XML);
    expect(h.notices[0]).toEqual({
      title: "Cannot Generate MyBatis Statement",
      body: `The document changed; retry\n${JAVA_PATH}`,
    });
  });
});

describe("generateParams", () => {
  const TWO = "package p;\n\npublic interface UserMapper {\n    int update(String name, Long id);\n}";

  it("annotates every parameter and adds the import the file lacks", async () => {
    const view = viewOf(TWO);
    const h = harness(null);
    await generateParams(view, "/p/UserMapper.java", "update", h.deps);
    expect(view.state.doc.toString()).toBe(
      `package p;
import org.apache.ibatis.annotations.Param;

public interface UserMapper {
    int update(@Param("name") String name, @Param("id") Long id);
}`,
    );
    expect(h.notices).toEqual([]);
  });

  it("reports a method whose parameters are already annotated", async () => {
    const text = 'package p; interface UserMapper { int update(@Param("a") String a, @Param("b") Long b); }';
    const view = viewOf(text);
    const h = harness(null);
    await generateParams(view, "/p/a.java", "update", h.deps);
    expect(view.state.doc.toString()).toBe(text);
    expect(h.notices[0]?.title).toBe("Cannot Generate @Param Annotations");
  });

  it("reports a method that is no longer in the document", async () => {
    const view = viewOf(TWO);
    const h = harness(null);
    await generateParams(view, "/p/a.java", "gone", h.deps);
    expect(h.notices[0]?.title).toBe("Cannot Generate @Param Annotations");
  });
});
