export interface Item {
    name: string
    price: number
    quantity: number
}

export function total(items: Item[]): number {
    return items.reduce((sum, item) => sum + item.price * item.quantity, 0)
}
