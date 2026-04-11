// MailMate Telegram Bot v3
// Stripe-ready · Onboarding · Multi-stijl · Concept verfijnen · Follow-up · Team · Rapportage
require('dotenv').config();
const TelegramBot      = require('node-telegram-bot-api');
const Anthropic        = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

// ── CONFIG ────────────────────────────────────────────
const BOT_TOKEN     = process.env.BOT_TOKEN;
const ADMIN_ID      = parseInt(process.env.ADMIN_ID);
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const MINI_APP_URL  = process.env.MINI_APP_URL;
const PORT          = process.env.PORT || 3000;
const WEBHOOK_URL   = process.env.WEBHOOK_URL;
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_KEY;
const STRIPE_KEY    = process.env.STRIPE_SECRET_KEY; // Zet in Railway als je Stripe activeert
const STRIPE_ACTIVE = !!STRIPE_KEY;

const bot       = new TelegramBot(BOT_TOKEN, WEBHOOK_URL ? { webHook: true } : { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
const supabase  = createClient(SUPABASE_URL, SUPABASE_KEY);

// Stripe optioneel laden
let stripe = null;
if (STRIPE_ACTIVE) {
  stripe = require('stripe')(STRIPE_KEY);
  console.log('💳 Stripe actief');
} else {
  console.log('💳 Stripe niet geconfigureerd — demo modus');
}

// Express voor webhook + Stripe webhook
const express = require('express');
const app = express();
app.use((req, res, next) => {
  if (req.path === '/stripe-webhook') express.raw({ type: 'application/json' })(req, res, next);
  else express.json()(req, res, next);
});

// Health check — Railway gebruikt dit om te zien of de app draait
app.get('/', (req, res) => res.send('MailMate OK'));
app.get('/health', (req, res) => res.send('OK'));

// Telegram webhook route
app.post(`/bot${BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Stripe webhook endpoint
app.post('/stripe-webhook', async (req, res) => {
  if (!STRIPE_ACTIVE) return res.sendStatus(200);
  const sig = req.headers['stripe-signature'];
  try {
    const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    if (event.type === 'checkout.session.completed') {
      const session    = event.data.object;
      const telegramId = parseInt(session.metadata.telegram_id);
      const credits    = parseInt(session.metadata.credits);
      const user       = await getUser(telegramId, '');
      if (user) {
        await saveUser(telegramId, { credits: user.credits + credits });
        bot.sendMessage(telegramId,
          `✅ *Betaling ontvangen!*\n\n*${credits} credits* toegevoegd.\nNieuw saldo: *${user.credits + credits} credits*`,
          { parse_mode: 'Markdown', reply_markup: mainKeyboard(telegramId) }
        );
      }
    }
  } catch(e) { console.error('Stripe webhook fout:', e.message); }
  res.sendStatus(200);
});

// Start server — webhook wordt automatisch gezet via WEBHOOK_URL variable
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✉ MailMate v3 draait op poort ${PORT}`);
  if (WEBHOOK_URL) {
    bot.setWebHook(`${WEBHOOK_URL}/bot${BOT_TOKEN}`)
      .then(() => console.log(`✅ Webhook actief`))
      .catch(e => console.error('Webhook fout:', e.message));
  }
});

// ── KENNISBASIS ──────────────────────────────────────
// Dynamisch op basis van vakgebied van de gebruiker
function buildBaseKnowledge(vakgebied, doel, toon) {
  return `
Jij bent een professionele e-mail assistent.

VAKGEBIED: ${vakgebied || 'Algemeen'}
DOEL VAN DE MAILS: ${doel || 'Professionele communicatie'}
TOON VOORKEUR: ${toon || 'Professioneel en vriendelijk'}

GEDRAGSREGELS:
- Schrijf altijd passend bij het vakgebied en doel
- Gebruik vaktermen die horen bij: ${vakgebied || 'het opgegeven vakgebied'}
- Houd rekening met de toon voorkeur: ${toon || 'professioneel'}
- Geen AI-uitleg — alleen het conceptantwoord
- Bij twijfel over specifieke details: verwijs naar een persoonlijk gesprek
  `.trim();
}


// ── SESSION STATE ─────────────────────────────────────
const sessionState = new Map();
function getState(id) {
  if (!sessionState.has(id)) sessionState.set(id, { step: 'idle', lastConcept: '', lastIncoming: '', activeStyle: 'default' });
  return sessionState.get(id);
}

// ── SUPABASE ──────────────────────────────────────────
async function getUser(telegramId, name) {
  try {
    const { data } = await supabase.from('users').select('*').eq('telegram_id', telegramId).single();
    if (data) return data;
    const { data: newUser, error: insertError } = await supabase.from('users')
      .insert({ telegram_id: telegramId, name: name || 'Gebruiker', credits: 10, concept_count: 0,
                style_profiles: JSON.stringify({ default: '' }), active_style: 'default',
                user_knowledge: '', onboarded: false })
      .select().single();
    if (insertError) { console.error('Insert fout:', JSON.stringify(insertError)); }
    return newUser || { telegram_id: telegramId, name: name||'Gebruiker', credits: 10, concept_count: 0, style_profiles: JSON.stringify({default:''}), active_style: 'default', user_knowledge: '', onboarded: false };
  } catch(e) {
    console.error('getUser fout:', e.message);
    return { telegram_id: telegramId, name: name||'Gebruiker', credits: 10, concept_count: 0, style_profiles: JSON.stringify({default:''}), active_style: 'default', user_knowledge: '', onboarded: false };
  }
}

async function saveUser(telegramId, updates) {
  await supabase.from('users').update({ ...updates, updated_at: new Date().toISOString() }).eq('telegram_id', telegramId);
}

async function addHistory(telegramId, subject, concept) {
  await supabase.from('history').insert({ telegram_id: telegramId, subject, concept, created_at: new Date().toISOString() });
}

async function getHistory(telegramId, limit = 10) {
  const { data } = await supabase.from('history').select('*').eq('telegram_id', telegramId).order('created_at', { ascending: false }).limit(limit);
  return data || [];
}

async function getAllUsers() {
  const { data } = await supabase.from('users').select('*').order('created_at', { ascending: false });
  return data || [];
}

async function getGlobalKnowledge() {
  const { data } = await supabase.from('global_knowledge').select('content').order('created_at', { ascending: true });
  return data ? data.map(d => d.content).join('\n\n---\n\n') : '';
}

async function addGlobalKnowledge(title, content) {
  await supabase.from('global_knowledge').insert({ title, content, created_at: new Date().toISOString() });
}

async function listGlobalKnowledge() {
  const { data } = await supabase.from('global_knowledge').select('id, title').order('created_at', { ascending: false });
  return data || [];
}

async function deleteGlobalKnowledge(id) {
  await supabase.from('global_knowledge').delete().eq('id', id);
}

// Follow-up herinneringen opslaan
async function scheduleFollowUp(telegramId, subject) {
  await supabase.from('followups').insert({ telegram_id: telegramId, subject, remind_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), sent: false });
}

async function getPendingFollowUps() {
  const { data } = await supabase.from('followups').select('*').eq('sent', false).lte('remind_at', new Date().toISOString());
  return data || [];
}

// ── SYSTEM PROMPT ─────────────────────────────────────
async function buildSystemPrompt(user, styleName = 'default') {
  const profiles     = JSON.parse(user.style_profiles || '{"default":""}');
  const activeProfile = profiles[styleName] || profiles['default'] || '';
  const globalExtra  = await getGlobalKnowledge();
  const vakgebied    = user.vakgebied || '';
  const doel         = user.doel || '';
  const toon         = user.toon_voorkeur || '';

  return `Je bent een professionele e-mail assistent.
Je schrijft conceptantwoorden in de schrijfstijl van de gebruiker.

════════════════════════════════
SCHRIJFSTIJL — ${styleName.toUpperCase()}
════════════════════════════════
${activeProfile || 'Nog niet getraind — schrijf professioneel en vriendelijk.'}

════════════════════════════════
PROFIEL VAN DEZE GEBRUIKER
════════════════════════════════
${buildBaseKnowledge(vakgebied, doel, toon)}

${globalExtra ? `════════════════════════════════
GLOBALE KENNISBANK (admin)
════════════════════════════════
${globalExtra}` : ''}

${user.user_knowledge ? `════════════════════════════════
PERSOONLIJKE KENNISBANK
════════════════════════════════
${user.user_knowledge}` : ''}

════════════════════════════════
REGELS
════════════════════════════════
- Schrijf ALTIJD in de opgegeven schrijfstijl
- Gebruik terminologie passend bij het vakgebied
- Geef ALLEEN het conceptantwoord — geen uitleg of commentaar`;
}

// ── STRIPE BETAALLINK ─────────────────────────────────
async function createStripeCheckout(telegramId, credits, priceEur) {
  if (!STRIPE_ACTIVE) return null;
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card', 'ideal'],
    line_items: [{ price_data: {
      currency: 'eur',
      product_data: { name: `MailMate — ${credits} credits` },
      unit_amount: priceEur * 100,
    }, quantity: 1 }],
    mode: 'payment',
    success_url: `${WEBHOOK_URL}/betaling-succes?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  `${WEBHOOK_URL}/betaling-geannuleerd`,
    metadata: { telegram_id: telegramId.toString(), credits: credits.toString() },
  });
  return session.url;
}

// ── KEYBOARDS ─────────────────────────────────────────
const isAdmin = (id) => id === ADMIN_ID;

function mainKeyboard(userId) {
  const b = [
    [{ text: '✍ Concept schrijven',  callback_data: 'compose'  }],
    [{ text: '◈ Stijl trainen',      callback_data: 'train'    }],
    [{ text: '📚 Kennisbank',        callback_data: 'myknow'   }],
    [{ text: '◷ Geschiedenis',       callback_data: 'history'  }],
    [{ text: '◆ Credits kopen',      callback_data: 'credits'  }],
    [{ text: '📱 Open Mini App',     web_app: { url: MINI_APP_URL } }],
  ];
  if (isAdmin(userId)) b.push([{ text: '⚙ Admin paneel', callback_data: 'admin' }]);
  return { inline_keyboard: b };
}

function creditsKeyboard(userId) {
  return { inline_keyboard: [
    [{ text: '50 credits — €9',   callback_data: 'buy_50_9'   },
     { text: '200 credits — €29', callback_data: 'buy_200_29' }],
    [{ text: '600 credits — €79', callback_data: 'buy_600_79' }],
  ]};
}

// ── CLAUDE ────────────────────────────────────────────
async function callClaude(userMsg, systemMsg = '', maxTokens = 1200) {
  const params = { model: 'claude-sonnet-4-20250514', max_tokens: maxTokens, messages: [{ role: 'user', content: userMsg }] };
  if (systemMsg) params.system = systemMsg;
  const res = await anthropic.messages.create(params);
  return res.content.map(b => b.text || '').join('');
}

// ── ONBOARDING ────────────────────────────────────────
async function startOnboarding(userId, firstName) {
  await bot.sendMessage(userId,
    `✉ *Welkom bij MailMate, ${firstName}!*\n\n` +
    `Ik ben jouw persoonlijke AI e-mail assistent.\n\n` +
    `Laten we je in 4 stappen instellen:\n\n` +
    `*Stap 1 van 4 — Jouw vakgebied*\n\n` +
    `In welk vakgebied werk je en wat is het doel van jouw e-mails?\n\n` +
    `Beschrijf dit kort, bijv:\n` +
    `• _Assurantiekantoor — klantadvies en polisbeheer_\n` +
    `• _Bouwbedrijf — offertes en projectopvolging_\n` +
    `• _Webshop — klantenservice en klachtenafhandeling_\n` +
    `• _ZZP coach — intake en sessie-opvolging_\n\n` +
    `_Of tik /skip om later in te stellen._`,
    { parse_mode: 'Markdown' }
  );
  getState(userId).step = 'onboard_vakgebied';
}

// ── /START ────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const { id, first_name } = msg.from;
  let user;
  try {
    user = await getUser(id, first_name);
  } catch(e) {
    console.error('Start fout bij getUser:', e.message);
    user = { telegram_id: id, name: first_name, credits: 10, concept_count: 0, style_profiles: '{"default":""}', active_style: 'default', user_knowledge: '', onboarded: false };
  }
  if (!user) {
    user = { telegram_id: id, name: first_name, credits: 10, concept_count: 0, style_profiles: '{"default":""}', active_style: 'default', user_knowledge: '', onboarded: false };
  }

  if (!user.onboarded) {
    await startOnboarding(id, first_name);
    return;
  }

  const profiles = JSON.parse(user.style_profiles || '{"default":""}');
  const styleNames = Object.keys(profiles).filter(k => profiles[k]);

  bot.sendMessage(id,
    `✉ *Welkom terug, ${first_name}!*\n\n` +
    `📊 Saldo: *${user.credits} credits*\n` +
    `◈ Stijlen: ${styleNames.length > 0 ? styleNames.join(', ') : '✗ Geen'}\n` +
    `📚 Kennisbank: ${user.user_knowledge ? '✓ Gevuld' : '✗ Leeg'}\n\n` +
    `Wat wil je doen?`,
    { parse_mode: 'Markdown', reply_markup: mainKeyboard(id) }
  );
});

bot.onText(/\/skip/, async (msg) => {
  const { id, first_name } = msg.from;
  const s = getState(id);

  if (s.step === 'onboard_vakgebied') {
    await saveUser(id, { vakgebied: 'Algemeen', doel: 'Professionele communicatie' });
    s.step = 'onboard_toon';
    bot.sendMessage(id,
      `✓ Overgeslagen.\n\n*Stap 2 van 4 — Toon voorkeur*\n\nWelke toon gebruik jij?`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '👔 Formeel', callback_data: 'toon_formeel' }],
        [{ text: '😊 Informeel', callback_data: 'toon_informeel' }],
        [{ text: '⚖️ Mix', callback_data: 'toon_mix' }],
      ]}}
    );
  } else if (s.step === 'onboard_style') {
    s.step = 'onboard_knowledge';
    bot.sendMessage(id,
      `✓ Stijl overgeslagen.\n\n*Stap 4 van 4 — Kennisbank*\n\nVoeg info toe die je agent moet kennen, of tik /skip.`,
      { parse_mode: 'Markdown' }
    );
  } else if (s.step === 'onboard_knowledge') {
    await saveUser(id, { onboarded: true });
    s.step = 'idle';
    bot.sendMessage(id,
      `✅ *Setup compleet!*\n\nJe agent is klaar. Stuur een mail om je eerste concept te schrijven.`,
      { parse_mode: 'Markdown', reply_markup: mainKeyboard(id) }
    );
  }
});

// ── FOLLOW-UP CHECKER (elke 6 uur) ───────────────────
setInterval(async () => {
  const pending = await getPendingFollowUps();
  for (const f of pending) {
    try {
      await bot.sendMessage(f.telegram_id,
        `🔔 *Follow-up herinnering*\n\nHeb je al geantwoord op:\n_"${f.subject}"_\n\nWil je een nieuw concept?`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
          [{ text: '✍ Nieuw concept', callback_data: 'compose' }, { text: '✓ Al verzonden', callback_data: `followup_done_${f.id}` }],
        ]}}
      );
      await supabase.from('followups').update({ sent: true }).eq('id', f.id);
    } catch(e) { console.error('Follow-up fout:', e.message); }
  }
}, 6 * 60 * 60 * 1000);

// ── LOW CREDITS CHECKER (dagelijks) ──────────────────
setInterval(async () => {
  const users = await getAllUsers();
  for (const u of users) {
    if (u.credits > 0 && u.credits <= 5) {
      try {
        await bot.sendMessage(u.telegram_id,
          `⚠️ *Bijna geen credits meer!*\n\nJe hebt nog *${u.credits} credit${u.credits === 1 ? '' : 's'}*.\n\nKoop credits om door te gaan:`,
          { parse_mode: 'Markdown', reply_markup: creditsKeyboard(u.telegram_id) }
        );
      } catch(e) {}
    }
  }
}, 24 * 60 * 60 * 1000);

// ── CALLBACKS ─────────────────────────────────────────
bot.on('callback_query', async (query) => {
  const { id: userId, first_name } = query.from;
  const data = query.data;
  const s    = getState(userId);
  bot.answerCallbackQuery(query.id);
  const user = await getUser(userId, first_name);

  // Follow-up done
  if (data.startsWith('followup_done_')) {
    const fid = data.replace('followup_done_', '');
    await supabase.from('followups').update({ sent: true }).eq('id', fid);
    return bot.sendMessage(userId, '✓ Gemarkeerd als verzonden.', { reply_markup: mainKeyboard(userId) });
  }

  // ── COMPOSE ──
  if (data === 'compose') {
    if (user.credits < 1) return bot.sendMessage(userId, '⚠️ Onvoldoende credits.', { reply_markup: creditsKeyboard(userId) });
    const profiles   = JSON.parse(user.style_profiles || '{"default":""}');
    const styleNames = Object.keys(profiles).filter(k => profiles[k]);

    if (styleNames.length > 1) {
      // Meerdere stijlen — laat kiezen
      const buttons = styleNames.map(n => [{ text: `◈ ${n}`, callback_data: `compose_style_${n}` }]);
      return bot.sendMessage(userId, '◈ *Kies een schrijfstijl:*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
    }

    s.step = 'awaiting_mail';
    s.activeStyle = styleNames[0] || 'default';
    bot.sendMessage(userId, '📨 *Inkomende mail*\n\nPlak de tekst van de mail waarop je wil antwoorden.', { parse_mode: 'Markdown' });
  }

  else if (data.startsWith('compose_style_')) {
    const styleName = data.replace('compose_style_', '');
    s.step = 'awaiting_mail';
    s.activeStyle = styleName;
    bot.sendMessage(userId, `📨 *Inkomende mail* (stijl: ${styleName})\n\nPlak de tekst van de mail.`, { parse_mode: 'Markdown' });
  }

  // ── VERFIJN CONCEPT ──
  else if (data === 'refine') {
    if (!s.lastConcept) return bot.sendMessage(userId, '⚠️ Geen concept om te verfijnen.', { reply_markup: mainKeyboard(userId) });
    s.step = 'awaiting_refine';
    bot.sendMessage(userId,
      '✏️ *Concept verfijnen*\n\nGeef een instructie, bijv:\n• _Maak hem korter_\n• _Voeg een disclaimer toe_\n• _Iets formeler_\n• _Verander de afsluiting_',
      { parse_mode: 'Markdown' }
    );
  }

  // ── STIJL TRAINEN ──
  else if (data === 'train') {
    if (user.credits < 3) return bot.sendMessage(userId, '⚠️ Minimaal 3 credits nodig.', { reply_markup: creditsKeyboard(userId) });
    const profiles   = JSON.parse(user.style_profiles || '{"default":""}');
    const styleNames = Object.keys(profiles);
    bot.sendMessage(userId,
      `◈ *Schrijfstijl trainen*\n\nJe hebt nu ${styleNames.length} stijl(en): ${styleNames.join(', ')}\n\nKies:`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '+ Nieuwe stijl aanmaken',     callback_data: 'train_new'     }],
        ...styleNames.map(n => [{ text: `◈ "${n}" hertrainen`, callback_data: `train_existing_${n}` }]),
      ]}}
    );
  }

  else if (data === 'train_new') {
    s.step = 'awaiting_style_name';
    bot.sendMessage(userId, '◈ Geef een naam voor de nieuwe stijl.\n\nBijv: _formeel_, _informeel_, _zakelijk_', { parse_mode: 'Markdown' });
  }

  else if (data.startsWith('train_existing_')) {
    const styleName = data.replace('train_existing_', '');
    s.step = 'awaiting_train';
    s.trainStyleName = styleName;
    bot.sendMessage(userId, `◈ *Stijl "${styleName}" hertrainen*\n\nStuur 5+ eigen e-mails, gescheiden door ——`, { parse_mode: 'Markdown' });
  }

  // ── KENNISBANK ──
  else if (data === 'myknow') {
    const preview = user.user_knowledge ? user.user_knowledge.slice(0, 200) + '...' : 'Leeg';
    bot.sendMessage(userId,
      `📚 *Jouw kennisbank*\n\n_${preview}_\n\nVoeg kantoorspecifieke info toe:`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '+ Tekst toevoegen',      callback_data: 'myknow_add'   }],
        [{ text: '📄 PDF uploaden',        callback_data: 'myknow_pdf'   }],
        [{ text: '🗑 Leegmaken',           callback_data: 'myknow_clear' }],
        [{ text: '← Terug',               callback_data: 'home'         }],
      ]}}
    );
  }

  else if (data === 'myknow_add') { s.step = 'awaiting_user_knowledge'; bot.sendMessage(userId, '📝 Stuur de tekst die je wil toevoegen.'); }
  else if (data === 'myknow_pdf') { s.step = 'awaiting_user_pdf';       bot.sendMessage(userId, '📄 Stuur een PDF.'); }
  else if (data === 'myknow_clear') {
    await saveUser(userId, { user_knowledge: '' });
    bot.sendMessage(userId, '✅ Kennisbank leeggemaakt.', { reply_markup: mainKeyboard(userId) });
  }

  // ── GESCHIEDENIS ──
  else if (data === 'history') {
    const hist = await getHistory(userId, 8);
    if (hist.length === 0) return bot.sendMessage(userId, '◷ Nog geen geschiedenis.', { reply_markup: mainKeyboard(userId) });
    const text = hist.map((h, i) => `${i+1}. _${h.subject}_ — ${new Date(h.created_at).toLocaleDateString('nl-NL')}`).join('\n');
    bot.sendMessage(userId, `◷ *Laatste ${hist.length} concepten:*\n\n${text}`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '← Terug', callback_data: 'home' }]] } });
  }

  // ── CREDITS ──
  else if (data === 'credits') {
    bot.sendMessage(userId, `◆ *Credits kopen*\n\nSaldo: *${user.credits} credits*\n\nKies een pakket:${STRIPE_ACTIVE ? '' : '\n\n_Demo: credits worden direct toegevoegd._'}`,
      { parse_mode: 'Markdown', reply_markup: creditsKeyboard(userId) }
    );
  }

  else if (data.startsWith('buy_')) {
    const [, amount, price] = data.split('_');
    if (STRIPE_ACTIVE) {
      try {
        const url = await createStripeCheckout(userId, parseInt(amount), parseInt(price));
        bot.sendMessage(userId,
          `💳 *${amount} credits voor €${price}*\n\nKlik hieronder om veilig te betalen via Stripe (iDEAL, creditcard):`,
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: `💳 Betaal €${price} via Stripe`, url }]] } }
        );
      } catch(e) { bot.sendMessage(userId, `❌ Stripe fout: ${e.message}`); }
    } else {
      bot.sendMessage(userId, `💳 *${amount} credits voor €${price}*\n\n_Demo modus: credits direct toegevoegd._`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: `✓ Bevestig ${amount} credits (demo)`, callback_data: `confirm_${amount}` }]] } }
      );
    }
  }

  else if (data.startsWith('confirm_')) {
    const amount = parseInt(data.split('_')[1]);
    await saveUser(userId, { credits: user.credits + amount });
    bot.sendMessage(userId, `✅ *${amount} credits toegevoegd!*\n\nNieuw saldo: *${user.credits + amount} credits*`, { parse_mode: 'Markdown', reply_markup: mainKeyboard(userId) });
  }

  // ── ADMIN ──
  else if (data === 'admin' && isAdmin(userId)) {
    const all    = await getAllUsers();
    const gklist = await listGlobalKnowledge();
    const list   = all.slice(0, 6).map(u => `\n• *${u.name}* — ${u.credits}cr · ${u.concept_count} concepten`).join('');
    bot.sendMessage(userId,
      `⚙ *Admin paneel*\n\n👥 ${all.length} gebruikers\n◆ ${all.reduce((s,u)=>s+u.credits,0)} credits\n✍ ${all.reduce((s,u)=>s+u.concept_count,0)} concepten\n📚 ${gklist.length} kennisitems\n💳 Stripe: ${STRIPE_ACTIVE ? '✅' : '✗ Demo'}\n\n*Recente gebruikers:*${list}`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '📚 Globale kennisbank',    callback_data: 'admin_knowledge'    }],
        [{ text: '+ Credits geven',          callback_data: 'admin_give_credits' }],
        [{ text: '📊 Rapport',               callback_data: 'admin_report'       }],
        [{ text: '🔑 API & Stripe status',   callback_data: 'admin_api'          }],
      ]}}
    );
  }

  else if (data === 'admin_knowledge' && isAdmin(userId)) {
    const list = await listGlobalKnowledge();
    const items = list.length > 0 ? list.map((k,i) => `${i+1}. ${k.title}`).join('\n') : 'Leeg';
    bot.sendMessage(userId, `📚 *Globale kennisbank*\n\nGeldt voor ALLE gebruikers.\n\n${items}`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '+ Tekst toevoegen', callback_data: 'admin_know_add' }],
        [{ text: '📄 PDF uploaden',   callback_data: 'admin_know_pdf' }],
        [{ text: '🗑 Verwijderen',    callback_data: 'admin_know_del' }],
        [{ text: '← Terug',          callback_data: 'admin'          }],
      ]}}
    );
  }

  else if (data === 'admin_know_add' && isAdmin(userId)) { s.step = 'admin_awaiting_knowledge'; bot.sendMessage(userId, '📝 Stuur tekst. Eerste regel = titel.\n\n`Productnaam\nInhoud hier...`', { parse_mode: 'Markdown' }); }
  else if (data === 'admin_know_pdf' && isAdmin(userId)) { s.step = 'admin_awaiting_pdf'; bot.sendMessage(userId, '📄 Stuur een PDF voor de globale kennisbank.'); }

  else if (data === 'admin_know_del' && isAdmin(userId)) {
    const list = await listGlobalKnowledge();
    if (!list.length) return bot.sendMessage(userId, 'Niets te verwijderen.');
    bot.sendMessage(userId, '🗑 Kies item:',
      { reply_markup: { inline_keyboard: [...list.map(k => [{ text: `🗑 ${k.title}`, callback_data: `admin_del_${k.id}` }]), [{ text: '← Terug', callback_data: 'admin_knowledge' }]] } }
    );
  }

  else if (data.startsWith('admin_del_') && isAdmin(userId)) {
    await deleteGlobalKnowledge(parseInt(data.replace('admin_del_', '')));
    bot.sendMessage(userId, '✅ Verwijderd.', { reply_markup: mainKeyboard(userId) });
  }

  else if (data === 'admin_api' && isAdmin(userId)) {
    bot.sendMessage(userId,
      `🔑 *Status*\n\nAnthropisch API: ${ANTHROPIC_KEY ? '✅' : '❌'}\nSupabase: ${SUPABASE_URL ? '✅' : '❌'}\nStripe: ${STRIPE_ACTIVE ? '✅ Actief' : '✗ Demo (STRIPE_SECRET_KEY niet ingesteld)'}\n\nModel: claude-sonnet-4-20250514`,
      { parse_mode: 'Markdown' }
    );
  }

  else if (data === 'admin_give_credits' && isAdmin(userId)) { s.step = 'admin_awaiting_credits'; bot.sendMessage(userId, '👤 Stuur: `TELEGRAM_ID AANTAL`', { parse_mode: 'Markdown' }); }

  else if (data === 'admin_report' && isAdmin(userId)) {
    const all = await getAllUsers();
    const today = new Date().toLocaleDateString('nl-NL');
    let r = `📊 *Rapport — ${today}*\n\n`;
    r += `👥 Totaal gebruikers: ${all.length}\n`;
    r += `◆ Credits in omloop: ${all.reduce((s,u)=>s+u.credits,0)}\n`;
    r += `✍ Concepten totaal: ${all.reduce((s,u)=>s+u.concept_count,0)}\n`;
    r += `◈ Getraind: ${all.filter(u=>{ try{ const p=JSON.parse(u.style_profiles||'{}'); return Object.values(p).some(v=>v); }catch{return false;} }).length}\n\n`;
    all.slice(0,10).forEach(u => { r += `*${u.name}* — ${u.credits}cr · ${u.concept_count} concepten\n`; });
    if (r.length > 3800) r = r.slice(0, 3800) + '\n_...meer..._';
    bot.sendMessage(userId, r, { parse_mode: 'Markdown' });
  }

  // ── TOON SELECTIE (onboarding stap 2) ──
  else if (data.startsWith('toon_')) {
    const toonMap = { toon_formeel: 'Formeel', toon_informeel: 'Informeel', toon_mix: 'Mix (situatie-afhankelijk)' };
    const toon = toonMap[data] || 'Professioneel';
    await saveUser(userId, { toon_voorkeur: toon });
    getState(userId).step = 'onboard_style';
    bot.sendMessage(userId,
      `✅ *Toon opgeslagen: ${toon}*\n\n*Stap 3 van 4 — Schrijfstijl*\n\nStuur me 5 of meer e-mails die jij zelf hebt geschreven (gescheiden door ——). Ik leer hieruit precies hoe jij schrijft.\n\n_Heb je geen mails bij de hand? Tik /skip om later te trainen._`,
      { parse_mode: 'Markdown' }
    );
  }

  // ── HOME ──
  else if (data === 'home') {
    s.step = 'idle';
    const fresh = await getUser(userId, first_name);
    bot.sendMessage(userId, `✉ *MailMate*\n\nSaldo: *${fresh.credits} credits*`,
      { parse_mode: 'Markdown', reply_markup: mainKeyboard(userId) }
    );
  }
});

// ── BERICHTEN ─────────────────────────────────────────
bot.on('message', async (msg) => {
  if (msg.text && msg.text.startsWith('/')) return;
  const { id: userId, first_name } = msg.from;
  const s    = getState(userId);
  const text = msg.text?.trim() || '';
  const user = await getUser(userId, first_name);

  // ── PDF verwerking ──
  if (msg.document) {
    const isPdf = s.step === 'awaiting_user_pdf' || s.step === 'admin_awaiting_pdf';
    if (!isPdf) return;
    try {
      const fileUrl  = await bot.getFileLink(msg.document.file_id);
      const res      = await fetch(fileUrl);
      const buffer   = await res.arrayBuffer();
      const pdfParse = require('pdf-parse');
      const pdfData  = await pdfParse(Buffer.from(buffer));
      const extracted = pdfData.text.slice(0, 8000);
      const fname     = msg.document.file_name || 'document.pdf';

      if (s.step === 'awaiting_user_pdf') {
        const updated = ((user.user_knowledge || '') + `\n\n## ${fname}\n${extracted}`).slice(0, 12000);
        await saveUser(userId, { user_knowledge: updated });
        s.step = 'idle';
        bot.sendMessage(userId, `✅ *PDF verwerkt!*\n_${fname}_ · ${pdfData.numpages} pagina's toegevoegd aan jouw kennisbank.`, { parse_mode: 'Markdown', reply_markup: mainKeyboard(userId) });
      } else if (s.step === 'admin_awaiting_pdf' && isAdmin(userId)) {
        await addGlobalKnowledge(fname, extracted);
        s.step = 'idle';
        bot.sendMessage(userId, `✅ *PDF in globale kennisbank!*\n_${fname}_ · ${pdfData.numpages} pagina's.`, { parse_mode: 'Markdown', reply_markup: mainKeyboard(userId) });
      }
    } catch(e) {
      s.step = 'idle';
      bot.sendMessage(userId, `❌ PDF fout: ${e.message}\n\nPlak de tekst handmatig.`);
    }
    return;
  }

  if (!text) return;

  // ── ONBOARDING: vakgebied ──
  if (s.step === 'onboard_vakgebied') {
    // Parse vakgebied en optioneel toon
    const parts = text.split('—').map(p => p.trim());
    const vakgebied = parts[0] || text;
    const doel = parts[1] || '';
    await saveUser(userId, { vakgebied, doel });
    s.step = 'onboard_toon';
    bot.sendMessage(userId,
      `✅ *Vakgebied opgeslagen!*\n\n*Stap 2 van 4 — Toon voorkeur*\n\nWelke toon gebruik jij in je e-mails?`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '👔 Formeel',           callback_data: 'toon_formeel'   }],
        [{ text: '😊 Informeel',         callback_data: 'toon_informeel' }],
        [{ text: '⚖️ Mix (situatie-afhankelijk)', callback_data: 'toon_mix' }],
      ]}}
    );
    return;
  }

  // ── ONBOARDING: stijl ──
  if (s.step === 'onboard_style') {
    if (text.length < 80) return bot.sendMessage(userId, '⚠️ Te kort. Stuur meer mails of tik /skip.');
    const load = await bot.sendMessage(userId, '◈ _Stijl analyseren..._', { parse_mode: 'Markdown' });
    try {
      const vakgebied = user.vakgebied || 'algemeen';
      const profile = await callClaude(`Analyseer de schrijfstijl van onderstaande e-mails (vakgebied: ${vakgebied}). Compact stijlprofiel in max 200 woorden: toon, je/u, aanhef, afsluiting, zinslengte, directheid, specifieke uitdrukkingen.\n\nE-MAILS:\n${text}`);
      const profiles = { default: profile };
      await saveUser(userId, { style_profiles: JSON.stringify(profiles), credits: user.credits - 3 });
      bot.deleteMessage(userId, load.message_id).catch(()=>{});
      s.step = 'onboard_knowledge';
      bot.sendMessage(userId,
        `✅ *Stijl geleerd!* (3 credits)\n\n*Stap 4 van 4 — Kennisbank*\n\nVoeg specifieke info toe die de agent moet weten: producten, diensten, veelgestelde vragen, voorwaarden.\n\n_Tik /skip om later toe te voegen._`,
        { parse_mode: 'Markdown' }
      );
    } catch(e) {
      bot.deleteMessage(userId, load.message_id).catch(()=>{});
      bot.sendMessage(userId, `❌ Fout: ${e.message}`);
    }
    return;
  }

  // ── ONBOARDING: kennisbank ──
  if (s.step === 'onboard_knowledge') {
    await saveUser(userId, { user_knowledge: text.slice(0, 12000), onboarded: true });
    s.step = 'idle';
    bot.sendMessage(userId,
      `✅ *Kennisbank gevuld!*\n\n*Stap 3 van 3 — Klaar!* 🎉\n\nJe bent volledig ingesteld. Je kunt nu concepten schrijven in jouw stijl, met jouw kantoorkennis én de assurantiekennisbasis.\n\nWat wil je doen?`,
      { parse_mode: 'Markdown', reply_markup: mainKeyboard(userId) }
    );
    return;
  }

  // ── STIJLNAAM ──
  if (s.step === 'awaiting_style_name') {
    s.trainStyleName = text.toLowerCase().trim();
    s.step = 'awaiting_train';
    bot.sendMessage(userId, `◈ *Stijl "${s.trainStyleName}" trainen*\n\nStuur 5+ eigen mails, gescheiden door ——`, { parse_mode: 'Markdown' });
    return;
  }

  // ── ADMIN: credits geven ──
  if (s.step === 'admin_awaiting_credits' && isAdmin(userId)) {
    const [tid, amt] = text.split(' ');
    const targetId = parseInt(tid), amount = parseInt(amt);
    if (!isNaN(targetId) && !isNaN(amount)) {
      const target = await getUser(targetId, '');
      if (target) {
        await saveUser(targetId, { credits: target.credits + amount });
        s.step = 'idle';
        return bot.sendMessage(userId, `✅ ${amount} credits aan ${targetId}. Saldo: ${target.credits + amount}`, { reply_markup: mainKeyboard(userId) });
      }
    }
    return bot.sendMessage(userId, '⚠️ Formaat: `123456789 50`', { parse_mode: 'Markdown' });
  }

  // ── ADMIN: globale kennis ──
  if (s.step === 'admin_awaiting_knowledge' && isAdmin(userId)) {
    const lines = text.split('\n');
    const title = lines[0].trim();
    const content = lines.slice(1).join('\n').trim() || text;
    await addGlobalKnowledge(title, content);
    s.step = 'idle';
    bot.sendMessage(userId, `✅ *"${title}"* toegevoegd aan globale kennisbank.`, { parse_mode: 'Markdown', reply_markup: mainKeyboard(userId) });
    return;
  }

  // ── GEBRUIKER: kennisbank ──
  if (s.step === 'awaiting_user_knowledge') {
    const updated = ((user.user_knowledge || '') + '\n\n' + text).slice(0, 12000);
    await saveUser(userId, { user_knowledge: updated });
    s.step = 'idle';
    bot.sendMessage(userId, `✅ Toegevoegd aan jouw kennisbank.`, { reply_markup: mainKeyboard(userId) });
    return;
  }

  // ── STIJL TRAINEN ──
  if (s.step === 'awaiting_train') {
    if (text.length < 100) return bot.sendMessage(userId, '⚠️ Te weinig tekst (min 100 tekens).');
    const load = await bot.sendMessage(userId, '◈ _Stijl analyseren..._', { parse_mode: 'Markdown' });
    try {
      const profile   = await callClaude(`Analyseer schrijfstijl van deze assurantie e-mails. Compact profiel max 200 woorden: toon, je/u, aanhef, afsluiting, zinslengte, directheid, vaktermen.\n\nE-MAILS:\n${text}`);
      const styleName = s.trainStyleName || 'default';
      const profiles  = JSON.parse(user.style_profiles || '{"default":""}');
      profiles[styleName] = profile;
      await saveUser(userId, { style_profiles: JSON.stringify(profiles), credits: user.credits - 3 });
      s.step = 'idle';
      bot.deleteMessage(userId, load.message_id).catch(()=>{});
      bot.sendMessage(userId,
        `✅ *Stijl "${styleName}" getraind!* (3 credits)\n\n_${profile.slice(0,220)}..._\n\nSaldo: *${user.credits-3} credits*`,
        { parse_mode: 'Markdown', reply_markup: mainKeyboard(userId) }
      );
    } catch(e) {
      bot.deleteMessage(userId, load.message_id).catch(()=>{});
      bot.sendMessage(userId, `❌ Fout: ${e.message}`);
    }
    return;
  }

  // ── CONCEPT VERFIJNEN ──
  if (s.step === 'awaiting_refine') {
    if (!s.lastConcept) return bot.sendMessage(userId, '⚠️ Geen concept beschikbaar.', { reply_markup: mainKeyboard(userId) });
    const load = await bot.sendMessage(userId, '✏️ _Concept aanpassen..._', { parse_mode: 'Markdown' });
    try {
      const refined = await callClaude(
        `Pas het volgende e-mail concept aan op basis van de instructie. Geef ALLEEN het aangepaste concept terug.\n\nHUIDIG CONCEPT:\n${s.lastConcept}\n\nINSTRUCTIE:\n${text}`,
        'Je bent een e-mail assistent. Pas het concept aan zoals gevraagd. Geef alleen het resultaat terug, geen uitleg.'
      );
      s.lastConcept = refined;
      s.step = 'idle';
      bot.deleteMessage(userId, load.message_id).catch(()=>{});
      bot.sendMessage(userId,
        `✉ *Aangepast concept:*\n\n${refined}\n\n_— Geen extra credit gebruikt —_`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
          [{ text: '✏️ Nogmaals aanpassen', callback_data: 'refine'  },
           { text: '↩ Herschrijven',       callback_data: 'compose' }],
          [{ text: '🏠 Home', callback_data: 'home' }],
        ]}}
      );
    } catch(e) {
      bot.deleteMessage(userId, load.message_id).catch(()=>{});
      bot.sendMessage(userId, `❌ Fout: ${e.message}`);
    }
    return;
  }

  // ── CONCEPT GENEREREN ──
  if (s.step === 'awaiting_mail') {
    if (text.length < 20) return bot.sendMessage(userId, '⚠️ Mail te kort.');
    const load = await bot.sendMessage(userId, '✍ _Concept schrijven..._', { parse_mode: 'Markdown' });
    try {
      const systemPrompt = await buildSystemPrompt(user, s.activeStyle || 'default');
      const reply = await callClaude(`Schrijf een conceptantwoord op deze inkomende mail:\n\n${text}`, systemPrompt);

      s.lastConcept  = reply;
      s.lastIncoming = text;
      s.step = 'idle';

      await saveUser(userId, { credits: user.credits - 1, concept_count: user.concept_count + 1 });
      const subj = (text.match(/(?:Onderwerp|Subject):\s*(.+)/)||['','Mail'])[1];
      await addHistory(userId, subj, reply);
      await scheduleFollowUp(userId, subj);

      bot.deleteMessage(userId, load.message_id).catch(()=>{});
      bot.sendMessage(userId,
        `✉ *Concept antwoord:*\n\n${reply}\n\n_— 1 credit · saldo: ${user.credits-1} —_`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
          [{ text: '✏️ Verfijnen',    callback_data: 'refine'  },
           { text: '↩ Herschrijven', callback_data: 'compose' }],
          [{ text: '🏠 Home', callback_data: 'home' },
           { text: '📱 Mini App', web_app: { url: MINI_APP_URL } }],
        ]}}
      );
    } catch(e) {
      bot.deleteMessage(userId, load.message_id).catch(()=>{});
      bot.sendMessage(userId, `❌ Fout: ${e.message}`, { reply_markup: mainKeyboard(userId) });
    }
    return;
  }

  bot.sendMessage(userId, `Gebruik de knoppen 👇`, { reply_markup: mainKeyboard(userId) });
});

console.log('✉ MailMate v3 gestart — Stripe · Onboarding · Multi-stijl · Verfijnen · Follow-up · Rapport');
