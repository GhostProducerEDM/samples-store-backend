/**
 * backfill-credits.js
 * Fetches all subscription orders from Lemon Squeezy and credits users in Supabase.
 * Run once: node scripts/backfill-credits.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const LS_API = 'https://api.lemonsqueezy.com/v1';
const HEADERS = {
  Authorization: `Bearer ${process.env.LEMONSQUEEZY_API_KEY}`,
  Accept: 'application/vnd.api+json',
};

const PLAN_CREDITS = {
  [process.env.LS_VARIANT_STARTER]:   { credits: 100,  plan: 'starter' },
  [process.env.LS_VARIANT_PRO]:       { credits: 350,  plan: 'pro' },
  [process.env.LS_VARIANT_UNLIMITED]: { credits: 1000, plan: 'unlimited' },
};

async function fetchAllOrders() {
  const orders = [];
  let url = `${LS_API}/orders?page[size]=100`;
  while (url) {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`LS API error: ${res.status} ${await res.text()}`);
    const json = await res.json();
    orders.push(...(json.data || []));
    url = json.links?.next || null;
    console.log(`Fetched ${orders.length} orders so far…`);
  }
  return orders;
}

async function main() {
  console.log('=== Backfill credits from Lemon Squeezy ===');

  const orders = await fetchAllOrders();
  console.log(`Total orders: ${orders.length}`);

  let credited = 0, skipped = 0, notFound = 0;

  for (const order of orders) {
    const attrs = order.attributes;
    if (attrs.status !== 'paid') { skipped++; continue; }

    const email = attrs.user_email;
    const variantId = String(attrs.first_order_item?.variant_id || '');
    const orderId = String(order.id);
    const planInfo = PLAN_CREDITS[variantId];

    if (!planInfo) { skipped++; continue; }

    // Find user by email
    const { data: user } = await supabase.from('users').select('id, credits').eq('email', email).single();
    if (!user) { console.log(`  NOT FOUND: ${email}`); notFound++; continue; }

    // Check if already credited (order already in subscriptions table)
    const { data: existing } = await supabase.from('subscriptions')
      .select('id').eq('user_id', user.id).eq('ls_order_id', orderId).single();
    if (existing) { skipped++; continue; }

    // Add credits
    await supabase.from('users').update({ credits: user.credits + planInfo.credits }).eq('id', user.id);
    await supabase.from('subscriptions').insert({
      user_id: user.id,
      plan: planInfo.plan,
      credits_added: planInfo.credits,
      ls_order_id: orderId,
    });

    console.log(`  ✓ ${email} +${planInfo.credits} credits (${planInfo.plan})`);
    credited++;
  }

  console.log(`\nDone. Credited: ${credited} | Skipped: ${skipped} | Not found: ${notFound}`);
}

main().catch(err => { console.error(err); process.exit(1); });
