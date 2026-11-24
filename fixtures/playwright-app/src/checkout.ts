export interface Line {
  sku: string;
  price: number;
  quantity: number;
}

const FREE_SHIPPING_FROM = 50;

export function subtotal(lines: Line[]): number {
  return lines.reduce((sum, l) => sum + l.price * l.quantity, 0);
}

export function shipping(lines: Line[]): number {
  // TODO: shipping by weight instead of a flat rate
  return subtotal(lines) >= FREE_SHIPPING_FROM ? 0 : 4.99;
}

export function applyCoupon(total: number, code: string): number {
  if (code === "HALF") return Math.round(total * 50) / 100;
  if (code === "TENOFF") return Math.max(0, total - 10);
  throw new Error(`unknown coupon: ${code}`);
}

// An intentional warning: never used.
function roundUp(value: number): number {
  return Math.ceil(value);
}
