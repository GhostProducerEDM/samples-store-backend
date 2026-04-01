// sync-bunny.js
// Запускать: node sync-bunny.js
// Читает все .wav файлы с Bunny CDN и добавляет новые в Supabase
// Уже существующие файлы не трогает

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const https = require('https');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const BUNNY_KEY  = process.env.BUNNY_STORAGE_KEY;
const BUNNY_ZONE = process.env.BUNNY_STORAGE_ZONE;
const CDN_URL    = process.env.BUNNY_CDN_URL; // https://gpe-samples.b-cdn.net
const REGION     = process.env.BUNNY_REGION || 'storage'; // storage / ny / la / sg / se

// ─── Парсер имён файлов ───────────────────────────────────────────────────────
// Обрабатывает все форматы:
//   "GPE - Astrona - Bass Loop 1 124BPM Cm"
//   "GPEMTH_Cymbal_One_Shot_001"
//   "GPEMTH_Drop_Loop_002_124BPM"
//   "All lost in the music (WET)"
//   "GPE - Minimal Bass - Synth Loop - 02 - (130) - (Emin)"

function parseSampleName(filename, folderPath) {
  // Убираем расширение
  const name = filename.replace(/\.(wav|mp3|aiff|flac)$/i, '');

  // --- BPM ---
  let bpm = null;
  const bpmMatch = name.match(/\b(\d{2,3})\s*(?:BPM|bpm)\b/) ||
                   name.match(/\((\d{2,3})\)/) ||
                   name.match(/[-_\s](\d{2,3})[-_\s]/);
  if (bpmMatch) {
    const val = parseInt(bpmMatch[1]);
    if (val >= 60 && val <= 200) bpm = val;
  }

  // --- Key / Тональность ---
  let key = null;
  const keyPatterns = [
    /\b([A-G][#b]?(?:min|maj|m|M)?)\b/,   // Cm, Emin, F#maj, G#m
    /\(([A-G][#b]?(?:min|maj|m)?)\)/,       // (Cm) (Emin)
  ];
  for (const pat of keyPatterns) {
    const m = name.match(pat);
    if (m) { key = m[1]; break; }
  }

  // --- Type (Loop / One Shot) ---
  let type = 'One Shot';
  if (/loop/i.test(name) || /loop/i.test(folderPath)) type = 'Loop';
  if (/one.?shot/i.test(name) || /one.?shot/i.test(folderPath)) type = 'One Shot';

  // --- Instrument из папки или имени ---
  const instrumentKeywords = [
    'Kick', 'Snare', 'HiHat', 'Hi-Hat', 'Clap', 'Cymbal', 'Crash', 'Ride', 'Tom',
    'Bass', 'Synth', 'Lead', 'Pad', 'Chord', 'Pluck', 'Arp',
    'Vocal', 'Vox', 'Voice', 'FX', 'Riser', 'Drop', 'Perc', 'Shaker',
    '808', 'Sub', 'Piano', 'Guitar', 'Keys'
  ];
  let instrument = null;
  for (const kw of instrumentKeywords) {
    if (new RegExp(kw, 'i').test(name) || new RegExp(kw, 'i').test(folderPath)) {
      instrument = kw.replace('-', ''); // HiHat
      break;
    }
  }
  if (!instrument) instrument = 'Other';

  // --- Genre из пути папки ---
  const genreMap = {
    'hardstyle': 'Hardstyle', 'rawstyle': 'Rawstyle', 'trap': 'Trap',
    'hiphop': 'Hip Hop', 'hip-hop': 'Hip Hop', 'house': 'House',
    'techno': 'Techno', 'edm': 'EDM', 'minimal': 'Minimal',
    'trance': 'Trance', 'ambient': 'Ambient', 'pop': 'Pop',
    'drum': 'Drums', 'bass': 'Bass Music', 'garage': 'Garage'
  };
  let genre = [];
  const pathLower = folderPath.toLowerCase();
  for (const [key, val] of Object.entries(genreMap)) {
    if (pathLower.includes(key)) genre.push(val);
  }

  // --- Pack name из пути ---
  const parts = folderPath.split('/').filter(Boolean);
  const pack = parts.length > 0 ? parts[0] : null;

  // --- Clean title ---
  const title = name
    .replace(/\b\d{2,3}\s*BPM\b/gi, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { title, bpm, key, type, instrument, genre, pack };
}

// ─── Получить список файлов с Bunny ─────────────────────────────────────────
function bunnyList(path = '/') {
  return new Promise((resolve, reject) => {
    const host = REGION === "storage" ? "storage.bunnycdn.com" : `${REGION}.storage.bunnycdn.com`;
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
        catch(e) { reject(new Error(`Parse error: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── Рекурсивно собрать все .wav файлы ──────────────────────────────────────
async function collectAllFiles(path = '/', results = []) {
  let items;
  try {
    items = await bunnyList(path);
  } catch(e) {
    console.error(`  ⚠️  Error listing ${path}: ${e.message}`);
    return results;
  }

  if (!Array.isArray(items)) {
    console.error(`  ⚠️  Unexpected response for ${path}:`, items);
    return results;
  }

  for (const item of items) {
    if (item.IsDirectory) {
      await collectAllFiles(path + item.ObjectName + '/', results);
    } else if (/\.(wav|mp3)$/i.test(item.ObjectName)) {
      results.push({
        filename: item.ObjectName,
        path: path,
        fullPath: path + item.ObjectName,
        cdnUrl: CDN_URL + path.split('/').map(p => encodeURIComponent(p)).join('/') + encodeURIComponent(item.ObjectName)
      });
    }
  }
  return results;
}

// ─── Главная функция ──────────────────────────────────────────────────────────
async function main() {
  console.log('🐰 Bunny → Supabase Sync');
  console.log(`   Zone: ${BUNNY_ZONE}`);
  console.log(`   CDN:  ${CDN_URL}`);
  console.log('');

  // 1. Получаем все файлы с Bunny
  console.log('📂 Scanning Bunny Storage...');
  const files = await collectAllFiles('/');
  console.log(`   Found ${files.length} audio files`);

  if (files.length === 0) {
    console.log('   No files found. Check BUNNY_STORAGE_ZONE and BUNNY_STORAGE_KEY.');
    return;
  }

  // 2. Получаем уже существующие URL в Supabase (чтобы не дублировать)
  const { data: existing } = await supabase
    .from('samples')
    .select('url');
  
  const existingUrls = new Set((existing || []).map(r => r.url));
  console.log(`📊 Already in Supabase: ${existingUrls.size} samples`);

  // 3. Фильтруем только новые
  const newFiles = files.filter(f => !existingUrls.has(f.cdnUrl));
  console.log(`✨ New files to add: ${newFiles.length}`);

  if (newFiles.length === 0) {
    console.log('   Everything is up to date!');
    return;
  }

  // 4. Парсим и вставляем батчами по 50
  // Build a map of MP3 filenames for quick lookup
  const mp3Files = files.filter(f => /\.mp3$/i.test(f.filename));
  const mp3Map = {};
  mp3Files.forEach(f => {
    const key = f.filename.replace(/\.mp3$/i, '').toLowerCase();
    mp3Map[key] = f.cdnUrl;
  });
  console.log(`🎵 MP3 previews found: ${mp3Files.length}`);

  const rows = newFiles
    .filter(f => /\.wav$/i.test(f.filename)) // only WAV for main samples
    .map(f => {
      const meta = parseSampleName(f.filename, f.path);
      // Match MP3 by filename (without extension)
      const baseName = f.filename.replace(/\.wav$/i, '').toLowerCase();
      const previewUrl = mp3Map[baseName] || null;
      return {
        title:       meta.title || f.filename,
        url:         f.cdnUrl,
        preview_url: previewUrl,
        bpm:         meta.bpm,
        key:         meta.key,
        type:        meta.type,
        instrument:  meta.instrument,
        genre:       meta.genre.length > 0 ? meta.genre : null,
        pack:        meta.pack ? decodeURIComponent(meta.pack) : null,
        cover:       null,
      };
    });

  // Preview первых 3
  console.log('\n📋 Preview (first 3):');
  rows.slice(0, 3).forEach(r => {
    console.log(`   "${r.title}" | ${r.instrument} | ${r.bpm || '-'} BPM | ${r.key || '-'} | ${r.type} | pack: ${r.pack || '-'}`);
  });
  console.log('');

  // Вставка батчами
  const BATCH = 50;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await supabase.from('samples').insert(batch);
    if (error) {
      console.error(`   ❌ Batch ${i}-${i + BATCH} error:`, error.message);
    } else {
      inserted += batch.length;
      process.stdout.write(`   ✅ ${inserted}/${rows.length} inserted...\r`);
    }
  }

  console.log(`\n\n🎉 Done! Added ${inserted} new samples to Supabase.`);
}

main().catch(console.error);
