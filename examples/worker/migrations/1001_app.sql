-- App-owned schema. Framework reserves 0001-; apps use 1001+.
CREATE TABLE IF NOT EXISTS feed_hashtags (
	host TEXT PRIMARY KEY,
	hashtag TEXT NOT NULL
);
