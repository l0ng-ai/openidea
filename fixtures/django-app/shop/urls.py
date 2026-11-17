from django.urls import path

from . import views

app_name = "shop"

urlpatterns = [
    path("", views.product_list, name="products"),
    path("products/<slug:slug>/", views.product_detail, name="product"),
]
