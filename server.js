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

async function fetchAll(buildQuery) {
  let all = [];
  let from = 0;
  const BATCH = 1000;
  while (true) {
    const { data, error } = await buildQuery(from, from + BATCH - 1);
    if (error) return { data: null, error };
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < BATCH) break;
    from += BATCH;
  }
  return { data: all, error: null };
}

// ===== WEBHOOK Lemon Squeezy =====
app.post('/api/webhook/lemonsqueezy', async (req, res) => {
  const secret = process.env.LEMONSQUEEZY_SECRET;
  const signature = req.headers['x-signature'];
  const body = req.body;
  const digest = crypto.createHmac('sha256', secret).update(body).digest('hex');
  if (signature !== digest) return res.status(401).json({ error: 'Invalid signature' });

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
    const { data: user } = await supabase.from('users').select('id, credits').eq('email', userEmail).single();
    if (!user) return res.status(404).json({ error: 'User not found' });
    await supabase.from('users').update({
      credits: user.credits + planInfo.credits,
      plan: planInfo.plan,
      subscription_id: subscriptionId,
      renews_at: renewsAt,
    }).eq('id', user.id);
    console.log(`+${planInfo.credits} credits → ${userEmail}`);
    return res.json({ ok: true, credits_added: planInfo.credits });
  }
  if (eventName === 'subscription_cancelled' || eventName === 'subscription_expired') {
    const { data: user } = await supabase.from('users').select('id').eq('email', userEmail).single();
    if (user) await supabase.from('users').update({ plan: null, subscription_id: null, renews_at: null }).eq('id', user.id);
    return res.json({ ok: true });
  }
  // ===== PACK PURCHASE (one-time order) =====
  if (eventName === 'order_created') {
    const orderAttrs = payload.data?.attributes;
    const orderEmail = orderAttrs?.user_email;
    const orderItems = orderAttrs?.first_order_item || {};
    const orderVariantId = String(orderItems?.variant_id || '');
    const orderId = String(payload.data?.id || '');

    console.log(`Pack order: ${orderId} | ${orderEmail} | variant: ${orderVariantId}`);

    // Find pack product by variant_id
    const { data: packProduct } = await supabase
      .from('pack_products')
      .select('pack_name, bonus_credits')
      .eq('ls_variant_id', orderVariantId)
      .single();

    if (!packProduct) {
      console.log('No pack product found for variant:', orderVariantId);
      return res.json({ ok: true, skipped: true });
    }

    // Find user by email
    const { data: user } = await supabase
      .from('users')
      .select('id, credits')
      .eq('email', orderEmail)
      .single();

    if (!user) {
      console.log('User not found for pack purchase:', orderEmail);
      return res.status(404).json({ error: 'User not found' });
    }

    // Record pack purchase (ignore duplicate)
    await supabase
      .from('user_packs')
      .upsert({
        user_id: user.id,
        pack_name: packProduct.pack_name,
        ls_order_id: orderId,
      }, { onConflict: 'user_id,pack_name' });

    // Add bonus credits
    if (packProduct.bonus_credits > 0) {
      await supabase
        .from('users')
        .update({ credits: user.credits + packProduct.bonus_credits })
        .eq('id', user.id);
    }

    console.log(`Pack "${packProduct.pack_name}" granted to ${orderEmail} + ${packProduct.bonus_credits} bonus credits`);
    return res.json({ ok: true, pack: packProduct.pack_name, bonus_credits: packProduct.bonus_credits });
  }

  res.json({ ok: true, skipped: true });
});

// ===== ENSURE USER =====
app.post('/api/ensure-user', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });
  const { data: existing } = await supabase.from('users').select('id').eq('id', authUser.id).single();
  if (!existing) await supabase.from('users').insert({ id: authUser.id, email: authUser.email, credits: 0, plan: null });
  res.json({ ok: true });
});

// ===== PROFILE =====
app.get('/api/profile', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });
  const { data } = await supabase.from('users').select('credits, plan, renews_at, email').eq('id', authUser.id).single();
  if (!data) return res.status(404).json({ error: 'User not found' });
  res.json(data);
});

// ===== CREDITS =====
app.get('/api/credits', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });
  const { data } = await supabase.from('users').select('credits').eq('id', authUser.id).single();
  if (!data) return res.status(404).json({ error: 'User not found' });
  res.json({ credits: data.credits });
});

// ===== GET SAMPLES — server-side pagination + filtering =====
// GET /api/samples?page=1&limit=50&search=kick&genre=Techno&instrument=Kick&type=Loop&key=Am&bpm_min=120&bpm_max=140&pack=Axion&mood=Dark&artist_style=Argy&sort=random
app.get('/api/samples', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      search,
      genre,
      instrument,
      type,
      key,
      bpm_min,
      bpm_max,
      pack,
      mood,
      artist_style,
      sort = 'random',
      seed,           // random seed for consistent shuffle per session
    } = req.query;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(200, Math.max(1, parseInt(limit)));
    const from = (pageNum - 1) * limitNum;
    const to = from + limitNum - 1;

    let query = supabase
      .from('samples')
      .select('id, title, url, preview_url, cover, bpm, key, genre, instrument, type, pack, mood, artist_style, subgenre, tags, play_count', { count: 'exact' });

    // Text search
    if (search?.trim()) {
      query = query.or(`title.ilike.%${search}%,pack.ilike.%${search}%`);
    }

    // Filters
    if (instrument) query = query.ilike('instrument', `%${instrument}%`);
    if (type)       query = query.eq('type', type);
    if (key)        query = query.ilike('key', `%${key}%`);
    if (pack)       query = query.ilike('pack', `%${pack}%`);
    if (bpm_min)    query = query.gte('bpm', Number(bpm_min));
    if (bpm_max)    query = query.lte('bpm', Number(bpm_max));
    if (genre)      query = query.contains('genre', [genre]);
    if (mood)       query = query.contains('mood', [mood]);
    if (artist_style) {
      const a = String(artist_style).trim();
      query = query.contains('artist_style', [a]);
    }

    // Sorting
    if (sort === 'popular') {
      query = query.order('play_count', { ascending: false });
    } else if (sort === 'bpm_asc') {
      query = query.order('bpm', { ascending: true });
    } else if (sort === 'bpm_desc') {
      query = query.order('bpm', { ascending: false });
    } else if (sort === 'duration_asc') {
      query = query.order('duration', { ascending: true });
    } else if (sort === 'duration_desc') {
      query = query.order('duration', { ascending: false });
    } else {
      // Default: random via id ordering with modulo trick
      // Use seed for consistent pagination
      const s = parseInt(seed) || 1;
      query = query.order('id', { ascending: true });
    }

    query = query.range(from, to);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json({
      samples: data || [],
      total: count || 0,
      page: pageNum,
      limit: limitNum,
      pages: Math.ceil((count || 0) / limitNum),
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== GET TOTAL COUNT (for display) =====
app.get('/api/samples/count', async (req, res) => {
  const { count, error } = await supabase.from('samples').select('id', { count: 'exact', head: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ total: count });
});

// ===== GET FILTER OPTIONS — cached, fetches all for dropdowns =====
app.get('/api/filters', async (req, res) => {
  try {
    const genreParam = req.query.genre || null;
    const { data: allData, error } = await fetchAll((from, to) =>
      supabase.from('samples')
        .select('instrument, genre, type, key, mood, artist_style, subgenre, pack, cover')
        .range(from, to)
    );
    if (error) return res.status(500).json({ error: error.message });
    // Filter by genre if requested
    const data = genreParam ? allData.filter(s => {
      if (Array.isArray(s.genre)) return s.genre.includes(genreParam);
      return s.genre === genreParam;
    }) : allData;

    const unique = (arr, key, isArray = false) => {
      const set = new Set();
      arr.forEach(item => {
        if (isArray && Array.isArray(item[key])) item[key].forEach(v => v && set.add(v));
        else if (item[key]) set.add(item[key]);
      });
      return [...set].sort();
    };

    const countScalar = (rows, key) => {
      const c = {};
      rows.forEach((row) => {
        const v = row[key];
        if (v == null || v === '') return;
        c[v] = (c[v] || 0) + 1;
      });
      return c;
    };

    const countArrayField = (rows, key) => {
      const c = {};
      rows.forEach((row) => {
        const val = row[key];
        if (Array.isArray(val)) {
          val.forEach((v) => {
            if (!v) return;
            c[v] = (c[v] || 0) + 1;
          });
        } else if (val != null && val !== '') {
          c[val] = (c[val] || 0) + 1;
        }
      });
      return c;
    };

    const uniqueArtistStyles = (rows) => {
      const set = new Set();
      rows.forEach((item) => {
        const v = item.artist_style;
        if (Array.isArray(v)) v.forEach((x) => x && set.add(x));
        else if (v) set.add(v);
      });
      return [...set].sort((a, b) => a.localeCompare(b));
    };

    const packMap = {};
    (data || []).forEach((s) => {
      if (!s.pack) return;
      if (!packMap[s.pack]) packMap[s.pack] = { _cc: {} };
      if (s.cover) {
        packMap[s.pack]._cc[s.cover] = (packMap[s.pack]._cc[s.cover] || 0) + 1;
      }
    });
    const pack_covers = {};
    Object.entries(packMap).forEach(([name, p]) => {
      const entries = Object.entries(p._cc);
      if (entries.length) pack_covers[name] = entries.sort((a, b) => b[1] - a[1])[0][0];
    });

    const packCounts = countScalar(data, 'pack');
    const packsByPopularity = Object.entries(packCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);

    const instrument_counts = countScalar(data, 'instrument');
    const artist_style_counts = countArrayField(data, 'artist_style');

    res.json({
      instruments:   unique(data, 'instrument'),
      genres:        unique(data, 'genre', true),
      types:         unique(data, 'type'),
      keys:          unique(data, 'key'),
      moods:         unique(data, 'mood', true),
      artist_styles: uniqueArtistStyles(data),
      subgenres:     unique(data, 'subgenre'),
      packs:         packsByPopularity.length ? packsByPopularity : unique(data, 'pack'),
      pack_covers,
      instrument_counts,
      artist_style_counts,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== DOWNLOAD =====
app.post('/api/download', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });
  const { sampleId } = req.body;
  const { data: user } = await supabase.from('users').select('credits, plan').eq('id', authUser.id).single();
  if (!user) return res.status(400).json({ error: 'User not found' });
  const { data: sample } = await supabase.from('samples').select('id, url').eq('id', sampleId).single();
  if (!sample) return res.status(400).json({ error: 'Sample not found' });
  const { data: existing } = await supabase.from('user_downloads').select('id')
    .eq('user_id', authUser.id).eq('sample_id', sampleId).single();
  if (existing) return res.json({ url: sample.url });
  if (user.credits <= 0) return res.status(400).json({ error: 'No credits' });
  await supabase.from('users').update({ credits: user.credits - 1 }).eq('id', authUser.id);
  await supabase.from('user_downloads').insert({ user_id: authUser.id, sample_id: sampleId });
  res.json({ url: sample.url });
});

// ===== DOWNLOADS HISTORY =====
app.get('/api/downloads', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });
  const { data, error } = await supabase.from('user_downloads')
    .select('sample_id, downloaded_at, samples(title, url, instrument, bpm, key, cover)')
    .eq('user_id', authUser.id).order('downloaded_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ===== BUY CREDITS =====
app.post('/api/buy', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });
  const { amount } = req.body;
  const { data: user } = await supabase.from('users').select('credits').eq('id', authUser.id).single();
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { data } = await supabase.from('users').update({ credits: user.credits + amount })
    .eq('id', authUser.id).select('credits').single();
  res.json({ success: true, credits: data.credits });
});

// ===== LIKES =====
app.get('/api/likes', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });
  const { data, error } = await supabase.from('user_likes')
    .select('sample_id, liked_at, samples(title, url, instrument, bpm, key, cover)')
    .eq('user_id', authUser.id).order('liked_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/likes', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });
  const { sampleId } = req.body;
  const { error } = await supabase.from('user_likes')
    .upsert({ user_id: authUser.id, sample_id: sampleId }, { onConflict: 'user_id,sample_id' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.delete('/api/likes', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });
  const { sampleId } = req.body;
  const { error } = await supabase.from('user_likes')
    .delete().eq('user_id', authUser.id).eq('sample_id', sampleId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ===== RECORD PLAY =====
app.post('/api/plays', async (req, res) => {
  const authUser = await getUserFromToken(req);
  const { sampleId } = req.body;
  if (!sampleId) return res.status(400).json({ error: 'sampleId required' });
  if (authUser) await supabase.from('user_plays').insert({ user_id: authUser.id, sample_id: sampleId });
  await supabase.rpc('increment_play_count', { sample_id: sampleId }).catch(() => {});
  res.json({ ok: true });
});

// ===== PACK PRODUCTS — список паков для продажи =====
app.get('/api/pack-products', async (req, res) => {
  const { data, error } = await supabase
    .from('pack_products')
    .select('pack_name, price_usd, bonus_credits, ls_variant_id');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ===== PACK ACCESS — купил ли пользователь пак =====
app.get('/api/pack-access', async (req, res) => {
  const authUser = await getUserFromToken(req);
  const { pack } = req.query;
  if (!pack) return res.status(400).json({ error: 'pack required' });

  // Not logged in — no access
  if (!authUser) return res.json({ access: false });

  const { data } = await supabase
    .from('user_packs')
    .select('id, purchased_at')
    .eq('user_id', authUser.id)
    .eq('pack_name', pack)
    .single();

  res.json({ access: !!data, purchased_at: data?.purchased_at || null });
});

// ===== USER PACKS — все купленные паки пользователя =====
app.get('/api/user-packs', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  const { data, error } = await supabase
    .from('user_packs')
    .select('pack_name, purchased_at')
    .eq('user_id', authUser.id)
    .order('purchased_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ===== PACKS with covers (for player strip) =====
app.get('/api/packs', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('samples')
      .select('pack, cover, genre, bpm')
      .not('pack', 'is', null);

    if (error) return res.status(500).json({ error: error.message });

    const packMap = {};
    (data || []).forEach(s => {
      if (!s.pack) return;
      if (!packMap[s.pack]) {
        packMap[s.pack] = { name: s.pack, cover: null, genre: null, bpm: null, count: 0, _cc: {} };
      }
      const p = packMap[s.pack];
      p.count++;
      if (s.cover) p._cc[s.cover] = (p._cc[s.cover] || 0) + 1;
      if (!p.genre && s.genre) p.genre = Array.isArray(s.genre) ? s.genre[0] : s.genre;
      if (!p.bpm && s.bpm) p.bpm = s.bpm;
    });

    const packs = Object.values(packMap).map(p => {
      const entries = Object.entries(p._cc);
      if (entries.length) p.cover = entries.sort((a,b) => b[1]-a[1])[0][0];
      delete p._cc;
      return p;
    }).sort((a, b) => b.count - a.count);

    res.json(packs);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== HEALTH CHECK =====
app.get('/', (req, res) => res.json({ status: 'ok', version: '4.0', note: 'server-side pagination' }));

// ===== START =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
