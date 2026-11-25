import { describe, expect, it } from "vitest";
import type { HeapEdge, HeapRootKind } from "@/platform/ipc";
import { edgeText } from "../heap/edgeText";

const root = (kind: HeapRootKind, thread: string | null = null): HeapEdge => ({ kind: "root", root: kind, thread });

describe("edgeText", () => {
  it("formats edges", () => {
    expect(edgeText({ kind: "field", name: "next" })).toBe(".next");
    expect(edgeText({ kind: "element", index: 12 })).toBe("[12]");
    expect(edgeText(root("javaFrame", "main"))).toBe("Local variable in main");
    expect(edgeText(root("javaFrame"))).toBe("Local variable");
  });

  it("names the class-level edges", () => {
    expect(edgeText({ kind: "static", name: "<resolved_references>" })).toBe("static <resolved_references>");
    expect(edgeText({ kind: "classOf" })).toBe("class");
    expect(edgeText({ kind: "superClass" })).toBe("superclass");
    expect(edgeText({ kind: "classLoader" })).toBe("class loader");
  });

  it("names every kind of root", () => {
    expect(edgeText(root("unknown"))).toBe("Unknown root");
    expect(edgeText(root("jniGlobal"))).toBe("JNI global");
    expect(edgeText(root("jniLocal", "main"))).toBe("JNI local");
    expect(edgeText(root("nativeStack"))).toBe("Native stack");
    expect(edgeText(root("stickyClass"))).toBe("System class");
    expect(edgeText(root("threadBlock"))).toBe("Thread block");
    expect(edgeText(root("monitorUsed"))).toBe("Monitor");
    expect(edgeText(root("threadObject", "worker-1"))).toBe("Thread worker-1");
    expect(edgeText(root("threadObject"))).toBe("Thread");
  });

  it("keeps a field the dump does not name visible", () => {
    expect(edgeText({ kind: "field", name: "" })).toBe(".?");
  });
});
