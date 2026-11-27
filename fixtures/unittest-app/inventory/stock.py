"""Items in stock and their quantities.

>>> stock = Stock()
>>> stock.add("apple", 3)
>>> stock.count("apple")
3
"""

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
        """Takes `quantity` of `name` and returns what is left.

        >>> stock = Stock()
        >>> stock.add("pear", 2)
        >>> stock.take("pear")
        1
        >>> stock.take("pear", 5)
        Traceback (most recent call last):
            ...
        inventory.stock.OutOfStock: pear: 1 in stock, 5 asked
        """
        have = self._items.get(name, 0)
        if quantity > have:
            raise OutOfStock(f"{name}: {have} in stock, {quantity} asked")
        self._items[name] = have - quantity
        return self._items[name]

    def count(self, name: str) -> int:
        return self._items.get(name, 0)

    # TODO: report the items running low
    def total(self) -> int:
        """All items together.

        >>> stock = Stock()
        >>> for name in "abcdefghij":
        ...     stock.add(name)
        >>> sorted(stock._items)  # doctest: +ELLIPSIS
        ['a', 'b', ..., 'j']
        >>> stock.total()
        10
        """
        return sum(self._items.values())
