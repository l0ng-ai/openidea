import { reducedMotion } from "@/platform/motion";
import { useLiveMarkdown } from "./live";

/** Keep one follower per split. A new editor position retargets the frame already in flight. */
export function followMarkdownSource(path: string, root: HTMLElement, offsetForLine: (line: number) => number) {
  let frame = 0;
  let lastTime = 0;
  let position = root.scrollTop;
  let applied = position;
  const target = () => {
    const state = useLiveMarkdown.getState()[path];
    const max = Math.max(0, root.scrollHeight - root.clientHeight);
    return state?.sourceAtEnd ? max : Math.min(max, Math.max(0, offsetForLine(state?.topLine ?? 0)));
  };
  const stop = () => {
    cancelAnimationFrame(frame);
    frame = 0;
  };
  const align = () => {
    stop();
    root.scrollTop = target();
  };
  const step = (time: number) => {
    frame = 0;
    if (Math.abs(root.scrollTop - applied) > 1) return;
    const destination = target();
    const elapsed = Math.max(0, Math.min(time - lastTime, 100));
    lastTime = time;
    position += (destination - position) * -Math.expm1(-elapsed / 40);
    if (Math.abs(position - destination) < 0.5 || reducedMotion()) {
      root.scrollTop = destination;
      return;
    }
    root.scrollTop = position;
    applied = root.scrollTop;
    frame = requestAnimationFrame(step);
  };
  const off = useLiveMarkdown.subscribe((next, prev) => {
    const a = next[path],
      b = prev[path];
    if (!a || (a.topLine === b?.topLine && a.scrollSeq === b?.scrollSeq && a.sourceAtEnd === b?.sourceAtEnd)) return;
    if (reducedMotion()) return align();
    if (frame) return;
    applied = position = root.scrollTop;
    lastTime = performance.now();
    frame = requestAnimationFrame(step);
  });
  root.addEventListener("wheel", stop, { passive: true });
  root.addEventListener("touchstart", stop, { passive: true });
  return {
    align,
    dispose() {
      stop();
      off();
      root.removeEventListener("wheel", stop);
      root.removeEventListener("touchstart", stop);
    },
  };
}
