import os
import unittest

from django.test import SimpleTestCase
from django.urls import reverse


class ProductPagesTests(SimpleTestCase):
    def test_lists_every_product(self):
        response = self.client.get(reverse("shop:products"))
        self.assertContains(response, "Espresso")
        self.assertContains(response, "Cornetto")
        self.assertContains(response, "€1.60")

    def test_unknown_product_is_not_found(self):
        response = self.client.get(reverse("shop:product", args=["tea"]))
        self.assertEqual(response.status_code, 404)

    @unittest.skipUnless(os.environ.get("OPENIDEA_FAIL"), "opt-in failing test")
    def test_intentionally_failing(self):
        # FIXME: the opt-in failing test, for the test runner's failure views.
        self.assertContains(self.client.get(reverse("shop:products")), "Tea")
