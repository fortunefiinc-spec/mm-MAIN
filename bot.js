// MailMate Telegram Bot v4
// Tier 1: Geheugen, Mail analyse, Verfijnen
// Tier 2: Batch, Onderwerpregel, Klantendossier, Templates
// Tier 3: Outlook/Gmail webhook, Team, Sentiment, A/B, API
require('dotenv').config();
const TelegramBot      = require('node-telegram-bot-api');
const Anthropic        = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const express          = require('express');

const BOT_TOKEN     = process.env.BOT_TOKEN;
const ADMIN_ID      = parseInt(process.env.ADMIN_ID);
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const MINI_APP_URL  = process.env.MINI_APP_URL;
const PORT          = process.env.PORT || 3000;
const WEBHOOK_URL   = process.env.WEBHOOK_URL;
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_KEY;
const STRIPE_KEY    = process.env.STRIPE_SECRET_KEY;
const STRIPE_ACTIVE = !!STRIPE_KEY;

const bot       = new TelegramBot(BOT_TOKEN, WEBHOOK_URL ? { webHook: true } : { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
const supabase  = createClient(SUPABASE_URL, SUPABASE_KEY);

let stripe = null;
if (STRIPE_ACTIVE) { stripe = require('stripe')(STRIPE_KEY); console.log('Stripe actief'); }
else { console.log('Stripe demo modus'); }

const app = express();
app.use((req, res, next) => {
  if (req.path === '/stripe-webhook') express.raw({ type: 'application/json' })(req, res, next);
  else express.json()(req, res, next);
});

app.get('/', (req, res) => res.send('MailMate v4 OK'));
app.get('/health', (req, res) => res.json({ status: 'ok', version: '4.0.0' }));
app.post('/bot' + BOT_TOKEN, (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });

// Stripe webhook
app.post('/stripe-webhook', async (req, res) => {
  if (!STRIPE_ACTIVE) return res.sendStatus(200);
  try {
    const event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
    if (event.type === 'checkout.session.completed') {
      const { telegram_id, credits } = event.data.object.metadata;
      const user = await getUser(parseInt(telegram_id), '');
      if (user) {
        const newTotal = user.credits + parseInt(credits);
        await saveUser(parseInt(telegram_id), { credits: newTotal });
        bot.sendMessage(parseInt(telegram_id), '*' + credits + ' credits toegevoegd! Saldo: ' + newTotal + '*', { parse_mode: 'Markdown', reply_markup: mainKeyboard(parseInt(telegram_id)) });
      }
    }
  } catch(e) { console.error('Stripe:', e.message); }
  res.sendStatus(200);
});

// Outlook/Gmail webhook via Zapier/Make
app.post('/mailhook/:userId', async (req, res) => {
  const telegramId = parseInt(req.params.userId);
  const apiKey     = req.headers['x-api-key'];
  const user = await getUser(telegramId, '');
  if (!user || user.webhook_key !== apiKey) return res.status(401).json({ error: 'Unauthorized' });

  const { subject, from, body } = req.body;
  if (!body) return res.status(400).json({ error: 'body required' });

  try {
    const mailText     = 'Van: ' + (from||'') + '\nOnderwerp: ' + (subject||'') + '\n\n' + body;
    const analysis     = await analyzeMail(mailText);
    const systemPrompt = await buildSystemPrompt(user);
    const concept      = await callClaude('Schrijf een conceptantwoord:\n\n' + mailText, systemPrompt);
    const subjectLine  = await generateSubjectLine(subject, concept);

    await saveUser(telegramId, { credits: user.credits - 1, concept_count: user.concept_count + 1 });
    await addHistory(telegramId, subject || 'Mail via webhook', concept);
    if (from) await upsertClient(telegramId, from, subject, body);

    const sentimentIcon = analysis.sentiment === 'urgent' ? 'URGENT' : analysis.sentiment === 'negatief' ? 'Negatief' : 'Normaal';

    bot.sendMessage(telegramId,
      '*Nieuwe mail via webhook*\n\nVan: ' + from + '\nOnderwerp: ' + subject + '\n' + sentimentIcon + '\n\n*Concept:*\n\n' + concept + '\n\n_Onderwerpregel: ' + subjectLine + '_\n\n_1 credit - saldo: ' + (user.credits-1) + '_',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: 'Verfijnen', callback_data: 'refine' }, { text: 'Herschrijven', callback_data: 'compose' }],
        [{ text: 'Home', callback_data: 'home' }],
      ]}}
    );

    res.json({ success: true, concept, subject_line: subjectLine, sentiment: analysis.sentiment });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Externe API
app.post('/api/compose', async (req, res) => {
  const { telegram_id, api_key, mail_text } = req.body;
  const user = await getUser(parseInt(telegram_id), '');
  if (!user || user.webhook_key !== api_key) return res.status(401).json({ error: 'Unauthorized' });
  if (user.credits < 1) return res.status(402).json({ error: 'Insufficient credits' });
  try {
    const systemPrompt = await buildSystemPrompt(user);
    const concept = await callClaude('Schrijf een conceptantwoord:\n\n' + mail_text, systemPrompt);
    const subjectLine = await generateSubjectLine('', concept);
    await saveUser(parseInt(telegram_id), { credits: user.credits - 1, concept_count: user.concept_count + 1 });
    res.json({ concept, subject_line: subjectLine, credits_remaining: user.credits - 1 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('MailMate v4 draait op poort ' + PORT);
  if (WEBHOOK_URL) {
    bot.setWebHook(WEBHOOK_URL + '/bot' + BOT_TOKEN)
      .then(() => console.log('Webhook actief'))
      .catch(e => console.error('Webhook fout:', e.message));
  }
});

// SUPABASE
function generateApiKey() { return 'mm_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); }

function fallbackUser(telegramId, name) {
  return { telegram_id: telegramId, name: name||'Gebruiker', credits: 10, concept_count: 0,
           style_profiles: '{"default":""}', active_style: 'default', user_knowledge: '',
           onboarded: false, vakgebied: '', doel: '', toon_voorkeur: '', webhook_key: '' };
}

async function getUser(telegramId, name) {
  try {
    const { data } = await supabase.from('users').select('*').eq('telegram_id', telegramId).single();
    if (data) return data;
    const { data: newUser, error } = await supabase.from('users')
      .insert({ telegram_id: telegramId, name: name||'Gebruiker', credits: 10, concept_count: 0,
                style_profiles: JSON.stringify({ default: '' }), active_style: 'default',
                user_knowledge: '', onboarded: false, vakgebied: '', doel: '', toon_voorkeur: '',
                webhook_key: generateApiKey() })
      .select().single();
    if (error) console.error('Insert fout:', JSON.stringify(error));
    return newUser || fallbackUser(telegramId, name);
  } catch(e) { console.error('getUser:', e.message); return fallbackUser(telegramId, name); }
}

async function saveUser(telegramId, updates) {
  await supabase.from('users').update({ ...updates, updated_at: new Date().toISOString() }).eq('telegram_id', telegramId);
}

async function addHistory(telegramId, subject, concept) {
  await supabase.from('history').insert({ telegram_id: telegramId, subject, concept: concept||'', created_at: new Date().toISOString() });
}

async function getHistory(telegramId, limit) {
  const { data } = await supabase.from('history').select('*').eq('telegram_id', telegramId).order('created_at', { ascending: false }).limit(limit||10);
  return data || [];
}

async function getAllUsers() {
  const { data } = await supabase.from('users').select('*').order('created_at', { ascending: false });
  return data || [];
}

async function upsertClient(telegramId, email, subject, lastMailText) {
  if (!email) return;
  const { data: existing } = await supabase.from('clients').select('*').eq('telegram_id', telegramId).eq('email', email).single();
  if (existing) {
    await supabase.from('clients').update({ contact_count: (existing.contact_count||0)+1, last_subject: subject, last_contact: new Date().toISOString() }).eq('id', existing.id);
  } else {
    await supabase.from('clients').insert({ telegram_id: telegramId, email, last_subject: subject, contact_count: 1, last_contact: new Date().toISOString(), notes: '' });
  }
}

async function getClient(telegramId, email) {
  if (!email) return null;
  const { data } = await supabase.from('clients').select('*').eq('telegram_id', telegramId).eq('email', email).single();
  return data;
}

async function getClients(telegramId) {
  const { data } = await supabase.from('clients').select('*').eq('telegram_id', telegramId).order('last_contact', { ascending: false });
  return data || [];
}

async function getTemplates(telegramId) {
  const { data } = await supabase.from('templates').select('*').eq('telegram_id', telegramId).order('created_at', { ascending: false });
  return data || [];
}

async function saveTemplate(telegramId, name, content) {
  await supabase.from('templates').insert({ telegram_id: telegramId, name, content, created_at: new Date().toISOString() });
}

async function deleteTemplate(id) {
  await supabase.from('templates').delete().eq('id', id);
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

async function scheduleFollowUp(telegramId, subject) {
  await supabase.from('followups').insert({ telegram_id: telegramId, subject, remind_at: new Date(Date.now() + 7*24*60*60*1000).toISOString(), sent: false });
}

// AI FUNCTIES
async function analyzeMail(mailText) {
  try {
    const result = await callClaude(
      'Analyseer deze e-mail. Geef ALLEEN valide JSON terug:\n{"type":"klacht|offerte|info|opvolging|vraag|bedankt|overig","sentiment":"positief|neutraal|negatief|urgent","urgentie":"laag|middel|hoog","afzender_naam":"naam","kernvraag":"max 10 woorden"}\n\nE-MAIL:\n' + mailText.slice(0, 1500),
      'Analyseer e-mails en retourneer alleen valide JSON.'
    );
    return JSON.parse(result.replace(/```json|```/g, '').trim());
  } catch(e) { return { type: 'overig', sentiment: 'neutraal', urgentie: 'middel', afzender_naam: '', kernvraag: '' }; }
}

async function generateSubjectLine(originalSubject, concept) {
  try {
    const result = await callClaude(
      'Genereer een professionele onderwerpregel. Geef ALLEEN de onderwerpregel terug.\n\nOrigineel: ' + (originalSubject||'onbekend') + '\n\nConcept:\n' + concept.slice(0, 500),
      'Genereer bondige professionele e-mail onderwerpregels.'
    );
    return result.trim().replace(/^"(.*)"$/, '$1');
  } catch(e) { return originalSubject ? 'Re: ' + originalSubject : 'Antwoord op uw bericht'; }
}

async function generateABVersions(mailText, systemPrompt) {
  const [formal, informal] = await Promise.all([
    callClaude('Schrijf een FORMEEL conceptantwoord:\n\n' + mailText, systemPrompt + '\n\nEXTRA: Schrijf extra formeel, gebruik "u".'),
    callClaude('Schrijf een INFORMEEL conceptantwoord:\n\n' + mailText, systemPrompt + '\n\nEXTRA: Schrijf informeler en toegankelijker.')
  ]);
  return { formal, informal };
}

function buildBaseKnowledge(vakgebied, doel, toon) {
  return 'VAKGEBIED: ' + (vakgebied||'Algemeen') + '\nDOEL: ' + (doel||'Professionele communicatie') + '\nTOON: ' + (toon||'Professioneel en vriendelijk');
}

async function buildSystemPrompt(user, styleName, clientInfo) {
  styleName = styleName || 'default';
  const profiles      = JSON.parse(user.style_profiles || '{"default":""}');
  const activeProfile = profiles[styleName] || profiles['default'] || '';
  const globalExtra   = await getGlobalKnowledge();

  let clientContext = '';
  if (clientInfo) {
    clientContext = '\n\nKLANTENDOSSIER:\nE-mail: ' + clientInfo.email + '\nEerder contact: ' + (clientInfo.contact_count||0) + ' keer\nLaatste onderwerp: ' + (clientInfo.last_subject||'n.v.t.') + '\nNotities: ' + (clientInfo.notes||'geen');
  }

  return 'Je bent een professionele e-mail assistent. Schrijf conceptantwoorden in de stijl van de gebruiker.\n\nSCHRIJFSTIJL:\n' + (activeProfile||'Schrijf professioneel en vriendelijk.') + '\n\nGEBRUIKERSPROFIEL:\n' + buildBaseKnowledge(user.vakgebied, user.doel, user.toon_voorkeur) + clientContext + (globalExtra ? '\n\nGLOBALE KENNISBANK:\n' + globalExtra : '') + (user.user_knowledge ? '\n\nPERSOONLIJKE KENNISBANK:\n' + user.user_knowledge : '') + '\n\nREGELS:\n- Schrijf in de opgegeven stijl\n- Gebruik vakgebied-terminologie\n- Geef ALLEEN het conceptantwoord';
}

async function callClaude(userMsg, systemMsg, maxTokens) {
  maxTokens = maxTokens || 1200;
  const params = { model: 'claude-sonnet-4-20250514', max_tokens: maxTokens, messages: [{ role: 'user', content: userMsg }] };
  if (systemMsg) params.system = systemMsg;
  const res = await anthropic.messages.create(params);
  return res.content.map(b => b.text || '').join('');
}

async function createStripeCheckout(telegramId, credits, priceEur) {
  if (!STRIPE_ACTIVE) return null;
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card', 'ideal'],
    line_items: [{ price_data: { currency: 'eur', product_data: { name: 'MailMate ' + credits + ' credits' }, unit_amount: priceEur * 100 }, quantity: 1 }],
    mode: 'payment',
    success_url: WEBHOOK_URL + '/betaling-succes',
    cancel_url:  WEBHOOK_URL + '/betaling-geannuleerd',
    metadata: { telegram_id: telegramId.toString(), credits: credits.toString() },
  });
  return session.url;
}

// SESSION
const sessionState = new Map();
function getState(id) {
  if (!sessionState.has(id)) sessionState.set(id, { step: 'idle', lastConcept: '', lastIncoming: '', activeStyle: 'default', lastAnalysis: null, trainStyleName: null });
  return sessionState.get(id);
}

// KEYBOARDS
const isAdmin = (id) => id === ADMIN_ID;

function mainKeyboard(userId) {
  const b = [
    [{ text: 'Concept schrijven',   callback_data: 'compose'   }],
    [{ text: 'Batch (meerdere)',     callback_data: 'batch'     }],
    [{ text: 'Stijl trainen',        callback_data: 'train'     }],
    [{ text: 'Kennisbank',           callback_data: 'myknow'    }],
    [{ text: 'Klantendossier',       callback_data: 'clients'   }],
    [{ text: 'Templates',            callback_data: 'templates' }],
    [{ text: 'Webhook instellen',    callback_data: 'webhook'   }],
    [{ text: 'Geschiedenis',         callback_data: 'history'   }],
    [{ text: 'Credits kopen',        callback_data: 'credits'   }],
    [{ text: 'Open Mini App',        web_app: { url: MINI_APP_URL } }],
  ];
  if (isAdmin(userId)) b.push([{ text: 'Admin paneel', callback_data: 'admin' }]);
  return { inline_keyboard: b };
}

function creditsKeyboard() {
  return { inline_keyboard: [
    [{ text: '50 credits - 9 euro', callback_data: 'buy_50_9' }, { text: '200 credits - 29 euro', callback_data: 'buy_200_29' }],
    [{ text: '600 credits - 79 euro', callback_data: 'buy_600_79' }],
  ]};
}

// ONBOARDING
async function startOnboarding(userId, firstName) {
  await bot.sendMessage(userId,
    '*Welkom bij MailMate, ' + firstName + '!*\n\nIk ben jouw persoonlijke AI e-mail assistent.\n\n*Stap 1 van 4 - Jouw vakgebied*\n\nIn welk vakgebied werk je?\n\nBijv: Assurantiekantoor - klantadvies\nOf: Bouwbedrijf - offertes\n\n_Tik /skip om later in te stellen._',
    { parse_mode: 'Markdown' }
  );
  getState(userId).step = 'onboard_vakgebied';
}

bot.onText(/\/skip/, async (msg) => {
  const { id, first_name } = msg.from;
  const s = getState(id);
  if (s.step === 'onboard_vakgebied') {
    await saveUser(id, { vakgebied: 'Algemeen', doel: 'Professionele communicatie' });
    s.step = 'onboard_toon';
    bot.sendMessage(id, '*Stap 2 van 4 - Toon voorkeur*\n\nWelke toon gebruik jij?',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: 'Formeel', callback_data: 'toon_formeel' }],
        [{ text: 'Informeel', callback_data: 'toon_informeel' }],
        [{ text: 'Mix', callback_data: 'toon_mix' }],
      ]}}
    );
  } else if (s.step === 'onboard_style') {
    s.step = 'onboard_knowledge';
    bot.sendMessage(id, '*Stap 4 van 4 - Kennisbank*\n\nVoeg info toe of tik /skip.', { parse_mode: 'Markdown' });
  } else if (s.step === 'onboard_knowledge') {
    await saveUser(id, { onboarded: true });
    s.step = 'idle';
    bot.sendMessage(id, '*Setup compleet! Je agent is klaar.*', { parse_mode: 'Markdown', reply_markup: mainKeyboard(id) });
  }
});

bot.onText(/\/start/, async (msg) => {
  const { id, first_name } = msg.from;
  let user;
  try { user = await getUser(id, first_name); }
  catch(e) { user = fallbackUser(id, first_name); }
  if (!user) user = fallbackUser(id, first_name);

  if (!user.onboarded) { await startOnboarding(id, first_name); return; }

  bot.sendMessage(id,
    '*Welkom terug, ' + first_name + '!*\n\nSaldo: *' + user.credits + ' credits*\nVakgebied: ' + (user.vakgebied||'niet ingesteld'),
    { parse_mode: 'Markdown', reply_markup: mainKeyboard(id) }
  );
});

bot.onText(/\/webhook_info/, async (msg) => {
  const { id } = msg.from;
  const user = await getUser(id, '');
  bot.sendMessage(id,
    '*Jouw webhook info*\n\nURL:\n`' + WEBHOOK_URL + '/mailhook/' + id + '`\n\nAPI Key:\n`' + (user.webhook_key||'nog niet aangemaakt') + '`\n\nGebruik in Zapier/Make:\nPOST naar URL met header x-api-key en body: {"subject":"...","from":"...","body":"..."}',
    { parse_mode: 'Markdown' }
  );
});

// CALLBACKS
bot.on('callback_query', async (query) => {
  const { id: userId, first_name } = query.from;
  const data = query.data;
  const s    = getState(userId);
  bot.answerCallbackQuery(query.id);
  const user = await getUser(userId, first_name);

  if (data.startsWith('toon_')) {
    const map = { toon_formeel: 'Formeel', toon_informeel: 'Informeel', toon_mix: 'Mix' };
    await saveUser(userId, { toon_voorkeur: map[data]||'Professioneel' });
    s.step = 'onboard_style';
    bot.sendMessage(userId, '*Toon: ' + map[data] + '*\n\n*Stap 3 van 4 - Schrijfstijl*\n\nStuur 5+ eigen mails (gescheiden door ——).\n\n_Tik /skip om later te trainen._', { parse_mode: 'Markdown' });
    return;
  }

  if (data === 'followup_done_' || data.startsWith('followup_done_')) {
    const fid = data.replace('followup_done_', '');
    if (fid) await supabase.from('followups').update({ sent: true }).eq('id', fid);
    bot.sendMessage(userId, 'Gemarkeerd als verzonden.', { reply_markup: mainKeyboard(userId) });
    return;
  }

  if (data === 'compose') {
    if (user.credits < 1) return bot.sendMessage(userId, 'Onvoldoende credits.', { reply_markup: creditsKeyboard() });
    const profiles   = JSON.parse(user.style_profiles || '{"default":""}');
    const styleNames = Object.keys(profiles).filter(k => profiles[k]);
    if (styleNames.length > 1) {
      s.step = 'awaiting_mail';
      return bot.sendMessage(userId, 'Kies een schrijfstijl:', { reply_markup: { inline_keyboard: styleNames.map(n => [{ text: n, callback_data: 'compose_style_' + n }]) } });
    }
    s.step = 'awaiting_mail';
    s.activeStyle = styleNames[0] || 'default';
    bot.sendMessage(userId, '*Inkomende mail*\n\nPlak de tekst van de mail.', { parse_mode: 'Markdown' });
  }

  else if (data.startsWith('compose_style_')) {
    s.activeStyle = data.replace('compose_style_', '');
    s.step = 'awaiting_mail';
    bot.sendMessage(userId, '*Inkomende mail* (stijl: ' + s.activeStyle + ')\n\nPlak de tekst.', { parse_mode: 'Markdown' });
  }

  else if (data === 'batch') {
    if (user.credits < 1) return bot.sendMessage(userId, 'Onvoldoende credits.', { reply_markup: creditsKeyboard() });
    s.step = 'awaiting_batch';
    bot.sendMessage(userId, '*Batch modus*\n\nStuur meerdere mails gescheiden door:\n`===MAIL===`\n\n_Per mail 1 credit._', { parse_mode: 'Markdown' });
  }

  else if (data === 'ab_versions') {
    if (!s.lastIncoming) return bot.sendMessage(userId, 'Geen mail beschikbaar.', { reply_markup: mainKeyboard(userId) });
    if (user.credits < 2) return bot.sendMessage(userId, 'A/B kost 2 credits.', { reply_markup: creditsKeyboard() });
    const load = await bot.sendMessage(userId, '_Twee versies genereren..._', { parse_mode: 'Markdown' });
    try {
      const systemPrompt = await buildSystemPrompt(user, s.activeStyle || 'default');
      const { formal, informal } = await generateABVersions(s.lastIncoming, systemPrompt);
      await saveUser(userId, { credits: user.credits - 2, concept_count: user.concept_count + 2 });
      bot.deleteMessage(userId, load.message_id).catch(()=>{});
      bot.sendMessage(userId, '*A/B Versies* (2 credits)\n\n*FORMEEL:*\n' + formal + '\n\n---\n\n*INFORMEEL:*\n' + informal, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Home', callback_data: 'home' }]] } });
    } catch(e) { bot.deleteMessage(userId, load.message_id).catch(()=>{}); bot.sendMessage(userId, 'Fout: ' + e.message); }
  }

  else if (data === 'refine') {
    if (!s.lastConcept) return bot.sendMessage(userId, 'Geen concept beschikbaar.', { reply_markup: mainKeyboard(userId) });
    s.step = 'awaiting_refine';
    bot.sendMessage(userId, '*Concept verfijnen*\n\nGeef een instructie:\n- Maak korter\n- Formeler/informeler\n- Voeg disclaimer toe', { parse_mode: 'Markdown' });
  }

  else if (data === 'templates') {
    const templates = await getTemplates(userId);
    if (templates.length === 0) return bot.sendMessage(userId, 'Nog geen templates.', { reply_markup: { inline_keyboard: [[{ text: 'Terug', callback_data: 'home' }]] } });
    bot.sendMessage(userId, '*Jouw templates (' + templates.length + '):*',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        ...templates.map(t => [{ text: t.name, callback_data: 'use_template_' + t.id }, { text: 'Verwijder', callback_data: 'del_template_' + t.id }]),
        [{ text: 'Terug', callback_data: 'home' }],
      ]}}
    );
  }

  else if (data.startsWith('use_template_')) {
    const tid = parseInt(data.replace('use_template_', ''));
    const templates = await getTemplates(userId);
    const tmpl = templates.find(t => t.id === tid);
    if (tmpl) {
      s.lastConcept = tmpl.content;
      bot.sendMessage(userId, '*Template: ' + tmpl.name + '*\n\n' + tmpl.content, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Verfijnen', callback_data: 'refine' }],[{ text: 'Home', callback_data: 'home' }]] } });
    }
  }

  else if (data.startsWith('del_template_')) {
    await deleteTemplate(parseInt(data.replace('del_template_', '')));
    bot.sendMessage(userId, 'Template verwijderd.', { reply_markup: mainKeyboard(userId) });
  }

  else if (data === 'save_template') {
    if (!s.lastConcept) return bot.sendMessage(userId, 'Geen concept om op te slaan.');
    s.step = 'awaiting_template_name';
    bot.sendMessage(userId, 'Geef een naam voor dit template:');
  }

  else if (data === 'clients') {
    const clients = await getClients(userId);
    if (clients.length === 0) return bot.sendMessage(userId, 'Nog geen klanten in dossier.', { reply_markup: { inline_keyboard: [[{ text: 'Terug', callback_data: 'home' }]] } });
    const list = clients.slice(0, 8).map(c => c.email + ' - ' + (c.contact_count||0) + 'x - ' + (c.last_subject||'')).join('\n');
    bot.sendMessage(userId, '*Klantendossier (' + clients.length + '):*\n\n' + list, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Terug', callback_data: 'home' }]] } });
  }

  else if (data === 'webhook') {
    const webhookKey = user.webhook_key || generateApiKey();
    if (!user.webhook_key) await saveUser(userId, { webhook_key: webhookKey });
    bot.sendMessage(userId,
      '*Outlook en Gmail koppeling*\n\nGebruik in Zapier of Make:\n\nWebhook URL:\n`' + WEBHOOK_URL + '/mailhook/' + userId + '`\n\nAPI Key (header x-api-key):\n`' + webhookKey + '`\n\nBody JSON:\n`{"subject":"...","from":"...","body":"..."}`\n\nZapier stappen:\n1. Trigger: Gmail of Outlook nieuwe mail\n2. Action: Webhooks POST\n3. URL: bovenstaande URL\n4. Headers: x-api-key = jouw key\n5. Body: subject, from, body uit trigger',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: 'Nieuwe API key', callback_data: 'webhook_reset' }],
        [{ text: 'Terug', callback_data: 'home' }],
      ]}}
    );
  }

  else if (data === 'webhook_reset') {
    const newKey = generateApiKey();
    await saveUser(userId, { webhook_key: newKey });
    bot.sendMessage(userId, 'Nieuwe API key:\n`' + newKey + '`', { parse_mode: 'Markdown', reply_markup: mainKeyboard(userId) });
  }

  else if (data === 'train') {
    if (user.credits < 3) return bot.sendMessage(userId, 'Minimaal 3 credits nodig.', { reply_markup: creditsKeyboard() });
    const profiles   = JSON.parse(user.style_profiles || '{"default":""}');
    const styleNames = Object.keys(profiles);
    bot.sendMessage(userId, '*Schrijfstijl trainen*\n\nJe hebt ' + styleNames.length + ' stijl(en): ' + styleNames.join(', '),
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '+ Nieuwe stijl', callback_data: 'train_new' }],
        ...styleNames.map(n => [{ text: n + ' hertrainen', callback_data: 'train_existing_' + n }]),
      ]}}
    );
  }

  else if (data === 'train_new') { s.step = 'awaiting_style_name'; bot.sendMessage(userId, 'Naam voor de nieuwe stijl (bijv: formeel, zakelijk):'); }
  else if (data.startsWith('train_existing_')) {
    s.trainStyleName = data.replace('train_existing_', '');
    s.step = 'awaiting_train';
    bot.sendMessage(userId, '*Stijl "' + s.trainStyleName + '" hertrainen*\n\nStuur 5+ eigen mails, gescheiden door ——', { parse_mode: 'Markdown' });
  }

  else if (data === 'myknow') {
    bot.sendMessage(userId, '*Kennisbank*\n\n' + (user.user_knowledge ? user.user_knowledge.slice(0,200)+'...' : 'Leeg'),
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '+ Toevoegen', callback_data: 'myknow_add' }],
        [{ text: 'PDF uploaden', callback_data: 'myknow_pdf' }],
        [{ text: 'Leegmaken',   callback_data: 'myknow_clear' }],
        [{ text: 'Terug',       callback_data: 'home' }],
      ]}}
    );
  }

  else if (data === 'myknow_add') { s.step = 'awaiting_user_knowledge'; bot.sendMessage(userId, 'Stuur de tekst die je wil toevoegen.'); }
  else if (data === 'myknow_pdf') { s.step = 'awaiting_user_pdf'; bot.sendMessage(userId, 'Stuur een PDF.'); }
  else if (data === 'myknow_clear') { await saveUser(userId, { user_knowledge: '' }); bot.sendMessage(userId, 'Kennisbank leeggemaakt.', { reply_markup: mainKeyboard(userId) }); }

  else if (data === 'history') {
    const hist = await getHistory(userId, 8);
    if (!hist.length) return bot.sendMessage(userId, 'Nog geen geschiedenis.', { reply_markup: mainKeyboard(userId) });
    const text = hist.map((h, i) => (i+1) + '. ' + h.subject + ' - ' + new Date(h.created_at).toLocaleDateString('nl-NL')).join('\n');
    bot.sendMessage(userId, '*Laatste concepten:*\n\n' + text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Terug', callback_data: 'home' }]] } });
  }

  else if (data === 'credits') {
    bot.sendMessage(userId, '*Credits kopen*\n\nSaldo: *' + user.credits + ' credits*' + (STRIPE_ACTIVE ? '' : '\n\n_Demo modus_'), { parse_mode: 'Markdown', reply_markup: creditsKeyboard() });
  }

  else if (data.startsWith('buy_')) {
    const parts  = data.split('_');
    const amount = parseInt(parts[1]);
    const price  = parseInt(parts[2]);
    if (STRIPE_ACTIVE) {
      try {
        const url = await createStripeCheckout(userId, amount, price);
        bot.sendMessage(userId, '*' + amount + ' credits voor euro ' + price + '*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Betaal via Stripe', url }]] } });
      } catch(e) { bot.sendMessage(userId, 'Stripe fout: ' + e.message); }
    } else {
      bot.sendMessage(userId, '*' + amount + ' credits voor euro ' + price + '* (demo)', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Bevestig demo', callback_data: 'confirm_' + amount }]] } });
    }
  }

  else if (data.startsWith('confirm_')) {
    const amount = parseInt(data.split('_')[1]);
    await saveUser(userId, { credits: user.credits + amount });
    bot.sendMessage(userId, '*' + amount + ' credits toegevoegd! Saldo: ' + (user.credits+amount) + '*', { parse_mode: 'Markdown', reply_markup: mainKeyboard(userId) });
  }

  else if (data === 'admin' && isAdmin(userId)) {
    const all = await getAllUsers();
    const gk  = await listGlobalKnowledge();
    bot.sendMessage(userId,
      '*Admin paneel*\n\n' + all.length + ' gebruikers\n' + all.reduce((s,u)=>s+u.credits,0) + ' credits\n' + all.reduce((s,u)=>s+u.concept_count,0) + ' concepten\n' + gk.length + ' kennisitems\nStripe: ' + (STRIPE_ACTIVE?'Actief':'Demo'),
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: 'Globale kennisbank', callback_data: 'admin_knowledge' }],
        [{ text: 'Credits geven',      callback_data: 'admin_give_credits' }],
        [{ text: 'Rapport',            callback_data: 'admin_report' }],
        [{ text: 'API status',         callback_data: 'admin_api' }],
      ]}}
    );
  }

  else if (data === 'admin_knowledge' && isAdmin(userId)) {
    const list = await listGlobalKnowledge();
    bot.sendMessage(userId, '*Globale kennisbank*\n\n' + (list.map((k,i) => (i+1)+'. '+k.title).join('\n')||'Leeg'),
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: 'Toevoegen', callback_data: 'admin_know_add' }],
        [{ text: 'Verwijderen', callback_data: 'admin_know_del' }],
        [{ text: 'Terug', callback_data: 'admin' }],
      ]}}
    );
  }

  else if (data === 'admin_know_add' && isAdmin(userId)) { s.step = 'admin_awaiting_knowledge'; bot.sendMessage(userId, 'Stuur tekst. Eerste regel = titel.'); }

  else if (data === 'admin_know_del' && isAdmin(userId)) {
    const list = await listGlobalKnowledge();
    if (!list.length) return bot.sendMessage(userId, 'Niets te verwijderen.');
    bot.sendMessage(userId, 'Kies:', { reply_markup: { inline_keyboard: [...list.map(k => [{ text: k.title, callback_data: 'admin_del_' + k.id }]), [{ text: 'Terug', callback_data: 'admin_knowledge' }]] } });
  }

  else if (data.startsWith('admin_del_') && isAdmin(userId)) {
    await deleteGlobalKnowledge(parseInt(data.replace('admin_del_', '')));
    bot.sendMessage(userId, 'Verwijderd.', { reply_markup: mainKeyboard(userId) });
  }

  else if (data === 'admin_api' && isAdmin(userId)) {
    bot.sendMessage(userId, '*API status*\n\nAnthropic: ' + (ANTHROPIC_KEY?'OK':'niet ingesteld') + '\nSupabase: ' + (SUPABASE_URL?'OK':'niet ingesteld') + '\nStripe: ' + (STRIPE_ACTIVE?'Actief':'Demo') + '\nModel: claude-sonnet-4-20250514', { parse_mode: 'Markdown' });
  }

  else if (data === 'admin_give_credits' && isAdmin(userId)) { s.step = 'admin_awaiting_credits'; bot.sendMessage(userId, 'Stuur: TELEGRAM_ID AANTAL'); }

  else if (data === 'admin_report' && isAdmin(userId)) {
    const all = await getAllUsers();
    let r = '*Rapport ' + new Date().toLocaleDateString('nl-NL') + '*\n\n' + all.length + ' gebruikers\n' + all.reduce((s,u)=>s+u.credits,0) + ' credits\n' + all.reduce((s,u)=>s+u.concept_count,0) + ' concepten\n\n';
    all.slice(0,8).forEach(u => { r += u.name + ' - ' + u.credits + 'cr - ' + u.concept_count + ' concepten - ' + (u.vakgebied||'geen vakgebied') + '\n'; });
    bot.sendMessage(userId, r.slice(0,3800), { parse_mode: 'Markdown' });
  }

  else if (data === 'home') {
    s.step = 'idle';
    const fresh = await getUser(userId, first_name);
    bot.sendMessage(userId, '*MailMate*\n\nSaldo: *' + fresh.credits + ' credits*', { parse_mode: 'Markdown', reply_markup: mainKeyboard(userId) });
  }
});

// BERICHTEN
bot.on('message', async (msg) => {
  if (msg.text && msg.text.startsWith('/')) return;
  const { id: userId, first_name } = msg.from;
  const s    = getState(userId);
  const text = msg.text ? msg.text.trim() : '';
  const user = await getUser(userId, first_name);

  // PDF
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
        await saveUser(userId, { user_knowledge: ((user.user_knowledge||'')+'\n\n'+fname+':\n'+extracted).slice(0,12000) });
        s.step = 'idle';
        bot.sendMessage(userId, 'PDF verwerkt: ' + fname, { reply_markup: mainKeyboard(userId) });
      } else if (s.step === 'admin_awaiting_pdf' && isAdmin(userId)) {
        await addGlobalKnowledge(fname, extracted);
        s.step = 'idle';
        bot.sendMessage(userId, 'PDF in globale kennisbank: ' + fname, { reply_markup: mainKeyboard(userId) });
      }
    } catch(e) { s.step = 'idle'; bot.sendMessage(userId, 'PDF fout: ' + e.message); }
    return;
  }

  if (!text) return;

  if (s.step === 'admin_awaiting_credits' && isAdmin(userId)) {
    const parts = text.split(' ');
    const targetId = parseInt(parts[0]), amount = parseInt(parts[1]);
    if (!isNaN(targetId) && !isNaN(amount)) {
      const target = await getUser(targetId, '');
      if (target) { await saveUser(targetId, { credits: target.credits + amount }); s.step = 'idle'; return bot.sendMessage(userId, amount + ' credits aan ' + targetId, { reply_markup: mainKeyboard(userId) }); }
    }
    return bot.sendMessage(userId, 'Formaat: 123456789 50');
  }

  if (s.step === 'admin_awaiting_knowledge' && isAdmin(userId)) {
    const lines = text.split('\n');
    await addGlobalKnowledge(lines[0].trim(), lines.slice(1).join('\n').trim() || text);
    s.step = 'idle';
    bot.sendMessage(userId, 'Toegevoegd aan globale kennisbank.', { reply_markup: mainKeyboard(userId) });
    return;
  }

  if (s.step === 'onboard_vakgebied') {
    const parts = text.split('-').map(p => p.trim());
    await saveUser(userId, { vakgebied: parts[0]||text, doel: parts[1]||'' });
    s.step = 'onboard_toon';
    bot.sendMessage(userId, '*Vakgebied opgeslagen!*\n\n*Stap 2 van 4 - Toon*\n\nWelke toon gebruik jij?',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: 'Formeel', callback_data: 'toon_formeel' }],
        [{ text: 'Informeel', callback_data: 'toon_informeel' }],
        [{ text: 'Mix', callback_data: 'toon_mix' }],
      ]}}
    );
    return;
  }

  if (s.step === 'onboard_style') {
    if (text.length < 80) return bot.sendMessage(userId, 'Te kort. Meer mails of /skip.');
    const load = await bot.sendMessage(userId, '_Stijl analyseren..._', { parse_mode: 'Markdown' });
    try {
      const profile = await callClaude('Analyseer schrijfstijl. Max 200 woorden: toon, je/u, aanhef, afsluiting, zinslengte.\n\nE-MAILS:\n' + text);
      const profiles = { default: profile };
      await saveUser(userId, { style_profiles: JSON.stringify(profiles), credits: user.credits - 3 });
      bot.deleteMessage(userId, load.message_id).catch(()=>{});
      s.step = 'onboard_knowledge';
      bot.sendMessage(userId, '*Stijl geleerd! (3 credits)*\n\n*Stap 4 van 4 - Kennisbank*\n\nVoeg info toe of tik /skip.', { parse_mode: 'Markdown' });
    } catch(e) { bot.deleteMessage(userId, load.message_id).catch(()=>{}); bot.sendMessage(userId, 'Fout: ' + e.message); }
    return;
  }

  if (s.step === 'onboard_knowledge') {
    await saveUser(userId, { user_knowledge: text.slice(0,12000), onboarded: true });
    s.step = 'idle';
    bot.sendMessage(userId, '*Setup compleet! Je agent is klaar.*', { parse_mode: 'Markdown', reply_markup: mainKeyboard(userId) });
    return;
  }

  if (s.step === 'awaiting_style_name') {
    s.trainStyleName = text.toLowerCase().trim();
    s.step = 'awaiting_train';
    bot.sendMessage(userId, '*Stijl "' + s.trainStyleName + '" trainen*\n\nStuur 5+ eigen mails, gescheiden door ——', { parse_mode: 'Markdown' });
    return;
  }

  if (s.step === 'awaiting_train') {
    if (text.length < 100) return bot.sendMessage(userId, 'Te weinig tekst.');
    const load = await bot.sendMessage(userId, '_Stijl analyseren..._', { parse_mode: 'Markdown' });
    try {
      const profile   = await callClaude('Analyseer schrijfstijl (vakgebied: ' + (user.vakgebied||'algemeen') + '). Max 200 woorden.\n\nE-MAILS:\n' + text);
      const styleName = s.trainStyleName || 'default';
      const profiles  = JSON.parse(user.style_profiles || '{"default":""}');
      profiles[styleName] = profile;
      await saveUser(userId, { style_profiles: JSON.stringify(profiles), credits: user.credits - 3 });
      s.step = 'idle';
      bot.deleteMessage(userId, load.message_id).catch(()=>{});
      bot.sendMessage(userId, '*Stijl "' + styleName + '" getraind! Saldo: ' + (user.credits-3) + ' credits*', { parse_mode: 'Markdown', reply_markup: mainKeyboard(userId) });
    } catch(e) { bot.deleteMessage(userId, load.message_id).catch(()=>{}); bot.sendMessage(userId, 'Fout: ' + e.message); }
    return;
  }

  if (s.step === 'awaiting_user_knowledge') {
    await saveUser(userId, { user_knowledge: ((user.user_knowledge||'')+'\n\n'+text).slice(0,12000) });
    s.step = 'idle';
    bot.sendMessage(userId, 'Toegevoegd aan kennisbank.', { reply_markup: mainKeyboard(userId) });
    return;
  }

  if (s.step === 'awaiting_template_name') {
    await saveTemplate(userId, text.trim(), s.lastConcept);
    s.step = 'idle';
    bot.sendMessage(userId, 'Template "' + text.trim() + '" opgeslagen!', { reply_markup: mainKeyboard(userId) });
    return;
  }

  if (s.step === 'awaiting_refine') {
    if (!s.lastConcept) return bot.sendMessage(userId, 'Geen concept.', { reply_markup: mainKeyboard(userId) });
    const load = await bot.sendMessage(userId, '_Concept aanpassen..._', { parse_mode: 'Markdown' });
    try {
      const refined = await callClaude('Pas dit concept aan: ' + text + '\n\nHUIDIG CONCEPT:\n' + s.lastConcept, 'Pas het e-mail concept aan zoals gevraagd. Geef alleen het resultaat terug.');
      s.lastConcept = refined;
      s.step = 'idle';
      bot.deleteMessage(userId, load.message_id).catch(()=>{});
      bot.sendMessage(userId, '*Aangepast concept:*\n\n' + refined,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
          [{ text: 'Nogmaals verfijnen', callback_data: 'refine' }, { text: 'Opslaan als template', callback_data: 'save_template' }],
          [{ text: 'Home', callback_data: 'home' }],
        ]}}
      );
    } catch(e) { bot.deleteMessage(userId, load.message_id).catch(()=>{}); bot.sendMessage(userId, 'Fout: ' + e.message); }
    return;
  }

  if (s.step === 'awaiting_batch') {
    const mails = text.split('===MAIL===').map(m => m.trim()).filter(m => m.length > 20);
    if (mails.length === 0) return bot.sendMessage(userId, 'Geen geldige mails. Scheidt ze met ===MAIL===');
    if (user.credits < mails.length) return bot.sendMessage(userId, 'Onvoldoende credits. Je hebt ' + user.credits + ' maar ' + mails.length + ' nodig.', { reply_markup: creditsKeyboard() });

    const load = await bot.sendMessage(userId, '_' + mails.length + ' mails verwerken..._', { parse_mode: 'Markdown' });
    try {
      const systemPrompt = await buildSystemPrompt(user, s.activeStyle || 'default');
      const concepts = await Promise.all(mails.map(mail => callClaude('Schrijf een conceptantwoord:\n\n' + mail, systemPrompt)));
      await saveUser(userId, { credits: user.credits - mails.length, concept_count: user.concept_count + mails.length });
      bot.deleteMessage(userId, load.message_id).catch(()=>{});
      for (let i = 0; i < concepts.length; i++) {
        await bot.sendMessage(userId, '*Concept ' + (i+1) + ' van ' + mails.length + ':*\n\n' + concepts[i], { parse_mode: 'Markdown' });
        await new Promise(r => setTimeout(r, 500));
      }
      s.step = 'idle';
      bot.sendMessage(userId, '*' + mails.length + ' concepten gegenereerd! ' + mails.length + ' credits gebruikt, saldo: ' + (user.credits-mails.length) + '*', { parse_mode: 'Markdown', reply_markup: mainKeyboard(userId) });
    } catch(e) { bot.deleteMessage(userId, load.message_id).catch(()=>{}); bot.sendMessage(userId, 'Fout: ' + e.message); }
    return;
  }

  if (s.step === 'awaiting_mail') {
    if (text.length < 20) return bot.sendMessage(userId, 'Mail te kort.');
    const load = await bot.sendMessage(userId, '_Concept schrijven..._', { parse_mode: 'Markdown' });
    try {
      const clientEmail  = (text.match(/Van:\s*([^\s]+@[^\s]+)/i)||[])[1] || null;
      const analysis     = await analyzeMail(text);
      const clientInfo   = clientEmail ? await getClient(userId, clientEmail) : null;
      const systemPrompt = await buildSystemPrompt(user, s.activeStyle || 'default', clientInfo);
      const reply        = await callClaude('Schrijf een conceptantwoord:\n\n' + text, systemPrompt);
      const subjectLine  = await generateSubjectLine((text.match(/Onderwerp:\s*(.+)/)||[])[1]||'', reply);

      s.lastConcept  = reply;
      s.lastIncoming = text;
      s.lastAnalysis = analysis;
      s.step = 'idle';

      await saveUser(userId, { credits: user.credits - 1, concept_count: user.concept_count + 1 });
      const subj = (text.match(/(?:Onderwerp|Subject):\s*(.+)/)||['','Mail'])[1];
      await addHistory(userId, subj, reply);
      await scheduleFollowUp(userId, subj);
      if (clientEmail) await upsertClient(userId, clientEmail, subj, text);

      bot.deleteMessage(userId, load.message_id).catch(()=>{});

      const sentimentIcon = analysis.sentiment === 'urgent' ? 'URGENT' : analysis.sentiment === 'negatief' ? 'Negatief' : 'Normaal';

      bot.sendMessage(userId,
        '*Concept antwoord:*\n' + sentimentIcon + ' - ' + analysis.type + '\n\n' + reply + '\n\n_Onderwerpregel: ' + subjectLine + '_\n\n_1 credit - saldo: ' + (user.credits-1) + '_',
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
          [{ text: 'Verfijnen', callback_data: 'refine' }, { text: 'A/B versies', callback_data: 'ab_versions' }],
          [{ text: 'Opslaan als template', callback_data: 'save_template' }, { text: 'Herschrijven', callback_data: 'compose' }],
          [{ text: 'Home', callback_data: 'home' }, { text: 'Mini App', web_app: { url: MINI_APP_URL } }],
        ]}}
      );
    } catch(e) {
      bot.deleteMessage(userId, load.message_id).catch(()=>{});
      bot.sendMessage(userId, 'Fout: ' + e.message, { reply_markup: mainKeyboard(userId) });
    }
    return;
  }

  bot.sendMessage(userId, 'Gebruik de knoppen hieronder', { reply_markup: mainKeyboard(userId) });
});

// FOLLOW-UP checker
setInterval(async () => {
  const { data } = await supabase.from('followups').select('*').eq('sent', false).lte('remind_at', new Date().toISOString());
  if (!data) return;
  for (const f of data) {
    try {
      await bot.sendMessage(f.telegram_id,
        '*Follow-up reminder*\n\n"' + f.subject + '"\n\nHeb je al geantwoord?',
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
          [{ text: 'Nieuw concept', callback_data: 'compose' }, { text: 'Al verzonden', callback_data: 'followup_done_' + f.id }],
        ]}}
      );
      await supabase.from('followups').update({ sent: true }).eq('id', f.id);
    } catch(e) { console.error('Follow-up:', e.message); }
  }
}, 6 * 60 * 60 * 1000);

// LOW CREDITS checker
setInterval(async () => {
  const users = await getAllUsers();
  for (const u of users) {
    if (u.credits > 0 && u.credits <= 5) {
      try { await bot.sendMessage(u.telegram_id, 'Nog ' + u.credits + ' credits over.', { reply_markup: creditsKeyboard() }); }
      catch(e) {}
    }
  }
}, 24 * 60 * 60 * 1000);

console.log('MailMate v4 gestart - Alle tiers actief');
