require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Хелпер: получить пользователя из Bearer токена
async function getUserFromToken(req) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

// ===== ENSURE USER (создать запись при первом входе) =====
app.post('/api/ensure-user', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  const { data: existing } = await supabase
    .from('users')
    .select('id')
    .eq('id', authUser.id)
    .single();

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

  const { data, error } = await supabase
    .from('users')
    .select('credits')
    .eq('id', authUser.id)
    .single();

  if (error || !data) return res.status(404).json({ error: 'User not found' });
  res.json({ credits: data.credits });
});

// ===== GET SAMPLES =====
app.get('/api/samples', async (req, res) => {
  const { data, error } = await supabase
    .from('samples')
    .select('*')
    .order('id', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ===== DOWNLOAD =====
app.post('/api/download', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  const { sampleId } = req.body;

  const { data: user } = await supabase
    .from('users')
    .select('credits')
    .eq('id', authUser.id)
    .single();

  if (!user) return res.status(400).json({ error: 'User not found' });

  const { data: sample } = await supabase
    .from('samples')
    .select('id, url')
    .eq('id', sampleId)
    .single();

  if (!sample) return res.status(400).json({ error: 'Sample not found' });

  const { data: existing } = await supabase
    .from('user_downloads')
    .select('id')
    .eq('user_id', authUser.id)
    .eq('sample_id', sampleId)
    .single();

  if (existing) return res.json({ url: sample.url });

  if (user.credits <= 0) return res.status(400).json({ error: 'No credits' });

  await supabase
    .from('users')
    .update({ credits: user.credits - 1 })
    .eq('id', authUser.id);

  await supabase
    .from('user_downloads')
    .insert({ user_id: authUser.id, sample_id: sampleId });

  res.json({ url: sample.url });
});

// ===== BUY CREDITS =====
app.post('/api/buy', async (req, res) => {
  const authUser = await getUserFromToken(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  const { amount } = req.body;

  const { data: user } = await supabase
    .from('users')
    .select('credits')
    .eq('id', authUser.id)
    .single();

  if (!user) return res.status(404).json({ error: 'User not found' });

  const { data } = await supabase
    .from('users')
    .update({ credits: user.credits + amount })
    .eq('id', authUser.id)
    .select('credits')
    .single();

  res.json({ success: true, credits: data.credits });
});

// ===== HEALTH CHECK =====
app.get('/', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Сервер на порту ${PORT}`));
