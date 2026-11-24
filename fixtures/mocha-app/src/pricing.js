export function withTax(net, rate) {
  if (rate < 0) throw new RangeError("tax rate must not be negative");
  return Math.round(net * (1 + rate) * 100) / 100;
}

export function bulkDiscount(quantity) {
  // TODO: read the tiers from the catalog instead of hard-coding them
  if (quantity >= 100) return 0.15;
  if (quantity >= 10) return 0.05;
  return 0;
}

// An intentional warning: never used.
const CURRENCY = "EUR";
