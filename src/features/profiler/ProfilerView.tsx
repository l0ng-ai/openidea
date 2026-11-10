/**
 * Profiler tool window: one tab per snapshot, and per snapshot a flame graph
 * (click to zoom, search highlights), the call tree (top-down) and the method
 * list (self / total). Double-click opens a frame's source when known.
 */
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type { Profile } from "@/platform/ipc";
import { EmptyState, IconButton, Input, Tabs, Tree, T } from "@/ui";
import { editorService } from "@/workbench/contributions";
import { colorSlot, flameLayout, formatWeight, frameLocation, matchingFrames, share } from "./model";
import { activeSnapshot, closeSnapshot, useProfiler, type ProfilerTab } from "./store";
import styles from "./Profiler.module.css";
import { tx } from "@/platform/i18n";

const ROW = 18;

function openFrame(profile: Profile, frame: number) {
  const f = profile.frames[frame];
  if (!f?.file) return;
  void editorService().openFile(
    f.file,
    f.line !== null ? { selection: { line: f.line, col: 0 }, focus: true } : { focus: true },
  );
}

export function ProfilerTabs() {
  const snapshots = useProfiler((s) => s.snapshots);
  const activeId = useProfiler((s) => s.activeId);
  if (!snapshots.length) return null;
  return (
    <Tabs
      variant="compact"
      aria-label="Profiler snapshots"
      className={styles.tabs}
      activeId={activeId}
      onSelect={(id) => useProfiler.setState({ activeId: id })}
      onClose={closeSnapshot}
      items={snapshots.map((s) => ({
        id: s.id,
        label: s.name,
        closable: true,
        tooltip: `${s.profile.profiler}, ${new Date(s.createdAt).toLocaleTimeString()}`,
      }))}
    />
  );
}

function FlameGraph({ profile, query }: { profile: Profile; query: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [focus, setFocus] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const layout = useMemo(() => flameLayout(profile, focus, width > 0 ? 1 / width : 0.002), [profile, focus, width]);
  const matches = useMemo(() => matchingFrames(profile, query), [profile, query]);
  const unit = profile.unit;
  const total = profile.total ?? 0;

  return (
    <div className={styles.flamePane}>
      {focus !== 0 && (
        <div className={styles.flameBar}>
          <IconButton icon="close" size="small" title="Reset Zoom" onClick={() => setFocus(0)} />
          <span className={styles.muted}>{tx`Zoomed into ${profile.frames[profile.nodes[focus]!.frame]!.name}`}</span>
        </div>
      )}
      <div className={styles.flameScroll} ref={ref}>
        <div className={styles.flame} style={{ height: layout.depth * ROW }} role="tree" aria-label={tx("Flame graph")}>
          {width > 0 &&
            layout.rects.map((r) => {
              const node = profile.nodes[r.node]!;
              const frame = profile.frames[node.frame]!;
              const w = r.width * width;
              const location = frameLocation(profile, node.frame);
              const label = r.node === 0 ? `all (${formatWeight(total, unit)})` : frame.name;
              return (
                <div
                  key={r.node}
                  role="treeitem"
                  aria-label={label}
                  className={clsx(
                    styles.frame,
                    styles[`c${colorSlot(frame.name)}`],
                    matches && (matches.has(node.frame) ? styles.match : styles.dim),
                  )}
                  style={{ left: r.x * width, width: Math.max(w - 1, 1), bottom: r.depth * ROW }}
                  title={`${frame.name}${location ? ` (${location})` : ""}\nTotal: ${formatWeight(node.total ?? 0, unit)} (${share(node.total ?? 0, total)})\nSelf: ${formatWeight(node.selfWeight ?? 0, unit)}`}
                  onClick={() => setFocus(r.node)}
                  onDoubleClick={() => openFrame(profile, node.frame)}
                >
                  {w > 28 && <span className={styles.frameText}>{label}</span>}
                </div>
              );
            })}
        </div>
      </div>
    </div>
  );
}

function CallTree({ profile }: { profile: Profile }) {
  const total = profile.total ?? 0;
  const roots = useMemo(() => profile.nodes[0]?.children ?? [], [profile]);
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  // The heaviest path starts expanded (IDEA expands the hottest call chain).
  const initial = useMemo(() => {
    const set = new Set<string>();
    let cur = roots[0];
    for (let i = 0; cur !== undefined && i < 30; i++) {
      set.add(String(cur));
      cur = profile.nodes[cur]!.children[0];
    }
    return set;
  }, [profile, roots]);
  return (
    <Tree<number>
      aria-label="Call tree"
      className={styles.tree}
      roots={roots}
      getKey={(n) => String(n)}
      getLabel={(n) => profile.frames[profile.nodes[n]!.frame]!.name}
      getChildren={(n) => (profile.nodes[n]!.children.length ? profile.nodes[n]!.children : undefined)}
      isExpandable={(n) => profile.nodes[n]!.children.length > 0}
      expanded={expanded ?? initial}
      onExpandedChange={(next) => setExpanded(next)}
      activateExpandable
      onActivate={(n) => openFrame(profile, profile.nodes[n]!.frame)}
      renderNode={(n) => {
        const node = profile.nodes[n]!;
        const location = frameLocation(profile, node.frame);
        return (
          <span className={styles.treeRow}>
            <span className={styles.share}>{share(node.total ?? 0, total)}</span>
            <span className={styles.name}>{profile.frames[node.frame]!.name}</span>
            {location && <span className={styles.muted}>{location}</span>}
            <span className={styles.weight}>
              {formatWeight(node.total ?? 0, profile.unit)}
              {(node.selfWeight ?? 0) > 0 && ` · self ${formatWeight(node.selfWeight ?? 0, profile.unit)}`}
            </span>
          </span>
        );
      }}
    />
  );
}

type MethodSort = "self" | "total" | "name";
const MAX_METHODS = 2000;

function MethodList({ profile, query }: { profile: Profile; query: string }) {
  const [sort, setSort] = useState<MethodSort>("self");
  const total = profile.total ?? 0;
  const rows = useMemo(() => {
    const matches = matchingFrames(profile, query);
    const list = profile.methods.filter((m) => !matches || matches.has(m.frame));
    const name = (f: number) => profile.frames[f]!.name;
    if (sort === "name") list.sort((a, b) => name(a.frame).localeCompare(name(b.frame)));
    else if (sort === "total") list.sort((a, b) => (b.total ?? 0) - (a.total ?? 0));
    return list.slice(0, MAX_METHODS);
  }, [profile, query, sort]);
  const header = (key: MethodSort, label: string) => (
    <th aria-sort={sort === key ? (key === "name" ? "ascending" : "descending") : "none"}>
      <button type="button" className={styles.headerCell} onClick={() => setSort(key)}>
        {tx(label)}
      </button>
    </th>
  );
  return (
    <div className={styles.tableScroll}>
      <table className={styles.table}>
        <thead>
          <tr>
            {header("name", "Method")}
            {header("self", "Self")}
            {header("total", "Total")}
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => {
            const location = frameLocation(profile, m.frame);
            return (
              <tr key={m.frame} onDoubleClick={() => openFrame(profile, m.frame)}>
                <td className={styles.methodCell}>
                  <span className={styles.name}>{profile.frames[m.frame]!.name}</span>
                  {location && <span className={styles.muted}>{location}</span>}
                </td>
                <td className={styles.num}>
                  {formatWeight(m.selfWeight ?? 0, profile.unit)}{" "}
                  <span className={styles.muted}>{share(m.selfWeight ?? 0, total)}</span>
                </td>
                <td className={styles.num}>
                  {formatWeight(m.total ?? 0, profile.unit)}{" "}
                  <span className={styles.muted}>{share(m.total ?? 0, total)}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ProfilerView() {
  const snapshot = useProfiler((s) => activeSnapshot(s));
  const tab = useProfiler((s) => s.tab);
  const query = useProfiler((s) => s.query);
  if (!snapshot) {
    return (
      <EmptyState title="No profiler snapshots">
        <span>
          <T>Profile a run configuration to see where it spends its time.</T>
        </span>
      </EmptyState>
    );
  }
  const profile = snapshot.profile;
  return (
    <div className={styles.view}>
      <div className={styles.toolbar}>
        <Tabs
          variant="compact"
          aria-label="Profiler views"
          className={styles.viewTabs}
          activeId={tab}
          onSelect={(id) => useProfiler.setState({ tab: id as ProfilerTab })}
          items={[
            { id: "flame", label: "Flame Graph" },
            { id: "tree", label: "Call Tree" },
            { id: "methods", label: "Method List" },
          ]}
        />
        <span className={styles.muted}>
          {profile.profiler} · {formatWeight(profile.total ?? 0, profile.unit)}
        </span>
        {tab !== "tree" && (
          <Input
            className={styles.search}
            placeholder="Search frames"
            aria-label="Search frames"
            value={query}
            onChange={(e) => useProfiler.setState({ query: e.target.value })}
          />
        )}
      </div>
      <div className={styles.body}>
        {tab === "flame" && <FlameGraph key={snapshot.id} profile={profile} query={query} />}
        {tab === "tree" && <CallTree key={snapshot.id} profile={profile} />}
        {tab === "methods" && <MethodList profile={profile} query={query} />}
      </div>
    </div>
  );
}
