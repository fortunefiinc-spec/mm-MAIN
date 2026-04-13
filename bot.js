// MailMate Bot v5 - Clean rebuild
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');

// Config
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID || '0');
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const MINI_APP_URL = process.env.MINI_APP_URL || '';
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const ACCESS_CODE = process.env.ACCESS_CODE || 'mailmate2025';
const MAX_PER_HOUR = parseInt(process.env.MAX_PER_HOUR || '20');

const bot = new TelegramBot(BOT_TOKEN, WEBHOOK_URL ? { webHook: true } : { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

let stripe = null;
if (STRIPE_KEY) {
  stripe = require('stripe')(STRIPE_KEY);
  console.log('Stripe actief');
} else {
  console.log('Stripe demo modus');
}

// Express
const app = express();

// CORS
app.use(function(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(function(req, res, next) {
  if (req.path === '/stripe-webhook') {
    express.raw({ type: 'application/json' })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});

app.get('/', function(req, res) { res.send('MailMate v5 OK'); });
app.get('/health', function(req, res) { res.json({ status: 'ok', version: '5.0.0' }); });

// Telegram webhook
app.post('/bot' + BOT_TOKEN, function(req, res) {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Magic link e-mail versturen
app.post('/api/send-login-email', async function(req, res) {
  var email = req.body.email;
  var token = req.body.token;
  var name  = req.body.name || 'gebruiker';
  if (!email || !token) return res.status(400).json({ error: 'email en token vereist' });
  var APP_URL = process.env.MINI_APP_URL || 'https://fortunefiinc-spec.github.io/MM-app';
  var loginUrl = APP_URL + '?token=' + token;
  var RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) {
    // Geen Resend key - stuur inlogcode terug
    return res.json({ success: true, fallback: true, message: 'Geen e-mail geconfigureerd' });
  }
  try {
    var emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + RESEND_KEY },
      body: JSON.stringify({
        from: 'MailMate <noreply@mailmate.nl>',
        to: [email],
        subject: 'Jouw inloglink voor MailMate',
        html: '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">' +
          '<h2 style="font-size:24px;margin-bottom:8px">Hallo ' + name + '</h2>' +
          '<p style="color:#666;margin-bottom:24px">Klik op de knop om direct in te loggen bij MailMate. De link is 24 uur geldig.</p>' +
          '<a href="' + loginUrl + '" style="display:inline-block;background:#b8860b;color:#fff;padding:14px 28px;text-decoration:none;font-weight:600;font-size:15px">Inloggen bij MailMate</a>' +
          '<p style="color:#999;font-size:12px;margin-top:24px">Of kopieer deze link: ' + loginUrl + '</p>' +
          '<p style="color:#ccc;font-size:11px;margin-top:16px">Als je deze e-mail niet hebt aangevraagd, kun je hem negeren.</p>' +
          '</div>'
      })
    });
    var emailData = await emailRes.json();
    if (emailData.id) {
      res.json({ success: true });
    } else {
      res.status(500).json({ error: 'E-mail versturen mislukt' });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin notificatie bij nieuwe registratie
app.post('/api/notify-admin', async function(req, res) {
  var naam   = req.body.naam || req.body.name || 'Onbekend';
  var email  = req.body.email || '';
  var beroep = req.body.beroep || '';
  try {
    // Zoek gebruiker op in Supabase voor telegram_id
    var { data: newUser } = await sb.from('users').select('*').eq('email', email).single();
    var tid = newUser ? newUser.telegram_id : 0;
    bot.sendMessage(ADMIN_ID,
      'Nieuwe aanvraag via webapp!\n\n' +
      'Naam: ' + naam + '\n' +
      'E-mail: ' + email + '\n' +
      'Beroep: ' + (beroep || 'niet opgegeven'),
      { reply_markup: { inline_keyboard: [
        [{ text: 'Goedkeuren + 10 berichten', callback_data: 'approve_email_' + email }],
        [{ text: 'Weigeren', callback_data: 'deny_email_' + email }]
      ]}}
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Stripe webhook
app.post('/stripe-webhook', async function(req, res) {
  if (!stripe) return res.sendStatus(200);
  try {
    var event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
    if (event.type === 'checkout.session.completed') {
      var tid = parseInt(event.data.object.metadata.telegram_id);
      var cr = parseInt(event.data.object.metadata.credits);
      var u = await getUser(tid, '');
      if (u) {
        await saveUser(tid, { credits: u.credits + cr });
        bot.sendMessage(tid, cr + ' berichten toegevoegd! Nieuw saldo: ' + (u.credits + cr), { reply_markup: mainKeyboard(tid) });
      }
    }
  } catch(e) { console.error('Stripe:', e.message); }
  res.sendStatus(200);
});

// Outlook/Gmail webhook
app.post('/mailhook/:userId', async function(req, res) {
  var tid = parseInt(req.params.userId);
  var apiKey = req.headers['x-api-key'];
  var u = await getUser(tid, '');
  if (!u || u.webhook_key !== apiKey) return res.status(401).json({ error: 'Unauthorized' });
  if (!u.approved && tid !== ADMIN_ID) return res.status(403).json({ error: 'Niet goedgekeurd' });
  var subject = req.body.subject || '';
  var from = req.body.from || '';
  var body = req.body.body || '';
  if (!body) return res.status(400).json({ error: 'body required' });
  try {
    var mailText = 'Van: ' + from + '\nOnderwerp: ' + subject + '\n\n' + body;
    var sys = await buildSystemPrompt(u);
    var concept = await callClaude('Schrijf een conceptantwoord op deze e-mail:\n\n' + mailText, sys);
    await saveUser(tid, { credits: u.credits - 1, concept_count: u.concept_count + 1 });
    await addHistory(tid, subject || 'Mail via koppeling', concept);
    bot.sendMessage(tid, 'Nieuwe mail van: ' + from + '\nOnderwerp: ' + subject + '\n\nConceptantwoord:\n\n' + concept + '\n\nSaldo: ' + (u.credits - 1) + ' berichten', {
      reply_markup: { inline_keyboard: [
        [{ text: 'Aanpassen', callback_data: 'refine' }, { text: 'Opnieuw', callback_data: 'compose' }],
        [{ text: 'Home', callback_data: 'home' }]
      ]}
    });
    res.json({ success: true, concept: concept });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// API endpoints voor webapp
app.post('/api/compose', async function(req, res) {
  var tid = parseInt(req.body.telegram_id) || 0;
  var apiKey = req.body.api_key;
  var mailText = req.body.mail_text || '';
  var style = req.body.style || 'default';
  var u = await getUser(tid, '');
  if (!u || u.webhook_key !== apiKey) return res.status(401).json({ error: 'Unauthorized' });
  if (!u.approved && tid !== ADMIN_ID) return res.status(403).json({ error: 'Niet goedgekeurd' });
  if (u.credits < 1) return res.status(402).json({ error: 'Onvoldoende berichten' });
  try {
    var sys = await buildSystemPrompt(u, style);
    var concept = await callClaude('Schrijf een conceptantwoord:\n\n' + mailText, sys);
    await saveUser(tid, { credits: u.credits - 1, concept_count: u.concept_count + 1 });
    await addHistory(tid, 'Mail via app', concept);
    res.json({ concept: concept, credits_remaining: u.credits - 1, sentiment: 'normaal' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/compose-ab', async function(req, res) {
  var tid = parseInt(req.body.telegram_id) || 0;
  var apiKey = req.body.api_key;
  var mailText = req.body.mail_text || '';
  var u = await getUser(tid, '');
  if (!u || u.webhook_key !== apiKey) return res.status(401).json({ error: 'Unauthorized' });
  if (u.credits < 2) return res.status(402).json({ error: 'Minimaal 2 berichten nodig' });
  try {
    var sys = await buildSystemPrompt(u);
    var results = await Promise.all([
      callClaude('Schrijf een FORMEEL conceptantwoord, gebruik u:\n\n' + mailText, sys),
      callClaude('Schrijf een INFORMEEL conceptantwoord, gebruik je:\n\n' + mailText, sys)
    ]);
    await saveUser(tid, { credits: u.credits - 2, concept_count: u.concept_count + 2 });
    res.json({ formal: results[0], informal: results[1] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/refine', async function(req, res) {
  var tid = parseInt(req.body.telegram_id) || 0;
  var apiKey = req.body.api_key;
  var concept = req.body.concept || '';
  var instruction = req.body.instruction || '';
  var u = await getUser(tid, '');
  if (!u || u.webhook_key !== apiKey) return res.status(401).json({ error: 'Unauthorized' });
  try {
    var refined = await callClaude('Pas dit concept aan. Instructie: ' + instruction + '\n\nConcept:\n' + concept, 'Pas het e-mail concept aan en geef alleen het resultaat terug.');
    res.json({ refined: refined });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/train-style', async function(req, res) {
  var tid = parseInt(req.body.telegram_id) || 0;
  var apiKey = req.body.api_key;
  var name = req.body.name || 'default';
  var mails = req.body.mails || '';
  var u = await getUser(tid, '');
  if (!u || u.webhook_key !== apiKey) return res.status(401).json({ error: 'Unauthorized' });
  if (u.credits < 3) return res.status(402).json({ error: 'Minimaal 3 berichten nodig' });
  try {
    var profile = await callClaude('Analyseer schrijfstijl in max 200 woorden. Beschrijf toon, aanhef, afsluiting, zinslengte.\n\nE-MAILS:\n' + mails);
    var profiles = JSON.parse(u.style_profiles || '{"default":""}');
    profiles[name] = profile;
    await saveUser(tid, { style_profiles: JSON.stringify(profiles), credits: u.credits - 3 });
    res.json({ success: true, profile: profile });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, '0.0.0.0', function() {
  console.log('MailMate v5 draait op poort ' + PORT);
  if (WEBHOOK_URL) {
    bot.setWebHook(WEBHOOK_URL + '/bot' + BOT_TOKEN)
      .then(function() { console.log('Webhook actief'); })
      .catch(function(e) { console.error('Webhook fout:', e.message); });
  }
});

// ????????????????????????????????????????
// SUPABASE FUNCTIES
// ????????????????????????????????????????

function generateKey() {
  return 'mm_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function fallback(tid, name) {
  return {
    telegram_id: tid, name: name || 'Gebruiker', credits: 10, concept_count: 0,
    style_profiles: '{"default":""}', active_style: 'default', user_knowledge: '',
    onboarded: false, approved: false, vakgebied: '', doel: '', toon_voorkeur: '',
    webhook_key: ''
  };
}

async function getUser(tid, name) {
  try {
    var result = await sb.from('users').select('*').eq('telegram_id', tid).single();
    if (result.data) return result.data;
    var ins = await sb.from('users').insert({
      telegram_id: tid, name: name || 'Gebruiker', credits: 10, concept_count: 0,
      style_profiles: JSON.stringify({ default: '' }), active_style: 'default',
      user_knowledge: '', onboarded: false, approved: false,
      vakgebied: '', doel: '', toon_voorkeur: '', webhook_key: generateKey()
    }).select().single();
    if (ins.error) console.error('Insert fout:', ins.error.message);
    return ins.data || fallback(tid, name);
  } catch(e) {
    console.error('getUser fout:', e.message);
    return fallback(tid, name);
  }
}

async function saveUser(tid, updates) {
  updates.updated_at = new Date().toISOString();
  await sb.from('users').update(updates).eq('telegram_id', tid);
}

async function addHistory(tid, subject, concept) {
  await sb.from('history').insert({
    telegram_id: tid, subject: subject, concept: concept || '',
    created_at: new Date().toISOString()
  });
}

async function getHistory(tid, limit) {
  var result = await sb.from('history').select('*').eq('telegram_id', tid).order('created_at', { ascending: false }).limit(limit || 8);
  return result.data || [];
}

async function getAllUsers() {
  var result = await sb.from('users').select('*').order('created_at', { ascending: false });
  return result.data || [];
}

async function getGlobalKnowledge() {
  var result = await sb.from('global_knowledge').select('content').order('created_at', { ascending: true });
  if (!result.data || !result.data.length) return '';
  return result.data.map(function(d) { return d.content; }).join('\n\n---\n\n');
}

async function addGlobalKnowledge(title, content) {
  await sb.from('global_knowledge').insert({ title: title, content: content, created_at: new Date().toISOString() });
}

async function listGlobalKnowledge() {
  var result = await sb.from('global_knowledge').select('id, title').order('created_at', { ascending: false });
  return result.data || [];
}

async function deleteGlobalKnowledge(id) {
  await sb.from('global_knowledge').delete().eq('id', id);
}

async function upsertClient(tid, email, subject) {
  if (!email) return;
  var result = await sb.from('clients').select('*').eq('telegram_id', tid).eq('email', email).single();
  if (result.data) {
    await sb.from('clients').update({
      contact_count: (result.data.contact_count || 0) + 1,
      last_subject: subject,
      last_contact: new Date().toISOString()
    }).eq('id', result.data.id);
  } else {
    await sb.from('clients').insert({
      telegram_id: tid, email: email, last_subject: subject,
      contact_count: 1, last_contact: new Date().toISOString(), notes: ''
    });
  }
}

async function getTemplates(tid) {
  var result = await sb.from('templates').select('*').eq('telegram_id', tid).order('created_at', { ascending: false });
  return result.data || [];
}

async function saveTemplate(tid, name, content) {
  await sb.from('templates').insert({ telegram_id: tid, name: name, content: content, created_at: new Date().toISOString() });
}

async function deleteTemplate(id) {
  await sb.from('templates').delete().eq('id', id);
}

async function scheduleFollowUp(tid, subject) {
  await sb.from('followups').insert({
    telegram_id: tid, subject: subject,
    remind_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    sent: false
  });
}

// ????????????????????????????????????????
// AI FUNCTIES
// ????????????????????????????????????????

async function callClaude(userMsg, systemMsg, maxTokens) {
  var params = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: maxTokens || 1200,
    messages: [{ role: 'user', content: userMsg }]
  };
  if (systemMsg) params.system = systemMsg;
  var res = await anthropic.messages.create(params);
  return res.content.map(function(b) { return b.text || ''; }).join('');
}

async function buildSystemPrompt(u, styleName) {
  styleName = styleName || u.active_style || 'default';
  var profiles = JSON.parse(u.style_profiles || '{"default":""}');
  var profile = profiles[styleName] || profiles['default'] || '';
  var globalKnowledge = await getGlobalKnowledge();

  var prompt = 'Je bent een professionele e-mail assistent. Schrijf conceptantwoorden in de stijl van de gebruiker.\n\n';
  prompt += 'SCHRIJFSTIJL:\n' + (profile || 'Schrijf professioneel en vriendelijk.') + '\n\n';
  prompt += 'VAKGEBIED: ' + (u.vakgebied || 'Algemeen') + '\n';
  prompt += 'TOON: ' + (u.toon_voorkeur || 'Professioneel') + '\n\n';
  if (globalKnowledge) prompt += 'KENNISBANK:\n' + globalKnowledge + '\n\n';
  if (u.user_knowledge) prompt += 'EIGEN KENNIS:\n' + u.user_knowledge + '\n\n';
  prompt += 'REGEL: Geef ALLEEN het conceptantwoord terug, geen uitleg.';
  return prompt;
}

async function createStripeCheckout(tid, credits, priceEur) {
  if (!stripe) return null;
  var session = await stripe.checkout.sessions.create({
    payment_method_types: ['card', 'ideal'],
    line_items: [{ price_data: { currency: 'eur', product_data: { name: 'MailMate ' + credits + ' berichten' }, unit_amount: priceEur * 100 }, quantity: 1 }],
    mode: 'payment',
    success_url: WEBHOOK_URL + '/betaling-succes',
    cancel_url: WEBHOOK_URL + '/betaling-geannuleerd',
    metadata: { telegram_id: tid.toString(), credits: credits.toString() }
  });
  return session.url;
}

// ????????????????????????????????????????
// RATE LIMITING
// ????????????????????????????????????????
var rateLimits = {};

function checkRate(tid) {
  var now = Date.now();
  if (!rateLimits[tid] || now > rateLimits[tid].reset) {
    rateLimits[tid] = { count: 1, reset: now + 60 * 60 * 1000 };
    return true;
  }
  if (rateLimits[tid].count >= MAX_PER_HOUR) return false;
  rateLimits[tid].count++;
  return true;
}

// ????????????????????????????????????????
// SESSION STATE
// ????????????????????????????????????????
var states = {};

function getState(tid) {
  if (!states[tid]) states[tid] = { step: 'idle', lastConcept: '', lastMail: '', style: 'default', trainName: null };
  return states[tid];
}

var isAdmin = function(tid) { return tid === ADMIN_ID; };

// ????????????????????????????????????????
// KEYBOARDS
// ????????????????????????????????????????
function mainKeyboard(tid) {
  var rows = [
    [{ text: 'Concept schrijven', callback_data: 'compose' }],
    [{ text: 'Meerdere mails', callback_data: 'batch' }],
    [{ text: 'Stijl trainen', callback_data: 'train' }],
    [{ text: 'Kennisbank', callback_data: 'myknow' }],
    [{ text: 'Opgeslagen antwoorden', callback_data: 'templates' }],
    [{ text: 'Koppeling instellen', callback_data: 'webhook' }],
    [{ text: 'Geschiedenis', callback_data: 'history' }],
    [{ text: 'Berichten kopen', callback_data: 'credits' }]
  ];
  if (MINI_APP_URL) rows.push([{ text: 'Open in app', web_app: { url: MINI_APP_URL } }]);
  if (isAdmin(tid)) rows.push([{ text: 'Beheer', callback_data: 'admin' }]);
  return { inline_keyboard: rows };
}

function creditsKeyboard() {
  return { inline_keyboard: [
    [{ text: '50 berichten - 9 euro', callback_data: 'buy_50_9' }, { text: '200 berichten - 29 euro', callback_data: 'buy_200_29' }],
    [{ text: '600 berichten - 79 euro', callback_data: 'buy_600_79' }]
  ]};
}

// ????????????????????????????????????????
// ONBOARDING
// ????????????????????????????????????????
async function startOnboarding(tid, name) {
  await bot.sendMessage(tid,
    'Welkom bij MailMate, ' + name + '!\n\n' +
    'Ik ben jouw persoonlijke e-mail assistent.\n\n' +
    'Stap 1 van 4 - Vakgebied\n\n' +
    'In welk vakgebied werk je?\n\n' +
    'Bijv: Assurantiekantoor - klantadvies\n' +
    'Of: Bouwbedrijf - offertes\n\n' +
    'Tik /skip om dit later in te stellen.'
  );
  getState(tid).step = 'onboard_vakgebied';
}

// ????????????????????????????????????????
// /start
// ????????????????????????????????????????
bot.onText(/\/start/, async function(msg) {
  var tid = msg.from.id;
  var name = msg.from.first_name || 'Gebruiker';
  var u;
  try { u = await getUser(tid, name); } catch(e) { u = fallback(tid, name); }
  if (!u) u = fallback(tid, name);

  if (isAdmin(tid) && !u.approved) {
    await saveUser(tid, { approved: true, credits: 100 });
    u.approved = true;
    u.credits = 100;
  }

  if (!u.approved) {
    getState(tid).step = 'awaiting_code';
    bot.sendMessage(tid, 'Welkom bij MailMate!\n\nVoer de toegangscode in om te starten.\n\nGeen code? Vraag toegang aan via de website.');
    return;
  }

  if (!u.onboarded) {
    await startOnboarding(tid, name);
    return;
  }

  bot.sendMessage(tid, 'Welkom terug, ' + name + '!\n\nSaldo: ' + u.credits + ' berichten', { reply_markup: mainKeyboard(tid) });
});

// /skip
bot.onText(/\/skip/, async function(msg) {
  var tid = msg.from.id;
  var s = getState(tid);
  if (s.step === 'onboard_vakgebied') {
    await saveUser(tid, { vakgebied: 'Algemeen' });
    s.step = 'onboard_toon';
    bot.sendMessage(tid, 'Stap 2 van 4 - Toon\n\nHoe schrijf jij normaal?', { reply_markup: { inline_keyboard: [
      [{ text: 'Formeel (u)', callback_data: 'toon_formeel' }],
      [{ text: 'Informeel (je)', callback_data: 'toon_informeel' }],
      [{ text: 'Mix', callback_data: 'toon_mix' }]
    ]}});
  } else if (s.step === 'onboard_style') {
    s.step = 'onboard_knowledge';
    bot.sendMessage(tid, 'Stap 4 van 4 - Kennisbank\n\nVoeg info toe over je bedrijf, of tik /skip.');
  } else if (s.step === 'onboard_knowledge') {
    await saveUser(tid, { onboarded: true });
    s.step = 'idle';
    bot.sendMessage(tid, 'Klaar! Je agent is ingesteld.', { reply_markup: mainKeyboard(tid) });
  }
});

// ????????????????????????????????????????
// CALLBACKS
// ????????????????????????????????????????
bot.on('callback_query', async function(query) {
  var tid = query.from.id;
  var name = query.from.first_name || 'Gebruiker';
  var data = query.data;
  var s = getState(tid);
  bot.answerCallbackQuery(query.id);

  // Toegangscontrole
  if (!isAdmin(tid)) {
    var check = await getUser(tid, name);
    if (!check || !check.approved) {
      bot.sendMessage(tid, 'Je hebt nog geen toegang. Tik /start en voer je code in.');
      return;
    }
  }

  var u = await getUser(tid, name);

  // Toon onboarding
  if (data.startsWith('toon_')) {
    var toonMap = { toon_formeel: 'Formeel', toon_informeel: 'Informeel', toon_mix: 'Mix' };
    await saveUser(tid, { toon_voorkeur: toonMap[data] || 'Professioneel' });
    s.step = 'onboard_style';
    bot.sendMessage(tid, 'Toon opgeslagen.\n\nStap 3 van 4 - Schrijfstijl\n\nStuur 5+ eigen e-mails gescheiden door --\n\nOf tik /skip.');
    return;
  }

  if (data === 'followup_done') {
    bot.sendMessage(tid, 'Gemarkeerd als verzonden.', { reply_markup: mainKeyboard(tid) });
    return;
  }

  if (data === 'compose') {
    if (u.credits < 1) { bot.sendMessage(tid, 'Geen berichten meer.', { reply_markup: creditsKeyboard() }); return; }
    if (!checkRate(tid)) { bot.sendMessage(tid, 'Maximum bereikt. Probeer over een uur opnieuw.'); return; }
    var profs = JSON.parse(u.style_profiles || '{"default":""}');
    var styleNames = Object.keys(profs).filter(function(k) { return profs[k]; });
    if (styleNames.length > 1) {
      s.step = 'awaiting_mail';
      return bot.sendMessage(tid, 'Kies een stijl:', { reply_markup: { inline_keyboard: styleNames.map(function(n) { return [{ text: n, callback_data: 'style_' + n }]; }) }});
    }
    s.step = 'awaiting_mail';
    s.style = styleNames[0] || 'default';
    bot.sendMessage(tid, 'Plak de e-mail waarop je wil antwoorden.');
  }

  else if (data.startsWith('style_')) {
    s.style = data.replace('style_', '');
    s.step = 'awaiting_mail';
    bot.sendMessage(tid, 'Stijl: ' + s.style + '\n\nPlak de e-mail.');
  }

  else if (data === 'batch') {
    if (u.credits < 1) { bot.sendMessage(tid, 'Geen berichten meer.', { reply_markup: creditsKeyboard() }); return; }
    s.step = 'awaiting_batch';
    bot.sendMessage(tid, 'Meerdere mails verwerken\n\nPlak mails en zet ===MAIL=== tussen elke mail.\n\n1 bericht per mail.');
  }

  else if (data === 'refine') {
    if (!s.lastConcept) { bot.sendMessage(tid, 'Geen concept beschikbaar.', { reply_markup: mainKeyboard(tid) }); return; }
    s.step = 'awaiting_refine';
    bot.sendMessage(tid, 'Geef aan wat je anders wil:\n- Maak korter\n- Formeler\n- Voeg disclaimer toe');
  }

  else if (data === 'ab_versions') {
    if (!s.lastMail) { bot.sendMessage(tid, 'Geen e-mail beschikbaar.', { reply_markup: mainKeyboard(tid) }); return; }
    if (u.credits < 2) { bot.sendMessage(tid, 'Twee versies kost 2 berichten.', { reply_markup: creditsKeyboard() }); return; }
    var loadMsg = await bot.sendMessage(tid, 'Twee versies maken...');
    try {
      var sys = await buildSystemPrompt(u, s.style);
      var ab = await Promise.all([
        callClaude('Schrijf een FORMEEL conceptantwoord, gebruik u:\n\n' + s.lastMail, sys),
        callClaude('Schrijf een INFORMEEL conceptantwoord, gebruik je:\n\n' + s.lastMail, sys)
      ]);
      await saveUser(tid, { credits: u.credits - 2, concept_count: u.concept_count + 2 });
      bot.deleteMessage(tid, loadMsg.message_id).catch(function() {});
      bot.sendMessage(tid, 'Twee versies (2 berichten):\n\nFORMEEL:\n' + ab[0] + '\n\n---\n\nINFORMEEL:\n' + ab[1], { reply_markup: { inline_keyboard: [[{ text: 'Home', callback_data: 'home' }]] }});
    } catch(e) {
      bot.deleteMessage(tid, loadMsg.message_id).catch(function() {});
      bot.sendMessage(tid, 'Fout: ' + e.message);
    }
  }

  else if (data === 'save_template') {
    if (!s.lastConcept) { bot.sendMessage(tid, 'Geen concept om op te slaan.'); return; }
    s.step = 'awaiting_template_name';
    bot.sendMessage(tid, 'Geef een naam voor dit antwoord:');
  }

  else if (data === 'templates') {
    var tmplList = await getTemplates(tid);
    if (!tmplList.length) { bot.sendMessage(tid, 'Nog geen opgeslagen antwoorden.', { reply_markup: { inline_keyboard: [[{ text: 'Terug', callback_data: 'home' }]] }}); return; }
    bot.sendMessage(tid, 'Opgeslagen antwoorden:', { reply_markup: { inline_keyboard: tmplList.map(function(t) { return [{ text: t.name, callback_data: 'use_tmpl_' + t.id }, { text: 'Verwijder', callback_data: 'del_tmpl_' + t.id }]; }).concat([[{ text: 'Terug', callback_data: 'home' }]]) }});
  }

  else if (data.startsWith('use_tmpl_')) {
    var tmplId = parseInt(data.replace('use_tmpl_', ''));
    var allTmpls = await getTemplates(tid);
    var tmpl = allTmpls.find(function(t) { return t.id === tmplId; });
    if (tmpl) {
      s.lastConcept = tmpl.content;
      bot.sendMessage(tid, tmpl.name + ':\n\n' + tmpl.content, { reply_markup: { inline_keyboard: [[{ text: 'Aanpassen', callback_data: 'refine' }], [{ text: 'Terug', callback_data: 'home' }]] }});
    }
  }

  else if (data.startsWith('del_tmpl_')) {
    await deleteTemplate(parseInt(data.replace('del_tmpl_', '')));
    bot.sendMessage(tid, 'Verwijderd.', { reply_markup: mainKeyboard(tid) });
  }

  else if (data === 'train') {
    if (u.credits < 3) { bot.sendMessage(tid, 'Stijl trainen kost 3 berichten.', { reply_markup: creditsKeyboard() }); return; }
    var profs2 = JSON.parse(u.style_profiles || '{"default":""}');
    var names2 = Object.keys(profs2);
    bot.sendMessage(tid, 'Schrijfstijlen: ' + names2.join(', '), { reply_markup: { inline_keyboard: [
      [{ text: 'Nieuwe stijl', callback_data: 'train_new' }],
      ...names2.map(function(n) { return [{ text: n + ' opnieuw trainen', callback_data: 'train_' + n }]; })
    ]}});
  }

  else if (data === 'train_new') { s.step = 'awaiting_style_name'; bot.sendMessage(tid, 'Naam voor de nieuwe stijl:'); }
  else if (data.startsWith('train_') && data !== 'train_new') {
    s.trainName = data.replace('train_', '');
    s.step = 'awaiting_train';
    bot.sendMessage(tid, 'Stijl "' + s.trainName + '" trainen.\n\nStuur 5+ eigen e-mails, gescheiden door --');
  }

  else if (data === 'myknow') {
    var knowPreview = u.user_knowledge ? u.user_knowledge.slice(0, 150) + '...' : 'Leeg';
    bot.sendMessage(tid, 'Kennisbank:\n\n' + knowPreview, { reply_markup: { inline_keyboard: [
      [{ text: 'Toevoegen', callback_data: 'know_add' }],
      [{ text: 'Leegmaken', callback_data: 'know_clear' }],
      [{ text: 'Terug', callback_data: 'home' }]
    ]}});
  }

  else if (data === 'know_add') { s.step = 'awaiting_knowledge'; bot.sendMessage(tid, 'Stuur de informatie die ik moet weten:'); }
  else if (data === 'know_clear') { await saveUser(tid, { user_knowledge: '' }); bot.sendMessage(tid, 'Kennisbank leeggemaakt.', { reply_markup: mainKeyboard(tid) }); }

  else if (data === 'webhook') {
    if (!u.webhook_key) await saveUser(tid, { webhook_key: generateKey() });
    var freshUser = await getUser(tid, name);
    var wUrl = WEBHOOK_URL + '/mailhook/' + tid;
    bot.sendMessage(tid,
      'Koppeling met Outlook en Gmail\n\n' +
      'Webhook URL:\n' + wUrl + '\n\n' +
      'API sleutel:\n' + freshUser.webhook_key + '\n\n' +
      'Zapier stappen:\n' +
      '1. Trigger: nieuwe e-mail\n' +
      '2. Actie: Webhooks POST\n' +
      '3. URL: bovenstaande URL\n' +
      '4. Header: x-api-key = jouw sleutel\n' +
      '5. Body: subject, from, body',
      { reply_markup: { inline_keyboard: [
        [{ text: 'Nieuwe sleutel', callback_data: 'webhook_reset' }],
        [{ text: 'Terug', callback_data: 'home' }]
      ]}}
    );
  }

  else if (data === 'webhook_reset') {
    var newKey = generateKey();
    await saveUser(tid, { webhook_key: newKey });
    bot.sendMessage(tid, 'Nieuwe sleutel:\n' + newKey, { reply_markup: mainKeyboard(tid) });
  }

  else if (data === 'history') {
    var hist = await getHistory(tid, 8);
    if (!hist.length) { bot.sendMessage(tid, 'Nog geen concepten gemaakt.', { reply_markup: mainKeyboard(tid) }); return; }
    var histText = hist.map(function(h, i) { return (i + 1) + '. ' + h.subject + ' - ' + new Date(h.created_at).toLocaleDateString('nl-NL'); }).join('\n');
    bot.sendMessage(tid, 'Recente concepten:\n\n' + histText, { reply_markup: { inline_keyboard: [[{ text: 'Terug', callback_data: 'home' }]] }});
  }

  else if (data === 'credits') {
    bot.sendMessage(tid, 'Berichten kopen\n\nSaldo: ' + u.credits + ' berichten\n\n1 concept = 1 bericht\nStijl trainen = 3 berichten', { reply_markup: creditsKeyboard() });
  }

  else if (data.startsWith('buy_')) {
    var parts = data.split('_');
    var amount = parseInt(parts[1]);
    var price = parseInt(parts[2]);
    if (stripe) {
      try {
        var url = await createStripeCheckout(tid, amount, price);
        bot.sendMessage(tid, amount + ' berichten voor euro ' + price, { reply_markup: { inline_keyboard: [[{ text: 'Betaal via Stripe', url: url }]] }});
      } catch(e) { bot.sendMessage(tid, 'Fout: ' + e.message); }
    } else {
      bot.sendMessage(tid, amount + ' berichten voor euro ' + price + ' (demo)', { reply_markup: { inline_keyboard: [[{ text: 'Bevestig demo', callback_data: 'confirm_' + amount }]] }});
    }
  }

  else if (data.startsWith('confirm_')) {
    var addAmount = parseInt(data.split('_')[1]);
    await saveUser(tid, { credits: u.credits + addAmount });
    bot.sendMessage(tid, addAmount + ' berichten toegevoegd! Nieuw saldo: ' + (u.credits + addAmount), { reply_markup: mainKeyboard(tid) });
  }

  else if (data === 'admin' && isAdmin(tid)) {
    var allUsers = await getAllUsers();
    var pending = allUsers.filter(function(x) { return !x.approved; });
    var active = allUsers.filter(function(x) { return x.approved; });
    var gkList = await listGlobalKnowledge();
    bot.sendMessage(tid,
      'Beheer\n\n' +
      active.length + ' actieve gebruikers\n' +
      pending.length + ' wachten op goedkeuring\n' +
      allUsers.reduce(function(s, x) { return s + x.credits; }, 0) + ' berichten totaal\n' +
      allUsers.reduce(function(s, x) { return s + x.concept_count; }, 0) + ' concepten gemaakt\n' +
      gkList.length + ' kennisitems',
      { reply_markup: { inline_keyboard: [
        [{ text: 'Goedkeuren (' + pending.length + ')', callback_data: 'admin_pending' }],
        [{ text: 'Kennisbank', callback_data: 'admin_know' }],
        [{ text: 'Credits geven', callback_data: 'admin_credits' }],
        [{ text: 'Rapport', callback_data: 'admin_report' }]
      ]}}
    );
  }

  else if (data === 'admin_pending' && isAdmin(tid)) {
    var pending2 = (await getAllUsers()).filter(function(x) { return !x.approved; });
    if (!pending2.length) { bot.sendMessage(tid, 'Geen aanvragen.', { reply_markup: mainKeyboard(tid) }); return; }
    pending2.slice(0, 5).forEach(function(pu) {
      bot.sendMessage(tid, 'Aanvraag: ' + pu.name + ' (ID: ' + pu.telegram_id + ')', { reply_markup: { inline_keyboard: [
        [{ text: 'Goedkeuren + 10 berichten', callback_data: 'approve_' + pu.telegram_id }, { text: 'Weigeren', callback_data: 'deny_' + pu.telegram_id }]
      ]}});
    });
  }

  else if (data.startsWith('approve_') && isAdmin(tid)) {
    var appId = parseInt(data.replace('approve_', ''));
    await saveUser(appId, { approved: true, credits: 10 });
    var newUser = await getUser(appId, '');
    bot.sendMessage(tid, 'Goedgekeurd! 10 berichten toegewezen.', { reply_markup: mainKeyboard(tid) });
    bot.sendMessage(appId,
      'Welkom bij MailMate! Je toegang is goedgekeurd.\n\n' +
      'Je hebt 10 gratis berichten ontvangen.\n\n' +
      'Je persoonlijke inlogcode voor de webapp:\n' + (newUser.webhook_key || '') + '\n\n' +
      'Gebruik deze code op:\nhttps://fortunefiinc-spec.github.io/MM-app\n\n' +
      'Of tik /start om hier in Telegram te beginnen.'
    );
  }

  else if (data.startsWith('deny_') && isAdmin(tid)) {
    bot.sendMessage(tid, 'Geweigerd.', { reply_markup: mainKeyboard(tid) });
    bot.sendMessage(parseInt(data.replace('deny_', '')), 'Je aanvraag is niet goedgekeurd.');
  }

  else if (data === 'admin_know' && isAdmin(tid)) {
    var gkList2 = await listGlobalKnowledge();
    var gkText = gkList2.length ? gkList2.map(function(k, i) { return (i + 1) + '. ' + k.title; }).join('\n') : 'Leeg';
    bot.sendMessage(tid, 'Globale kennisbank:\n\n' + gkText, { reply_markup: { inline_keyboard: [
      [{ text: 'Toevoegen', callback_data: 'admin_know_add' }],
      [{ text: 'Terug', callback_data: 'admin' }]
    ]}});
  }

  else if (data === 'admin_know_add' && isAdmin(tid)) { s.step = 'admin_know_add'; bot.sendMessage(tid, 'Stuur tekst. Eerste regel = titel.'); }

  else if (data === 'admin_credits' && isAdmin(tid)) { s.step = 'admin_give_credits'; bot.sendMessage(tid, 'Stuur: TELEGRAM_ID AANTAL\n\nBijv: 123456789 50'); }

  else if (data === 'admin_report' && isAdmin(tid)) {
    var allU = await getAllUsers();
    var report = 'Rapport ' + new Date().toLocaleDateString('nl-NL') + '\n\n';
    report += allU.filter(function(x) { return x.approved; }).length + ' actieve gebruikers\n';
    report += allU.reduce(function(s, x) { return s + x.credits; }, 0) + ' berichten totaal\n';
    report += allU.reduce(function(s, x) { return s + x.concept_count; }, 0) + ' concepten gemaakt\n\n';
    allU.filter(function(x) { return x.approved; }).slice(0, 8).forEach(function(x) {
      report += x.name + ': ' + x.credits + ' berichten, ' + x.concept_count + ' concepten\n';
    });
    bot.sendMessage(tid, report.slice(0, 3800));
  }

  else if (data.startsWith('approve_email_') && isAdmin(tid)) {
    var appEmail = data.replace('approve_email_', '');
    var webhookKey = 'mm_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    await sb.from('users').update({ approved: true, credits: 10, webhook_key: webhookKey }).eq('email', appEmail);
    var APP_URL = process.env.MINI_APP_URL || 'https://fortunefiinc-spec.github.io/MM-app';
    // Altijd de code tonen in Telegram
    bot.sendMessage(tid,
      'Goedgekeurd: ' + appEmail + '\n\n' +
      'Stuur dit naar de gebruiker:\n\n' +
      'Je toegangscode: ' + webhookKey + '\n' +
      'Inloggen via: ' + APP_URL + '\n\n' +
      '10 berichten toegewezen.',
      { reply_markup: mainKeyboard(tid) }
    );
    // Probeer ook e-mail te sturen als Resend beschikbaar
    var RESEND_KEY = process.env.RESEND_API_KEY;
    if (RESEND_KEY) {
      var loginToken = 'lt_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      await sb.from('users').update({ login_token: loginToken }).eq('email', appEmail);
      var loginUrl = APP_URL + '?token=' + loginToken;
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + RESEND_KEY },
          body: JSON.stringify({
            from: 'MailMate <noreply@mailmate.nl>',
            to: [appEmail],
            subject: 'Je toegang tot MailMate is goedgekeurd!',
            html: '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">' +
              '<h2 style="font-size:24px;margin-bottom:8px">Welkom bij MailMate!</h2>' +
              '<p style="color:#666;margin-bottom:8px">Je aanvraag is goedgekeurd. Je hebt 10 gratis berichten ontvangen.</p>' +
              '<p style="color:#666;margin-bottom:16px">Je persoonlijke toegangscode: <strong>' + webhookKey + '</strong></p>' +
              '<a href="' + loginUrl + '" style="display:inline-block;background:#b8860b;color:#fff;padding:14px 28px;text-decoration:none;font-weight:600;font-size:15px">Direct inloggen</a>' +
              '<p style="color:#999;font-size:12px;margin-top:24px">Of ga naar ' + APP_URL + ' en gebruik de code hierboven.</p>' +
              '</div>'
          })
        });
        bot.sendMessage(tid, 'E-mail verstuurd naar ' + appEmail);
      } catch(e) { console.error('E-mail fout:', e.message); }
    }
  }

  else if (data.startsWith('deny_email_') && isAdmin(tid)) {
    var denyEmail = data.replace('deny_email_', '');
    await sb.from('users').delete().eq('email', denyEmail);
    bot.sendMessage(tid, 'Geweigerd en verwijderd: ' + denyEmail, { reply_markup: mainKeyboard(tid) });
  }

  else if (data === 'home') {
    s.step = 'idle';
    var fresh = await getUser(tid, name);
    bot.sendMessage(tid, 'MailMate\n\nSaldo: ' + fresh.credits + ' berichten', { reply_markup: mainKeyboard(tid) });
  }
});

// ????????????????????????????????????????
// BERICHTEN
// ????????????????????????????????????????
bot.on('message', async function(msg) {
  if (msg.text && msg.text.startsWith('/')) return;
  var tid = msg.from.id;
  var name = msg.from.first_name || 'Gebruiker';
  var s = getState(tid);
  var text = msg.text ? msg.text.trim() : '';
  var u = await getUser(tid, name);

  // PDF upload
  if (msg.document) {
    if (s.step !== 'awaiting_pdf' && s.step !== 'admin_pdf') return;
    try {
      var fileUrl = await bot.getFileLink(msg.document.file_id);
      var resp = await fetch(fileUrl);
      var buf = await resp.arrayBuffer();
      var pdfParse = require('pdf-parse');
      var pdfData = await pdfParse(Buffer.from(buf));
      var extracted = pdfData.text.slice(0, 8000);
      var fname = msg.document.file_name || 'document.pdf';
      if (s.step === 'awaiting_pdf') {
        await saveUser(tid, { user_knowledge: ((u.user_knowledge || '') + '\n\n' + fname + ':\n' + extracted).slice(0, 12000) });
        s.step = 'idle';
        bot.sendMessage(tid, 'PDF verwerkt: ' + fname, { reply_markup: mainKeyboard(tid) });
      } else if (s.step === 'admin_pdf' && isAdmin(tid)) {
        await addGlobalKnowledge(fname, extracted);
        s.step = 'idle';
        bot.sendMessage(tid, 'PDF toegevoegd aan kennisbank.', { reply_markup: mainKeyboard(tid) });
      }
    } catch(e) { s.step = 'idle'; bot.sendMessage(tid, 'Fout: ' + e.message); }
    return;
  }

  if (!text) return;

  // Toegangscode check
  if (s.step === 'awaiting_code') {
    if (text === ACCESS_CODE) {
      s.step = 'idle';
      bot.sendMessage(tid, 'Code correct! Je aanvraag is ingediend.\n\nJe ontvangt een bericht zodra je bent goedgekeurd.');
      bot.sendMessage(ADMIN_ID, 'Nieuwe aanvraag: ' + name + ' (ID: ' + tid + ')', { reply_markup: { inline_keyboard: [
        [{ text: 'Goedkeuren + 10 berichten', callback_data: 'approve_' + tid }, { text: 'Weigeren', callback_data: 'deny_' + tid }]
      ]}});
    } else {
      bot.sendMessage(tid, 'Onjuiste code. Probeer opnieuw.');
    }
    return;
  }

  // Toegangscontrole
  if (!isAdmin(tid) && !u.approved) {
    bot.sendMessage(tid, 'Geen toegang. Tik /start en voer je code in.');
    return;
  }

  // Admin: credits geven
  if (s.step === 'admin_give_credits' && isAdmin(tid)) {
    var creditParts = text.split(' ');
    var targetId = parseInt(creditParts[0]);
    var addCr = parseInt(creditParts[1]);
    if (!isNaN(targetId) && !isNaN(addCr)) {
      var target = await getUser(targetId, '');
      if (target) { await saveUser(targetId, { credits: target.credits + addCr }); s.step = 'idle'; return bot.sendMessage(tid, addCr + ' berichten aan ' + targetId, { reply_markup: mainKeyboard(tid) }); }
    }
    return bot.sendMessage(tid, 'Formaat: 123456789 50');
  }

  // Admin: kennisbank toevoegen
  if (s.step === 'admin_know_add' && isAdmin(tid)) {
    var lines = text.split('\n');
    await addGlobalKnowledge(lines[0].trim(), lines.slice(1).join('\n').trim() || text);
    s.step = 'idle';
    bot.sendMessage(tid, 'Toegevoegd.', { reply_markup: mainKeyboard(tid) });
    return;
  }

  // Onboarding: vakgebied
  if (s.step === 'onboard_vakgebied') {
    var vakParts = text.split('-').map(function(p) { return p.trim(); });
    await saveUser(tid, { vakgebied: vakParts[0] || text, doel: vakParts[1] || '' });
    s.step = 'onboard_toon';
    bot.sendMessage(tid, 'Vakgebied opgeslagen.\n\nStap 2 van 4 - Toon\n\nHoe schrijf jij normaal?', { reply_markup: { inline_keyboard: [
      [{ text: 'Formeel (u)', callback_data: 'toon_formeel' }],
      [{ text: 'Informeel (je)', callback_data: 'toon_informeel' }],
      [{ text: 'Mix', callback_data: 'toon_mix' }]
    ]}});
    return;
  }

  // Onboarding: stijl
  if (s.step === 'onboard_style') {
    if (text.length < 80) { bot.sendMessage(tid, 'Te kort. Meer mails of /skip.'); return; }
    var loadMsg2 = await bot.sendMessage(tid, 'Stijl analyseren...');
    try {
      var styleProfile = await callClaude('Analyseer schrijfstijl in max 200 woorden. Toon, aanhef, afsluiting, zinslengte.\n\nE-MAILS:\n' + text);
      await saveUser(tid, { style_profiles: JSON.stringify({ default: styleProfile }), credits: u.credits - 3 });
      bot.deleteMessage(tid, loadMsg2.message_id).catch(function() {});
      s.step = 'onboard_knowledge';
      bot.sendMessage(tid, 'Stijl geleerd! (3 berichten)\n\nStap 4 van 4 - Kennisbank\n\nVoeg info toe over je bedrijf of tik /skip.');
    } catch(e) { bot.deleteMessage(tid, loadMsg2.message_id).catch(function() {}); bot.sendMessage(tid, 'Fout: ' + e.message); }
    return;
  }

  // Onboarding: kennisbank
  if (s.step === 'onboard_knowledge') {
    await saveUser(tid, { user_knowledge: text.slice(0, 12000), onboarded: true });
    s.step = 'idle';
    bot.sendMessage(tid, 'Klaar! Je agent is ingesteld.', { reply_markup: mainKeyboard(tid) });
    return;
  }

  // Stijlnaam
  if (s.step === 'awaiting_style_name') {
    s.trainName = text.toLowerCase().trim();
    s.step = 'awaiting_train';
    bot.sendMessage(tid, 'Stijl "' + s.trainName + '" trainen.\n\nStuur 5+ eigen e-mails, gescheiden door --');
    return;
  }

  // Stijl trainen
  if (s.step === 'awaiting_train') {
    if (text.length < 100) { bot.sendMessage(tid, 'Te weinig tekst.'); return; }
    var trainLoad = await bot.sendMessage(tid, 'Stijl analyseren...');
    try {
      var trainProfile = await callClaude('Analyseer schrijfstijl in max 200 woorden. Toon, aanhef, afsluiting, zinslengte.\n\nE-MAILS:\n' + text);
      var trainName2 = s.trainName || 'default';
      var trainProfs = JSON.parse(u.style_profiles || '{"default":""}');
      trainProfs[trainName2] = trainProfile;
      await saveUser(tid, { style_profiles: JSON.stringify(trainProfs), credits: u.credits - 3 });
      s.step = 'idle';
      bot.deleteMessage(tid, trainLoad.message_id).catch(function() {});
      bot.sendMessage(tid, 'Stijl "' + trainName2 + '" opgeslagen! Saldo: ' + (u.credits - 3) + ' berichten', { reply_markup: mainKeyboard(tid) });
    } catch(e) { bot.deleteMessage(tid, trainLoad.message_id).catch(function() {}); bot.sendMessage(tid, 'Fout: ' + e.message); }
    return;
  }

  // Kennisbank toevoegen
  if (s.step === 'awaiting_knowledge') {
    await saveUser(tid, { user_knowledge: ((u.user_knowledge || '') + '\n\n' + text).slice(0, 12000) });
    s.step = 'idle';
    bot.sendMessage(tid, 'Toegevoegd.', { reply_markup: mainKeyboard(tid) });
    return;
  }

  // Template naam
  if (s.step === 'awaiting_template_name') {
    await saveTemplate(tid, text.trim(), s.lastConcept);
    s.step = 'idle';
    bot.sendMessage(tid, '"' + text.trim() + '" opgeslagen!', { reply_markup: mainKeyboard(tid) });
    return;
  }

  // Verfijnen
  if (s.step === 'awaiting_refine') {
    if (!s.lastConcept) { bot.sendMessage(tid, 'Geen concept.', { reply_markup: mainKeyboard(tid) }); return; }
    var refineLoad = await bot.sendMessage(tid, 'Aanpassen...');
    try {
      var refined = await callClaude('Pas dit concept aan. Instructie: ' + text + '\n\nConcept:\n' + s.lastConcept, 'Pas het concept aan en geef alleen het resultaat.');
      s.lastConcept = refined;
      s.step = 'idle';
      bot.deleteMessage(tid, refineLoad.message_id).catch(function() {});
      bot.sendMessage(tid, 'Aangepast:\n\n' + refined, { reply_markup: { inline_keyboard: [
        [{ text: 'Nogmaals', callback_data: 'refine' }, { text: 'Opslaan', callback_data: 'save_template' }],
        [{ text: 'Home', callback_data: 'home' }]
      ]}});
    } catch(e) { bot.deleteMessage(tid, refineLoad.message_id).catch(function() {}); bot.sendMessage(tid, 'Fout: ' + e.message); }
    return;
  }

  // Batch
  if (s.step === 'awaiting_batch') {
    var mails = text.split('===MAIL===').map(function(m) { return m.trim(); }).filter(function(m) { return m.length > 20; });
    if (!mails.length) { bot.sendMessage(tid, 'Geen mails gevonden. Gebruik ===MAIL=== als scheiding.'); return; }
    if (u.credits < mails.length) { bot.sendMessage(tid, 'Je hebt ' + u.credits + ' berichten maar hebt ' + mails.length + ' nodig.', { reply_markup: creditsKeyboard() }); return; }
    var batchLoad = await bot.sendMessage(tid, mails.length + ' mails verwerken...');
    try {
      var batchSys = await buildSystemPrompt(u, s.style);
      var concepts = await Promise.all(mails.map(function(mail) { return callClaude('Schrijf een conceptantwoord:\n\n' + mail, batchSys); }));
      await saveUser(tid, { credits: u.credits - mails.length, concept_count: u.concept_count + mails.length });
      bot.deleteMessage(tid, batchLoad.message_id).catch(function() {});
      for (var i = 0; i < concepts.length; i++) {
        await bot.sendMessage(tid, 'Concept ' + (i + 1) + ' van ' + mails.length + ':\n\n' + concepts[i]);
        await new Promise(function(r) { setTimeout(r, 500); });
      }
      s.step = 'idle';
      bot.sendMessage(tid, mails.length + ' concepten klaar. Saldo: ' + (u.credits - mails.length) + ' berichten', { reply_markup: mainKeyboard(tid) });
    } catch(e) { bot.deleteMessage(tid, batchLoad.message_id).catch(function() {}); bot.sendMessage(tid, 'Fout: ' + e.message); }
    return;
  }

  // Concept genereren
  if (s.step === 'awaiting_mail') {
    if (text.length < 20) { bot.sendMessage(tid, 'E-mail te kort.'); return; }
    if (!checkRate(tid)) { bot.sendMessage(tid, 'Maximum bereikt. Probeer over een uur.'); return; }
    var composeLoad = await bot.sendMessage(tid, 'Conceptantwoord schrijven...');
    try {
      var composeSys = await buildSystemPrompt(u, s.style);
      var reply = await callClaude('Schrijf een conceptantwoord:\n\n' + text, composeSys);
      s.lastConcept = reply;
      s.lastMail = text;
      s.step = 'idle';
      await saveUser(tid, { credits: u.credits - 1, concept_count: u.concept_count + 1 });
      var subjectMatch = text.match(/(?:Onderwerp|Subject):\s*(.+)/);
      var subj = subjectMatch ? subjectMatch[1] : 'E-mail';
      await addHistory(tid, subj, reply);
      await scheduleFollowUp(tid, subj);
      var emailMatch = text.match(/Van:\s*([^\s]+@[^\s]+)/i);
      if (emailMatch) await upsertClient(tid, emailMatch[1], subj);
      bot.deleteMessage(tid, composeLoad.message_id).catch(function() {});
      bot.sendMessage(tid, 'Conceptantwoord:\n\n' + reply + '\n\nSaldo: ' + (u.credits - 1) + ' berichten', { reply_markup: { inline_keyboard: [
        [{ text: 'Aanpassen', callback_data: 'refine' }, { text: 'Twee versies', callback_data: 'ab_versions' }],
        [{ text: 'Opslaan', callback_data: 'save_template' }, { text: 'Opnieuw', callback_data: 'compose' }],
        [{ text: 'Home', callback_data: 'home' }]
      ]}});
    } catch(e) {
      bot.deleteMessage(tid, composeLoad.message_id).catch(function() {});
      bot.sendMessage(tid, 'Fout: ' + e.message, { reply_markup: mainKeyboard(tid) });
    }
    return;
  }

  bot.sendMessage(tid, 'Gebruik de knoppen.', { reply_markup: mainKeyboard(tid) });
});

// Follow-up checker
setInterval(async function() {
  try {
    var result = await sb.from('followups').select('*').eq('sent', false).lte('remind_at', new Date().toISOString());
    if (!result.data) return;
    for (var i = 0; i < result.data.length; i++) {
      var f = result.data[i];
      try {
        await bot.sendMessage(f.telegram_id, 'Herinnering: "' + f.subject + '"\n\nHeb je al geantwoord?', { reply_markup: { inline_keyboard: [
          [{ text: 'Nieuw concept', callback_data: 'compose' }, { text: 'Al gedaan', callback_data: 'followup_done' }]
        ]}});
        await sb.from('followups').update({ sent: true }).eq('id', f.id);
      } catch(e) { /* stil falen */ }
    }
  } catch(e) { /* stil falen */ }
}, 6 * 60 * 60 * 1000);

console.log('MailMate v5 gestart');
