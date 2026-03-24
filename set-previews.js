// set-previews.js
// Запускать: node set-previews.js
// Заполняет preview_url для всех существующих семплов в Supabase
// MP3 файлы лежат в папке "MP3 PREVIEW 256KB/" на Bunny

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const https = require('https');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const BUNNY_KEY  = process.env.BUNNY_STORAGE_KEY;
const BUNNY_ZONE = process.env.BUNNY_STORAGE_ZONE;
const CDN_URL    = process.env.BUNNY_CDN_URL;
const REGION     = process.env.BUNNY_REGION || 'storage';

const MP3_FOLDER = 'MP3 PREVIEW 256KB'; // папка с MP3 на Bunny

// ── Получить список файлов из папки на Bunny ──────────────────────────────────
function bunnyList(path) {
  return new Promise((resolve, reject) => {
    const host = REGION === 'storage' ? 'storage.bunnycdn.com' : `${REGION}.storage.bunnycdn.com`;
    const url = '/' + BUNNY_ZONE + path.split('/').map(p => encodeURIComponent(p)).join('/');
    const options = {
      hostname: host,
      path: url,
      method: 'GET',
      headers: { 'AccessKey': BUNNY_KEY }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error(`Parse error at ${path}: ${data.slice(0,200)}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Собрать все MP3 файлы рекурсивно ─────────────────────────────────────────
async function collectMp3Files(path = '/', results = []) {
  let items;
  try { items = await bunnyList(path); }
  catch(e) { console.error(`  ⚠️  Error listing ${path}: ${e.message}`); return results; }
  if (!Array.isArray(items)) return results;

  for (const item of items) {
    if (item.IsDirectory) {
      await collectMp3Files(path + item.ObjectName + '/', results);
    } else if (/\.mp3$/i.test(item.ObjectName)) {
      const cdnUrl = CDN_URL + path.split('/').map(p => encodeURIComponent(p)).join('/') + encodeURIComponent(item.ObjectName);
      const baseName = item.ObjectName.replace(/\.mp3$/i, '').toLowerCase().trim();
      results.push({ baseName, cdnUrl, filename: item.ObjectName });
    }
  }
  return results;
}

// ── Главная функция ───────────────────────────────────────────────────────────
async function main() {
  console.log('🎵 Set Preview URLs — MP3 → Supabase');
  console.log(`   CDN: ${CDN_URL}`);
  console.log(`   MP3 folder: ${MP3_FOLDER}\n`);

  // 1. Сканируем MP3 папку на Bunny
  console.log('📂 Scanning MP3 folder on Bunny...');
  const mp3Files = await collectMp3Files('/' + MP3_FOLDER + '/');
  console.log(`   Found ${mp3Files.length} MP3 files`);

  if (mp3Files.length === 0) {
    console.log('   No MP3 files found. Check folder name.');
    return;
  }

  // Строим map: имя_файла_без_расширения → cdn url
  const mp3Map = {};
  mp3Files.forEach(f => { mp3Map[f.baseName] = f.cdnUrl; });

  // 2. Загружаем все семплы из Supabase батчами
  console.log('\n📊 Loading samples from Supabase...');
  let allSamples = [];
  let from = 0;
  const BATCH = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('samples')
      .select('id, url, preview_url')
      .range(from, from + BATCH - 1);
    if (error) { console.error('Supabase error:', error.message); break; }
    if (!data || data.length === 0) break;
    allSamples = allSamples.concat(data);
    if (data.length < BATCH) break;
    from += BATCH;
  }
  console.log(`   Loaded ${allSamples.length} samples`);

  // 3. Матчим WAV → MP3 по имени файла
  let matched = 0;
  let notFound = 0;
  let alreadySet = 0;
  const updates = [];

  allSamples.forEach(s => {
    // Извлекаем имя файла из WAV URL
    const urlDecoded = decodeURIComponent(s.url);
    const wavFilename = urlDecoded.split('/').pop(); // последний сегмент пути
    const baseName = wavFilename.replace(/\.wav$/i, '').toLowerCase().trim();

    const previewUrl = mp3Map[baseName];

    if (previewUrl) {
      if (s.preview_url === previewUrl) {
        alreadySet++;
      } else {
        matched++;
        updates.push({ id: s.id, preview_url: previewUrl });
      }
    } else {
      notFound++;
      if (notFound <= 5) {
        console.log(`   ⚠️  No MP3 for: ${wavFilename}`);
      }
    }
  });

  console.log(`\n📋 Results:`);
  console.log(`   ✅ To update: ${matched}`);
  console.log(`   ✓  Already set: ${alreadySet}`);
  console.log(`   ❌ No MP3 found: ${notFound}`);

  if (updates.length === 0) {
    console.log('\n   Nothing to update!');
    return;
  }

  // 4. Обновляем батчами по 50
  console.log(`\n🔄 Updating ${updates.length} records...`);
  const UPDATE_BATCH = 50;
  let updated = 0;

  for (let i = 0; i < updates.length; i += UPDATE_BATCH) {
    const batch = updates.slice(i, i + UPDATE_BATCH);
    // Обновляем каждый по отдельности (Supabase upsert по id)
    const promises = batch.map(u =>
      supabase.from('samples').update({ preview_url: u.preview_url }).eq('id', u.id)
    );
    await Promise.all(promises);
    updated += batch.length;
    process.stdout.write(`   ${updated}/${updates.length} updated...\r`);
  }

  console.log(`\n\n🎉 Done! Updated ${updated} preview URLs.`);
  console.log(`   ${notFound} WAV files have no matching MP3 — check filenames match.`);
}

main().catch(console.error);
