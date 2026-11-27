import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";

// The prefetch list is module state, so every test starts from a fresh module.
async function setup() {
  vi.resetModules();
  return import("./lazy");
}

const view =
  (name: string): ComponentType =>
  () => <p>{name}</p>;

describe("prefetchLazyComponents", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("loads only the components that opted in, and the rest still load when first rendered", async () => {
    const { lazyComponent, lazyWhen, prefetchLazyComponents } = await setup();
    const warm = vi.fn(async () => view("warm"));
    const warmWhen = vi.fn(async () => view("warm when"));
    const cold = vi.fn(async () => view("cold"));
    const coldWhen = vi.fn(async () => view("cold when"));
    lazyComponent(warm, { prefetch: true });
    lazyWhen(() => false, warmWhen, { prefetch: true });
    const Cold = lazyComponent(cold);
    lazyWhen(() => true, coldWhen);

    prefetchLazyComponents();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(warm).toHaveBeenCalledTimes(1);
    expect(warmWhen).toHaveBeenCalledTimes(1);
    expect(cold).not.toHaveBeenCalled();
    expect(coldWhen).not.toHaveBeenCalled();

    render(<Cold />);
    await act(async () => {});
    expect(screen.getByText("cold")).toBeInTheDocument();
    expect(cold).toHaveBeenCalledTimes(1);
  });

  it("does not load a prefetched component again when it is first rendered", async () => {
    const { lazyComponent, prefetchLazyComponents } = await setup();
    const load = vi.fn(async () => view("warm"));
    const Warm = lazyComponent(load, { prefetch: true });

    prefetchLazyComponents();
    await vi.advanceTimersByTimeAsync(60_000);
    render(<Warm />);

    expect(screen.getByText("warm")).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
  });
});
