from pymongo import MongoClient
from myapp.models import Author, Book

client = MongoClient()
db = client.shop

def orders_with_users():
    orders = db.orders.find({"status": "open"})
    for o in orders:
        o["user"] = db.users.find_one({"_id": o["user_id"]})
    return orders

def everything():
    return list(db.products.find({}))

def names(q):
    return db.users.find({"name": {"$regex": q}}, {"name": 1})

def django_n_plus_one():
    for a in Author.objects.all():
        books = Book.objects.filter(author=a)
    return [Book.objects.get(pk=i) for i in range(10)]

def title_find(s):
    return s.find("x")

def bulk(items):
    for it in items:
        db.items.update_one({"_id": it["id"]}, {"$set": {"p": it["p"]}})
