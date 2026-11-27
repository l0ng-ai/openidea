import { describe, expect, it, vi } from "vitest";
import type { ProcessMemory } from "@/platform/ipc";
import { formatBytes, formatCount, formatMs, formatSize, formatUptime } from "../format";
import { indicatorLabel, indicatorTooltip, memorySections, summarizeMemory } from "../memory";
import { RollingWindow, percentile } from "../stats";
import { isEditorTypingEntry, keystrokeLatencies, supportsEntryType } from "../events";
import { startPolling } from "../poll";

const MB = 1024 * 1024;
const GB = 1024 * MB;

describe("format", () => {
  it("formats bytes like IDEA's memory indicator", () => {
    expect(formatBytes(412 * MB)).toBe("412M");
    expect(formatBytes(2 * GB)).toBe("2G");
    expect(formatBytes(1.94 * GB)).toBe("1.9G");
    expect(formatBytes(1023.7 * MB)).toBe("1G");
    expect(formatBytes(512)).toBe("512B");
    expect(formatBytes(12 * 1024)).toBe("12K");
    expect(formatBytes(null)).toBe("–");
    expect(formatBytes(-1)).toBe("–");
  });

  it("formats sizes for tooltips and the breakdown", () => {
    expect(formatSize(560 * MB)).toBe("560 MB");
    expect(formatSize(1.1 * GB)).toBe("1.1 GB");
    expect(formatSize(12 * 1024)).toBe("12 KB");
    expect(formatSize(null)).toBe("–");
  });

  it("formats durations and counts", () => {
    expect(formatMs(0.42)).toBe("0.4 ms");
    expect(formatMs(16.4)).toBe("16 ms");
    expect(formatMs(2300)).toBe("2.3 s");
    expect(formatMs(null)).toBe("–");
    expect(formatUptime(42_000)).toBe("42s");
    expect(formatUptime(303_000)).toBe("5m 03s");
    expect(formatUptime((2 * 60 + 7) * 60_000)).toBe("2h 07m");
    expect(formatUptime(76 * 3_600_000)).toBe("3d 4h");
    expect(formatCount(1234567)).toBe("1,234,567");
  });
});

describe("stats", () => {
  it("computes nearest-rank percentiles", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 95)).toBe(10);
    expect(percentile(sorted, 0)).toBe(1);
    expect(percentile([], 50)).toBeNull();
  });

  it("keeps a rolling window", () => {
    const w = new RollingWindow(3);
    expect(w.summary().last).toBeNull();
    [5, 1, 9, 30].forEach((v) => w.push(v));
    w.push(Number.NaN);
    expect(w.size).toBe(3);
    expect(w.pushed).toBe(4);
    expect(w.values().sort((a, b) => a - b)).toEqual([1, 9, 30]);
    const s = w.summary(16);
    expect(s).toMatchObject({ count: 3, last: 30, p50: 9, max: 30, overBudget: 1 });
    w.clear();
    expect(w.summary().count).toBe(0);
  });
});

describe("event timing", () => {
  const inEditor = () => {
    const editor = document.createElement("div");
    editor.className = "cm-editor";
    const content = document.createElement("div");
    editor.appendChild(content);
    const text = document.createTextNode("x");
    content.appendChild(text);
    return { content, text };
  };

  it("keeps only typing events inside CodeMirror", () => {
    const { content, text } = inEditor();
    const outside = document.createElement("input");
    expect(isEditorTypingEntry({ name: "keydown", duration: 20, target: content })).toBe(true);
    expect(isEditorTypingEntry({ name: "input", duration: 20, target: text })).toBe(true);
    expect(isEditorTypingEntry({ name: "keydown", duration: 20, target: outside })).toBe(false);
    expect(isEditorTypingEntry({ name: "click", duration: 20, target: content })).toBe(false);
    expect(isEditorTypingEntry({ name: "keydown", duration: 20, target: null })).toBe(false);
  });

  it("collapses one keystroke's entries into its slowest", () => {
    const { content } = inEditor();
    const lat = keystrokeLatencies([
      { name: "keydown", duration: 18, target: content, interactionId: 7 },
      { name: "beforeinput", duration: 24, target: content, interactionId: 7 },
      { name: "keydown", duration: 40, target: content, interactionId: 8 },
      { name: "input", duration: 17, target: content, interactionId: 0 },
      { name: "pointerdown", duration: 90, target: content, interactionId: 9 },
    ]);
    expect(lat.sort((a, b) => a - b)).toEqual([17, 24, 40]);
  });

  it("feature-detects entry types", () => {
    const original = globalThis.PerformanceObserver;
    expect(typeof supportsEntryType("event")).toBe("boolean");
    vi.stubGlobal("PerformanceObserver", { supportedEntryTypes: ["event"] });
    expect(supportsEntryType("event")).toBe(true);
    expect(supportsEntryType("longtask")).toBe(false);
    vi.stubGlobal("PerformanceObserver", undefined);
    expect(supportsEntryType("event")).toBe(false);
    vi.stubGlobal("PerformanceObserver", original);
    vi.unstubAllGlobals();
  });
});

describe("polling", () => {
  it("pauses while the document is hidden", () => {
    vi.useFakeTimers();
    const listeners = new Set<() => void>();
    const doc = {
      visibilityState: "visible" as DocumentVisibilityState,
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    } as unknown as Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
    const tick = vi.fn();
    const stop = startPolling(tick, { intervalMs: 1000, doc });
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(tick).toHaveBeenCalledTimes(3);
    (doc as { visibilityState: string }).visibilityState = "hidden";
    listeners.forEach((l) => l());
    vi.advanceTimersByTime(5000);
    expect(tick).toHaveBeenCalledTimes(3);
    (doc as { visibilityState: string }).visibilityState = "visible";
    listeners.forEach((l) => l());
    expect(tick).toHaveBeenCalledTimes(4);
    stop();
    vi.advanceTimersByTime(5000);
    expect(tick).toHaveBeenCalledTimes(4);
    expect(listeners.size).toBe(0);
    vi.useRealTimers();
  });
});

const row = (category: ProcessMemory["category"], label: string, mb: number | null, detail: string | null = null) =>
  ({
    category,
    label,
    detail,
    pid: 1,
    processes: 1,
    bytes: mb == null ? null : mb * MB,
    cpuPercent: null,
  }) satisfies ProcessMemory;

describe("memory breakdown", () => {
  const rows: ProcessMemory[] = [
    row("app", "Backend", 60),
    row("app", "Web content", 400, "idea"),
    row("app", "GPU", 40),
    row("app", "Networking", 20),
    row("languageServer", "jdtls", 900, "idea"),
    { ...row("languageServer", "rust-analyzer", 226, "idea"), pid: 300, processes: 2, cpuPercent: 12.4 },
    row("process", "zsh", null, "Terminal"),
  ];

  it("sums per group and labels the indicator without a fake denominator", () => {
    const s = summarizeMemory({ memory: rows, rssBytes: 1 });
    expect(s).toEqual({ app: 520 * MB, languageServers: 1126 * MB, processes: null, total: 1646 * MB });
    expect(indicatorLabel(s)).toBe("OpenIDEA 520M");
    expect(indicatorTooltip(s)).toBe("OpenIDEA 520 MB · language servers 1.1 GB");
  });

  it("falls back to the backend's resident memory without a breakdown", () => {
    const s = summarizeMemory({ memory: [], rssBytes: 125 * MB });
    expect(indicatorLabel(s)).toBe("OpenIDEA 125M");
    expect(indicatorTooltip(s)).toBe("OpenIDEA 125 MB");
    expect(indicatorLabel(summarizeMemory(null))).toBe("OpenIDEA –");
  });

  it("builds popup sections in category order", () => {
    const sections = memorySections(rows);
    expect(sections.map((s) => [s.title, s.total, s.rows.length])).toEqual([
      ["OpenIDEA", "520 MB", 4],
      ["Language servers", "1.1 GB", 2],
      ["Debug adapters & processes", "–", 1],
    ]);
    expect(sections[1]!.rows[1]).toMatchObject({
      label: "rust-analyzer",
      detail: "idea",
      value: "226 MB",
      cpu: "12%",
      pid: 300,
      processes: 2,
      endable: true,
    });
    expect(sections[1]!.cpu).toBe("12%");
    expect(sections[0]!.cpu).toBe("–");
    expect(sections[0]!.rows.every((r) => !r.endable)).toBe(true);
    expect(memorySections([])).toEqual([]);
  });
});
