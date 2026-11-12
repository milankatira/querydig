// mongosh shop tests/live/seed/mongo.js
db = db.getSiblingDB('shop');
db.dropDatabase();
const statuses = ['open', 'paid', 'shipped', 'cancelled'];
db.users.insertMany(Array.from({ length: 500 }, (_, i) => ({ _id: i + 1, name: 'user' + i, email: `u${i}@example.com`, active: i % 3 !== 0, createdAt: new Date(2024, 0, 1 + (i % 365)) })));
db.users.createIndex({ email: 1 }, { name: 'email_1' }); // never used by any query: LV004
db.products.insertMany(Array.from({ length: 50 }, (_, i) => ({ _id: i + 1, name: 'product' + i, category: 'c' + (i % 5), price: i * 3 })));
for (let b = 0; b < 30; b++) {
  db.orders.insertMany(Array.from({ length: 10000 }, (_, i) => {
    const n = b * 10000 + i;
    return { userId: (n % 500) + 1, status: statuses[n % 4], total: n % 997, createdAt: new Date(Date.now() - n * 60000) };
  }));
}
db.items.insertMany(Array.from({ length: 20 }, (_, i) => ({ _id: i, p: i })));
// a slow query so the profiler has something to report: COLLSCAN + in-memory sort on 300k docs
db.setProfilingLevel(1, { slowms: 50 });
db.orders.find({ status: 'open' }).sort({ createdAt: -1 }).toArray();
db.orders.find({ status: 'open' }).sort({ createdAt: -1 }).toArray();
print('seeded: orders=' + db.orders.estimatedDocumentCount() + ' users=' + db.users.estimatedDocumentCount() + ' profile=' + db.system.profile.countDocuments());
