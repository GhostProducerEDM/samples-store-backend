require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// Подключение к Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ===== GET CREDITS =====
app.get('/api/credits', async (req, res) => {
  const userId = req.query.userId;
  const { data, error } = await supabase
    .from('users')
    .select('credits')
    .eq('id', userId)
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

// ===== DOWNLOAD (списывает 1 кредит) =====
app.post('/api/download', async (req, res) => {
  const { userId, sampleId } = req.body;

  const { data: user, error: userErr } = await supabase
    .from('users')
    .select('id, credits')
    .eq('id', userId)
    .single();

  if (userErr || !user) return res.status(400).json({ error: 'Invalid user' });

  const { data: sample, error: sampleErr } = await supabase
    .from('samples')
    .select('id, url')
    .eq('id', sampleId)
    .single();

  if (sampleErr || !sample) return res.status(400).json({ error: 'Invalid sample' });

  const { data: existing } = await supabase
    .from('user_downloads')
    .select('id')
    .eq('user_id', userId)
    .eq('sample_id', sampleId)
    .single();

  if (existing) {
    return res.json({ url: sample.url });
  }

  if (user.credits <= 0) {
    return res.status(400).json({ error: 'No credits' });
  }

  await supabase
    .from('users')
    .update({ credits: user.credits - 1 })
    .eq('id', userId);

  await supabase
    .from('user_downloads')
    .insert({ user_id: userId, sample_id: sampleId });

  res.json({ url: sample.url });
});

// ===== BUY CREDITS =====
app.post('/api/buy', async (req, res) => {
  const { userId, amount } = req.body;

  const { data: user, error } = await supabase
    .from('users')
    .select('credits')
    .eq('id', userId)
    .single();

  if (error || !user) return res.status(404).json({ error: 'User not found' });

  const { data, error: updateErr } = await supabase
    .from('users')
    .update({ credits: user.credits + amount })
    .eq('id', userId)
    .select('credits')
    .single();

  if (updateErr) return res.status(500).json({ error: updateErr.message });
  res.json({ success: true, credits: data.credits });
});

// ===== HEALTH CHECK =====
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Sample Store API running' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
