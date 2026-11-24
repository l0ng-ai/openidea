import { create } from "zustand";

export type StripeSide = "left" | "right";

/** Stripe button widths with names; icons only follow `--stripe-icon-button`. */
export const STRIPE_MIN = 44;
export const STRIPE_MAX = 96;
const STRIPE_DEFAULT = 56;
const STRIPE_KEY = "openidea.stripes.v1";

interface StripeSize {
  width: number;
  /** Names shown or hidden by a resize. Unset follows the appearance setting. */
  names?: boolean;
}

interface Stripes extends Record<StripeSide, StripeSize> {
  moreSide: StripeSide;
}

function readStripes(): Stripes {
  const out: Stripes = { left: { width: STRIPE_DEFAULT }, right: { width: STRIPE_DEFAULT }, moreSide: "left" };
  try {
    const raw = JSON.parse(localStorage.getItem(STRIPE_KEY) ?? "null");
    for (const side of ["left", "right"] as const) {
      const v = raw?.[side];
      if (typeof v?.width === "number") out[side].width = Math.min(STRIPE_MAX, Math.max(STRIPE_MIN, v.width));
      if (typeof v?.names === "boolean") out[side].names = v.names;
    }
    if (raw?.moreSide === "right") out.moreSide = "right";
  } catch {
    /* storage unavailable */
  }
  return out;
}

export const useStripes = create<Stripes>(readStripes);

function saveStripes(next: Partial<Stripes>) {
  useStripes.setState(next);
  try {
    localStorage.setItem(STRIPE_KEY, JSON.stringify(useStripes.getState()));
  } catch {
    /* storage unavailable */
  }
}

export function setStripe(side: StripeSide, size: StripeSize) {
  saveStripes({ [side]: size });
}

/** "Show Tool Window Names" (menu or settings) applies to both stripes again. */
export function resetStripeNames() {
  const s = useStripes.getState();
  if (s.left.names === undefined && s.right.names === undefined) return;
  saveStripes({ left: { width: s.left.width }, right: { width: s.right.width } });
}

export function toggleMoreToolWindowsSide() {
  saveStripes({ moreSide: useStripes.getState().moreSide === "left" ? "right" : "left" });
}
