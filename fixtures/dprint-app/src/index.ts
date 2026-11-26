import {total,type Item} from "./cart.ts";

const items:Item[]=[{name:"Notebook",price:4.5,quantity:2},{name:"Pen",price:1.25,quantity:4}];

console.log("Total:",total(items).toFixed(2));
