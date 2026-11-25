export interface Item {
    name: string
    price: number
    quantity: number
}

export function total(items: Item[]): number {
    let sum = 0
    for (const item of items) sum += item.price * item.quantity
    return sum
}

// Intentional Biome problems: `let` never reassigned (useConst, safe fix),
// string concatenation (useTemplate) and `==` (noDoubleEquals).
export function describe(items: Item[]): string {
    let label = "Cart: " + items.length + " items"
    if (items.length == 0) {
        return "Cart is empty"
    }
    return label
}
