/**
 * Whether motion should be reduced: Settings › Appearance › Reduce motion (the `data-reduce-motion`
 * root attribute) or the system's reduced-motion preference. For script-driven animation; CSS
 * reads the attribute and the media query itself.
 */
export function reducedMotion(): boolean {
  if (typeof document !== "undefined" && document.documentElement.dataset.reduceMotion !== undefined) return true;
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}
