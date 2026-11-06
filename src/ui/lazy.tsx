import { useEffect, useState, type ComponentType } from "react";

const loaders: Array<() => Promise<unknown>> = [];

/**
 * A component whose code loads on first render (rendering nothing until then),
 * so contributions keep heavy views out of the start-up bundle. Deliberately
 * not `React.lazy`: a suspended boundary is revealed ~300 ms late (React's
 * fallback throttling), even when the chunk is already there.
 */
export function lazyComponent<P extends object>(load: () => Promise<ComponentType<P>>): ComponentType<P> {
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
  loaders.push(get);

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
  return LazyComponent;
}

/**
 * A lazy component mounted only while `useShown()` holds (a dialog's `open`), so an
 * always-registered overlay doesn't load its code at start-up.
 */
export function lazyWhen<P extends object>(
  useShown: () => boolean,
  load: () => Promise<ComponentType<P>>,
): ComponentType<P> {
  const Lazy = lazyComponent(load);
  return function LazyWhen(props: P) {
    return useShown() ? <Lazy {...props} /> : null;
  };
}

/**
 * Loads every lazy component's code one at a time while the app is idle, so a
 * view opened later shows at once. Call after start-up.
 */
export function prefetchLazyComponents(): () => void {
  let cancelled = false;
  let next = 0;
  const idle = (f: () => void) =>
    typeof requestIdleCallback === "function" ? requestIdleCallback(f, { timeout: 10_000 }) : setTimeout(f, 200);
  const step = () => {
    if (cancelled || next >= loaders.length) return;
    void loaders[next++]!()
      .catch(() => {})
      .finally(() => idle(step));
  };
  idle(step);
  return () => {
    cancelled = true;
  };
}
