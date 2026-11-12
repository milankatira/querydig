-- psql -d shop -f tests/live/seed/postgres.sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
DROP TABLE IF EXISTS posts, events, sessions, products, users CASCADE;
CREATE TABLE users (id serial PRIMARY KEY, email text NOT NULL, name text, created_at timestamptz DEFAULT now());
CREATE INDEX users_name_idx ON users (name);              -- never used: LV004
CREATE TABLE posts (id serial PRIMARY KEY, "authorId" int REFERENCES users (id), title text); -- FK without index: LV005
CREATE TABLE products (id serial PRIMARY KEY, name text, price int);
CREATE TABLE events (id bigserial PRIMARY KEY, kind text, created_at timestamptz);
CREATE TABLE sessions (id serial PRIMARY KEY, user_id int);
INSERT INTO users (email, name) SELECT 'u' || g || '@example.com', 'user' || g FROM generate_series(1, 500) g;
INSERT INTO posts ("authorId", title) SELECT (g % 500) + 1, 'post ' || g FROM generate_series(1, 200000) g;
INSERT INTO products (name, price) SELECT 'product' || g, g FROM generate_series(1, 50) g;
INSERT INTO events (kind, created_at) SELECT 'k' || (g % 7), now() - (g || ' minutes')::interval FROM generate_series(1, 300000) g;
ANALYZE;
SELECT pg_stat_statements_reset();
-- slow statements for pg_stat_statements
SELECT count(*) FROM posts WHERE "authorId" = 7;
SELECT id FROM events ORDER BY created_at DESC OFFSET 250000 LIMIT 20;
SELECT id FROM events ORDER BY created_at DESC OFFSET 250000 LIMIT 20;
