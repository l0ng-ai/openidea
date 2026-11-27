import unittest

from inventory.stock import Stock


class TotalTests(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(Stock().total(), 0)

    def test_sums_every_item(self):
        stock = Stock()
        stock.add("apple", 2)
        stock.add("pear", 3)
        self.assertEqual(stock.total(), 5)
