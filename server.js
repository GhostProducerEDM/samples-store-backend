require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());

// Вебхук читаем как raw body для проверки подписи
app.use('/api/webhook/lemonsqueezy', express.raw({ type: 'application/json' }));
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Сколько кредитов даёт каждый вариант
const CREDITS_MAP = {
  [process.env.LS_VARIANT_STARTER]:   100,
  [process.env.LS_VARIANT_PRO]:       350,
  [process.env.LS_VARIANT_UNLIMITED]: 1000,
};

// Хелпер: получить пользователя из Bearer токена
async function getUserFromToken(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

// ===== WEBHOOK от Lemon Squeezy =====
app.post('/api/webhook/lemonsqueezy', async (req, res) => {
  const secret = process.env.LEMONSQUEEZY_SECRET;
  const signature = req.headers['x-signature'];
  const body = req.body; // raw Buffer

  // Проверяем подпись — защита от фейковых запросов
  const hmac = crypto.createHmac('sha256', secret);
  const digest = hmac.update(body).digest('hex');

  if (signature !== digest) {
    console.log('❌ Невалидная подпись вебхука');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const payload = JSON.parse(body.toString());
  const eventName = payload.meta?.event_name;

  // Нас интересует только успешная оплата
  if (eventName !== 'order_created') {
    return res.json({ ok: true, skipped: true });
  }

  const order = payload.data?.attributes;
  const variantId = String(order?.first_order_item?.variant_id);
  const userEmail = order?.user_email;
  const creditsToAdd = CREDITS_MAP[variantId];

  if (!creditsToAdd) {
    console.log('⚠️ Неизвестный variant_id:', variantId);
    return res.json({ ok: true, skipped: true });
  }

  // Находим пользователя по email
  const { data: user } = await supabase
    .from('users')
    .select('id, credits')
    .eq('email', userEmail)
    .single();

  if (!user) {
    console.log('⚠️ Пользователь не найден:', userEmail);
    return res.status(404).json({ error: 'User not found' });
  }

  // Начисляем кредиты
  await supabase
    .from('users')
    .update({ credits: user.credits + creditsToAdd })
    .eq('id', user.id);

  console.log(`✅ Начислено ${creditsToAdd} кредитов для ${userEmail}`);
  res.json({ ok: true, credits_added: creditsToAdd });
});

// ===== ENSURE USER =====
app.post('/api/ensure-user', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  const { data: existing } = await supabase
    .from('users').select('id').eq('id', authUser.id).single();

  if (!existing) {
    await supabase.from('users').insert({
      id: authUser.id,
      email: authUser.email,
      credits: 100
    });
  }
  res.json({ ok: true });
});

// ===== GET CREDITS =====
app.get('/api/credits', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  const { data } = await supabase
    .from('users').select('credits').eq('id', authUser.id).single();

  if (!data) return res.status(404).json({ error: 'User not found' });
  res.json({ credits: data.credits });
});

// ===== GET SAMPLES =====
app.get('/api/samples', async (req, res) => {
  const { data, error } = await supabase
    .from('samples').select('*').order('id', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ===== DOWNLOAD =====
app.post('/api/download', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  const { sampleId } = req.body;

  const { data: user } = await supabase
    .from('users').select('credits').eq('id', authUser.id).single();
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

// ===== BUY CREDITS (прямо, без Lemon Squeezy — для теста) =====
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

// ===== HEALTH CHECK =====
app.get('/', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Сервер на порту ${PORT}`));
