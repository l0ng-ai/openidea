export interface Item {
  sku: string;
  price: number;
  quantity: number;
}

const TAX_RATE = 0.1;

export function subtotal(items: Item[]): number {
  return items.reduce((sum, i) => sum + i.price * i.quantity, 0);
}

export function withTax(total: number): number {
  // FIXME: tax rates differ by region
  return Math.round(total * (1 + TAX_RATE) * 100) / 100;
}

export function discount(total: number, code: string): number {
  if (code === "HALF") return Math.round(total * 50) / 100;
  throw new Error(`unknown code: ${code}`);
}

// An intentional warning: never used.
function roundDown(value: number): number {
  return Math.floor(value);
}
