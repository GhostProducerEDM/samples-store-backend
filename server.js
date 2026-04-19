require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

// ── Simple in-memory cache ───────────────────────────────────────────────────
const _cache = {};
function cacheGet(key) {
  const e = _cache[key];
  if (!e) return null;
  if (Date.now() > e.expiresAt) { delete _cache[key]; return null; }
  return e.value;
}
function cacheSet(key, value, ttlMs) {
  _cache[key] = { value, expiresAt: Date.now() + ttlMs };
}

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

// ── Preview token — привязан к IP + час, нельзя использовать с другого адреса ──
const PREVIEW_SECRET = process.env.PREVIEW_SECRET || 'gpe_preview_s3cr3t_2025';
function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
}
function genPreviewToken(ip, hourOffset = 0) {
  return crypto.createHmac('sha256', PREVIEW_SECRET)
    .update(String(Math.floor(Date.now() / 3600000) + hourOffset) + ip)
    .digest('hex').slice(0, 40);
}
function isValidPreviewToken(t, ip) {
  return t && (t === genPreviewToken(ip, 0) || t === genPreviewToken(ip, -1));
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

// One-time credit pack variants → credits to add
const CREDIT_PACK_VARIANTS = {
  [process.env.LS_VARIANT_CREDITS_50]:  50,
  [process.env.LS_VARIANT_CREDITS_100]: 100,
  [process.env.LS_VARIANT_CREDITS_200]: 200,
};
const CREDIT_PACK_PRICES = { 50: 4.99, 100: 8.99, 200: 15.99 };

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

// ── Subscription access helpers ───────────────────────────────────────────────
// canUserDownload: can the user spend a credit to download?
// → YES for active/cancelled-in-period (Pro credits)
// → YES for cancelled-past-period and expired (credit-only, no Pro gate)
// → NO only if credits are 0
function canUserDownload(user) {
  const credits = user.credits ?? 0;
  if (credits <= 0) return false;
  return true; // if they have credits, they can always download
}

// hasProAccess: does user get Pro features (monthly credit refresh, collections, etc.)?
// → active: yes
// → cancelled within billing period: yes (paid for it)
// → cancelled past billing period / expired: no
function hasProAccess(user) {
  const status = user.subscription_status;
  const periodEnd = user.current_period_end ? new Date(user.current_period_end) : null;
  const now = new Date();
  if (status === 'active') return true;
  if (status === 'cancelled') return periodEnd ? periodEnd > now : false;
  if (status === 'expired') return false;
  // legacy fallback (no subscription_status column yet)
  return !!(user.plan && (!user.renews_at || new Date(user.renews_at) > now));
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
  const customUserId = payload.meta?.custom_data?.user_id || null;
  const subscriptionId = String(payload.data?.id || '');
  const renewsAt = attrs?.renews_at || attrs?.ends_at || null;

  console.log(`Webhook: ${eventName} | ${userEmail} | variant: ${variantId} | sub_id: ${subscriptionId} | custom_user_id: ${customUserId}`);
  console.log(`Webhook env variants — starter:${process.env.LS_VARIANT_STARTER} pro:${process.env.LS_VARIANT_PRO} unlimited:${process.env.LS_VARIANT_UNLIMITED}`);

  // Helper: find user by custom_data.user_id first, fall back to email
  async function findUser(selectFields = 'id, credits') {
    if (customUserId) {
      const { data } = await supabase.from('users').select(selectFields).eq('id', customUserId).single();
      if (data) return data;
    }
    const { data } = await supabase.from('users').select(selectFields).eq('email', userEmail).single();
    return data || null;
  }

  const planInfo = PLAN_CREDITS[variantId];

  // subscription_payment_success fires on every successful renewal billing cycle
  if (eventName === 'subscription_payment_success') {
    if (!planInfo) {
      console.warn(`⚠️  subscription_payment_success: variant ${variantId} not mapped. Skipping.`);
      return res.json({ ok: true, skipped: true });
    }
    const user = await findUser('id, credits');
    if (!user) return res.status(404).json({ error: 'User not found' });
    await supabase.from('users').update({
      credits: user.credits + planInfo.credits,
      plan: planInfo.plan,
      subscription_status: 'active',
      subscription_id: subscriptionId,
      renews_at: renewsAt,
      current_period_end: renewsAt,
    }).eq('id', user.id);
    await supabase.from('subscriptions').insert({
      user_id: user.id,
      plan: planInfo.plan,
      credits_added: planInfo.credits,
    });
    console.log(`+${planInfo.credits} credits (renewal) → ${userEmail}`);
    return res.json({ ok: true, credits_added: planInfo.credits });
  }

  if (eventName === 'subscription_created' || eventName === 'subscription_renewed') {
    if (!planInfo) {
      console.warn(`⚠️  No plan found for variant ${variantId} — check LS_VARIANT_* env vars. Skipping credits.`);
      return res.json({ ok: true, skipped: true, reason: `variant ${variantId} not mapped` });
    }
    const user = await findUser('id, credits, subscription_id');
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
      subscription_status: 'active',
      subscription_id: subscriptionId,
      renews_at: renewsAt,
      current_period_end: renewsAt,
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
  if (eventName === 'subscription_cancelled') {
    const user = await findUser('id, subscription_id, current_period_end');
    if (user && user.subscription_id === subscriptionId) {
      // Keep plan + period_end intact — user retains access until period ends.
      // subscription_expired will fire when access truly ends.
      const updateData = { subscription_status: 'cancelled' };
      // Update current_period_end from webhook if provided (more reliable than our DB value)
      if (renewsAt) updateData.current_period_end = renewsAt;
      await supabase.from('users').update(updateData).eq('id', user.id);
      console.log(`Sub ${subscriptionId} marked cancelled for ${userEmail} — access until ${renewsAt || user.current_period_end}`);
    } else if (user) {
      console.log(`Ignoring subscription_cancelled for old sub ${subscriptionId} — active: ${user.subscription_id}`);
    }
    return res.json({ ok: true });
  }

  if (eventName === 'subscription_expired') {
    const user = await findUser('id, subscription_id');
    if (user && user.subscription_id === subscriptionId) {
      // Period ended — remove Pro privileges but KEEP subscription_id (needed for resume)
      await supabase.from('users').update({
        plan: null,
        subscription_status: 'expired',
        renews_at: null,
        current_period_end: null,
      }).eq('id', user.id);
      console.log(`Sub ${subscriptionId} expired for ${userEmail} — plan cleared, sub_id kept for resume`);
    } else if (user) {
      console.log(`Ignoring subscription_expired for old sub ${subscriptionId} — active: ${user.subscription_id}`);
    }
    return res.json({ ok: true });
  }
  // ===== ONE-TIME ORDER (credit packs + pack purchases) =====
  if (eventName === 'order_created') {
    const orderAttrs = payload.data?.attributes;
    const orderEmail = orderAttrs?.user_email;
    const orderItems = orderAttrs?.first_order_item || {};
    const orderVariantId = String(orderItems?.variant_id || '');
    const orderId = String(payload.data?.id || '');

    console.log(`Order: ${orderId} | ${orderEmail} | variant: ${orderVariantId}`);

    // ── Credit pack purchase ──
    const creditAmount = CREDIT_PACK_VARIANTS[orderVariantId];
    if (creditAmount) {
      const user = await findUser('id, credits');
      if (!user) {
        console.log('User not found for credit pack purchase:', orderEmail, '| custom_user_id:', customUserId);
        return res.status(404).json({ error: 'User not found' });
      }
      await supabase.from('users').update({ credits: user.credits + creditAmount }).eq('id', user.id);
      const { error: txErr } = await supabase.from('credit_transactions').insert({
        user_id: user.id,
        credits_added: creditAmount,
        source: 'purchase',
        ls_order_id: orderId,
      });
      if (txErr) console.error('credit_transactions insert error:', txErr.message, txErr.details);
      console.log(`+${creditAmount} credits (purchase) → ${orderEmail} (user: ${user.id})`);
      return res.json({ ok: true, credits_added: creditAmount });
    }

    // ── Pack purchase ──
    const { data: packProduct } = await supabase
      .from('pack_products')
      .select('pack_name, bonus_credits')
      .eq('ls_variant_id', orderVariantId)
      .single();

    if (!packProduct) {
      console.log('No product found for variant:', orderVariantId);
      return res.json({ ok: true, skipped: true });
    }

    const user = await findUser('id, credits');
    if (!user) {
      console.log('User not found for pack purchase:', orderEmail, '| custom_user_id:', customUserId);
      return res.status(404).json({ error: 'User not found' });
    }

    await supabase.from('user_packs').upsert({
      user_id: user.id,
      pack_name: packProduct.pack_name,
      ls_order_id: orderId,
    }, { onConflict: 'user_id,pack_name' });

    if (packProduct.bonus_credits > 0) {
      await supabase.from('users').update({ credits: user.credits + packProduct.bonus_credits }).eq('id', user.id);
    }

    console.log(`Pack "${packProduct.pack_name}" granted to ${orderEmail} + ${packProduct.bonus_credits} bonus credits`);
    return res.json({ ok: true, pack: packProduct.pack_name, bonus_credits: packProduct.bonus_credits });
  }

  if (eventName === 'subscription_resumed') {
    const user = await findUser('id, subscription_id');
    if (user) {
      // Accept resume even if subscription_id was cleared (e.g. old cancel logic wiped it)
      const resumePlan = planInfo?.plan || null;
      const updateData = {
        subscription_status: 'active',
        subscription_id: subscriptionId,
        renews_at: renewsAt,
        current_period_end: renewsAt,
      };
      if (resumePlan) updateData.plan = resumePlan;
      await supabase.from('users').update(updateData).eq('id', user.id);
      console.log(`Sub ${subscriptionId} resumed for ${userEmail} — plan: ${resumePlan}, renews: ${renewsAt}`);
    }
    return res.json({ ok: true });
  }

  // subscription_updated fires for plan changes, resumes, pauses, etc.
  if (eventName === 'subscription_updated') {
    const lsStatus = attrs?.status;
    console.log(`subscription_updated for ${userEmail} — LS status: ${lsStatus}, sub: ${subscriptionId}`);

    if (lsStatus === 'active' || lsStatus === 'on_trial') {
      // Always sync on active — covers resume, plan change, billing date update
      const user = await findUser('id, subscription_status');
      if (user) {
        const resumePlan = planInfo?.plan || null;
        const updateData = {
          subscription_status: 'active',
          subscription_id: subscriptionId,
          renews_at: renewsAt,
          current_period_end: renewsAt,
        };
        if (resumePlan) updateData.plan = resumePlan;
        await supabase.from('users').update(updateData).eq('id', user.id);
        console.log(`subscription_updated → synced active for ${userEmail}, plan: ${resumePlan}, renews: ${renewsAt}`);
      }
    } else if (lsStatus === 'cancelled') {
      // Also handle cancel via subscription_updated (some LS versions send this instead of subscription_cancelled)
      const user = await findUser('id, subscription_id');
      if (user && user.subscription_id === subscriptionId) {
        const updateData = { subscription_status: 'cancelled' };
        if (renewsAt) updateData.current_period_end = renewsAt;
        await supabase.from('users').update(updateData).eq('id', user.id);
        console.log(`subscription_updated → cancel synced for ${userEmail}`);
      }
    }
    return res.json({ ok: true });
  }

  console.log(`Unhandled webhook event: ${eventName}`);
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
  const { data } = await supabase
    .from('users')
    .select('credits, plan, subscription_status, subscription_id, current_period_end, renews_at, email, nickname, avatar_url, bio, website')
    .eq('id', authUser.id)
    .single();
  if (!data) return res.status(404).json({ error: 'User not found' });
  res.json(data);
});

app.put('/api/profile', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  const { nickname, bio, website, avatar_url } = req.body;
  const updates = {};

  // ── nickname ──
  if (nickname !== undefined) {
    const nick = nickname.trim();
    if (!/^[a-zA-Z0-9_\-]{3,30}$/.test(nick))
      return res.status(400).json({ error: 'Nickname must be 3–30 characters: letters, numbers, _ or -' });

    // uniqueness check
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .ilike('nickname', nick)
      .neq('id', authUser.id)
      .maybeSingle();
    if (existing) return res.status(409).json({ error: 'That nickname is already taken' });

    updates.nickname = nick;
  }

  // ── bio ──
  if (bio !== undefined) {
    if (bio.length > 200) return res.status(400).json({ error: 'Bio must be 200 characters or less' });
    updates.bio = bio.trim();
  }

  // ── website ──
  if (website !== undefined) {
    const ws = website.trim();
    if (ws && !/^https?:\/\/.+/.test(ws))
      return res.status(400).json({ error: 'Website must start with http:// or https://' });
    updates.website = ws || null;
  }

  // ── avatar_url ──
  if (avatar_url !== undefined) {
    const av = avatar_url.trim();
    if (av && !/^https?:\/\/.+/.test(av))
      return res.status(400).json({ error: 'Avatar URL must start with http:// or https://' });
    updates.avatar_url = av || null;
  }

  if (Object.keys(updates).length === 0)
    return res.status(400).json({ error: 'Nothing to update' });

  const { data, error } = await supabase
    .from('users')
    .update(updates)
    .eq('id', authUser.id)
    .select('nickname, avatar_url, bio, website')
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Sync author_name in community wisdom posts + comments when nickname changes
  if (updates.nickname && authUser.email) {
    await Promise.allSettled([
      supabase.schema('community_wisdom').from('ideas')
        .update({ author_name: updates.nickname })
        .eq('author_email', authUser.email),
      supabase.schema('community_wisdom').from('comments')
        .update({ author_name: updates.nickname })
        .eq('author_email', authUser.email),
    ]);
  }

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
      .select('id, title, preview_url, waveform_url, cover, bpm, key, genre, instrument, type, pack, mood, artist_style, subgenre, tags, play_count, bunny_video_id, bunny_library_id', { count: 'exact' });

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
  res.json({ token: genPreviewToken(getClientIp(req), 0), expiresIn: 3600 });
});

// ===== PREVIEW PROXY — pipes audio without exposing CDN URL =====
app.get('/api/preview/:id', async (req, res) => {
  if (!isValidPreviewToken(req.query.t, getClientIp(req))) {
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
    const cacheKey = 'filters:' + (genreParam || 'all');

    // Serve from cache (5 min TTL) — this endpoint scans the entire library
    const cached = cacheGet(cacheKey);
    if (cached) {
      res.set('Cache-Control', 'public, max-age=300');
      return res.json(cached);
    }

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

    const result = {
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
    };

    cacheSet(cacheKey, result, 5 * 60 * 1000); // 5 min server-side cache
    res.set('Cache-Control', 'public, max-age=300'); // 5 min browser cache
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== DOWNLOAD =====
app.post('/api/download', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });
  const { sampleId } = req.body;
  const { data: user } = await supabase.from('users').select('credits, plan, subscription_status, current_period_end, renews_at').eq('id', authUser.id).single();
  if (!user) return res.status(400).json({ error: 'User not found' });
  if (!canUserDownload(user)) return res.status(403).json({ error: 'Active subscription required to download' });
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

// ===== CREATE CHECKOUT (server-side, embeds user_id in custom_data) =====
app.post('/api/create-checkout', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  const { variant_id } = req.body;
  if (!variant_id) return res.status(400).json({ error: 'variant_id required' });

  const apiKey = process.env.LEMONSQUEEZY_API_KEY;
  const storeId = process.env.LS_STORE_ID;
  if (!apiKey || !storeId) return res.status(500).json({ error: 'LS not configured' });

  const { data: user } = await supabase.from('users').select('email').eq('id', authUser.id).single();
  if (!user) return res.status(404).json({ error: 'User not found' });

  try {
    const lsRes = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
      },
      body: JSON.stringify({
        data: {
          type: 'checkouts',
          attributes: {
            checkout_data: {
              email: user.email,
              custom: { user_id: authUser.id },
            },
          },
          relationships: {
            store:   { data: { type: 'stores',   id: String(storeId)   } },
            variant: { data: { type: 'variants',  id: String(variant_id) } },
          },
        },
      }),
    });

    const json = await lsRes.json();
    if (!lsRes.ok) {
      console.error('LS checkout error:', JSON.stringify(json));
      return res.status(502).json({ error: 'Failed to create checkout' });
    }

    const url = json.data?.attributes?.url;
    res.json({ url });
  } catch (e) {
    console.error('create-checkout error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===== BILLING PORTAL (Lemon Squeezy Customer Portal) =====
app.get('/api/billing-portal', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  const { data: user } = await supabase
    .from('users').select('subscription_id').eq('id', authUser.id).single();

  if (!user?.subscription_id)
    return res.status(404).json({ error: 'No active subscription found' });

  const apiKey = process.env.LEMONSQUEEZY_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'LS not configured' });

  try {
    const lsRes = await fetch(
      `https://api.lemonsqueezy.com/v1/subscriptions/${user.subscription_id}`,
      { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/vnd.api+json' } }
    );
    const json = await lsRes.json();
    if (!lsRes.ok) {
      console.error('LS billing-portal error:', JSON.stringify(json));
      return res.status(502).json({ error: 'Could not retrieve portal URL' });
    }
    const portalUrl = json.data?.attributes?.urls?.customer_portal;
    if (!portalUrl) return res.status(502).json({ error: 'Portal URL unavailable' });
    res.json({ url: portalUrl });
  } catch (e) {
    console.error('billing-portal error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===== CANCEL SUBSCRIPTION =====
app.post('/api/cancel-subscription', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  const { data: user } = await supabase
    .from('users').select('subscription_id, plan, subscription_status').eq('id', authUser.id).single();

  console.log(`cancel-subscription: user=${authUser.email} sub_id=${user?.subscription_id} status=${user?.subscription_status} plan=${user?.plan}`);

  const apiKey = process.env.LEMONSQUEEZY_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'LS not configured' });

  // If subscription_id missing in DB but user has a plan — try to find sub in LS by store
  if (!user?.subscription_id) {
    // Try to recover subscription_id from LS
    try {
      const lsListRes = await fetch(
        `https://api.lemonsqueezy.com/v1/subscriptions?filter[user_email]=${encodeURIComponent(authUser.email)}&filter[store_id]=${process.env.LS_STORE_ID}`,
        { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/vnd.api+json' } }
      );
      const lsList = await lsListRes.json().catch(() => ({}));
      const activeSub = lsList.data?.find(s => ['active', 'on_trial', 'cancelled'].includes(s.attributes?.status));
      if (activeSub) {
        // Restore subscription_id in DB
        await supabase.from('users').update({ subscription_id: activeSub.id }).eq('id', authUser.id);
        user.subscription_id = activeSub.id;
        console.log(`Recovered subscription_id ${activeSub.id} for ${authUser.email}`);
      } else {
        return res.status(404).json({ error: 'No active subscription found' });
      }
    } catch (e) {
      return res.status(404).json({ error: 'No active subscription found' });
    }
  }

  try {
    // First GET the subscription to check its current status
    const getRes = await fetch(
      `https://api.lemonsqueezy.com/v1/subscriptions/${user.subscription_id}`,
      { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/vnd.api+json' } }
    );
    const getJson = await getRes.json().catch(() => ({}));

    if (!getRes.ok) {
      const lsError = getJson.errors?.[0]?.detail || getJson.message || 'Subscription not found in LS';
      console.error(`LS GET subscription error (${user.subscription_id}):`, lsError);
      // If 404 — subscription doesn't exist in LS anymore, mark as expired but keep subscription_id
      if (getRes.status === 404) {
        await supabase.from('users').update({ plan: null, subscription_status: 'expired', renews_at: null, current_period_end: null }).eq('id', authUser.id);
        return res.json({ ok: true, note: 'Subscription not found in LS — marked expired' });
      }
      return res.status(502).json({ error: lsError });
    }

    const lsAttrs = getJson.data?.attributes || {};
    const lsStatus = lsAttrs.status;
    // renews_at or ends_at tells us when access actually expires
    const periodEnd = lsAttrs.ends_at || lsAttrs.renews_at || null;
    console.log(`LS subscription ${user.subscription_id} status: ${lsStatus}, ends: ${periodEnd}`);

    // Already cancelled in LS — sync our DB to match (keep subscription_id for resume)
    if (lsStatus === 'cancelled') {
      await supabase.from('users').update({
        subscription_status: 'cancelled',
        current_period_end: periodEnd,
      }).eq('id', authUser.id);
      console.log(`Subscription already cancelled in LS — synced DB for ${authUser.email}`);
      return res.json({ ok: true });
    }

    // Expired in LS — mark as expired, clear plan but KEEP subscription_id for resume
    if (lsStatus === 'expired') {
      await supabase.from('users').update({
        subscription_status: 'expired',
        plan: null,
        renews_at: null,
        current_period_end: null,
      }).eq('id', authUser.id);
      console.log(`Subscription expired in LS — plan cleared, sub_id kept for ${authUser.email}`);
      return res.json({ ok: true });
    }

    // Active/on_trial — DELETE to schedule cancellation at end of billing period
    const delRes = await fetch(
      `https://api.lemonsqueezy.com/v1/subscriptions/${user.subscription_id}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/vnd.api+json' },
      }
    );
    if (!delRes.ok) {
      const delJson = await delRes.json().catch(() => ({}));
      const lsError = delJson.errors?.[0]?.detail || delJson.message || 'Could not cancel subscription';
      console.error(`LS DELETE subscription error (${user.subscription_id}):`, JSON.stringify(delJson));
      return res.status(502).json({ error: lsError });
    }

    // Immediately update DB — don't wait for webhook (avoids race condition on page reload)
    // Explicitly keep subscription_id so Resume button stays visible
    await supabase.from('users').update({
      subscription_status: 'cancelled',
      subscription_id: user.subscription_id,
      current_period_end: periodEnd,
    }).eq('id', authUser.id);

    console.log(`Subscription ${user.subscription_id} cancellation scheduled for ${authUser.email}, access until ${periodEnd}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('cancel-subscription error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===== RESUME SUBSCRIPTION =====
app.post('/api/resume-subscription', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  const { data: user } = await supabase
    .from('users').select('subscription_id, subscription_status').eq('id', authUser.id).single();

  if (!user?.subscription_id)
    return res.status(404).json({ error: 'No subscription found — please contact support.' });

  // Allow resume from cancelled or expired state (or null — legacy accounts)
  if (user.subscription_status === 'active')
    return res.status(400).json({ error: 'Subscription is already active.' });

  const apiKey = process.env.LEMONSQUEEZY_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'LS not configured' });

  try {
    const lsRes = await fetch(
      `https://api.lemonsqueezy.com/v1/subscriptions/${user.subscription_id}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/vnd.api+json',
          'Content-Type': 'application/vnd.api+json',
        },
        body: JSON.stringify({
          data: {
            type: 'subscriptions',
            id: String(user.subscription_id),
            attributes: { cancelled: false },
          },
        }),
      }
    );
    if (!lsRes.ok) {
      const json = await lsRes.json().catch(() => ({}));
      const lsError = json.errors?.[0]?.detail || 'Could not resume subscription';
      console.error('LS resume-subscription error:', JSON.stringify(json));
      return res.status(502).json({ error: lsError });
    }
    await supabase.from('users').update({ subscription_status: 'active' }).eq('id', authUser.id);
    console.log(`Subscription ${user.subscription_id} resumed for ${authUser.email}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('resume-subscription error:', e.message);
    res.status(500).json({ error: e.message });
  }
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
  const cached = cacheGet('pack-products');
  if (cached) {
    res.set('Cache-Control', 'public, max-age=300');
    return res.json(cached);
  }
  const { data, error } = await supabase
    .from('pack_products')
    .select('pack_name, price_usd, bonus_credits, ls_variant_id, download_url, producer, featured, created_at, cover_url, preview_url')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  const result = data || [];
  cacheSet('pack-products', result, 5 * 60 * 1000);
  res.set('Cache-Control', 'public, max-age=300');
  res.json(result);
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

  const [{ data: packs }, { data: subs }, { data: products }, { data: creditTxns }] = await Promise.all([
    supabase.from('user_packs').select('pack_name, purchased_at, ls_order_id')
      .eq('user_id', authUser.id).order('purchased_at', { ascending: false }),
    supabase.from('subscriptions').select('plan, credits_added, created_at')
      .eq('user_id', authUser.id).order('created_at', { ascending: false }),
    supabase.from('pack_products').select('pack_name, price_usd'),
    supabase.from('credit_transactions').select('credits_added, source, created_at')
      .eq('user_id', authUser.id).order('created_at', { ascending: false }),
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

  const creditItems = (creditTxns || []).map(t => ({
    type: 'credits',
    description: `${t.credits_added} credits`,
    date: t.created_at,
    amount: CREDIT_PACK_PRICES[t.credits_added] ?? null,
  }));

  const result = [...packItems, ...subItems, ...creditItems]
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

// ===== COLLECTIONS =====

// GET /api/my-collection-likes — slugs the user has liked
app.get('/api/my-collection-likes', async (req, res) => {
  try {
    const authUser = await getUserFromToken(req);
    if (!authUser) return res.json([]);
    const { data } = await supabase
      .from('collection_likes')
      .select('liked_at, collections(slug, title, cover_url, price_credits)')
      .eq('user_id', authUser.id);
    res.json((data || []).map(r => ({
      slug: r.collections?.slug,
      title: r.collections?.title,
      cover_url: r.collections?.cover_url,
      price_credits: r.collections?.price_credits,
      liked_at: r.liked_at,
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/collection-likes — like a collection
app.post('/api/collection-likes', async (req, res) => {
  try {
    const authUser = await getUserFromToken(req);
    if (!authUser) return res.status(401).json({ error: 'Unauthorized' });
    const { slug } = req.body;
    if (!slug) return res.status(400).json({ error: 'slug required' });
    const { data: col } = await supabase.from('collections').select('id').eq('slug', slug).single();
    if (!col) return res.status(404).json({ error: 'Collection not found' });
    await supabase.from('collection_likes').upsert({ user_id: authUser.id, collection_id: col.id });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/collection-likes — unlike a collection
app.delete('/api/collection-likes', async (req, res) => {
  try {
    const authUser = await getUserFromToken(req);
    if (!authUser) return res.status(401).json({ error: 'Unauthorized' });
    const { slug } = req.body;
    if (!slug) return res.status(400).json({ error: 'slug required' });
    const { data: col } = await supabase.from('collections').select('id').eq('slug', slug).single();
    if (!col) return res.status(404).json({ error: 'Collection not found' });
    await supabase.from('collection_likes').delete().eq('user_id', authUser.id).eq('collection_id', col.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/my-collection-downloads', async (req, res) => {
  try {
    const authUser = await getUserFromToken(req);
    if (!authUser) return res.json([]);
    const { data } = await supabase
      .from('user_collection_downloads')
      .select('downloaded_at, collections(slug, title, cover_url, price_credits)')
      .eq('user_id', authUser.id);
    res.json((data || []).map(r => ({
      slug: r.collections?.slug,
      title: r.collections?.title,
      cover_url: r.collections?.cover_url,
      price_credits: r.collections?.price_credits,
      downloaded_at: r.downloaded_at,
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/collections', async (req, res) => {
  try {
    const { data: collections, error } = await supabase
      .from('collections')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    const { data: countRows } = await supabase
      .from('collection_samples')
      .select('collection_id');

    const countMap = {};
    (countRows || []).forEach(r => {
      countMap[r.collection_id] = (countMap[r.collection_id] || 0) + 1;
    });

    res.set('Cache-Control', 'public, max-age=60');
    res.json((collections || []).map(c => ({ ...c, sample_count: countMap[c.id] || 0 })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/collections/:slug', async (req, res) => {
  try {
    const { data: collection, error: colErr } = await supabase
      .from('collections')
      .select('id, title, slug, description, genre, cover_url, price_credits, created_at')
      .eq('slug', req.params.slug)
      .single();
    if (colErr || !collection) return res.status(404).json({ error: 'Collection not found' });

    const { data: rows, error: samplesErr } = await supabase
      .from('collection_samples')
      .select('position, samples(id, title, preview_url, waveform_url, cover, bpm, key, genre, instrument, type, pack, mood, play_count)')
      .eq('collection_id', collection.id)
      .order('position', { ascending: true });
    if (samplesErr) return res.status(500).json({ error: samplesErr.message });

    const samples = (rows || [])
      .filter(r => r.samples)
      .map(r => ({ ...r.samples, position: r.position }));

    const cover_url = collection.cover_url || samples.find(s => s.cover)?.cover || null;

    res.json({ ...collection, cover_url, samples });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/collection-access', async (req, res) => {
  try {
    const authUser = await getUserFromToken(req);
    if (!authUser) return res.json({ access: false });

    const { slug } = req.query;
    if (!slug) return res.status(400).json({ error: 'slug required' });

    const { data: collection } = await supabase
      .from('collections').select('id').eq('slug', slug).single();
    if (!collection) return res.json({ access: false });

    const { data } = await supabase
      .from('user_collection_downloads')
      .select('downloaded_at')
      .eq('user_id', authUser.id)
      .eq('collection_id', collection.id)
      .single();

    res.json({ access: !!data, downloaded_at: data?.downloaded_at || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// NOTE: For 50+ sample collections, consider pre-building ZIPs and storing a zip_url
// on the collections table. On-the-fly generation may approach timeout limits on Render.
app.post('/api/collections/:slug/download', async (req, res) => {
  try {
    const authUser = await getUserFromToken(req);
    if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

    const { data: collection, error: colErr } = await supabase
      .from('collections').select('id, title, price_credits')
      .eq('slug', req.params.slug).single();
    if (colErr || !collection) return res.status(404).json({ error: 'Collection not found' });

    const { data: existing } = await supabase
      .from('user_collection_downloads')
      .select('downloaded_at')
      .eq('user_id', authUser.id)
      .eq('collection_id', collection.id)
      .single();

    if (!existing) {
      const { data: user } = await supabase
        .from('users').select('credits, plan, subscription_status, current_period_end, renews_at')
        .eq('id', authUser.id).single();
      if (!user) return res.status(404).json({ error: 'User not found' });

      if (!canUserDownload(user)) return res.status(403).json({ error: 'Active subscription required' });

      const cost = collection.price_credits;
      if (user.credits < cost) return res.status(400).json({ error: 'No credits' });

      const { error: deductErr } = await supabase
        .from('users').update({ credits: user.credits - cost }).eq('id', authUser.id);
      if (deductErr) return res.status(500).json({ error: 'Failed to deduct credits' });

      await supabase.from('user_collection_downloads')
        .insert({ user_id: authUser.id, collection_id: collection.id });
    }

    const { data: rows, error: samplesErr } = await supabase
      .from('collection_samples')
      .select('position, samples(id, title, url)')
      .eq('collection_id', collection.id)
      .order('position', { ascending: true });
    if (samplesErr) return res.status(500).json({ error: 'Failed to fetch samples' });

    const samples = (rows || []).filter(r => r.samples?.url).map(r => r.samples);
    if (samples.length === 0) return res.status(500).json({ error: 'No samples available' });

    // Bulk-record all samples as downloaded — for stats, library dedup, and Trending Now.
    // Only on first purchase (not re-download). Skip any sample_ids already in user_downloads.
    if (!existing && samples.length > 0) {
      const sampleIds = samples.map(s => s.id);
      const { data: alreadyDl } = await supabase
        .from('user_downloads')
        .select('sample_id')
        .eq('user_id', authUser.id)
        .in('sample_id', sampleIds);
      const alreadySet = new Set((alreadyDl || []).map(r => r.sample_id));
      const newDlRows = sampleIds
        .filter(id => !alreadySet.has(id))
        .map(id => ({ user_id: authUser.id, sample_id: id }));
      if (newDlRows.length > 0) {
        await supabase.from('user_downloads').insert(newDlRows);
      }
    }

    const zip = new JSZip();
    const usedNames = new Set();

    async function fetchAndAdd(sample) {
      try {
        const fileRes = await nodeFetch(sample.url, { timeout: 30000 });
        if (!fileRes.ok) return;
        const buffer = await fileRes.buffer();
        let name = (sample.title || `sample_${sample.id}`)
          .replace(/[^\w\s\-().]/g, '').trim().substring(0, 80) + '.wav';
        let unique = name, n = 1;
        while (usedNames.has(unique)) unique = name.replace('.wav', `_${n++}.wav`);
        usedNames.add(unique);
        zip.file(unique, buffer);
      } catch (e) { console.warn('Collection ZIP: skip', sample?.title, e.message); }
    }

    for (let i = 0; i < samples.length; i += 5) {
      await Promise.all(samples.slice(i, i + 5).map(fetchAndAdd));
    }

    if (Object.keys(zip.files).length === 0)
      return res.status(500).json({ error: 'All files failed to download' });

    const safeName = (collection.title || req.params.slug).replace(/[^a-zA-Z0-9\-_. ]/g, '_');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.zip"`);
    zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true })
      .pipe(res)
      .on('error', err => { console.error('ZIP stream error:', err); res.end(); });

  } catch (e) {
    console.error('Collection download error:', e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
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

// ===== PRESET PREVIEW PROXY =====
app.get('/api/preset-preview/:id', async (req, res) => {
  if (!isValidPreviewToken(req.query.t, getClientIp(req))) return res.status(403).end();
  try {
    const { data: preset, error } = await supabase
      .from('presets').select('preview_url').eq('id', req.params.id).single();
    if (error || !preset?.preview_url) return res.status(404).end();

    const upHeaders = { 'User-Agent': 'Mozilla/5.0' };
    if (req.headers['range']) upHeaders['Range'] = req.headers['range'];

    const upstream = await nodeFetch(signBunnyUrl(preset.preview_url, 300), { headers: upHeaders });
    res.status(upstream.status);
    for (const h of ['content-type','content-length','content-range','accept-ranges']) {
      const v = upstream.headers.get(h); if (v) res.setHeader(h, v);
    }
    res.setHeader('Cache-Control', 'private, max-age=300');
    upstream.body.pipe(res).on('error', () => res.end());
  } catch(e) { res.status(500).end(); }
});

// ===== PRESET LIKES =====
app.get('/api/preset-likes', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });
  const uc = await userClient(req);
  const { data, error } = await uc.from('preset_likes')
    .select('preset_id, liked_at').eq('user_id', authUser.id)
    .order('liked_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/preset-likes', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });
  const presetId = req.body.presetId ?? req.body.preset_id;
  if (!presetId) return res.status(400).json({ error: 'presetId required' });
  const uc = await userClient(req);
  const { error } = await uc.from('preset_likes')
    .upsert({ user_id: authUser.id, preset_id: presetId }, { onConflict: 'user_id,preset_id' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.delete('/api/preset-likes', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });
  const presetId = req.body.presetId ?? req.body.preset_id;
  if (!presetId) return res.status(400).json({ error: 'presetId required' });
  const uc = await userClient(req);
  const { error } = await uc.from('preset_likes')
    .delete().eq('user_id', authUser.id).eq('preset_id', presetId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ===== PRESET DOWNLOADS =====
app.get('/api/preset-downloads', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });
  const uc = await userClient(req);
  const { data, error } = await uc.from('preset_downloads')
    .select('preset_id, downloaded_at').eq('user_id', authUser.id)
    .order('downloaded_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/preset-download', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });
  const { presetId } = req.body;
  if (!presetId) return res.status(400).json({ error: 'presetId required' });
  const { data: user } = await supabase.from('users')
    .select('credits, plan, subscription_status, current_period_end, renews_at').eq('id', authUser.id).single();
  if (!user) return res.status(400).json({ error: 'User not found' });
  if (!canUserDownload(user)) return res.status(403).json({ error: 'Active subscription required to download' });
  const { data: preset } = await supabase.from('presets')
    .select('id, file_url').eq('id', presetId).single();
  if (!preset) return res.status(400).json({ error: 'Preset not found' });
  // Use userClient so RLS auth.uid() resolves correctly for preset_downloads
  const uc = await userClient(req);
  const { data: existing } = await uc.from('preset_downloads').select('id')
    .eq('user_id', authUser.id).eq('preset_id', presetId).single();
  if (existing) return res.json({ url: signBunnyUrl(preset.file_url) });
  if (user.credits <= 0) return res.status(400).json({ error: 'No credits' });
  await supabase.from('users').update({ credits: user.credits - 1 }).eq('id', authUser.id);
  const { error: insertErr } = await uc.from('preset_downloads')
    .insert({ user_id: authUser.id, preset_id: presetId });
  if (insertErr) {
    // Roll back credit deduction so user isn't charged for a failed record
    await supabase.from('users').update({ credits: user.credits }).eq('id', authUser.id);
    return res.status(500).json({ error: 'Failed to record download' });
  }
  res.json({ url: signBunnyUrl(preset.file_url) });
});

// ===== PRESET PLAYS =====
app.post('/api/preset-plays', async (req, res) => {
  const authUser = await getUserFromToken(req);
  const { presetId, referrer, page, sessionId } = req.body;
  if (!presetId) return res.status(400).json({ error: 'presetId required' });
  const ip = (req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0] || req.ip || '').trim() || null;
  const country = req.headers['cf-ipcountry'] || null;
  const userAgent = (req.headers['user-agent'] || '').slice(0, 512) || null;
  await supabase.from('preset_plays').insert({
    user_id: authUser?.id || null, preset_id: presetId,
    session_id: sessionId || null, referrer: referrer ? referrer.slice(0, 512) : null,
    page: page || null, ip, country, user_agent: userAgent,
  });
  try { await supabase.rpc('increment_preset_play_count', { preset_id: presetId }); } catch(e) {}
  res.json({ ok: true });
});

// ===== ADMIN PRESETS =====
app.get('/api/admin/presets', requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 30, search, vst } = req.query;
    const lim = Math.min(100, Math.max(1, parseInt(limit)));
    const from = (Math.max(1, parseInt(page)) - 1) * lim;
    const to = from + lim - 1;
    let q = supabase.from('presets')
      .select('id, name, vst, preview_url, file_url, cover, play_count, created_at', { count: 'exact' });
    if (search) q = q.or(`name.ilike.%${search}%,vst.ilike.%${search}%`);
    if (vst) q = q.eq('vst', vst);
    q = q.order('created_at', { ascending: false }).range(from, to);
    const { data, count, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ presets: data || [], total: count || 0, page: parseInt(page), pages: Math.ceil((count || 0) / lim) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/presets', requireAdmin, async (req, res) => {
  try {
    const { name, vst, preview_url, file_url, cover } = req.body;
    if (!name || !vst) return res.status(400).json({ error: 'name and vst required' });
    const { data, error } = await supabase.from('presets')
      .insert({ name, vst, preview_url: preview_url || null, file_url: file_url || null, cover: cover || null })
      .select('id').single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, id: data.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/presets/:id', requireAdmin, async (req, res) => {
  try {
    const { name, vst, preview_url, file_url, cover } = req.body;
    const { error } = await supabase.from('presets')
      .update({ name, vst, preview_url: preview_url || null, file_url: file_url || null, cover: cover || null })
      .eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/presets/:id', requireAdmin, async (req, res) => {
  try {
    await supabase.from('preset_downloads').delete().eq('preset_id', req.params.id);
    await supabase.from('preset_likes').delete().eq('preset_id', req.params.id);
    await supabase.from('preset_plays').delete().eq('preset_id', req.params.id);
    const { error } = await supabase.from('presets').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== START =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
