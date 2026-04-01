require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

// ── Bunny CDN signed URL (SHA-256, NOT HMAC — per Bunny docs) ────────────────
function signBunnyUrl(url, expirySeconds = 3600) {
  if (!process.env.BUNNY_TOKEN_KEY || !url) return url;
  try {
    const urlObj = new URL(url);
    const expiry = Math.floor(Date.now() / 1000) + expirySeconds;
    // Bunny expects the DECODED path (no %20 etc.) — matches their Go/PHP SDK behaviour
    const filePath = decodeURIComponent(urlObj.pathname);
    const token = crypto.createHash('sha256')
      .update(process.env.BUNNY_TOKEN_KEY + filePath + expiry)
      .digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    urlObj.searchParams.set('token', token);
    urlObj.searchParams.set('expires', String(expiry));
    return urlObj.toString();
  } catch(e) { return url; }
}

// ── Preview token (changes hourly, valid for current + previous hour) ──────────
const PREVIEW_SECRET = process.env.PREVIEW_SECRET || 'gpe_preview_s3cr3t_2025';
function genPreviewToken(hourOffset = 0) {
  return crypto.createHmac('sha256', PREVIEW_SECRET)
    .update(String(Math.floor(Date.now() / 3600000) + hourOffset))
    .digest('hex').slice(0, 40);
}
function isValidPreviewToken(t) {
  return t && (t === genPreviewToken(0) || t === genPreviewToken(-1));
}
const { createClient } = require('@supabase/supabase-js');
const JSZip = require('jszip');
const nodeFetch = require('node-fetch');

const app = express();

app.use(cors({ origin: '*' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

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
const PLAN_PRICES = { starter: 9.99, pro: 19.99, unlimited: 29.99 };

async function getUserFromToken(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

// Creates a supabase client authenticated as the user (so RLS auth.uid() resolves correctly)
async function userClient(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
  // setSession makes the client's auth interceptor use the user's JWT on every DB call
  await client.auth.setSession({ access_token: token, refresh_token: token });
  return client;
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
    const { data: user } = await supabase.from('users').select('id, credits, subscription_id').eq('email', userEmail).single();
    if (!user) return res.status(404).json({ error: 'User not found' });
    // Cancel previous subscription on upgrade (subscription_created only)
    if (eventName === 'subscription_created' && user.subscription_id && user.subscription_id !== subscriptionId) {
      try {
        await fetch(`https://api.lemonsqueezy.com/v1/subscriptions/${user.subscription_id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${process.env.LEMONSQUEEZY_API_KEY}`, Accept: 'application/vnd.api+json' },
        });
        console.log(`Cancelled old subscription ${user.subscription_id} for ${userEmail}`);
      } catch (e) {
        console.warn(`Failed to cancel old subscription ${user.subscription_id}:`, e.message);
      }
    }
    await supabase.from('users').update({
      credits: user.credits + planInfo.credits,
      plan: planInfo.plan,
      subscription_id: subscriptionId,
      renews_at: renewsAt,
    }).eq('id', user.id);
    // Record subscription payment in history
    await supabase.from('subscriptions').insert({
      user_id: user.id,
      plan: planInfo.plan,
      credits_added: planInfo.credits,
    });
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
      .select('id, title, preview_url, waveform_url, cover, bpm, key, genre, instrument, type, pack, mood, artist_style, subgenre, tags, play_count', { count: 'exact' });

    // Text search — title, pack, instrument (partial) + genre, mood, artist_style (array contains)
    if (search?.trim()) {
      const s = search.trim();
      query = query.or(
        `title.ilike.%${s}%,pack.ilike.%${s}%,instrument.ilike.%${s}%,genre.cs.{${s}},mood.cs.{${s}},artist_style.cs.{${s}}`
      );
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
    if (sort === 'popular' || sort === 'plays_desc') {
      query = query.order('play_count', { ascending: false });
    } else if (sort === 'newest') {
      query = query.order('created_at', { ascending: false });
    } else if (sort === 'bpm_asc') {
      query = query.order('bpm', { ascending: true });
    } else if (sort === 'bpm_desc') {
      query = query.order('bpm', { ascending: false });
    } else {
      // Default: id order (stable)
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

// ===== STREAM — secure redirect to audio file (auth required) =====
app.get('/api/stream/:id', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { data: sample, error } = await supabase
      .from('samples')
      .select('url')
      .eq('id', req.params.id)
      .single();

    if (error || !sample?.url) return res.status(404).json({ error: 'Not found' });

    res.redirect(302, signBunnyUrl(sample.url));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== PREVIEW TOKEN — short-lived token for audio proxy =====
app.get('/api/preview-token', (req, res) => {
  res.json({ token: genPreviewToken(0), expiresIn: 3600 });
});

// ===== PREVIEW PROXY — pipes audio without exposing CDN URL =====
app.get('/api/preview/:id', async (req, res) => {
  if (!isValidPreviewToken(req.query.t)) {
    return res.status(403).end();
  }
  try {
    const { data: sample, error } = await supabase
      .from('samples')
      .select('preview_url')
      .eq('id', req.params.id)
      .single();

    if (error || !sample?.preview_url) return res.status(404).end();

    const upHeaders = { 'User-Agent': 'Mozilla/5.0' };
    if (req.headers['range']) upHeaders['Range'] = req.headers['range'];

    const upstream = await nodeFetch(signBunnyUrl(sample.preview_url, 300), { headers: upHeaders });

    res.status(upstream.status);
    for (const h of ['content-type','content-length','content-range','accept-ranges']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader('Cache-Control', 'private, max-age=300');
    upstream.body.pipe(res).on('error', () => res.end());
  } catch(e) {
    res.status(500).end();
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
  const { data: user } = await supabase.from('users').select('credits, plan, renews_at').eq('id', authUser.id).single();
  if (!user) return res.status(400).json({ error: 'User not found' });
  // Subscription must be active to spend credits
  const hasActivePlan = user.plan && (!user.renews_at || new Date(user.renews_at) > new Date());
  if (!hasActivePlan) return res.status(403).json({ error: 'Active subscription required to download' });
  const { data: sample } = await supabase.from('samples').select('id, url').eq('id', sampleId).single();
  if (!sample) return res.status(400).json({ error: 'Sample not found' });
  const { data: existing } = await supabase.from('user_downloads').select('id')
    .eq('user_id', authUser.id).eq('sample_id', sampleId).single();
  if (existing) return res.json({ url: signBunnyUrl(sample.url) });
  if (user.credits <= 0) return res.status(400).json({ error: 'No credits' });
  await supabase.from('users').update({ credits: user.credits - 1 }).eq('id', authUser.id);
  await supabase.from('user_downloads').insert({ user_id: authUser.id, sample_id: sampleId });
  res.json({ url: signBunnyUrl(sample.url) });
});

// ===== DOWNLOADS HISTORY =====
app.get('/api/downloads', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });
  const { data, error } = await supabase.from('user_downloads')
    .select('sample_id, downloaded_at, samples(title, preview_url, waveform_url, instrument, bpm, key, cover, pack)')
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
    .select('sample_id, liked_at, samples(title, preview_url, waveform_url, instrument, bpm, key, cover, pack)')
    .eq('user_id', authUser.id).order('liked_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/likes', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });
  const sampleId = req.body.sampleId ?? req.body.sample_id;
  if (!sampleId) return res.status(400).json({ error: 'sampleId required' });
  const { error } = await supabase.from('user_likes')
    .upsert({ user_id: authUser.id, sample_id: sampleId }, { onConflict: 'user_id,sample_id' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.delete('/api/likes', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });
  const sampleId = req.body.sampleId ?? req.body.sample_id;
  if (!sampleId) return res.status(400).json({ error: 'sampleId required' });
  const { error } = await supabase.from('user_likes')
    .delete().eq('user_id', authUser.id).eq('sample_id', sampleId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ===== PACK LIKES =====
app.get('/api/pack-likes', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });
  const uc = await userClient(req);
  const { data, error } = await uc.from('user_pack_likes')
    .select('pack_name, liked_at')
    .order('liked_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/pack-likes', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });
  const { packName } = req.body;
  if (!packName) return res.status(400).json({ error: 'packName required' });
  const uc = await userClient(req);
  const { error } = await uc.from('user_pack_likes')
    .upsert({ user_id: authUser.id, pack_name: packName }, { onConflict: 'user_id,pack_name' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.delete('/api/pack-likes', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });
  const { packName } = req.body;
  const uc = await userClient(req);
  const { error } = await uc.from('user_pack_likes')
    .delete().eq('pack_name', packName);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ===== RECORD PLAY =====
app.post('/api/plays', async (req, res) => {
  const authUser = await getUserFromToken(req);
  const { sampleId, referrer, page, sessionId } = req.body;
  if (!sampleId) return res.status(400).json({ error: 'sampleId required' });

  const ip = (req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0] || req.ip || '').trim() || null;
  const country = req.headers['cf-ipcountry'] || null;
  const userAgent = (req.headers['user-agent'] || '').slice(0, 512) || null;

  await supabase.from('user_plays').insert({
    user_id: authUser?.id || null,
    sample_id: sampleId,
    session_id: sessionId || null,
    referrer: referrer ? referrer.slice(0, 512) : null,
    page: page || null,
    ip,
    country,
    user_agent: userAgent,
  });
  try { await supabase.rpc('increment_play_count', { sample_id: sampleId }); } catch(e) {}
  res.json({ ok: true });
});

// ===== PACK STATS — plays + downloads per pack =====
app.get('/api/pack-stats', async (req, res) => {
  try {
    const [samplesRes, downloadsRes] = await Promise.all([
      supabase.from('samples').select('pack, play_count').not('pack', 'is', null),
      supabase.from('user_downloads').select('samples(pack)'),
    ]);
    const plays = {}, downloads = {};
    (samplesRes.data || []).forEach(s => {
      if (!s.pack) return;
      plays[s.pack] = (plays[s.pack] || 0) + (s.play_count || 0);
    });
    (downloadsRes.data || []).forEach(d => {
      const pack = d.samples?.pack;
      if (pack) downloads[pack] = (downloads[pack] || 0) + 1;
    });
    const packs = new Set([...Object.keys(plays), ...Object.keys(downloads)]);
    const result = {};
    packs.forEach(p => { result[p] = { plays: plays[p] || 0, downloads: downloads[p] || 0 }; });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== PACK COVERS — most-common cover URL per pack =====
app.get('/api/pack-covers', async (req, res) => {
  const { data, error } = await supabase
    .from('samples')
    .select('pack, cover')
    .not('pack', 'is', null)
    .not('cover', 'is', null);
  if (error) return res.status(500).json({ error: error.message });
  const cc = {};
  (data || []).forEach(({ pack, cover }) => {
    if (!cc[pack]) cc[pack] = {};
    cc[pack][cover] = (cc[pack][cover] || 0) + 1;
  });
  const result = {};
  Object.entries(cc).forEach(([pack, counts]) => {
    result[pack] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  });
  res.json(result);
});

// ===== RECENT PLAYS — last 20 plays for a user =====
app.get('/api/recent-plays', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });
  const { data, error } = await supabase
    .from('user_plays')
    .select('id, sample_id, page, played_at, samples(id, title, preview_url, waveform_url, cover, bpm, key, instrument, type, pack)')
    .eq('user_id', authUser.id)
    .order('played_at', { ascending: false })
    .limit(20);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ===== PACK PREVIEW — first sample preview_url for a pack (for demo playback) =====
app.get('/api/pack-preview', async (req, res) => {
  const { pack } = req.query;
  if (!pack) return res.status(400).json({ error: 'pack required' });
  const { data, error } = await supabase
    .from('samples')
    .select('id, title, preview_url')
    .eq('pack', pack)
    .not('preview_url', 'is', null)
    .limit(1)
    .single();
  if (error || !data) return res.status(404).json({ error: 'No preview available' });
  res.json(data);
});

// ===== WAVEFORM PROXY (CORS workaround for Bunny CDN) =====
app.get('/api/waveform-proxy', async (req, res) => {
  const url = req.query.url;
  if (!url || !url.startsWith('https://gpe-samples-store-pl.b-cdn.net/')) {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  try {
    const r = await fetch(signBunnyUrl(url, 300));
    if (!r.ok) return res.status(r.status).json({ error: 'CDN error' });
    const data = await r.json();
    res.set('Cache-Control', 'public, max-age=86400');
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== FEATURED SAMPLES — guest first page =====
app.get('/api/featured-samples', async (req, res) => {
  const { data, error } = await supabase
    .from('featured_samples')
    .select('samples(id, title, preview_url, waveform_url, cover, bpm, key, genre, instrument, type, pack, mood, artist_style, subgenre, tags, play_count)')
    .order('position', { ascending: true })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  const samples = (data || []).map(r => r.samples).filter(Boolean);
  res.json({ samples, total: samples.length });
});

// ===== PACK PRODUCTS — список паков для продажи =====
app.get('/api/pack-products', async (req, res) => {
  const { data, error } = await supabase
    .from('pack_products')
    .select('pack_name, price_usd, bonus_credits, ls_variant_id, download_url, producer, featured, created_at, cover_url')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// POST /api/admin/pack-products — upsert a pack product entry (admin only)
app.post('/api/admin/pack-products', requireAdmin, async (req, res) => {
  try {
    const { pack_name, ls_variant_id, price_usd, bonus_credits, download_url, producer, featured } = req.body;
    if (!pack_name) return res.status(400).json({ error: 'pack_name required' });
    const { error } = await supabase.from('pack_products').upsert({
      pack_name,
      ls_variant_id: ls_variant_id ? String(ls_variant_id) : '0',
      price_usd: price_usd ?? null,
      bonus_credits: bonus_credits || 0,
      download_url: download_url || null,
      producer: producer || 'GPE',
      featured: featured ?? false,
    }, { onConflict: 'pack_name' });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
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

// ===== PACK ZIP DOWNLOAD — Bunny.net =====
app.get('/api/pack-download', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  const { pack } = req.query;
  if (!pack) return res.status(400).json({ error: 'pack required' });

  // Check user has purchased this pack
  const { data: access } = await supabase
    .from('user_packs')
    .select('id')
    .eq('user_id', authUser.id)
    .eq('pack_name', pack)
    .single();

  if (!access) return res.status(403).json({ error: 'No access to this pack' });

  // Use custom download_url from pack_products if set, otherwise build CDN path
  const { data: product } = await supabase
    .from('pack_products')
    .select('download_url')
    .eq('pack_name', pack)
    .single();

  const cdnBase = process.env.BUNNY_CDN_URL || 'https://gpe-samples-store-pl.b-cdn.net';
  const url = product?.download_url || `${cdnBase}/Packs/${encodeURIComponent(pack)}.zip`;

  res.json({ url });
});

// ===== PAYMENT HISTORY =====
app.get('/api/payment-history', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  const [{ data: packs }, { data: subs }, { data: products }] = await Promise.all([
    supabase.from('user_packs').select('pack_name, purchased_at, ls_order_id')
      .eq('user_id', authUser.id).order('purchased_at', { ascending: false }),
    supabase.from('subscriptions').select('plan, credits_added, created_at')
      .eq('user_id', authUser.id).order('created_at', { ascending: false }),
    supabase.from('pack_products').select('pack_name, price_usd'),
  ]);

  const priceMap = {};
  (products || []).forEach(p => { priceMap[p.pack_name] = p.price_usd; });

  const packItems = (packs || []).map(p => ({
    type: 'pack',
    description: p.pack_name,
    date: p.purchased_at,
    amount: priceMap[p.pack_name] ?? null,
  }));

  const subItems = (subs || []).map(s => ({
    type: 'subscription',
    description: `${s.plan.charAt(0).toUpperCase() + s.plan.slice(1)} plan — ${s.credits_added} credits`,
    date: s.created_at,
    amount: PLAN_PRICES[s.plan?.toLowerCase()] ?? null,
  }));

  const result = [...packItems, ...subItems]
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  res.json(result);
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

// ===== PACKS with covers, genres, play_count =====
app.get('/api/packs', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('samples')
      .select('pack, cover, genre, bpm, play_count')
      .not('pack', 'is', null);

    if (error) return res.status(500).json({ error: error.message });

    const packMap = {};
    (data || []).forEach(s => {
      if (!s.pack) return;
      if (!packMap[s.pack]) {
        packMap[s.pack] = { name: s.pack, cover: null, genres: [], bpm: null, count: 0, play_count: 0, _cc: {}, _gc: {} };
      }
      const p = packMap[s.pack];
      p.count++;
      p.play_count += (s.play_count || 0);
      if (s.cover) p._cc[s.cover] = (p._cc[s.cover] || 0) + 1;
      const genres = Array.isArray(s.genre) ? s.genre : (s.genre ? [s.genre] : []);
      genres.forEach(g => { if (g) p._gc[g] = (p._gc[g] || 0) + 1; });
      if (!p.bpm && s.bpm) p.bpm = s.bpm;
    });

    const packs = Object.values(packMap).map(p => {
      const entries = Object.entries(p._cc);
      if (entries.length) p.cover = entries.sort((a,b) => b[1]-a[1])[0][0];
      p.genres = Object.entries(p._gc).sort((a,b) => b[1]-a[1]).map(e => e[0]).slice(0, 5);
      delete p._cc; delete p._gc;
      return p;
    }).sort((a, b) => b.count - a.count);

    res.set('Cache-Control', 'public, max-age=300');
    res.json(packs);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== HEALTH CHECK =====
app.get('/', (req, res) => res.json({ status: 'ok', version: '4.0', note: 'server-side pagination' }));

// ═══════════════════════════════════════════
// ADMIN API — protected by X-Admin-Key header
// ═══════════════════════════════════════════
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin_gpe_2024';

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden — invalid admin key' });
  }
  next();
}

// GET /api/admin/stats — dashboard numbers
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const [samplesR, usersR, downloadsR, purchasesR, likesR, subsR] = await Promise.all([
      supabase.from('samples').select('id', { count: 'exact', head: true }),
      supabase.from('users').select('id', { count: 'exact', head: true }),
      supabase.from('user_downloads').select('id', { count: 'exact', head: true }),
      supabase.from('user_packs').select('id', { count: 'exact', head: true }),
      supabase.from('user_likes').select('id', { count: 'exact', head: true }),
      supabase.from('subscriptions').select('plan, credits_added'),
    ]);
    // Compute revenue from subscriptions
    const PRICES = { starter: 9.99, pro: 19.99, unlimited: 29.99 };
    let revenue = 0;
    (subsR.data || []).forEach(s => { revenue += PRICES[s.plan?.toLowerCase()] || 0; });
    res.json({
      total_samples: samplesR.count || 0,
      total_users: usersR.count || 0,
      total_downloads: downloadsR.count || 0,
      total_purchases: purchasesR.count || 0,
      total_likes: likesR.count || 0,
      total_revenue: revenue,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/users?page=1&limit=30&search=
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 30, search } = req.query;
    const lim = Math.min(100, Math.max(1, parseInt(limit)));
    const from = (Math.max(1, parseInt(page)) - 1) * lim;
    const to = from + lim - 1;
    let q = supabase.from('users')
      .select('id, email, credits, plan, renews_at, created_at', { count: 'exact' });
    if (search) q = q.ilike('email', `%${search}%`);
    q = q.order('created_at', { ascending: false }).range(from, to);
    const { data, count, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ users: data || [], total: count || 0, page: parseInt(page), pages: Math.ceil((count || 0) / lim) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/users/:id/credits — adjust user credits (amount can be negative)
app.post('/api/admin/users/:id/credits', requireAdmin, async (req, res) => {
  try {
    const { amount } = req.body;
    if (typeof amount !== 'number') return res.status(400).json({ error: 'amount must be number' });
    const { data: user } = await supabase.from('users').select('credits').eq('id', req.params.id).single();
    if (!user) return res.status(404).json({ error: 'User not found' });
    const newCredits = Math.max(0, user.credits + amount);
    const { error } = await supabase.from('users').update({ credits: newCredits }).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, new_credits: newCredits });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/admin/users/:id/plan — change user plan
app.put('/api/admin/users/:id/plan', requireAdmin, async (req, res) => {
  try {
    const { plan } = req.body;
    const { error } = await supabase.from('users').update({ plan: plan || null }).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/samples — admin view with url field + more details
app.get('/api/admin/samples', requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 30, search, instrument, genre, pack, sort } = req.query;
    const lim = Math.min(100, Math.max(1, parseInt(limit)));
    const from = (Math.max(1, parseInt(page)) - 1) * lim;
    const to = from + lim - 1;
    let q = supabase.from('samples')
      .select('id, title, pack, instrument, bpm, key, genre, type, mood, artist_style, preview_url, url, play_count, cover', { count: 'exact' });
    if (search) q = q.or(`title.ilike.%${search}%,pack.ilike.%${search}%`);
    if (instrument) q = q.ilike('instrument', `%${instrument}%`);
    if (pack) q = q.ilike('pack', `%${pack}%`);
    if (genre) q = q.contains('genre', [genre]);
    if (sort === 'bpm_asc') q = q.order('bpm', { ascending: true });
    else if (sort === 'bpm_desc') q = q.order('bpm', { ascending: false });
    else if (sort === 'plays') q = q.order('play_count', { ascending: false });
    else q = q.order('id', { ascending: true });
    q = q.range(from, to);
    const { data, count, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ samples: data || [], total: count || 0, pages: Math.ceil((count || 0) / lim) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/admin/samples/:id — inline edit
app.put('/api/admin/samples/:id', requireAdmin, async (req, res) => {
  try {
    const allowed = ['title', 'pack', 'instrument', 'bpm', 'key', 'type', 'preview_url', 'url', 'cover'];
    const update = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    if (!Object.keys(update).length) return res.status(400).json({ error: 'Nothing to update' });
    const { error } = await supabase.from('samples').update(update).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/admin/samples/:id
app.delete('/api/admin/samples/:id', requireAdmin, async (req, res) => {
  try {
    // Remove related records first
    await supabase.from('user_downloads').delete().eq('sample_id', req.params.id);
    await supabase.from('user_likes').delete().eq('sample_id', req.params.id);
    await supabase.from('user_plays').delete().eq('sample_id', req.params.id);
    const { error } = await supabase.from('samples').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/downloads?page=1&limit=30
app.get('/api/admin/downloads', requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 30 } = req.query;
    const lim = Math.min(100, Math.max(1, parseInt(limit)));
    const from = (Math.max(1, parseInt(page)) - 1) * lim;
    const to = from + lim - 1;
    const { data, count, error } = await supabase.from('user_downloads')
      .select('id, user_id, sample_id, downloaded_at, users(email), samples(title, pack, instrument)', { count: 'exact' })
      .order('downloaded_at', { ascending: false })
      .range(from, to);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ downloads: data || [], total: count || 0, pages: Math.ceil((count || 0) / lim) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/purchases?page=1&limit=30
app.get('/api/admin/purchases', requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 30 } = req.query;
    const lim = Math.min(100, Math.max(1, parseInt(limit)));
    const from = (Math.max(1, parseInt(page)) - 1) * lim;
    const to = from + lim - 1;
    const { data: packs, count: packCount, error: packErr } = await supabase.from('user_packs')
      .select('user_id, pack_name, purchased_at, ls_order_id, users(email)', { count: 'exact' })
      .order('purchased_at', { ascending: false })
      .range(from, to);
    if (packErr) return res.status(500).json({ error: packErr.message });

    const { data: products } = await supabase.from('pack_products').select('pack_name, price_usd');
    const priceMap = {};
    (products || []).forEach(p => { priceMap[p.pack_name] = p.price_usd; });

    const items = (packs || []).map(p => ({
      ...p,
      price_usd: priceMap[p.pack_name] || null,
    }));
    res.json({ purchases: items, total: packCount || 0, pages: Math.ceil((packCount || 0) / lim) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/subscriptions
app.get('/api/admin/subscriptions', requireAdmin, async (req, res) => {
  try {
    const { data, count, error } = await supabase.from('subscriptions')
      .select('user_id, plan, credits_added, created_at, users(email)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) return res.status(500).json({ error: error.message });
    const PRICES = { starter: 9.99, pro: 19.99, unlimited: 29.99 };
    const items = (data || []).map(s => ({ ...s, price_usd: PRICES[s.plan?.toLowerCase()] || null }));
    res.json({ subscriptions: items, total: count || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/tools/audit-previews
app.post('/api/admin/tools/audit-previews', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await fetchAll((from, to) =>
      supabase.from('samples').select('id, title, preview_url').range(from, to)
    );
    if (error) return res.status(500).json({ error: error.message });
    const missing = (data || []).filter(s => !s.preview_url);
    res.json({
      total: data.length,
      ok: data.length - missing.length,
      missing_count: missing.length,
      missing: missing.slice(0, 50).map(s => ({ id: s.id, title: s.title })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/tools/metadata-check
app.post('/api/admin/tools/metadata-check', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await fetchAll((from, to) =>
      supabase.from('samples').select('id, title, bpm, key, instrument, genre').range(from, to)
    );
    if (error) return res.status(500).json({ error: error.message });
    const noBpm = (data || []).filter(s => !s.bpm).length;
    const noKey = (data || []).filter(s => !s.key).length;
    const noInst = (data || []).filter(s => !s.instrument).length;
    const noGenre = (data || []).filter(s => !s.genre || (Array.isArray(s.genre) && !s.genre.length)).length;
    res.json({ total: data.length, no_bpm: noBpm, no_key: noKey, no_instrument: noInst, no_genre: noGenre });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/tools/find-duplicates
app.post('/api/admin/tools/find-duplicates', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await fetchAll((from, to) =>
      supabase.from('samples').select('id, title').range(from, to)
    );
    if (error) return res.status(500).json({ error: error.message });
    const counts = {};
    (data || []).forEach(s => { counts[s.title] = (counts[s.title] || 0) + 1; });
    const dupes = Object.entries(counts)
      .filter(([, n]) => n > 1)
      .sort((a, b) => b[1] - a[1])
      .map(([title, count]) => ({ title, count }));
    res.json({ total: data.length, duplicate_groups: dupes.length, items: dupes.slice(0, 50) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/tools/fix-covers — normalize cover URLs per pack
app.post('/api/admin/tools/fix-covers', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await fetchAll((from, to) =>
      supabase.from('samples').select('id, pack, cover').range(from, to)
    );
    if (error) return res.status(500).json({ error: error.message });
    // Find most common cover per pack
    const packCovers = {};
    (data || []).forEach(s => {
      if (!s.pack || !s.cover) return;
      if (!packCovers[s.pack]) packCovers[s.pack] = {};
      packCovers[s.pack][s.cover] = (packCovers[s.pack][s.cover] || 0) + 1;
    });
    const canonical = {};
    Object.entries(packCovers).forEach(([pack, covers]) => {
      canonical[pack] = Object.entries(covers).sort((a, b) => b[1] - a[1])[0][0];
    });
    // Count how many need fixing
    const needsFix = (data || []).filter(s => s.pack && canonical[s.pack] && s.cover !== canonical[s.pack]);
    res.json({
      packs_analyzed: Object.keys(canonical).length,
      samples_needing_fix: needsFix.length,
      note: 'Run with apply=true to apply fixes',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== RECOMMENDATIONS — based on user's downloaded genres/instruments =====
app.get('/api/recommendations', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  const { data: downloads } = await supabase
    .from('user_downloads')
    .select('sample_id, samples(genre, instrument)')
    .eq('user_id', authUser.id)
    .order('downloaded_at', { ascending: false })
    .limit(50);

  if (!downloads?.length) return res.json([]);

  const downloadedIds = downloads.map(d => d.sample_id);

  const genreCount = {};
  const instrCount = {};
  downloads.forEach(d => {
    const s = d.samples;
    if (!s) return;
    if (Array.isArray(s.genre)) s.genre.forEach(g => { genreCount[g] = (genreCount[g] || 0) + 1; });
    if (s.instrument) instrCount[s.instrument] = (instrCount[s.instrument] || 0) + 1;
  });

  const topGenres = Object.entries(genreCount).sort((a,b) => b[1]-a[1]).slice(0,3).map(([g]) => g);
  const topInstr  = Object.entries(instrCount).sort((a,b)  => b[1]-a[1]).slice(0,2).map(([i]) => i);

  if (!topGenres.length && !topInstr.length) return res.json([]);

  const orParts = [
    ...topGenres.map(g => `genre.cs.{${g}}`),
    ...topInstr.map(i => `instrument.ilike.%${i}%`),
  ].join(',');

  const { data, error } = await supabase
    .from('samples')
    .select('id, title, preview_url, waveform_url, cover, bpm, key, genre, instrument, type, pack')
    .or(orParts)
    .not('id', 'in', `(${downloadedIds.join(',')})`)
    .order('play_count', { ascending: false })
    .limit(20);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ===== DOWNLOAD LIBRARY AS ZIP =====
app.get('/api/download-library-zip', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  // Get all downloaded samples for this user (title + url)
  const { data: downloads, error } = await supabase
    .from('user_downloads')
    .select('sample_id, samples(title, url)')
    .eq('user_id', authUser.id)
    .order('downloaded_at', { ascending: false });

  if (error) return res.status(500).json({ error: 'Could not fetch library' });
  if (!downloads || downloads.length === 0) {
    return res.status(400).json({ error: 'Library is empty' });
  }

  const zip = new JSZip();
  const CONCURRENCY = 5;

  // Fetch all files and add to zip
  const queue = [...downloads];
  const usedNames = new Set();

  async function processItem(item) {
    const sample = item.samples;
    if (!sample?.url) return;
    try {
      const fileRes = await nodeFetch(sample.url, { timeout: 30000 });
      if (!fileRes.ok) return;
      const buffer = await fileRes.buffer();
      // Sanitize filename, ensure unique
      let name = (sample.title || `sample_${item.sample_id}`)
        .replace(/[^\w\s\-().]/g, '')
        .trim()
        .substring(0, 80) + '.wav';
      let unique = name;
      let n = 1;
      while (usedNames.has(unique)) unique = name.replace('.wav', `_${n++}.wav`);
      usedNames.add(unique);
      zip.file(unique, buffer);
    } catch(e) {
      console.warn('ZIP: failed to fetch', sample?.url, e.message);
    }
  }

  // Process in batches of CONCURRENCY
  for (let i = 0; i < queue.length; i += CONCURRENCY) {
    await Promise.all(queue.slice(i, i + CONCURRENCY).map(processItem));
  }

  if (Object.keys(zip.files).length === 0) {
    return res.status(500).json({ error: 'All files failed to download' });
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="my-library.zip"');

  zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true })
    .pipe(res)
    .on('error', err => { console.error('ZIP stream error:', err); res.end(); });
});

// ===== START =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
