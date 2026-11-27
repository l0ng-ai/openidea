import os
import unittest

from inventory.stock import OutOfStock, Stock


class StockTests(unittest.TestCase):
    def setUp(self):
        self.stock = Stock()
        self.stock.add("apple", 3)

    def test_add(self):
        self.stock.add("apple", 2)
        self.assertEqual(self.stock.count("apple"), 5)

    def test_take(self):
        print("taking one apple")
        self.assertEqual(self.stock.take("apple"), 2)

    def test_take_too_many(self):
        with self.assertRaises(OutOfStock):
            self.stock.take("apple", 4)

    def test_rejects_bad_quantities(self):
        for quantity in (0, -1, -5):
            with self.subTest(quantity=quantity):
                with self.assertRaises(ValueError):
                    self.stock.add("pear", quantity)

    @unittest.skip("FIXME: low-stock report not written yet")
    def test_low_stock_report(self):
        pass

    @unittest.expectedFailure
    def test_negative_total(self):
        self.assertLess(self.stock.total(), 0)

    @unittest.skipUnless(os.environ.get("OPENIDEA_FAIL"), "set OPENIDEA_FAIL=1 to run")
    def test_failing(self):
        self.assertEqual(self.stock.count("apple"), 4)
