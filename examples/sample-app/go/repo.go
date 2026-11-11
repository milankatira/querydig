package repo

import (
	"context"
	"database/sql"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
)

func OrdersWithUsers(ctx context.Context, db *mongo.Database) error {
	cur, err := db.Collection("orders").Find(ctx, bson.M{"status": "open"})
	if err != nil {
		return err
	}
	for cur.Next(ctx) {
		var o Order
		_ = cur.Decode(&o)
		db.Collection("users").FindOne(ctx, bson.M{"_id": o.UserID})
	}
	return nil
}

func All(ctx context.Context, coll *mongo.Collection) {
	coll.Find(ctx, bson.M{})
}

func Prices(ctx context.Context, coll *mongo.Collection, items []Item) {
	for _, it := range items {
		coll.UpdateOne(ctx, bson.M{"_id": it.ID}, bson.M{"$set": bson.M{"price": it.Price}})
	}
}

func Users(db *sql.DB, ids []int) {
	for _, id := range ids {
		db.QueryRow("SELECT name FROM users WHERE id = $1", id)
	}
	db.Query(`SELECT * FROM users`)
}

func Poll(ctx context.Context, coll *mongo.Collection) {
	for {
		coll.FindOne(ctx, bson.M{"state": "pending"})
	}
}
