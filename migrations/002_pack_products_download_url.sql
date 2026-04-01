-- Migration: Add download_url to pack_products
-- Run this in Supabase Dashboard → SQL Editor

-- 1. Add download_url column (stores custom CDN URL for this pack's zip/file)
ALTER TABLE pack_products
  ADD COLUMN IF NOT EXISTS download_url TEXT;

-- 2. Insert test product (Variant ID 1443844)
--    Change pack_name to match an actual pack in your samples table
INSERT INTO pack_products (pack_name, ls_variant_id, price_usd, bonus_credits, download_url)
VALUES (
  'Test Pack',                                                      -- change to your actual pack name
  '1443844',                                                        -- Lemon Squeezy variant ID
  9.99,                                                             -- price shown to users
  0,                                                                -- bonus credits on purchase
  'https://GPE-Samples-store-PL.b-cdn.net/Test-purchase-file-bunny.jpg'  -- Bunny CDN file URL
)
ON CONFLICT (pack_name) DO UPDATE
  SET ls_variant_id  = EXCLUDED.ls_variant_id,
      price_usd      = EXCLUDED.price_usd,
      bonus_credits  = EXCLUDED.bonus_credits,
      download_url   = EXCLUDED.download_url;

-- 3. Verify
SELECT pack_name, ls_variant_id, price_usd, download_url FROM pack_products;
