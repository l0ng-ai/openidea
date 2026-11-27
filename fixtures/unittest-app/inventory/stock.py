"""Items in stock and their quantities."""

import os  # intentional warning: unused import


class OutOfStock(Exception):
    """Raised when taking more than is in stock."""


class Stock:
    def __init__(self):
        self._items: dict[str, int] = {}

    def add(self, name: str, quantity: int = 1) -> None:
        if quantity <= 0:
            raise ValueError("quantity must be positive")
        self._items[name] = self._items.get(name, 0) + quantity

    def take(self, name: str, quantity: int = 1) -> int:
        have = self._items.get(name, 0)
        if quantity > have:
            raise OutOfStock(f"{name}: {have} in stock, {quantity} asked")
        self._items[name] = have - quantity
        return self._items[name]

    def count(self, name: str) -> int:
        return self._items.get(name, 0)

    # TODO: report the items running low
    def total(self) -> int:
        return sum(self._items.values())
