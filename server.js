require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use('/api/webhook/lemonsqueezy', express.raw({ type: 'application/json' }));
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const PLAN_CREDITS = {
  [process.env.LS_VARIANT_STARTER]:   { credits: 100,  plan: 'starter' },
  [process.env.LS_VARIANT_PRO]:       { credits: 350,  plan: 'pro' },
  [process.env.LS_VARIANT_UNLIMITED]: { credits: 1000, plan: 'unlimited' },
};

async function getUserFromToken(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

// ===== WEBHOOK Lemon Squeezy =====
app.post('/api/webhook/lemonsqueezy', async (req, res) => {
  const secret = process.env.LEMONSQUEEZY_SECRET;
  const signature = req.headers['x-signature'];
  const body = req.body;

  const digest = crypto.createHmac('sha256', secret).update(body).digest('hex');
  if (signature !== digest) {
    console.log('Invalid webhook signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const payload = JSON.parse(body.toString());
  const eventName = payload.meta?.event_name;
  const attrs = payload.data?.attributes;
  const variantId = String(attrs?.variant_id || attrs?.first_order_item?.variant_id || '');
  const userEmail = attrs?.user_email;
  const subscriptionId = String(payload.data?.id || '');
  const renewsAt = attrs?.renews_at || attrs?.ends_at || null;

  console.log(`Webhook: ${eventName} | ${userEmail} | variant: ${variantId}`);

  const planInfo = PLAN_CREDITS[variantId];

  if (eventName === 'subscription_created' || eventName === 'subscription_renewed') {
    if (!planInfo) return res.json({ ok: true, skipped: true });

    const { data: user } = await supabase
      .from('users').select('id, credits').eq('email', userEmail).single();

    if (!user) return res.status(404).json({ error: 'User not found' });

    await supabase.from('users').update({
      credits: user.credits + planInfo.credits,
      plan: planInfo.plan,
      subscription_id: subscriptionId,
      renews_at: renewsAt,
    }).eq('id', user.id);

    console.log(`+${planInfo.credits} credits (rollover) → ${userEmail}`);
    return res.json({ ok: true, credits_added: planInfo.credits });
  }

  if (eventName === 'subscription_cancelled' || eventName === 'subscription_expired') {
    const { data: user } = await supabase
      .from('users').select('id').eq('email', userEmail).single();
    if (user) {
      await supabase.from('users').update({
        plan: null, subscription_id: null, renews_at: null,
      }).eq('id', user.id);
    }
    return res.json({ ok: true });
  }

  res.json({ ok: true, skipped: true });
});

// ===== ENSURE USER =====
app.post('/api/ensure-user', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  const { data: existing } = await supabase
    .from('users').select('id').eq('id', authUser.id).single();

  if (!existing) {
    await supabase.from('users').insert({
      id: authUser.id, email: authUser.email, credits: 0, plan: null,
    });
  }
  res.json({ ok: true });
});

// ===== PROFILE =====
app.get('/api/profile', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  const { data } = await supabase
    .from('users').select('credits, plan, renews_at, email').eq('id', authUser.id).single();

  if (!data) return res.status(404).json({ error: 'User not found' });
  res.json(data);
});

// ===== CREDITS =====
app.get('/api/credits', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  const { data } = await supabase
    .from('users').select('credits').eq('id', authUser.id).single();

  if (!data) return res.status(404).json({ error: 'User not found' });
  res.json({ credits: data.credits });
});

// ===== GET SAMPLES — батчами по 1000, без лимита =====
app.get('/api/samples', async (req, res) => {
  try {
    let allData = [];
    let from = 0;
    const BATCH = 1000;

    while (true) {
      let query = supabase
        .from('samples')
        .select('id, title, url, cover, bpm, key, genre, instrument, type, pack, mood, artist_style, subgenre, tags')
        .order('id', { ascending: true })
        .range(from, from + BATCH - 1);

      const { data, error } = await query;
      if (error) return res.status(500).json({ error: error.message });
      if (!data || data.length === 0) break;

      allData = allData.concat(data);
      if (data.length < BATCH) break;
      from += BATCH;
    }

    console.log(`Served ${allData.length} samples`);
    res.json(allData);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== GET FILTER OPTIONS =====
app.get('/api/filters', async (req, res) => {
  // Fetch all for filter building — also in batches
  let allData = [];
  let from = 0;
  const BATCH = 1000;

  while (true) {
    const { data, error } = await supabase
      .from('samples')
      .select('instrument, genre, type, key, mood, artist_style, subgenre, pack')
      .range(from, from + BATCH - 1);

    if (error) return res.status(500).json({ error: error.message });
    if (!data || data.length === 0) break;
    allData = allData.concat(data);
    if (data.length < BATCH) break;
    from += BATCH;
  }

  const unique = (arr, key, isArray = false) => {
    const set = new Set();
    arr.forEach(item => {
      if (isArray && Array.isArray(item[key])) {
        item[key].forEach(v => v && set.add(v));
      } else if (item[key]) {
        set.add(item[key]);
      }
    });
    return [...set].sort();
  };

  res.json({
    instruments:   unique(allData, 'instrument'),
    genres:        unique(allData, 'genre', true),
    types:         unique(allData, 'type'),
    keys:          unique(allData, 'key'),
    moods:         unique(allData, 'mood', true),
    artist_styles: unique(allData, 'artist_style', true),
    subgenres:     unique(allData, 'subgenre'),
    packs:         unique(allData, 'pack'),
  });
});

// ===== DOWNLOAD =====
app.post('/api/download', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  const { sampleId } = req.body;

  const { data: user } = await supabase
    .from('users').select('credits, plan').eq('id', authUser.id).single();
  if (!user) return res.status(400).json({ error: 'User not found' });

  const { data: sample } = await supabase
    .from('samples').select('id, url').eq('id', sampleId).single();
  if (!sample) return res.status(400).json({ error: 'Sample not found' });

  const { data: existing } = await supabase
    .from('user_downloads').select('id')
    .eq('user_id', authUser.id).eq('sample_id', sampleId).single();

  if (existing) return res.json({ url: sample.url });
  if (user.credits <= 0) return res.status(400).json({ error: 'No credits' });

  await supabase.from('users')
    .update({ credits: user.credits - 1 }).eq('id', authUser.id);
  await supabase.from('user_downloads')
    .insert({ user_id: authUser.id, sample_id: sampleId });

  res.json({ url: sample.url });
});

// ===== DOWNLOADS HISTORY =====
app.get('/api/downloads', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  const { data, error } = await supabase
    .from('user_downloads')
    .select('sample_id, downloaded_at, samples(title, url, instrument, bpm, key, cover)')
    .eq('user_id', authUser.id)
    .order('downloaded_at', { ascending: false })
    .limit(100);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ===== BUY CREDITS =====
app.post('/api/buy', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  const { amount } = req.body;
  const { data: user } = await supabase
    .from('users').select('credits').eq('id', authUser.id).single();
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { data } = await supabase
    .from('users').update({ credits: user.credits + amount })
    .eq('id', authUser.id).select('credits').single();

  res.json({ success: true, credits: data.credits });
});

// ===== LIKES =====
app.get('/api/likes', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  const { data, error } = await supabase
    .from('user_likes')
    .select('sample_id, liked_at, samples(title, url, instrument, bpm, key, cover)')
    .eq('user_id', authUser.id)
    .order('liked_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/likes', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  const { sampleId } = req.body;
  const { error } = await supabase
    .from('user_likes')
    .upsert({ user_id: authUser.id, sample_id: sampleId }, { onConflict: 'user_id,sample_id' });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.delete('/api/likes', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  const { sampleId } = req.body;
  const { error } = await supabase
    .from('user_likes')
    .delete()
    .eq('user_id', authUser.id)
    .eq('sample_id', sampleId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ===== HEALTH CHECK =====
app.get('/', (req, res) => res.json({ status: 'ok', version: '2.1', note: 'batch loading enabled' }));

// ===== START =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
