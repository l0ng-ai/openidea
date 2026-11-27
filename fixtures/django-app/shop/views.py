"""Views of the shop: a product list and a product page."""

import json  # Intentional warning: unused import.
from dataclasses import dataclass
from decimal import Decimal

from django.http import Http404, HttpRequest, HttpResponse
from django.shortcuts import render


@dataclass(frozen=True)
class Product:
    slug: str
    name: str
    price: Decimal
    tags: tuple[str, ...] = ()


PRODUCTS = [
    Product("espresso", "Espresso", Decimal("1.20"), ("coffee", "hot")),
    Product("cappuccino", "Cappuccino", Decimal("1.60"), ("coffee", "milk")),
    Product("cornetto", "Cornetto", Decimal("1.30")),
]


def product_list(request: HttpRequest) -> HttpResponse:
    # TODO: paginate once the menu grows.
    return render(request, "shop/product_list.html", {"products": PRODUCTS})


def product_detail(request: HttpRequest, slug: str) -> HttpResponse:
    product = next((p for p in PRODUCTS if p.slug == slug), None)  # Set a breakpoint here
    if product is None:
        raise Http404(slug)
    return render(request, "shop/product_list.html", {"products": [product], "single": True})
