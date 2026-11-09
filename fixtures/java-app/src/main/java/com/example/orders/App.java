package com.example.orders;

public class App {
    public static void main(String[] args) {
        OrderBook book = new OrderBook();
        book.place("alice", "Mechanical keyboard", 1, 8999);
        book.place("bob", "Wireless mouse", 2, 2999);
        book.place("alice", "USB-C hub", 1, 3999);

        int unused = 42; // intentional warning: unused variable
        // Set a breakpoint here (QA: debugger) and inspect `book`.
        long revenue = book.revenueCents();
        System.out.printf("%d orders, revenue %.2f%n", book.size(), revenue / 100.0);
        book.largest().ifPresent(o -> System.out.println("Largest: " + o.product()));
    }
}
