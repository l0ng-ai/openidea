import { useEffect, useState, type ComponentType } from "react";

/** Loaders of the components that opted into `prefetch`, in registration order. */
const prefetched: Array<() => Promise<unknown>> = [];

type LazyOptions = {
  /**
   * Load this component's code in the background after start-up (see
   * `prefetchLazyComponents`). Set it only for views most users open early, where
   * a blank first frame would be noticeable; every prefetched chunk costs
   * download, parse and heap in every window, opened or not.
   */
  prefetch?: boolean;
};

export type LazyComponent<P extends object = Record<string, never>> = ComponentType<P> & {
  preload(): Promise<ComponentType<P>>;
};

/**
 * A component whose code loads on first render (rendering nothing until then),
 * so contributions keep heavy views out of the start-up bundle. Deliberately
 * not `React.lazy`: a suspended boundary is revealed ~300 ms late (React's
 * fallback throttling), even when the chunk is already there.
 */
export function lazyComponent<P extends object>(
  load: () => Promise<ComponentType<P>>,
  { prefetch = false }: LazyOptions = {},
): LazyComponent<P> {
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;
  const get = () =>
    (pending ??= load().then(
      (component) => (loaded = component),
      (e: unknown) => {
        pending = null; // A failed chunk load may succeed later.
        throw e;
      },
    ));
  if (prefetch) prefetched.push(get);

  function LazyComponent(props: P) {
    const [Component, setComponent] = useState<ComponentType<P> | null>(() => loaded);
    useEffect(() => {
      if (Component) return;
      let live = true;
      get().then(
        (c) => live && setComponent(() => c),
        (e: unknown) => console.error("could not load view", e),
      );
      return () => {
        live = false;
      };
    }, [Component]);
    return Component ? <Component {...props} /> : null;
  }
  LazyComponent.preload = get;
  return LazyComponent;
}

/**
 * A lazy component first mounted when `useShown()` holds (a dialog opens), so an
 * always-registered overlay doesn't load its code at start-up. It stays mounted
 * afterwards: the component still decides what to render when closed.
 */
export function lazyWhen<P extends object>(
  useShown: () => boolean,
  load: () => Promise<ComponentType<P>>,
  options?: LazyOptions,
): ComponentType<P> {
  const Lazy = lazyComponent(load, options);
  let shown = false;
  return function LazyWhen(props: P) {
    const now = useShown();
    shown ||= now;
    return shown ? <Lazy {...props} /> : null;
  };
}

/**
 * Loads the code of the lazy components marked `prefetch` one at a time while the
 * app is idle, so those views show at once when first opened. The others load
 * when first rendered. Call after start-up.
 */
export function prefetchLazyComponents(): () => void {
  let cancelled = false;
  let next = 0;
  const idle = (f: () => void) =>
    typeof requestIdleCallback === "function" ? requestIdleCallback(f, { timeout: 10_000 }) : setTimeout(f, 200);
  const step = () => {
    if (cancelled || next >= prefetched.length) return;
    void prefetched[next++]!()
      .catch(() => {})
      .finally(() => idle(step));
  };
  idle(step);
  return () => {
    cancelled = true;
  };
}
