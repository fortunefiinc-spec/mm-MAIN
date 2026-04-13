// MailMate Bot v4.1 — Whitelist + Rate limiting + Toegangsbeveiliging
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

// Toegangscode voor nieuwe gebruikers (stel in via Railway Variables)
const ACCESS_CODE   = process.env.ACCESS_CODE || 'mailmate2025';

// Rate limiting: max concepten per uur
const MAX_PER_HOUR  = parseInt(process.env.MAX_PER_HOUR || '20');

const bot       = new TelegramBot(BOT_TOKEN, WEBHOOK_URL ? { webHook: true } : { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
const supabase  = createClient(SUPABASE_URL, SUPABASE_KEY);

let stripe = null;
if (STRIPE_ACTIVE) { stripe = require('stripe')(STRIPE_KEY); console.log('Stripe actief'); }
else { console.log('Stripe demo modus'); }

// Express
const app = express();

// CORS — laat webapp op app.mailmate.nl de API gebruiken
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use((req, res, next) => {
  if (req.path === '/stripe-webhook') express.raw({ type: 'application/json' })(req, res, next);
  else express.json()(req, res, next);
});

app.get('/', (req, res) => res.send('MailMate v4.1 OK'));
app.get('/health', (req, res) => res.json({ status: 'ok', version: '4.1.0' }));
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
        await saveUser(parseInt(telegram_id), { credits: user.credits + parseInt(credits) });
        bot.sendMessage(parseInt(telegram_id), '*' + credits + ' berichten toegevoegd!*\n\nNieuw saldo: *' + (user.credits + parseInt(credits)) + ' berichten*', { parse_mode: 'Markdown', reply_markup: mainKeyboard(parseInt(telegram_id)) });
      }
    }
  } catch(e) { console.error('Stripe:', e.message); }
  res.sendStatus(200);
});

// Outlook/Gmail webhook
app.post('/mailhook/:userId', async (req, res) => {
  const telegramId = parseInt(req.params.userId);
  const apiKey     = req.headers['x-api-key'];
  const user = await getUser(telegramId, '');
  if (!user || user.webhook_key !== apiKey) return res.status(401).json({ error: 'Unauthorized' });
  if (!user.approved) return res.status(403).json({ error: 'Account niet goedgekeurd' });

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

    bot.sendMessage(telegramId,
      '*Nieuwe mail via koppeling*\n\nVan: ' + from + '\nOnderwerp: ' + subject + '\nSfeer: ' + (analysis.sentiment === 'urgent' ? 'Urgent' : analysis.sentiment === 'negatief' ? 'Negatief' : 'Normaal') + '\n\n*Conceptantwoord:*\n\n' + concept + '\n\n_Onderwerpregel: ' + subjectLine + '_\n\n_Saldo: ' + (user.credits-1) + ' berichten_',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: 'Aanpassen', callback_data: 'refine' }, { text: 'Herschrijven', callback_data: 'compose' }],
        [{ text: 'Home', callback_data: 'home' }],
      ]}}
    );
    res.json({ success: true, concept, subject_line: subjectLine });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Externe API — webapp endpoints
// POST /api/compose-ab — A/B versies
app.post('/api/compose-ab', async (req, res) => {
  const { telegram_id, api_key, mail_text, style } = req.body;
  const user = await getUser(parseInt(telegram_id)||0, '');
  if (!user || user.webhook_key !== api_key) return res.status(401).json({ error: 'Unauthorized' });
  if (!user.approved && parseInt(telegram_id) !== ADMIN_ID) return res.status(403).json({ error: 'Niet goedgekeurd' });
  if (user.credits < 2) return res.status(402).json({ error: 'Onvoldoende berichten (2 nodig voor A/B)' });
  try {
    const systemPrompt = await buildSystemPrompt(user, style||'default');
    const [formal, informal] = await Promise.all([
      callClaude('Schrijf een FORMEEL conceptantwoord (gebruik u):

' + mail_text, systemPrompt),
      callClaude('Schrijf een INFORMEEL conceptantwoord (gebruik je):

' + mail_text, systemPrompt)
    ]);
    await saveUser(parseInt(telegram_id)||0, { credits: user.credits - 2, concept_count: user.concept_count + 2 });
    res.json({ formal, informal });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/refine — concept verfijnen
app.post('/api/refine', async (req, res) => {
  const { telegram_id, api_key, concept, instruction } = req.body;
  const user = await getUser(parseInt(telegram_id)||0, '');
  if (!user || user.webhook_key !== api_key) return res.status(401).json({ error: 'Unauthorized' });
  if (!concept || !instruction) return res.status(400).json({ error: 'concept en instruction vereist' });
  try {
    const refined = await callClaude(
      'Pas dit e-mail concept aan op basis van de instructie. Geef ALLEEN het resultaat terug.

Instructie: ' + instruction + '

Concept:
' + concept,
      'Pas het e-mail concept aan. Geef alleen het resultaat terug.'
    );
    res.json({ refined });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/train-style — stijl trainen via webapp
app.post('/api/train-style', async (req, res) => {
  const { telegram_id, api_key, name, mails } = req.body;
  const user = await getUser(parseInt(telegram_id)||0, '');
  if (!user || user.webhook_key !== api_key) return res.status(401).json({ error: 'Unauthorized' });
  if (user.credits < 3) return res.status(402).json({ error: 'Minimaal 3 berichten nodig' });
  if (!mails || mails.length < 50) return res.status(400).json({ error: 'Te weinig tekst' });
  try {
    const profile = await callClaude('Analyseer schrijfstijl. Max 200 woorden: toon, je/u, aanhef, afsluiting, zinslengte.

E-MAILS:
' + mails);
    const profiles = JSON.parse(user.style_profiles || '{"default":""}');
    profiles[name || 'default'] = profile;
    await saveUser(parseInt(telegram_id)||0, { style_profiles: JSON.stringify(profiles), credits: user.credits - 3 });
    res.json({ success: true, profile });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Bestaande compose endpoint
app.post('/api/compose', async (req, res) => {
  const { telegram_id, api_key, mail_text } = req.body;
  const user = await getUser(parseInt(telegram_id), '');
  if (!user || user.webhook_key !== api_key) return res.status(401).json({ error: 'Unauthorized' });
  if (!user.approved) return res.status(403).json({ error: 'Niet goedgekeurd' });
  if (user.credits < 1) return res.status(402).json({ error: 'Onvoldoende berichten' });
  try {
    const concept = await callClaude('Schrijf een conceptantwoord:\n\n' + mail_text, await buildSystemPrompt(user));
    await saveUser(parseInt(telegram_id), { credits: user.credits - 1, concept_count: user.concept_count + 1 });
    res.json({ concept, credits_remaining: user.credits - 1 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('MailMate v4.1 draait op poort ' + PORT);
  if (WEBHOOK_URL) {
    bot.setWebHook(WEBHOOK_URL + '/bot' + BOT_TOKEN)
      .then(() => console.log('Webhook actief'))
      .catch(e => console.error('Webhook fout:', e.message));
  }
});

// ════════════════════════════════════════════════════
// BEVEILIGING
// ════════════════════════════════════════════════════

// Rate limiting in geheugen
const rateLimits = new Map(); // userId -> { count, resetAt }

function checkRateLimit(userId) {
  const now = Date.now();
  const limit = rateLimits.get(userId);
  if (!limit || now > limit.resetAt) {
    rateLimits.set(userId, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return true;
  }
  if (limit.count >= MAX_PER_HOUR) return false;
  limit.count++;
  return true;
}

function getRateLimitRemaining(userId) {
  const limit = rateLimits.get(userId);
  if (!limit) return MAX_PER_HOUR;
  return Math.max(0, MAX_PER_HOUR - limit.count);
}

// Toegangscontrole
async function isApproved(telegramId) {
  if (telegramId === ADMIN_ID) return true;
  const user = await getUser(telegramId, '');
  return user && user.approved === true;
}

// ════════════════════════════════════════════════════
// SUPABASE
// ════════════════════════════════════════════════════
function generateApiKey() { return 'mm_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); }

function fallbackUser(telegramId, name) {
  return { telegram_id: telegramId, name: name||'Gebruiker', credits: 0, concept_count: 0,
           style_profiles: '{"default":""}', active_style: 'default', user_knowledge: '',
           onboarded: false, approved: false, vakgebied: '', doel: '', toon_voorkeur: '', webhook_key: '' };
}

async function getUser(telegramId, name) {
  try {
    const { data } = await supabase.from('users').select('*').eq('telegram_id', telegramId).single();
    if (data) return data;
    const { data: newUser, error } = await supabase.from('users')
      .insert({ telegram_id: telegramId, name: name||'Gebruiker', credits: 0, concept_count: 0,
                style_profiles: JSON.stringify({ default: '' }), active_style: 'default',
                user_knowledge: '', onboarded: false, approved: false,
                vakgebied: '', doel: '', toon_voorkeur: '', webhook_key: generateApiKey() })
      .select().single();
    if (error) console.error('Insert fout:', JSON.stringify(error));
    return newUser || fallbackUser(telegramId, name);
  } catch(e) { console.error('getUser:', e.message); return fallbackUser(telegramId, name); }
}

async function saveUser(telegramId, updates) {
  await supabase.from('users').update({ ...updates, updated_at: new Date().toISOString() }).eq('telegram_id', telegramId);
}

async function getPendingUsers() {
  const { data } = await supabase.from('users').select('*').eq('approved', false).eq('onboarded', false).order('created_at', { ascending: false });
  return data || [];
}

async function getApprovedUsers() {
  const { data } = await supabase.from('users').select('*').eq('approved', true).order('created_at', { ascending: false });
  return data || [];
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

async function upsertClient(telegramId, email, subject, body) {
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

// ════════════════════════════════════════════════════
// AI
// ════════════════════════════════════════════════════
async function analyzeMail(mailText) {
  try {
    const result = await callClaude(
      'Analyseer deze e-mail. Geef ALLEEN valide JSON:\n{"type":"klacht|offerte|info|opvolging|vraag|bedankt|overig","sentiment":"positief|neutraal|negatief|urgent","urgentie":"laag|middel|hoog","kernvraag":"max 10 woorden"}\n\nE-MAIL:\n' + mailText.slice(0, 1500),
      'Analyseer e-mails en retourneer alleen valide JSON.'
    );
    return JSON.parse(result.replace(/```json|```/g, '').trim());
  } catch(e) { return { type: 'overig', sentiment: 'neutraal', urgentie: 'middel', kernvraag: '' }; }
}

async function generateSubjectLine(originalSubject, concept) {
  try {
    const result = await callClaude(
      'Genereer een professionele onderwerpregel. Geef ALLEEN de onderwerpregel terug.\n\nOrigineel: ' + (originalSubject||'onbekend') + '\n\nConcept:\n' + concept.slice(0, 400),
      'Genereer bondige professionele e-mail onderwerpregels.'
    );
    return result.trim().replace(/^"(.*)"$/, '$1');
  } catch(e) { return originalSubject ? 'Re: ' + originalSubject : 'Antwoord op uw bericht'; }
}

async function generateABVersions(mailText, systemPrompt) {
  const [formal, informal] = await Promise.all([
    callClaude('Schrijf een FORMEEL conceptantwoord:\n\n' + mailText, systemPrompt + '\n\nEXTRA: Schrijf extra formeel, gebruik "u".'),
    callClaude('Schrijf een INFORMEEL conceptantwoord:\n\n' + mailText, systemPrompt + '\n\nEXTRA: Schrijf toegankelijker en informeler.')
  ]);
  return { formal, informal };
}

async function buildSystemPrompt(user, styleName, clientInfo) {
  styleName = styleName || 'default';
  const profiles      = JSON.parse(user.style_profiles || '{"default":""}');
  const activeProfile = profiles[styleName] || profiles['default'] || '';
  const globalExtra   = await getGlobalKnowledge();
  let clientContext = '';
  if (clientInfo) clientContext = '\n\nKLANTINFO:\nE-mail: ' + clientInfo.email + '\nEerder contact: ' + (clientInfo.contact_count||0) + ' keer\nLaatst over: ' + (clientInfo.last_subject||'n.v.t.');

  return 'Je bent een professionele e-mail assistent. Schrijf conceptantwoorden in de schrijfstijl van de gebruiker.\n\nSCHRIJFSTIJL:\n' + (activeProfile||'Schrijf professioneel en vriendelijk.') + '\n\nVAKGEBIED: ' + (user.vakgebied||'Algemeen') + '\nTOON: ' + (user.toon_voorkeur||'Professioneel') + clientContext + (globalExtra ? '\n\nKENNISBANK:\n' + globalExtra : '') + (user.user_knowledge ? '\n\nEIGEN KENNIS:\n' + user.user_knowledge : '') + '\n\nREGEL: Geef ALLEEN het conceptantwoord terug, geen uitleg.';
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
    line_items: [{ price_data: { currency: 'eur', product_data: { name: 'MailMate ' + credits + ' berichten' }, unit_amount: priceEur * 100 }, quantity: 1 }],
    mode: 'payment',
    success_url: WEBHOOK_URL + '/betaling-succes',
    cancel_url:  WEBHOOK_URL + '/betaling-geannuleerd',
    metadata: { telegram_id: telegramId.toString(), credits: credits.toString() },
  });
  return session.url;
}

// ════════════════════════════════════════════════════
// SESSION
// ════════════════════════════════════════════════════
const sessionState = new Map();
function getState(id) {
  if (!sessionState.has(id)) sessionState.set(id, { step: 'idle', lastConcept: '', lastIncoming: '', activeStyle: 'default', trainStyleName: null });
  return sessionState.get(id);
}

// ════════════════════════════════════════════════════
// KEYBOARDS
// ════════════════════════════════════════════════════
const isAdmin = (id) => id === ADMIN_ID;

function mainKeyboard(userId) {
  const b = [
    [{ text: 'Concept schrijven',  callback_data: 'compose'   }],
    [{ text: 'Meerdere mails',     callback_data: 'batch'     }],
    [{ text: 'Stijl trainen',      callback_data: 'train'     }],
    [{ text: 'Kennisbank',         callback_data: 'myknow'    }],
    [{ text: 'Klanten',            callback_data: 'clients'   }],
    [{ text: 'Opgeslagen antwoorden', callback_data: 'templates' }],
    [{ text: 'Koppeling instellen', callback_data: 'webhook'  }],
    [{ text: 'Geschiedenis',       callback_data: 'history'   }],
    [{ text: 'Berichten kopen',    callback_data: 'credits'   }],
    [{ text: 'Open in app',        web_app: { url: MINI_APP_URL } }],
  ];
  if (isAdmin(userId)) b.push([{ text: 'Beheer', callback_data: 'admin' }]);
  return { inline_keyboard: b };
}

function creditsKeyboard() {
  return { inline_keyboard: [
    [{ text: '50 berichten - 9 euro', callback_data: 'buy_50_9' }, { text: '200 berichten - 29 euro', callback_data: 'buy_200_29' }],
    [{ text: '600 berichten - 79 euro', callback_data: 'buy_600_79' }],
  ]};
}

// ════════════════════════════════════════════════════
// ONBOARDING
// ════════════════════════════════════════════════════
async function startOnboarding(userId, firstName) {
  await bot.sendMessage(userId,
    '*Welkom bij MailMate, ' + firstName + '!*\n\nIk ben jouw persoonlijke e-mail assistent. Ik leer hoe jij schrijft en zet automatisch conceptantwoorden klaar.\n\n*Stap 1 van 4*\n\nIn welk vakgebied werk je en wat doe je?\n\nBijvoorbeeld:\n- Assurantiekantoor - klantadvies\n- Bouwbedrijf - offertes en projecten\n- Webshop - klantenservice\n\n_Tik /skip als je dit later wil invullen._',
    { parse_mode: 'Markdown' }
  );
  getState(userId).step = 'onboard_vakgebied';
}

bot.onText(/\/skip/, async (msg) => {
  const { id, first_name } = msg.from;
  const s = getState(id);
  if (s.step === 'onboard_vakgebied') {
    await saveUser(id, { vakgebied: 'Algemeen' });
    s.step = 'onboard_toon';
    bot.sendMessage(id, '*Stap 2 van 4 — Toon*\n\nHoe schrijf jij normaal?',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: 'Formeel (u)', callback_data: 'toon_formeel' }],
        [{ text: 'Informeel (je)', callback_data: 'toon_informeel' }],
        [{ text: 'Hangt van de klant af', callback_data: 'toon_mix' }],
      ]}}
    );
  } else if (s.step === 'onboard_style') {
    s.step = 'onboard_knowledge';
    bot.sendMessage(id, '*Stap 4 van 4 — Eigen kennis*\n\nVoeg informatie toe die ik moet weten over jouw bedrijf, producten of diensten. Of tik /skip.', { parse_mode: 'Markdown' });
  } else if (s.step === 'onboard_knowledge') {
    await saveUser(id, { onboarded: true });
    s.step = 'idle';
    bot.sendMessage(id, '*Klaar! Je bent ingesteld.*\n\nStuur me een e-mail en ik schrijf direct een conceptantwoord in jouw stijl.', { parse_mode: 'Markdown', reply_markup: mainKeyboard(id) });
  }
});

// ════════════════════════════════════════════════════
// /START — MET TOEGANGSCONTROLE
// ════════════════════════════════════════════════════
bot.onText(/\/start/, async (msg) => {
  const { id, first_name } = msg.from;

  // Admin altijd toegang
  if (isAdmin(id)) {
    let user;
    try { user = await getUser(id, first_name); }
    catch(e) { user = fallbackUser(id, first_name); }
    if (!user.onboarded) { await startOnboarding(id, first_name); return; }
    bot.sendMessage(id, '*Welkom terug, ' + first_name + '!*\n\nSaldo: *' + user.credits + ' berichten*', { parse_mode: 'Markdown', reply_markup: mainKeyboard(id) });
    return;
  }

  // Controleer of gebruiker al bestaat en goedgekeurd is
  let user;
  try { user = await getUser(id, first_name); }
  catch(e) { user = fallbackUser(id, first_name); }

  if (user.approved) {
    // Goedgekeurde gebruiker
    if (!user.onboarded) { await startOnboarding(id, first_name); return; }
    bot.sendMessage(id, '*Welkom terug, ' + first_name + '!*\n\nSaldo: *' + user.credits + ' berichten*', { parse_mode: 'Markdown', reply_markup: mainKeyboard(id) });
    return;
  }

  // Nieuwe gebruiker — vraag toegangscode
  getState(id).step = 'awaiting_access_code';
  bot.sendMessage(id,
    '*Welkom bij MailMate*\n\nVoer de toegangscode in om te starten.\n\n_Geen toegangscode? Neem contact op via de website._',
    { parse_mode: 'Markdown' }
  );
});

// ════════════════════════════════════════════════════
// CALLBACKS
// ════════════════════════════════════════════════════
bot.on('callback_query', async (query) => {
  const { id: userId, first_name } = query.from;
  const data = query.data;
  const s    = getState(userId);
  bot.answerCallbackQuery(query.id);

  // Toegangscontrole op alle callbacks
  if (!isAdmin(userId)) {
    const approved = await isApproved(userId);
    if (!approved) {
      bot.sendMessage(userId, 'Je hebt nog geen toegang. Tik /start en voer je toegangscode in.');
      return;
    }
  }

  const user = await getUser(userId, first_name);

  // Toon onboarding
  if (data.startsWith('toon_')) {
    const map = { toon_formeel: 'Formeel', toon_informeel: 'Informeel', toon_mix: 'Mix' };
    await saveUser(userId, { toon_voorkeur: map[data]||'Professioneel' });
    s.step = 'onboard_style';
    bot.sendMessage(userId, '*Stap 3 van 4 — Schrijfstijl*\n\nStuur 5 of meer e-mails die jij zelf hebt geschreven. Ik leer hieruit precies hoe jij schrijft.\n\nScheid de mails met: ——\n\n_Tik /skip als je dit later wil doen._', { parse_mode: 'Markdown' });
    return;
  }

  // Follow-up
  if (data.startsWith('followup_done_')) {
    const fid = data.replace('followup_done_', '');
    if (fid) await supabase.from('followups').update({ sent: true }).eq('id', fid);
    bot.sendMessage(userId, 'Gemarkeerd als verzonden.', { reply_markup: mainKeyboard(userId) });
    return;
  }

  // COMPOSE
  if (data === 'compose') {
    if (user.credits < 1) return bot.sendMessage(userId, 'Je hebt geen berichten meer.\n\nKoop berichten om door te gaan.', { reply_markup: creditsKeyboard() });
    if (!checkRateLimit(userId)) return bot.sendMessage(userId, 'Je hebt het maximum aantal concepten per uur bereikt. Probeer het over een uur opnieuw.');
    const profiles   = JSON.parse(user.style_profiles || '{"default":""}');
    const styleNames = Object.keys(profiles).filter(k => profiles[k]);
    if (styleNames.length > 1) {
      s.step = 'awaiting_mail';
      return bot.sendMessage(userId, 'Kies een schrijfstijl:', { reply_markup: { inline_keyboard: styleNames.map(n => [{ text: n, callback_data: 'compose_style_' + n }]) } });
    }
    s.step = 'awaiting_mail';
    s.activeStyle = styleNames[0] || 'default';
    bot.sendMessage(userId, '*Inkomende e-mail*\n\nPlak de tekst van de e-mail waarop je wil antwoorden.', { parse_mode: 'Markdown' });
  }

  else if (data.startsWith('compose_style_')) {
    s.activeStyle = data.replace('compose_style_', '');
    s.step = 'awaiting_mail';
    bot.sendMessage(userId, 'Plak de e-mail tekst.', { parse_mode: 'Markdown' });
  }

  // BATCH
  else if (data === 'batch') {
    if (user.credits < 1) return bot.sendMessage(userId, 'Geen berichten meer.', { reply_markup: creditsKeyboard() });
    s.step = 'awaiting_batch';
    bot.sendMessage(userId, '*Meerdere mails verwerken*\n\nPlak meerdere e-mails in één bericht. Zet tussen elke mail:\n`===MAIL===`\n\n_Per e-mail wordt 1 bericht gebruikt._', { parse_mode: 'Markdown' });
  }

  // A/B VERSIES
  else if (data === 'ab_versions') {
    if (!s.lastIncoming) return bot.sendMessage(userId, 'Geen e-mail beschikbaar.', { reply_markup: mainKeyboard(userId) });
    if (user.credits < 2) return bot.sendMessage(userId, 'Twee versies kost 2 berichten.', { reply_markup: creditsKeyboard() });
    const load = await bot.sendMessage(userId, '_Twee versies maken..._', { parse_mode: 'Markdown' });
    try {
      const systemPrompt = await buildSystemPrompt(user, s.activeStyle || 'default');
      const { formal, informal } = await generateABVersions(s.lastIncoming, systemPrompt);
      await saveUser(userId, { credits: user.credits - 2, concept_count: user.concept_count + 2 });
      bot.deleteMessage(userId, load.message_id).catch(()=>{});
      bot.sendMessage(userId, '*Twee versies (2 berichten gebruikt):*\n\n*Formeel:*\n' + formal + '\n\n---\n\n*Informeel:*\n' + informal, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Home', callback_data: 'home' }]] } });
    } catch(e) { bot.deleteMessage(userId, load.message_id).catch(()=>{}); bot.sendMessage(userId, 'Fout: ' + e.message); }
  }

  // VERFIJNEN
  else if (data === 'refine') {
    if (!s.lastConcept) return bot.sendMessage(userId, 'Geen concept beschikbaar.', { reply_markup: mainKeyboard(userId) });
    s.step = 'awaiting_refine';
    bot.sendMessage(userId, '*Antwoord aanpassen*\n\nGeef aan wat je anders wil:\n- Maak het korter\n- Formeler of informeler\n- Voeg een disclaimer toe\n- Iets anders', { parse_mode: 'Markdown' });
  }

  // TEMPLATES
  else if (data === 'templates') {
    const templates = await getTemplates(userId);
    if (!templates.length) return bot.sendMessage(userId, 'Je hebt nog geen opgeslagen antwoorden.\n\nNa het genereren van een concept kun je het opslaan.', { reply_markup: { inline_keyboard: [[{ text: 'Terug', callback_data: 'home' }]] } });
    bot.sendMessage(userId, '*Opgeslagen antwoorden:*',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        ...templates.map(t => [{ text: t.name, callback_data: 'use_template_' + t.id }, { text: 'Verwijder', callback_data: 'del_template_' + t.id }]),
        [{ text: 'Terug', callback_data: 'home' }],
      ]}}
    );
  }

  else if (data.startsWith('use_template_')) {
    const templates = await getTemplates(userId);
    const tmpl = templates.find(t => t.id === parseInt(data.replace('use_template_', '')));
    if (tmpl) {
      s.lastConcept = tmpl.content;
      bot.sendMessage(userId, '*' + tmpl.name + ':*\n\n' + tmpl.content, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Aanpassen', callback_data: 'refine' }],[{ text: 'Terug', callback_data: 'home' }]] } });
    }
  }

  else if (data.startsWith('del_template_')) {
    await deleteTemplate(parseInt(data.replace('del_template_', '')));
    bot.sendMessage(userId, 'Verwijderd.', { reply_markup: mainKeyboard(userId) });
  }

  else if (data === 'save_template') {
    if (!s.lastConcept) return bot.sendMessage(userId, 'Geen concept om op te slaan.');
    s.step = 'awaiting_template_name';
    bot.sendMessage(userId, 'Geef een naam voor dit antwoord:');
  }

  // KLANTEN
  else if (data === 'clients') {
    const clients = await getClients(userId);
    if (!clients.length) return bot.sendMessage(userId, 'Nog geen klanten. Ze worden automatisch toegevoegd als je concepten maakt.', { reply_markup: { inline_keyboard: [[{ text: 'Terug', callback_data: 'home' }]] } });
    const list = clients.slice(0, 8).map(c => c.email + ' (' + (c.contact_count||0) + 'x)').join('\n');
    bot.sendMessage(userId, '*Klanten (' + clients.length + '):*\n\n' + list, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Terug', callback_data: 'home' }]] } });
  }

  // WEBHOOK
  else if (data === 'webhook') {
    const key = user.webhook_key || generateApiKey();
    if (!user.webhook_key) await saveUser(userId, { webhook_key: key });
    bot.sendMessage(userId,
      '*Koppeling met Outlook of Gmail*\n\nMet Zapier of Make kun je nieuwe e-mails automatisch laten verwerken.\n\nJouw koppelingsadres:\n`' + WEBHOOK_URL + '/mailhook/' + userId + '`\n\nJouw sleutel:\n`' + key + '`\n\nIn Zapier:\n1. Trigger: nieuwe e-mail in Outlook of Gmail\n2. Actie: Webhooks - POST\n3. URL: bovenstaand adres\n4. Header: x-api-key = jouw sleutel\n5. Body: subject, from, body',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: 'Nieuwe sleutel aanmaken', callback_data: 'webhook_reset' }],
        [{ text: 'Terug', callback_data: 'home' }],
      ]}}
    );
  }

  else if (data === 'webhook_reset') {
    const newKey = generateApiKey();
    await saveUser(userId, { webhook_key: newKey });
    bot.sendMessage(userId, 'Nieuwe sleutel:\n`' + newKey + '`', { parse_mode: 'Markdown', reply_markup: mainKeyboard(userId) });
  }

  // STIJL TRAINEN
  else if (data === 'train') {
    if (user.credits < 3) return bot.sendMessage(userId, 'Stijl trainen kost 3 berichten. Koop eerst berichten bij.', { reply_markup: creditsKeyboard() });
    const profiles   = JSON.parse(user.style_profiles || '{"default":""}');
    const styleNames = Object.keys(profiles);
    bot.sendMessage(userId, '*Schrijfstijl*\n\nJe hebt ' + styleNames.length + ' stijl(en): ' + styleNames.join(', '),
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: 'Nieuwe stijl toevoegen', callback_data: 'train_new' }],
        ...styleNames.map(n => [{ text: '"' + n + '" opnieuw trainen', callback_data: 'train_existing_' + n }]),
      ]}}
    );
  }

  else if (data === 'train_new') { s.step = 'awaiting_style_name'; bot.sendMessage(userId, 'Geef een naam voor de nieuwe stijl (bijv: formeel, zakelijk):'); }
  else if (data.startsWith('train_existing_')) {
    s.trainStyleName = data.replace('train_existing_', '');
    s.step = 'awaiting_train';
    bot.sendMessage(userId, '*"' + s.trainStyleName + '" opnieuw trainen*\n\nStuur 5+ e-mails die jij hebt geschreven. Scheid ze met ——', { parse_mode: 'Markdown' });
  }

  // KENNISBANK
  else if (data === 'myknow') {
    bot.sendMessage(userId, '*Kennisbank*\n\n' + (user.user_knowledge ? user.user_knowledge.slice(0,200)+'...' : 'Leeg — voeg informatie toe over jouw bedrijf, producten of diensten.'),
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: 'Tekst toevoegen',  callback_data: 'myknow_add'   }],
        [{ text: 'PDF uploaden',     callback_data: 'myknow_pdf'   }],
        [{ text: 'Leegmaken',        callback_data: 'myknow_clear' }],
        [{ text: 'Terug',            callback_data: 'home'         }],
      ]}}
    );
  }

  else if (data === 'myknow_add') { s.step = 'awaiting_user_knowledge'; bot.sendMessage(userId, 'Stuur de informatie die ik moet weten:'); }
  else if (data === 'myknow_pdf') { s.step = 'awaiting_user_pdf'; bot.sendMessage(userId, 'Stuur een PDF document.'); }
  else if (data === 'myknow_clear') { await saveUser(userId, { user_knowledge: '' }); bot.sendMessage(userId, 'Kennisbank leeggemaakt.', { reply_markup: mainKeyboard(userId) }); }

  // GESCHIEDENIS
  else if (data === 'history') {
    const hist = await getHistory(userId, 8);
    if (!hist.length) return bot.sendMessage(userId, 'Nog geen concepten gemaakt.', { reply_markup: mainKeyboard(userId) });
    const text = hist.map((h, i) => (i+1) + '. ' + h.subject + ' — ' + new Date(h.created_at).toLocaleDateString('nl-NL')).join('\n');
    bot.sendMessage(userId, '*Recente concepten:*\n\n' + text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Terug', callback_data: 'home' }]] } });
  }

  // BERICHTEN KOPEN
  else if (data === 'credits') {
    bot.sendMessage(userId, '*Berichten kopen*\n\nHuidig saldo: *' + user.credits + ' berichten*\n\n1 concept = 1 bericht\nStijl trainen = 3 berichten', { parse_mode: 'Markdown', reply_markup: creditsKeyboard() });
  }

  else if (data.startsWith('buy_')) {
    const parts = data.split('_'); const amount = parseInt(parts[1]); const price = parseInt(parts[2]);
    if (STRIPE_ACTIVE) {
      try {
        const url = await createStripeCheckout(userId, amount, price);
        bot.sendMessage(userId, '*' + amount + ' berichten voor euro ' + price + '*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Betaal via Stripe', url }]] } });
      } catch(e) { bot.sendMessage(userId, 'Betaalfout: ' + e.message); }
    } else {
      bot.sendMessage(userId, '*(Demo) ' + amount + ' berichten voor euro ' + price + '*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Bevestig (demo)', callback_data: 'confirm_' + amount }]] } });
    }
  }

  else if (data.startsWith('confirm_')) {
    const amount = parseInt(data.split('_')[1]);
    await saveUser(userId, { credits: user.credits + amount });
    bot.sendMessage(userId, '*' + amount + ' berichten toegevoegd!*\n\nNieuw saldo: *' + (user.credits+amount) + '*', { parse_mode: 'Markdown', reply_markup: mainKeyboard(userId) });
  }

  // ADMIN
  else if (data === 'admin' && isAdmin(userId)) {
    const all     = await getAllUsers();
    const pending = await getPendingUsers();
    const gk      = await listGlobalKnowledge();
    bot.sendMessage(userId,
      '*Beheer*\n\n' + all.filter(u=>u.approved).length + ' actieve gebruikers\n' + pending.length + ' wachten op goedkeuring\n' + all.reduce((s,u)=>s+u.credits,0) + ' berichten in omloop\n' + all.reduce((s,u)=>s+u.concept_count,0) + ' concepten gemaakt\n' + gk.length + ' kennisitems',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        pending.length > 0 ? [{ text: 'Goedkeuren (' + pending.length + ')', callback_data: 'admin_pending' }] : [{ text: 'Geen aanvragen', callback_data: 'admin' }],
        [{ text: 'Gebruikers beheren',    callback_data: 'admin_users'      }],
        [{ text: 'Kennisbank beheren',    callback_data: 'admin_knowledge'  }],
        [{ text: 'Credits geven',         callback_data: 'admin_give_credits' }],
        [{ text: 'Rapport',               callback_data: 'admin_report'     }],
      ]}}
    );
  }

  else if (data === 'admin_pending' && isAdmin(userId)) {
    const pending = await getPendingUsers();
    if (!pending.length) return bot.sendMessage(userId, 'Geen aanvragen.', { reply_markup: mainKeyboard(userId) });
    for (const u of pending.slice(0, 5)) {
      bot.sendMessage(userId,
        '*Toegangsaanvraag*\n\nNaam: ' + u.name + '\nID: ' + u.telegram_id + '\nAangemeld: ' + new Date(u.created_at).toLocaleDateString('nl-NL'),
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
          [{ text: 'Goedkeuren + 10 berichten', callback_data: 'approve_' + u.telegram_id },
           { text: 'Weigeren', callback_data: 'deny_' + u.telegram_id }],
        ]}}
      );
    }
  }

  else if (data.startsWith('approve_') && isAdmin(userId)) {
    const targetId = parseInt(data.replace('approve_', ''));
    await saveUser(targetId, { approved: true, credits: 10 });
    bot.sendMessage(userId, 'Goedgekeurd! 10 berichten toegewezen.', { reply_markup: mainKeyboard(userId) });
    bot.sendMessage(targetId, '*Je toegang is goedgekeurd!*\n\nJe hebt 10 gratis berichten ontvangen om te starten.\n\nTik /start om te beginnen.', { parse_mode: 'Markdown' });
  }

  else if (data.startsWith('deny_') && isAdmin(userId)) {
    const targetId = parseInt(data.replace('deny_', ''));
    bot.sendMessage(userId, 'Aanvraag geweigerd.', { reply_markup: mainKeyboard(userId) });
    bot.sendMessage(targetId, 'Je toegangsaanvraag is niet goedgekeurd. Neem contact op via de website voor meer informatie.');
  }

  else if (data === 'admin_users' && isAdmin(userId)) {
    const approved = await getApprovedUsers();
    const list = approved.slice(0,8).map(u => u.name + ' - ' + u.credits + ' berichten - ' + u.concept_count + ' concepten').join('\n');
    bot.sendMessage(userId, '*Actieve gebruikers (' + approved.length + '):*\n\n' + (list||'Geen'), { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Terug', callback_data: 'admin' }]] } });
  }

  else if (data === 'admin_knowledge' && isAdmin(userId)) {
    const list = await listGlobalKnowledge();
    bot.sendMessage(userId, '*Kennisbank (' + list.length + ' items)*\n\n' + (list.map((k,i)=>(i+1)+'. '+k.title).join('\n')||'Leeg'),
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: 'Toevoegen', callback_data: 'admin_know_add' }],
        [{ text: 'Verwijderen', callback_data: 'admin_know_del' }],
        [{ text: 'Terug', callback_data: 'admin' }],
      ]}}
    );
  }

  else if (data === 'admin_know_add' && isAdmin(userId)) { s.step = 'admin_awaiting_knowledge'; bot.sendMessage(userId, 'Stuur de tekst. Eerste regel = titel:'); }

  else if (data === 'admin_know_del' && isAdmin(userId)) {
    const list = await listGlobalKnowledge();
    if (!list.length) return bot.sendMessage(userId, 'Niets te verwijderen.');
    bot.sendMessage(userId, 'Kies wat je wil verwijderen:', { reply_markup: { inline_keyboard: [...list.map(k => [{ text: k.title, callback_data: 'admin_del_' + k.id }]), [{ text: 'Terug', callback_data: 'admin_knowledge' }]] } });
  }

  else if (data.startsWith('admin_del_') && isAdmin(userId)) {
    await deleteGlobalKnowledge(parseInt(data.replace('admin_del_', '')));
    bot.sendMessage(userId, 'Verwijderd.', { reply_markup: mainKeyboard(userId) });
  }

  else if (data === 'admin_give_credits' && isAdmin(userId)) { s.step = 'admin_awaiting_credits'; bot.sendMessage(userId, 'Stuur: TELEGRAM_ID AANTAL\n\nBijvoorbeeld: 123456789 50'); }

  else if (data === 'admin_report' && isAdmin(userId)) {
    const all = await getAllUsers();
    let r = '*Rapport ' + new Date().toLocaleDateString('nl-NL') + '*\n\n';
    r += all.filter(u=>u.approved).length + ' actieve gebruikers\n';
    r += all.reduce((s,u)=>s+u.credits,0) + ' berichten in omloop\n';
    r += all.reduce((s,u)=>s+u.concept_count,0) + ' concepten gemaakt\n\n';
    all.filter(u=>u.approved).slice(0,8).forEach(u => { r += u.name + ': ' + u.credits + ' berichten, ' + u.concept_count + ' concepten\n'; });
    bot.sendMessage(userId, r.slice(0,3800), { parse_mode: 'Markdown' });
  }

  // HOME
  else if (data === 'home') {
    s.step = 'idle';
    const fresh = await getUser(userId, first_name);
    bot.sendMessage(userId, '*MailMate*\n\nSaldo: *' + fresh.credits + ' berichten*', { parse_mode: 'Markdown', reply_markup: mainKeyboard(userId) });
  }
});

// ════════════════════════════════════════════════════
// BERICHTEN
// ════════════════════════════════════════════════════
bot.on('message', async (msg) => {
  if (msg.text && msg.text.startsWith('/')) return;
  const { id: userId, first_name } = msg.from;
  const s    = getState(userId);
  const text = msg.text ? msg.text.trim() : '';
  const user = await getUser(userId, first_name);

  // TOEGANGSCODE CHECK
  if (s.step === 'awaiting_access_code') {
    if (text === ACCESS_CODE) {
      // Juiste code — markeer als aanvraag ingediend en notificeer admin
      s.step = 'idle';
      await saveUser(userId, { name: first_name });
      bot.sendMessage(userId, '*Code correct!*\n\nJe aanvraag is ingediend. Je ontvangt een bericht zodra je toegang hebt gekregen.', { parse_mode: 'Markdown' });
      // Notificeer admin
      bot.sendMessage(ADMIN_ID,
        '*Nieuwe toegangsaanvraag*\n\nNaam: ' + first_name + '\nTelegram ID: ' + userId,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
          [{ text: 'Goedkeuren + 10 berichten', callback_data: 'approve_' + userId },
           { text: 'Weigeren', callback_data: 'deny_' + userId }],
        ]}}
      );
    } else {
      bot.sendMessage(userId, 'Onjuiste toegangscode. Probeer het opnieuw of neem contact op via de website.');
    }
    return;
  }

  // TOEGANGSCONTROLE op alle overige berichten
  if (!isAdmin(userId) && !user.approved) {
    bot.sendMessage(userId, 'Je hebt nog geen toegang. Tik /start om een toegangscode in te voeren.');
    return;
  }

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
        bot.sendMessage(userId, 'Document verwerkt: ' + fname, { reply_markup: mainKeyboard(userId) });
      } else if (s.step === 'admin_awaiting_pdf' && isAdmin(userId)) {
        await addGlobalKnowledge(fname, extracted);
        s.step = 'idle';
        bot.sendMessage(userId, 'Document toegevoegd aan kennisbank.', { reply_markup: mainKeyboard(userId) });
      }
    } catch(e) { s.step = 'idle'; bot.sendMessage(userId, 'Fout bij verwerken: ' + e.message); }
    return;
  }

  if (!text) return;

  // ADMIN: credits geven
  if (s.step === 'admin_awaiting_credits' && isAdmin(userId)) {
    const parts = text.split(' ');
    const targetId = parseInt(parts[0]), amount = parseInt(parts[1]);
    if (!isNaN(targetId) && !isNaN(amount)) {
      const target = await getUser(targetId, '');
      if (target) { await saveUser(targetId, { credits: target.credits + amount }); s.step = 'idle'; return bot.sendMessage(userId, amount + ' berichten toegevoegd aan ' + targetId, { reply_markup: mainKeyboard(userId) }); }
    }
    return bot.sendMessage(userId, 'Formaat: 123456789 50');
  }

  // ADMIN: kennisbank
  if (s.step === 'admin_awaiting_knowledge' && isAdmin(userId)) {
    const lines = text.split('\n');
    await addGlobalKnowledge(lines[0].trim(), lines.slice(1).join('\n').trim() || text);
    s.step = 'idle';
    bot.sendMessage(userId, 'Toegevoegd aan kennisbank.', { reply_markup: mainKeyboard(userId) });
    return;
  }

  // ONBOARDING: vakgebied
  if (s.step === 'onboard_vakgebied') {
    const parts = text.split('-').map(p => p.trim());
    await saveUser(userId, { vakgebied: parts[0]||text, doel: parts[1]||'' });
    s.step = 'onboard_toon';
    bot.sendMessage(userId, '*Stap 2 van 4 — Toon*\n\nHoe schrijf jij normaal?',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: 'Formeel (u)', callback_data: 'toon_formeel' }],
        [{ text: 'Informeel (je)', callback_data: 'toon_informeel' }],
        [{ text: 'Hangt van de klant af', callback_data: 'toon_mix' }],
      ]}}
    );
    return;
  }

  // ONBOARDING: stijl
  if (s.step === 'onboard_style') {
    if (text.length < 80) return bot.sendMessage(userId, 'Te kort. Stuur meer e-mails of tik /skip.');
    const load = await bot.sendMessage(userId, '_Schrijfstijl analyseren..._', { parse_mode: 'Markdown' });
    try {
      const profile = await callClaude('Analyseer de schrijfstijl. Max 200 woorden: toon, je/u, aanhef, afsluiting, zinslengte.\n\nE-MAILS:\n' + text);
      await saveUser(userId, { style_profiles: JSON.stringify({ default: profile }), credits: user.credits - 3 });
      bot.deleteMessage(userId, load.message_id).catch(()=>{});
      s.step = 'onboard_knowledge';
      bot.sendMessage(userId, '*Stijl geleerd! (3 berichten gebruikt)*\n\n*Stap 4 van 4 — Eigen kennis*\n\nVoeg informatie toe over je bedrijf, producten of diensten. Ik gebruik dit bij elk antwoord.\n\n_Tik /skip om later toe te voegen._', { parse_mode: 'Markdown' });
    } catch(e) { bot.deleteMessage(userId, load.message_id).catch(()=>{}); bot.sendMessage(userId, 'Fout: ' + e.message); }
    return;
  }

  // ONBOARDING: kennisbank
  if (s.step === 'onboard_knowledge') {
    await saveUser(userId, { user_knowledge: text.slice(0,12000), onboarded: true });
    s.step = 'idle';
    bot.sendMessage(userId, '*Klaar! Je bent volledig ingesteld.*\n\nStuur me een e-mail en ik schrijf direct een conceptantwoord.', { parse_mode: 'Markdown', reply_markup: mainKeyboard(userId) });
    return;
  }

  // STIJLNAAM
  if (s.step === 'awaiting_style_name') {
    s.trainStyleName = text.toLowerCase().trim();
    s.step = 'awaiting_train';
    bot.sendMessage(userId, 'Naam: "' + s.trainStyleName + '"\n\nStuur nu 5+ e-mails die jij hebt geschreven. Scheid ze met ——', { parse_mode: 'Markdown' });
    return;
  }

  // STIJL TRAINEN
  if (s.step === 'awaiting_train') {
    if (text.length < 100) return bot.sendMessage(userId, 'Te weinig tekst. Stuur meer e-mails.');
    const load = await bot.sendMessage(userId, '_Schrijfstijl analyseren..._', { parse_mode: 'Markdown' });
    try {
      const profile   = await callClaude('Analyseer de schrijfstijl. Max 200 woorden: toon, je/u, aanhef, afsluiting, zinslengte.\n\nE-MAILS:\n' + text);
      const styleName = s.trainStyleName || 'default';
      const profiles  = JSON.parse(user.style_profiles || '{"default":""}');
      profiles[styleName] = profile;
      await saveUser(userId, { style_profiles: JSON.stringify(profiles), credits: user.credits - 3 });
      s.step = 'idle';
      bot.deleteMessage(userId, load.message_id).catch(()=>{});
      bot.sendMessage(userId, '*Stijl "' + styleName + '" opgeslagen!*\n\nSaldo: ' + (user.credits-3) + ' berichten', { parse_mode: 'Markdown', reply_markup: mainKeyboard(userId) });
    } catch(e) { bot.deleteMessage(userId, load.message_id).catch(()=>{}); bot.sendMessage(userId, 'Fout: ' + e.message); }
    return;
  }

  // KENNISBANK TOEVOEGEN
  if (s.step === 'awaiting_user_knowledge') {
    await saveUser(userId, { user_knowledge: ((user.user_knowledge||'')+'\n\n'+text).slice(0,12000) });
    s.step = 'idle';
    bot.sendMessage(userId, 'Toegevoegd aan kennisbank.', { reply_markup: mainKeyboard(userId) });
    return;
  }

  // TEMPLATE NAAM
  if (s.step === 'awaiting_template_name') {
    await saveTemplate(userId, text.trim(), s.lastConcept);
    s.step = 'idle';
    bot.sendMessage(userId, '"' + text.trim() + '" opgeslagen!', { reply_markup: mainKeyboard(userId) });
    return;
  }

  // VERFIJNEN
  if (s.step === 'awaiting_refine') {
    if (!s.lastConcept) return bot.sendMessage(userId, 'Geen concept.', { reply_markup: mainKeyboard(userId) });
    const load = await bot.sendMessage(userId, '_Antwoord aanpassen..._', { parse_mode: 'Markdown' });
    try {
      const refined = await callClaude('Pas dit e-mail concept aan op basis van de instructie. Geef alleen het resultaat.\n\nInstructie: ' + text + '\n\nHuidig concept:\n' + s.lastConcept, 'Pas het concept aan. Geef alleen het resultaat terug.');
      s.lastConcept = refined;
      s.step = 'idle';
      bot.deleteMessage(userId, load.message_id).catch(()=>{});
      bot.sendMessage(userId, '*Aangepast antwoord:*\n\n' + refined,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
          [{ text: 'Nogmaals aanpassen', callback_data: 'refine' }, { text: 'Opslaan', callback_data: 'save_template' }],
          [{ text: 'Home', callback_data: 'home' }],
        ]}}
      );
    } catch(e) { bot.deleteMessage(userId, load.message_id).catch(()=>{}); bot.sendMessage(userId, 'Fout: ' + e.message); }
    return;
  }

  // BATCH
  if (s.step === 'awaiting_batch') {
    const mails = text.split('===MAIL===').map(m => m.trim()).filter(m => m.length > 20);
    if (!mails.length) return bot.sendMessage(userId, 'Geen e-mails gevonden. Zet ===MAIL=== tussen de mails.');
    if (user.credits < mails.length) return bot.sendMessage(userId, 'Je hebt ' + user.credits + ' berichten maar hebt ' + mails.length + ' nodig.', { reply_markup: creditsKeyboard() });
    const load = await bot.sendMessage(userId, '_' + mails.length + ' e-mails verwerken..._', { parse_mode: 'Markdown' });
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
      bot.sendMessage(userId, '*' + mails.length + ' concepten klaar.*\n\nSaldo: ' + (user.credits-mails.length) + ' berichten', { parse_mode: 'Markdown', reply_markup: mainKeyboard(userId) });
    } catch(e) { bot.deleteMessage(userId, load.message_id).catch(()=>{}); bot.sendMessage(userId, 'Fout: ' + e.message); }
    return;
  }

  // CONCEPT GENEREREN
  if (s.step === 'awaiting_mail') {
    if (text.length < 20) return bot.sendMessage(userId, 'E-mail te kort.');
    if (!checkRateLimit(userId)) return bot.sendMessage(userId, 'Je hebt het maximum van ' + MAX_PER_HOUR + ' concepten per uur bereikt. Probeer het straks opnieuw.');
    const load = await bot.sendMessage(userId, '_Conceptantwoord schrijven..._', { parse_mode: 'Markdown' });
    try {
      const clientEmail  = (text.match(/Van:\s*([^\s]+@[^\s]+)/i)||[])[1] || null;
      const analysis     = await analyzeMail(text);
      const clientInfo   = clientEmail ? await getClient(userId, clientEmail) : null;
      const systemPrompt = await buildSystemPrompt(user, s.activeStyle || 'default', clientInfo);
      const reply        = await callClaude('Schrijf een conceptantwoord:\n\n' + text, systemPrompt);
      const subjectLine  = await generateSubjectLine((text.match(/Onderwerp:\s*(.+)/)||[])[1]||'', reply);

      s.lastConcept  = reply;
      s.lastIncoming = text;
      s.step = 'idle';

      await saveUser(userId, { credits: user.credits - 1, concept_count: user.concept_count + 1 });
      const subj = (text.match(/(?:Onderwerp|Subject):\s*(.+)/)||['','E-mail'])[1];
      await addHistory(userId, subj, reply);
      await scheduleFollowUp(userId, subj);
      if (clientEmail) await upsertClient(userId, clientEmail, subj, text);

      bot.deleteMessage(userId, load.message_id).catch(()=>{});

      const sentimentTekst = analysis.sentiment === 'urgent' ? 'Urgent' : analysis.sentiment === 'negatief' ? 'Negatieve toon' : '';

      bot.sendMessage(userId,
        (sentimentTekst ? '*' + sentimentTekst + '*\n\n' : '') +
        '*Conceptantwoord:*\n\n' + reply + '\n\n_Onderwerpregel: ' + subjectLine + '_\n\n_Saldo: ' + (user.credits-1) + ' berichten_',
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
          [{ text: 'Aanpassen', callback_data: 'refine' }, { text: 'Twee versies', callback_data: 'ab_versions' }],
          [{ text: 'Opslaan', callback_data: 'save_template' }, { text: 'Opnieuw', callback_data: 'compose' }],
          [{ text: 'Home', callback_data: 'home' }],
        ]}}
      );
    } catch(e) {
      bot.deleteMessage(userId, load.message_id).catch(()=>{});
      bot.sendMessage(userId, 'Fout: ' + e.message, { reply_markup: mainKeyboard(userId) });
    }
    return;
  }

  bot.sendMessage(userId, 'Gebruik de knoppen hieronder.', { reply_markup: mainKeyboard(userId) });
});

// FOLLOW-UP checker
setInterval(async () => {
  const { data } = await supabase.from('followups').select('*').eq('sent', false).lte('remind_at', new Date().toISOString());
  if (!data) return;
  for (const f of data) {
    try {
      await bot.sendMessage(f.telegram_id, '*Herinnering*\n\n"' + f.subject + '"\n\nHeb je al geantwoord?',
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
          [{ text: 'Nieuw concept', callback_data: 'compose' }, { text: 'Al gedaan', callback_data: 'followup_done_' + f.id }],
        ]}}
      );
      await supabase.from('followups').update({ sent: true }).eq('id', f.id);
    } catch(e) {}
  }
}, 6 * 60 * 60 * 1000);

// Berichten bijna op checker
setInterval(async () => {
  const users = await getAllUsers();
  for (const u of users) {
    if (u.approved && u.credits > 0 && u.credits <= 5) {
      try { await bot.sendMessage(u.telegram_id, 'Nog *' + u.credits + ' berichten* resterend. Koop berichten om door te gaan.', { parse_mode: 'Markdown', reply_markup: creditsKeyboard() }); }
      catch(e) {}
    }
  }
}, 24 * 60 * 60 * 1000);

console.log('MailMate v4.1 gestart — Whitelist + Rate limiting actief');
