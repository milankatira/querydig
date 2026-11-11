import mongoose from 'mongoose';
import { User, Order, Product } from './models';

export async function listOrdersWithUsers() {
  const orders = await Order.find({ status: 'open' });
  for (const o of orders) {
    o.user = await User.findById(o.userId);
  }
  return orders;
}

export async function report() {
  const users = await User.find({ active: true }).lean();
  return Promise.all(users.map(async (u) => {
    const items = await Order.find({ userId: u._id }).select('total').lean();
    return { u, items };
  }));
}

export async function everything() {
  return Product.find({});
}

export async function search(q: string) {
  return User.find({ name: { $regex: q, $options: 'i' } }).sort({ createdAt: -1 }).lean();
}

export async function page(n: number) {
  return Product.find({ category: 'x' }).skip(n * 50).limit(50).lean();
}

export async function bump(items: { id: string; price: number }[]) {
  for (const i of items) {
    await Product.updateOne({ _id: i.id }, { $set: { price: i.price } });
  }
}

export async function hasOrders(uid: string) {
  if ((await Order.countDocuments({ userId: uid })) > 0) return true;
  return false;
}

export async function stats() {
  return Order.aggregate([
    { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'user' } },
    { $unwind: '$user' },
    { $match: { 'user.country': 'IN' } },
  ]);
}

export async function legacy() {
  return Order.find({ $where: 'this.total > 100' }).limit(10).lean();
}

// array helpers must NOT be flagged
export function local(xs: number[]) {
  return xs.find((x) => x > 1);
}

export async function ok(ids: string[]) {
  return User.find({ _id: { $in: ids } }).select('name').limit(100).lean();
}

export async function ignored(ids: string[]) {
  for (const id of ids) {
    await User.findById(id); // querydig-ignore QD001
  }
}
