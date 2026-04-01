-- =========================================================
-- RLS (Row Level Security) policies for sample-store
-- Apply via Supabase Dashboard → SQL Editor
-- =========================================================

-- ---- users ----
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- Users can read and update only their own row
CREATE POLICY "users: read own" ON users
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "users: update own" ON users
  FOR UPDATE USING (auth.uid() = id);

-- Service role (backend) can do everything (bypasses RLS by default with service key)

-- ---- user_downloads ----
ALTER TABLE user_downloads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_downloads: read own" ON user_downloads
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "user_downloads: insert own" ON user_downloads
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ---- user_likes ----
ALTER TABLE user_likes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_likes: read own" ON user_likes
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "user_likes: insert own" ON user_likes
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "user_likes: delete own" ON user_likes
  FOR DELETE USING (auth.uid() = user_id);

-- ---- user_pack_likes ----
ALTER TABLE user_pack_likes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_pack_likes: read own" ON user_pack_likes
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "user_pack_likes: insert own" ON user_pack_likes
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "user_pack_likes: delete own" ON user_pack_likes
  FOR DELETE USING (auth.uid() = user_id);

-- ---- user_packs ----
ALTER TABLE user_packs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_packs: read own" ON user_packs
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "user_packs: insert own" ON user_packs
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ---- subscriptions ----
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "subscriptions: read own" ON subscriptions
  FOR SELECT USING (auth.uid() = user_id);

-- Only backend (service key) can insert subscriptions — no client-side inserts

-- ---- samples — public read, no write from client ----
ALTER TABLE samples ENABLE ROW LEVEL SECURITY;

-- Anyone can read samples (public catalog)
CREATE POLICY "samples: public read" ON samples
  FOR SELECT USING (true);

-- No client-side inserts/updates/deletes (service key bypasses RLS)
