-- Add producer and featured columns to pack_products
ALTER TABLE pack_products
  ADD COLUMN IF NOT EXISTS producer TEXT DEFAULT 'GPE',
  ADD COLUMN IF NOT EXISTS featured BOOLEAN DEFAULT false;

-- Ensure created_at exists (Supabase usually adds it, but just in case)
ALTER TABLE pack_products
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();

-- Set GPE as producer for all existing packs
UPDATE pack_products SET producer = 'GPE' WHERE producer IS NULL;

-- Set Minimal Bass Vol.1 as featured spotlight
UPDATE pack_products SET featured = true WHERE pack_name ILIKE '%Minimal Bass%';

-- Insert Wild Kickz as free pack (upsert — won't duplicate if already exists)
INSERT INTO pack_products (pack_name, price_usd, bonus_credits, ls_variant_id, producer, featured)
VALUES ('Wild Kickz', 0, 0, '0', 'GPE', false)
ON CONFLICT (pack_name) DO UPDATE SET price_usd = 0, producer = 'GPE';
