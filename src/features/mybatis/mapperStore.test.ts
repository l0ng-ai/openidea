import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emitLocalIdeEvent } from "@/platform/ipc";
import { ipcPath } from "@/platform/paths";
import {
  clearMapperIndex,
  installMapperIndex,
  mapperInterfaceFor,
  mapperXmlFor,
  type MapperIndexDeps,
} from "./mapperStore";

const NAMESPACE = "com.example.mapper.UserMapper";

const JAVA = `package com.example.mapper;

public interface UserMapper {
  User findById(Long id);
}`;

const XML = `<mapper namespace="${NAMESPACE}">
  <select id="findById" resultType="User">SELECT 1</select>
</mapper>`;

/** A second `UserMapper` the same simple name has to look past. */
const OTHER_JAVA = `package com.other;

public interface UserMapper {
  int count();
}`;

const OTHER_XML = `<mapper namespace="com.example.mapper.OrderMapper">
  <select id="list">SELECT ${NAMESPACE} /* mentioned, not declared */</select>
</mapper>`;

const texts: Record<string, string> = {
  "/p/UserMapper.java": JAVA,
  "/p/UserMapper.xml": XML,
  "/p/Inner.java": OTHER_JAVA,
  "/p/OrderMapper.xml": OTHER_XML,
};

/** Deps over an in-memory project, recording every lookup. */
function fakeDeps(paths: { search?: string[]; byName?: string[] }, calls: string[] = []): MapperIndexDeps {
  return {
    search: async (needle, include) => {
      calls.push(`search ${needle} ${include.join(",")}`);
      return paths.search ?? [];
    },
    byName: async (name) => {
      calls.push(`byName ${name}`);
      return paths.byName ?? [];
    },
    read: async (path) => texts[path] ?? null,
  };
}

let calls: string[];
let dispose: (() => void) | undefined;

beforeEach(() => {
  calls = [];
  clearMapperIndex();
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  clearMapperIndex();
});

describe("mapperXmlFor", () => {
  it("picks the file whose namespace declares the interface", async () => {
    const found = await mapperXmlFor(
      NAMESPACE,
      fakeDeps({ search: ["/p/OrderMapper.xml", "/p/UserMapper.xml"] }, calls),
    );
    expect(found?.path).toBe("/p/UserMapper.xml");
    expect(found?.parsed.statements.map((s) => s.id)).toEqual(["findById"]);
    expect(calls).toEqual([`search ${NAMESPACE} *.xml`]);
  });

  it("reads only the candidates the search reported", async () => {
    expect(await mapperXmlFor(NAMESPACE, fakeDeps({ search: [] }, calls))).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("keeps the answer, and drops it when the project changes", async () => {
    const miss = await mapperXmlFor(NAMESPACE, fakeDeps({ search: [] }, calls));
    // A second ask is served from the cache, even though another search would hit.
    expect(await mapperXmlFor(NAMESPACE, fakeDeps({ search: ["/p/UserMapper.xml"] }, calls))).toBe(miss);
    expect(calls).toHaveLength(1);

    dispose = installMapperIndex();
    emitLocalIdeEvent({ type: "fsChanged", created: [], modified: [ipcPath("/p/notes.md")], removed: [] });
    expect(await mapperXmlFor(NAMESPACE, fakeDeps({ search: ["/p/UserMapper.xml"] }, calls))).toBe(miss);
    expect(calls).toHaveLength(1);

    emitLocalIdeEvent({ type: "fsChanged", created: [ipcPath("/p/UserMapper.xml")], modified: [], removed: [] });
    const found = await mapperXmlFor(NAMESPACE, fakeDeps({ search: ["/p/UserMapper.xml"] }, calls));
    expect(found?.path).toBe("/p/UserMapper.xml");
    expect(calls).toHaveLength(2);
  });
});

describe("mapperInterfaceFor", () => {
  it("looks the interface up by its simple name and checks the package", async () => {
    const found = await mapperInterfaceFor(
      NAMESPACE,
      fakeDeps({ byName: ["/p/Inner.java", "/p/UserMapper.java"] }, calls),
    );
    expect(found?.path).toBe("/p/UserMapper.java");
    expect(found?.parsed.methods.map((m) => m.name)).toEqual(["findById"]);
    expect(calls).toEqual(["byName UserMapper.java"]);
  });

  it("gives up when no candidate declares the namespace", async () => {
    expect(await mapperInterfaceFor(NAMESPACE, fakeDeps({ byName: ["/p/Inner.java"] }, calls))).toBeNull();
  });

  it("caches both halves per namespace", async () => {
    const deps = fakeDeps({ byName: ["/p/UserMapper.java"] }, calls);
    expect(await mapperInterfaceFor(NAMESPACE, deps)).toBe(await mapperInterfaceFor(NAMESPACE, deps));
    expect(calls).toHaveLength(1);
  });
});
