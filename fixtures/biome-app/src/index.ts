import { describe, total, type Item } from "./cart.ts"

const items: Item[] = [
    { name: "Notebook", price: 4.5, quantity: 2 },
    { name: "Pen", price: 1.25, quantity: 4 },
]

// Set a breakpoint here
console.log(describe(items), "-", total(items).toFixed(2))
