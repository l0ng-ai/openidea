/** Per-project display order, independent of detected or saved run configurations. */
import { useEffect } from "react";
import { create } from "zustand";

export type ServiceOrder = Record<string, string[]>;
const STORAGE_KEY = "openidea.services.runOrder:";
const EMPTY: ServiceOrder = {};
const unsaved = new Map<string, ServiceOrder>();
const useOrder = create<{ location: string | null; order: ServiceOrder }>(() => ({ location: null, order: EMPTY }));

export function readServiceOrder(location: string): ServiceOrder {
  const pending = unsaved.get(location);
  if (pending) return pending;
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY + location) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(
      Object.entries(raw).flatMap(([kind, ids]) =>
        Array.isArray(ids)
          ? [[kind, [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))]]]
          : [],
      ),
    );
  } catch {
    return {};
  }
}

export function orderServices<T extends { id: string }>(entries: readonly T[], saved: readonly string[] = []): T[] {
  const rank = new Map(saved.map((id, i) => [id, i]));
  return [...entries].sort((a, b) => (rank.get(a.id) ?? saved.length) - (rank.get(b.id) ?? saved.length));
}

export function moveServiceOrder(
  saved: readonly string[],
  ids: readonly string[],
  source: string,
  target: string,
  position: "before" | "after",
): string[] {
  if (source === target || !ids.includes(source) || !ids.includes(target)) return [...saved];
  const order = [...new Set([...saved, ...ids])].filter((id) => id !== source);
  order.splice(order.indexOf(target) + (position === "after" ? 1 : 0), 0, source);
  return order;
}

export function currentServiceOrder(location: string): ServiceOrder {
  const s = useOrder.getState();
  return s.location === location ? s.order : readServiceOrder(location);
}

/** Returns false if only the in-memory order could be saved. */
export function saveServiceOrder(location: string, order: ServiceOrder): boolean {
  useOrder.setState({ location, order });
  try {
    localStorage.setItem(STORAGE_KEY + location, JSON.stringify(order));
    unsaved.delete(location);
    return true;
  } catch {
    unsaved.set(location, order);
    return false;
  }
}

export function useServiceOrder(location: string | null): ServiceOrder {
  const state = useOrder();
  useEffect(() => {
    const reload = () => useOrder.setState({ location, order: location ? readServiceOrder(location) : EMPTY });
    reload();
    const storage = (e: StorageEvent) => {
      if ((e.key === null || e.key === STORAGE_KEY + location) && (!e.storageArea || e.storageArea === localStorage)) {
        if (location) unsaved.delete(location);
        reload();
      }
    };
    window.addEventListener("storage", storage);
    return () => window.removeEventListener("storage", storage);
  }, [location]);
  return state.location === location ? state.order : location ? readServiceOrder(location) : EMPTY;
}
