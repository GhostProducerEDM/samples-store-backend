-- Add foreign key from user_likes to samples so Supabase relational queries work
ALTER TABLE user_likes
  ADD CONSTRAINT IF NOT EXISTS user_likes_sample_id_fkey
  FOREIGN KEY (sample_id) REFERENCES samples(id) ON DELETE CASCADE;

-- Add foreign key from user_downloads to samples (same reason)
ALTER TABLE user_downloads
  ADD CONSTRAINT IF NOT EXISTS user_downloads_sample_id_fkey
  FOREIGN KEY (sample_id) REFERENCES samples(id) ON DELETE CASCADE;
