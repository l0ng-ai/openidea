/**
 * Exit animations for overlays that callers unmount outright (`{open && <X />}`,
 * a host returning null): on unmount, a static copy of the overlay's DOM stays
 * behind and fades out. The copy is inert, so the overlay is gone for focus,
 * keyboard, pointer and assistive tech the moment it closes, and nothing
 * re-renders stale props or store state while it animates.
 */
import { useLayoutEffect, type RefObject } from "react";
import { animate, MotionGlobalConfig, type DOMKeyframesDefinition, type Transition } from "motion/react";

export interface ExitGhost {
  /** The element to copy: its position is taken as is (fixed overlays). */
  root: RefObject<HTMLElement | null>;
  /** The element inside `root` that animates; `root` itself when omitted. */
  target?: RefObject<HTMLElement | null>;
  keyframes: DOMKeyframesDefinition;
  transition: Transition;
}

export function useExitGhost({ root, target, keyframes, transition }: ExitGhost) {
  useLayoutEffect(() => {
    // Refs are detached during the unmount: hold on to the nodes now.
    const node = root.current;
    const animated = target?.current ?? node;
    return () => {
      if (!node || !animated || skip()) return;
      const ghost = copy(node);
      const path = pathTo(node, animated);
      queueMicrotask(() => {
        // StrictMode re-runs effects on a mounted overlay: no ghost then.
        if (node.isConnected) return;
        document.body.appendChild(ghost.el);
        ghost.restoreScroll();
        const el = path ? follow(ghost.el, path) : ghost.el;
        void animate(el, keyframes, transition).finished.finally(() => ghost.el.remove());
      });
    };
    // The nodes are fixed for the overlay's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

function skip(): boolean {
  return (
    MotionGlobalConfig.skipAnimations === true ||
    (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches)
  );
}

/** A deep copy with what `cloneNode` drops: field values, canvas pixels, scroll offsets. */
function copy(node: HTMLElement) {
  const el = node.cloneNode(true) as HTMLElement;
  el.inert = true;
  el.setAttribute("aria-hidden", "true");
  el.style.pointerEvents = "none";
  const from = [node, ...node.querySelectorAll<HTMLElement>("*")];
  const to = [el, ...el.querySelectorAll<HTMLElement>("*")];
  const scrolled: [HTMLElement, number, number][] = [];
  from.forEach((src, i) => {
    const dst = to[i]!;
    if (dst.id) dst.removeAttribute("id");
    if (src.scrollTop || src.scrollLeft) scrolled.push([dst, src.scrollTop, src.scrollLeft]);
    if (src instanceof HTMLInputElement || src instanceof HTMLTextAreaElement || src instanceof HTMLSelectElement) {
      (dst as typeof src).value = src.value;
    } else if (src instanceof HTMLCanvasElement && src.width && src.height) {
      (dst as HTMLCanvasElement).getContext("2d")?.drawImage(src, 0, 0);
    }
  });
  return {
    el,
    restoreScroll() {
      for (const [dst, top, left] of scrolled) dst.scrollTo(left, top);
    },
  };
}

function pathTo(root: Element, el: Element): number[] | null {
  const path: number[] = [];
  for (let cur = el; cur !== root; cur = cur.parentElement!) {
    if (!cur.parentElement) return null;
    path.unshift([...cur.parentElement.children].indexOf(cur));
  }
  return path;
}

function follow(root: HTMLElement, path: number[]): HTMLElement {
  return path.reduce<HTMLElement>((el, i) => el.children[i] as HTMLElement, root);
}
