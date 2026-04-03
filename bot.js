// MailMate Telegram Bot
// Gebruiker: stuurt mail tekst → krijgt concept terug
// Beheerder: beheert credits, users, API key via commando's

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');

// ── CONFIG ──────────────────────────────────────────
const BOT_TOKEN      = process.env.BOT_TOKEN;
const ADMIN_ID       = parseInt(process.env.ADMIN_ID);
const ANTHROPIC_KEY  = process.env.ANTHROPIC_KEY;
const MINI_APP_URL   = process.env.MINI_APP_URL; // bijv. https://jouwusername.github.io/mailmate
const PORT           = process.env.PORT || 3000;
const WEBHOOK_URL    = process.env.WEBHOOK_URL;  // bijv. https://jouw-railway-app.up.railway.app

const bot = new TelegramBot(BOT_TOKEN, WEBHOOK_URL ? { webHook: true } : { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

if (WEBHOOK_URL) {
  bot.setWebHook(`${WEBHOOK_URL}/bot${BOT_TOKEN}`);
  const express = require('express');
  const app = express();
  app.use(require('express').json());
  app.post(`/bot${BOT_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
  app.listen(PORT, () => console.log(`MailMate bot draait op poort ${PORT}`));
}

// ── IN-MEMORY STORE ──────────────────────────────────
// In productie: vervang door Supabase
const users  = new Map(); // userId -> { name, credits, conceptCount, styleProfile, history }
const state  = new Map(); // userId -> { step: 'idle'|'awaiting_mail'|'awaiting_train' }

function getUser(id, name) {
  if (!users.has(id)) {
    users.set(id, { name: name || 'Gebruiker', credits: 10, conceptCount: 0, styleProfile: '', history: [] });
  }
  return users.get(id);
}

function getState(id) {
  if (!state.has(id)) state.set(id, { step: 'idle' });
  return state.get(id);
}

// ── HELPERS ──────────────────────────────────────────
const isAdmin = (id) => id === ADMIN_ID;

function creditsKeyboard(userId) {
  return {
    inline_keyboard: [[
      { text: '50 credits — €9',  callback_data: `buy_50_9`  },
      { text: '200 credits — €29', callback_data: `buy_200_29` },
    ],[
      { text: '600 credits — €79', callback_data: `buy_600_79` },
    ]]
  };
}

function mainKeyboard(userId) {
  const buttons = [
    [{ text: '✍ Concept schrijven', callback_data: 'compose' }],
    [{ text: '◈ Agent trainen',     callback_data: 'train'   }],
    [{ text: '◆ Credits kopen',     callback_data: 'credits' }],
    [{ text: '📱 Open Mini App',    web_app: { url: MINI_APP_URL } }],
  ];
  if (isAdmin(userId)) {
    buttons.push([{ text: '⚙ Admin paneel', callback_data: 'admin' }]);
  }
  return { inline_keyboard: buttons };
}

async function callClaude(userMsg, systemMsg = '') {
  const params = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [{ role: 'user', content: userMsg }],
  };
  if (systemMsg) params.system = systemMsg;
  const res = await anthropic.messages.create(params);
  return res.content.map(b => b.text || '').join('');
}

// ── /START ────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const { id, first_name } = msg.from;
  const user = getUser(id, first_name);

  const welcome = `✉ *Welkom bij MailMate, ${first_name}!*\n\n` +
    `MailMate leert jouw schrijfstijl en zet automatisch conceptantwoorden klaar.\n\n` +
    `📊 Jouw saldo: *${user.credits} credits*\n` +
    `• 1 concept genereren = 1 credit\n` +
    `• Agent trainen = 3 credits\n\n` +
    `Wat wil je doen?`;

  bot.sendMessage(id, welcome, { parse_mode: 'Markdown', reply_markup: mainKeyboard(id) });
});

// ── CALLBACK QUERIES ──────────────────────────────────
bot.on('callback_query', async (query) => {
  const { id: userId, first_name } = query.from;
  const data = query.data;
  const user = getUser(userId, first_name);
  const s = getState(userId);

  bot.answerCallbackQuery(query.id);

  // ── COMPOSE ──
  if (data === 'compose') {
    if (!user.styleProfile) {
      bot.sendMessage(userId,
        '⚠️ Je hebt nog geen agent getraind.\n\nTrain eerst je agent door je eigen mails te sturen.',
        { reply_markup: { inline_keyboard: [[{ text: '◈ Agent trainen', callback_data: 'train' }]] } }
      );
      return;
    }
    if (user.credits < 1) {
      bot.sendMessage(userId, '⚠️ Onvoldoende credits. Koop credits om verder te gaan.',
        { reply_markup: creditsKeyboard(userId) });
      return;
    }
    s.step = 'awaiting_mail';
    bot.sendMessage(userId,
      '📨 *Inkomende mail*\n\nStuur me de tekst van de mail waarop je wil antwoorden. ' +
      'Kopieer de volledige tekst inclusief afzender en onderwerp als je dat hebt.',
      { parse_mode: 'Markdown' }
    );
  }

  // ── TRAIN ──
  else if (data === 'train') {
    if (user.credits < 3) {
      bot.sendMessage(userId, '⚠️ Je hebt minimaal 3 credits nodig om te trainen.',
        { reply_markup: creditsKeyboard(userId) });
      return;
    }
    s.step = 'awaiting_train';
    bot.sendMessage(userId,
      '◈ *Agent trainen*\n\nStuur me 5 of meer e-mails die jij zelf hebt geschreven. ' +
      'Plak ze allemaal in één bericht, gescheiden door ——\n\n' +
      '_Hoe meer mails, hoe beter het profiel._',
      { parse_mode: 'Markdown' }
    );
  }

  // ── CREDITS ──
  else if (data === 'credits') {
    bot.sendMessage(userId,
      `◆ *Credits kopen*\n\nHuidig saldo: *${user.credits} credits*\n\nKies een pakket:`,
      { parse_mode: 'Markdown', reply_markup: creditsKeyboard(userId) }
    );
  }

  // ── BUY CREDITS ──
  else if (data.startsWith('buy_')) {
    const [, amount, price] = data.split('_');
    // In productie: Stripe betaallink sturen
    bot.sendMessage(userId,
      `💳 *Betaling starten*\n\n${amount} credits voor €${price}\n\n` +
      `_In de demo worden credits direct toegevoegd. In productie ontvang je hier een Stripe betaallink._`,
      { parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[
          { text: `✓ Bevestig ${amount} credits (demo)`, callback_data: `confirm_${amount}` }
        ]]}
      }
    );
  }

  else if (data.startsWith('confirm_')) {
    const amount = parseInt(data.split('_')[1]);
    user.credits += amount;
    bot.sendMessage(userId,
      `✅ *${amount} credits toegevoegd!*\n\nNieuw saldo: *${user.credits} credits*`,
      { parse_mode: 'Markdown', reply_markup: mainKeyboard(userId) }
    );
  }

  // ── ADMIN ──
  else if (data === 'admin' && isAdmin(userId)) {
    const totalUsers = users.size;
    const totalCredits = Array.from(users.values()).reduce((s, u) => s + u.credits, 0);
    const totalConcepts = Array.from(users.values()).reduce((s, u) => s + u.conceptCount, 0);

    let userList = '';
    users.forEach((u, uid) => {
      userList += `\n• *${u.name}* (${uid}) — ${u.credits} cr, ${u.conceptCount} concepten`;
    });

    bot.sendMessage(userId,
      `⚙ *Admin paneel*\n\n` +
      `👥 Gebruikers: ${totalUsers}\n` +
      `◆ Totaal credits in omloop: ${totalCredits}\n` +
      `✍ Totaal concepten gegenereerd: ${totalConcepts}\n\n` +
      `*Gebruikers:*${userList || '\nNog geen gebruikers'}`,
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: '+ Credits geven aan gebruiker', callback_data: 'admin_give_credits' }],
          [{ text: '📊 Gedetailleerd rapport',       callback_data: 'admin_report' }],
          [{ text: '🔑 API key status',              callback_data: 'admin_api' }],
        ]}
      }
    );
  }

  else if (data === 'admin_api' && isAdmin(userId)) {
    bot.sendMessage(userId,
      `🔑 *API configuratie*\n\n` +
      `Model: claude-sonnet-4-20250514\n` +
      `Key: \`${ANTHROPIC_KEY ? ANTHROPIC_KEY.slice(0,16) + '••••' : 'Niet ingesteld'}\`\n` +
      `Status: ${ANTHROPIC_KEY ? '✅ Actief' : '❌ Niet geconfigureerd'}`,
      { parse_mode: 'Markdown' }
    );
  }

  else if (data === 'admin_give_credits' && isAdmin(userId)) {
    s.step = 'admin_awaiting_credits';
    bot.sendMessage(userId,
      '👤 Stuur het Telegram user ID en het aantal credits in dit formaat:\n\n`123456789 50`',
      { parse_mode: 'Markdown' }
    );
  }

  else if (data === 'admin_report' && isAdmin(userId)) {
    let report = '📊 *Rapport alle gebruikers*\n\n';
    users.forEach((u, uid) => {
      report += `*${u.name}*\n`;
      report += `  ID: ${uid}\n`;
      report += `  Credits: ${u.credits}\n`;
      report += `  Concepten: ${u.conceptCount}\n`;
      report += `  Agent: ${u.styleProfile ? '✓ Getraind' : '✗ Niet getraind'}\n\n`;
    });
    bot.sendMessage(userId, report, { parse_mode: 'Markdown' });
  }

  // ── HOME ──
  else if (data === 'home') {
    s.step = 'idle';
    bot.sendMessage(userId,
      `✉ *MailMate*\n\nSaldo: *${user.credits} credits*\n\nWat wil je doen?`,
      { parse_mode: 'Markdown', reply_markup: mainKeyboard(userId) }
    );
  }
});

// ── TEXT MESSAGES ─────────────────────────────────────
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const { id: userId, first_name } = msg.from;
  const user = getUser(userId, first_name);
  const s = getState(userId);
  const text = msg.text.trim();

  // ── ADMIN: credits geven ──
  if (s.step === 'admin_awaiting_credits' && isAdmin(userId)) {
    const parts = text.split(' ');
    if (parts.length === 2) {
      const targetId = parseInt(parts[0]);
      const amount   = parseInt(parts[1]);
      if (!isNaN(targetId) && !isNaN(amount) && users.has(targetId)) {
        users.get(targetId).credits += amount;
        s.step = 'idle';
        bot.sendMessage(userId, `✅ ${amount} credits toegevoegd aan gebruiker ${targetId}. Nieuw saldo: ${users.get(targetId).credits}`, { reply_markup: mainKeyboard(userId) });
      } else {
        bot.sendMessage(userId, '⚠️ Gebruiker niet gevonden of ongeldig formaat. Probeer: `123456789 50`', { parse_mode: 'Markdown' });
      }
    }
    return;
  }

  // ── AWAITING TRAIN MAILS ──
  if (s.step === 'awaiting_train') {
    if (text.length < 100) {
      bot.sendMessage(userId, '⚠️ Te weinig tekst. Stuur meerdere e-mails (minimaal 100 tekens).');
      return;
    }

    const loadingMsg = await bot.sendMessage(userId, '◈ _Agent aan het trainen..._', { parse_mode: 'Markdown' });

    try {
      const profile = await callClaude(
        `Analyseer de schrijfstijl van onderstaande e-mails en maak een compact stijlprofiel in max 200 woorden. Beschrijf: toon, je/u, aanhef, afsluiting, zinslengte, directheid, patronen.\n\nE-MAILS:\n${text}`
      );
      user.styleProfile = profile;
      user.credits -= 3;
      s.step = 'idle';

      bot.deleteMessage(userId, loadingMsg.message_id).catch(() => {});
      bot.sendMessage(userId,
        `✅ *Agent succesvol getraind!* (3 credits gebruikt)\n\n` +
        `*Jouw stijlprofiel:*\n_${profile.slice(0, 300)}${profile.length > 300 ? '...' : ''}_\n\n` +
        `Saldo: *${user.credits} credits*`,
        { parse_mode: 'Markdown', reply_markup: mainKeyboard(userId) }
      );
    } catch(e) {
      bot.deleteMessage(userId, loadingMsg.message_id).catch(() => {});
      bot.sendMessage(userId, `❌ Fout bij trainen: ${e.message}`);
    }
    return;
  }

  // ── AWAITING INCOMING MAIL ──
  if (s.step === 'awaiting_mail') {
    if (text.length < 20) {
      bot.sendMessage(userId, '⚠️ Mail te kort. Plak de volledige tekst.');
      return;
    }

    const loadingMsg = await bot.sendMessage(userId, '✍ _Concept schrijven in jouw stijl..._', { parse_mode: 'Markdown' });

    try {
      const system = `Je bent een e-mail assistent die antwoorden schrijft PRECIES in de schrijfstijl van de gebruiker.\n\nSCHRIJFSTIJL PROFIEL:\n${user.styleProfile}\n\nREGELS:\n- Schrijf in dezelfde stijl, toon en structuur\n- Gebruik dezelfde aanhef en afsluiting\n- Geen uitleg — alleen het conceptantwoord`;
      const reply = await callClaude(`Schrijf een conceptantwoord op deze inkomende mail:\n\n${text}`, system);

      user.credits -= 1;
      user.conceptCount += 1;

      const subj = (text.match(/(?:Onderwerp|Subject):\s*(.+)/) || ['', 'Mail'])[1];
      user.history.unshift({ subject: subj, time: new Date().toLocaleString('nl-NL') });

      s.step = 'idle';

      bot.deleteMessage(userId, loadingMsg.message_id).catch(() => {});
      bot.sendMessage(userId,
        `✉ *Concept antwoord:*\n\n${reply}\n\n` +
        `_— 1 credit gebruikt · saldo: ${user.credits} credits —_`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [
            [{ text: '↩ Herschrijven', callback_data: 'compose' }, { text: '🏠 Home', callback_data: 'home' }],
            [{ text: '📱 Open Mini App', web_app: { url: MINI_APP_URL } }],
          ]}
        }
      );
    } catch(e) {
      bot.deleteMessage(userId, loadingMsg.message_id).catch(() => {});
      bot.sendMessage(userId, `❌ Fout: ${e.message}`, { reply_markup: mainKeyboard(userId) });
    }
    return;
  }

  // ── DEFAULT ──
  bot.sendMessage(userId,
    `Hoi ${first_name}! Gebruik de knoppen hieronder 👇`,
    { reply_markup: mainKeyboard(userId) }
  );
});

console.log('✉ MailMate bot gestart');
