// MailMate Telegram Bot v2 — Schrijfstijl + Kennisbank (globaal + per gebruiker)
require('dotenv').config();
const TelegramBot          = require('node-telegram-bot-api');
const Anthropic            = require('@anthropic-ai/sdk');
const { createClient }     = require('@supabase/supabase-js');

// ── CONFIG ────────────────────────────────────────────
const BOT_TOKEN     = process.env.BOT_TOKEN;
const ADMIN_ID      = parseInt(process.env.ADMIN_ID);
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const MINI_APP_URL  = process.env.MINI_APP_URL;
const PORT          = process.env.PORT || 3000;
const WEBHOOK_URL   = process.env.WEBHOOK_URL;
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_KEY;

const bot       = new TelegramBot(BOT_TOKEN, WEBHOOK_URL ? { webHook: true } : { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
const supabase  = createClient(SUPABASE_URL, SUPABASE_KEY);

if (WEBHOOK_URL) {
  bot.setWebHook(`${WEBHOOK_URL}/bot${BOT_TOKEN}`);
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.post(`/bot${BOT_TOKEN}`, (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });
  app.listen(PORT, () => console.log(`✉ MailMate v2 draait op poort ${PORT}`));
}

// ── VASTE GLOBALE KENNISBASIS (Wft + assurantie) ─────
const BASE_KNOWLEDGE = `
## Assurantie Kennisbasis — Altijd van toepassing

### Wft (Wet op het financieel toezicht)
- Adviseurs hebben een zorgplicht: zij moeten het belang van de klant centraal stellen
- Provisieverbod: adviseurs mogen geen provisie ontvangen van aanbieders voor schadeverzekeringen in bepaalde gevallen
- Klanten hebben recht op een dienstverleningsdocument (dvd) en een passend advies
- Bij complexe producten geldt informatieplicht via een Financieel Bijsluiter

### Kernbegrippen
- **Premie**: bedrag dat verzekerde periodiek betaalt voor dekking
- **Eigen risico**: bedrag dat verzekerde zelf betaalt bij schade
- **Dekking**: de situaties en schades waarvoor de polis uitkeert
- **Uitsluitingen**: situaties die expliciet niet gedekt zijn
- **Claimvrije jaren**: korting op premie bij schadevrije periode
- **Aansprakelijkheid**: wettelijke verplichting schade van anderen te vergoeden
- **Herbouwwaarde**: kosten om een pand opnieuw op te bouwen (relevant voor opstalverzekering)
- **Dagwaarde**: actuele waarde van een object rekening houdend met slijtage
- **Nieuwwaarde**: vervangingswaarde door een nieuw vergelijkbaar object
- **Royement**: beëindiging van een polis door de verzekeraar

### Verzekeringsvormen
- **Levensverzekering**: uitkering bij overlijden of in leven zijn op einddatum
- **Opstalverzekering**: dekt schade aan het gebouw zelf
- **Inboedelverzekering**: dekt schade aan de inhoud van een woning
- **Aansprakelijkheidsverzekering (AVP)**: particuliere aansprakelijkheid
- **Bedrijfsaansprakelijkheid (AVB)**: zakelijke aansprakelijkheid
- **Rechtsbijstand**: vergoedt kosten van juridische hulp
- **Arbeidsongeschiktheidsverzekering (AOV)**: inkomen bij ziekte/arbeidsongeschiktheid
- **Overlijdensrisicoverzekering (ORV)**: uitkering bij overlijden verzekerde
- **Uitvaartverzekering**: dekt kosten van begrafenis of crematie

### Zorgplicht & Communicatie
- Altijd helder en begrijpelijk communiceren, geen onnodig jargon
- Bij twijfel altijd verwijzen naar de polisvoorwaarden of een persoonlijk gesprek
- Nooit garanties geven over uitkeringen zonder de polis te kennen
- Bij klachten: verwijs naar de klachtenprocedure en eventueel het Kifid
- Disclaimer altijd meenemen bij adviesgerelateerde antwoorden

### Kifid
Het Klachteninstituut Financiële Dienstverlening behandelt geschillen tussen consumenten en financiële dienstverleners. Verwijzing is gepast bij klachten die intern niet opgelost kunnen worden.
`;

// ── SESSION STATE ─────────────────────────────────────
const sessionState = new Map();
function getState(id) {
  if (!sessionState.has(id)) sessionState.set(id, { step: 'idle' });
  return sessionState.get(id);
}

// ── SUPABASE: GEBRUIKERS ──────────────────────────────
async function getUser(telegramId, name) {
  const { data } = await supabase.from('users').select('*').eq('telegram_id', telegramId).single();
  if (!data) {
    const { data: newUser } = await supabase.from('users')
      .insert({ telegram_id: telegramId, name: name || 'Gebruiker', credits: 10, concept_count: 0, style_profile: '', user_knowledge: '' })
      .select().single();
    return newUser;
  }
  return data;
}

async function saveUser(telegramId, updates) {
  await supabase.from('users').update({ ...updates, updated_at: new Date().toISOString() }).eq('telegram_id', telegramId);
}

async function addHistory(telegramId, subject) {
  await supabase.from('history').insert({ telegram_id: telegramId, subject, created_at: new Date().toISOString() });
}

async function getAllUsers() {
  const { data } = await supabase.from('users').select('*').order('created_at', { ascending: false });
  return data || [];
}

// ── SUPABASE: GLOBALE KENNISBANK (admin only) ─────────
async function getGlobalKnowledge() {
  const { data } = await supabase.from('global_knowledge').select('content').order('created_at', { ascending: true });
  if (!data || data.length === 0) return '';
  return data.map(d => d.content).join('\n\n---\n\n');
}

async function addGlobalKnowledge(title, content) {
  await supabase.from('global_knowledge').insert({ title, content, created_at: new Date().toISOString() });
}

async function listGlobalKnowledge() {
  const { data } = await supabase.from('global_knowledge').select('id, title, created_at').order('created_at', { ascending: false });
  return data || [];
}

async function deleteGlobalKnowledge(id) {
  await supabase.from('global_knowledge').delete().eq('id', id);
}

// ── SYSTEM PROMPT BOUWEN ──────────────────────────────
async function buildSystemPrompt(user) {
  const globalExtra = await getGlobalKnowledge();

  return `Je bent een professionele e-mail assistent voor een assurantiekantoor.
Je schrijft conceptantwoorden in de schrijfstijl van de gebruiker, met correcte assurantiekennis.

════════════════════════════════
SCHRIJFSTIJL VAN DEZE GEBRUIKER
════════════════════════════════
${user.style_profile || 'Nog niet getraind — schrijf professioneel en vriendelijk.'}

════════════════════════════════
VASTE ASSURANTIE KENNISBASIS
════════════════════════════════
${BASE_KNOWLEDGE}

${globalExtra ? `════════════════════════════════
KANTOORSPECIFIEKE KENNIS (GLOBAAL)
════════════════════════════════
${globalExtra}` : ''}

${user.user_knowledge ? `════════════════════════════════
PERSOONLIJKE KANTOORKENNIS
════════════════════════════════
${user.user_knowledge}` : ''}

════════════════════════════════
REGELS
════════════════════════════════
- Schrijf ALTIJD in de schrijfstijl van de gebruiker
- Gebruik correcte assurantie terminologie waar van toepassing
- Voeg een korte disclaimer toe bij adviesgerelateerde antwoorden
- Geef ALLEEN het conceptantwoord terug — geen uitleg of commentaar
- Bij twijfel over dekking: verwijs naar de polisvoorwaarden`;
}

// ── KEYBOARDS ─────────────────────────────────────────
const isAdmin = (id) => id === ADMIN_ID;

function mainKeyboard(userId) {
  const b = [
    [{ text: '✍ Concept schrijven',  callback_data: 'compose'  }],
    [{ text: '◈ Stijl trainen',      callback_data: 'train'    }],
    [{ text: '📚 Mijn kennisbank',   callback_data: 'myknow'   }],
    [{ text: '◆ Credits kopen',      callback_data: 'credits'  }],
    [{ text: '📱 Open Mini App',     web_app: { url: MINI_APP_URL } }],
  ];
  if (isAdmin(userId)) b.push([{ text: '⚙ Admin paneel', callback_data: 'admin' }]);
  return { inline_keyboard: b };
}

function creditsKeyboard() {
  return { inline_keyboard: [
    [{ text: '50 credits — €9', callback_data: 'buy_50_9' }, { text: '200 credits — €29', callback_data: 'buy_200_29' }],
    [{ text: '600 credits — €79', callback_data: 'buy_600_79' }],
  ]};
}

// ── CLAUDE ────────────────────────────────────────────
async function callClaude(userMsg, systemMsg = '') {
  const params = { model: 'claude-sonnet-4-20250514', max_tokens: 1200, messages: [{ role: 'user', content: userMsg }] };
  if (systemMsg) params.system = systemMsg;
  const res = await anthropic.messages.create(params);
  return res.content.map(b => b.text || '').join('');
}

// ── /START ────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const { id, first_name } = msg.from;
  const user = await getUser(id, first_name);
  bot.sendMessage(id,
    `✉ *Welkom bij MailMate, ${first_name}!*\n\n` +
    `Jouw AI-assistent voor professionele assurantie e-mails.\n\n` +
    `📊 Saldo: *${user.credits} credits*\n` +
    `◈ Stijl: ${user.style_profile ? '✓ Getraind' : '✗ Nog niet getraind'}\n` +
    `📚 Kennisbank: ${user.user_knowledge ? '✓ Gevuld' : '✗ Leeg'}\n\n` +
    `Wat wil je doen?`,
    { parse_mode: 'Markdown', reply_markup: mainKeyboard(id) }
  );
});

// ── CALLBACKS ─────────────────────────────────────────
bot.on('callback_query', async (query) => {
  const { id: userId, first_name } = query.from;
  const data = query.data;
  const s    = getState(userId);
  bot.answerCallbackQuery(query.id);
  const user = await getUser(userId, first_name);

  // ── COMPOSE ──
  if (data === 'compose') {
    if (user.credits < 1) return bot.sendMessage(userId, '⚠️ Onvoldoende credits.', { reply_markup: creditsKeyboard() });
    s.step = 'awaiting_mail';
    bot.sendMessage(userId,
      '📨 *Inkomende mail*\n\nPlak de tekst van de mail waarop je wil antwoorden.\n\n_Inclusief afzender en onderwerp als je dat hebt._',
      { parse_mode: 'Markdown' }
    );
  }

  // ── STIJL TRAINEN ──
  else if (data === 'train') {
    if (user.credits < 3) return bot.sendMessage(userId, '⚠️ Minimaal 3 credits nodig.', { reply_markup: creditsKeyboard() });
    s.step = 'awaiting_train';
    bot.sendMessage(userId,
      '◈ *Schrijfstijl trainen*\n\nStuur 5+ e-mails die jij zelf hebt geschreven, gescheiden door ——\n\n_Hoe meer voorbeelden, hoe beter het profiel._',
      { parse_mode: 'Markdown' }
    );
  }

  // ── MIJN KENNISBANK ──
  else if (data === 'myknow') {
    bot.sendMessage(userId,
      `📚 *Jouw kantoorkennis*\n\n${user.user_knowledge ? `_${user.user_knowledge.slice(0, 300)}${user.user_knowledge.length > 300 ? '...' : ''}_` : 'Nog leeg.'}\n\nVoeg productinformatie, voorwaarden of kantoorspecifieke info toe:`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '+ Tekst toevoegen',  callback_data: 'myknow_add'   }],
        [{ text: '📄 PDF uploaden',    callback_data: 'myknow_pdf'   }],
        [{ text: '🗑 Kennisbank leegmaken', callback_data: 'myknow_clear' }],
        [{ text: '← Terug',           callback_data: 'home'          }],
      ]}}
    );
  }

  else if (data === 'myknow_add') {
    s.step = 'awaiting_user_knowledge';
    bot.sendMessage(userId,
      '📝 Stuur de tekst die je wil toevoegen aan jouw kennisbank.\n\nDenk aan: producten, voorwaarden, kantoorinfo, veelgestelde vragen.',
      { parse_mode: 'Markdown' }
    );
  }

  else if (data === 'myknow_pdf') {
    s.step = 'awaiting_user_pdf';
    bot.sendMessage(userId,
      '📄 Stuur een PDF met polisvoorwaarden of productinformatie.\n\n_De tekst wordt automatisch uitgelezen en opgeslagen._',
      { parse_mode: 'Markdown' }
    );
  }

  else if (data === 'myknow_clear') {
    await saveUser(userId, { user_knowledge: '' });
    bot.sendMessage(userId, '✅ Jouw kennisbank is leeggemaakt.', { reply_markup: mainKeyboard(userId) });
  }

  // ── CREDITS ──
  else if (data === 'credits') {
    bot.sendMessage(userId, `◆ *Credits kopen*\n\nSaldo: *${user.credits} credits*\n\nKies een pakket:`,
      { parse_mode: 'Markdown', reply_markup: creditsKeyboard() }
    );
  }

  else if (data.startsWith('buy_')) {
    const [, amount, price] = data.split('_');
    bot.sendMessage(userId, `💳 *${amount} credits voor €${price}*\n\n_Demo: direct toevoegen. In productie: Stripe betaallink._`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: `✓ Bevestig ${amount} credits`, callback_data: `confirm_${amount}` }]] }}
    );
  }

  else if (data.startsWith('confirm_')) {
    const amount = parseInt(data.split('_')[1]);
    await saveUser(userId, { credits: user.credits + amount });
    bot.sendMessage(userId, `✅ *${amount} credits toegevoegd!*\n\nNieuw saldo: *${user.credits + amount} credits*`,
      { parse_mode: 'Markdown', reply_markup: mainKeyboard(userId) }
    );
  }

  // ── ADMIN ──
  else if (data === 'admin' && isAdmin(userId)) {
    const all    = await getAllUsers();
    const gklist = await listGlobalKnowledge();
    const list   = all.slice(0, 6).map(u => `\n• *${u.name}* — ${u.credits} cr, ${u.concept_count} concepten${u.style_profile ? ' ◈' : ''}${u.user_knowledge ? ' 📚' : ''}`).join('');
    bot.sendMessage(userId,
      `⚙ *Admin paneel*\n\n` +
      `👥 Gebruikers: ${all.length}\n` +
      `◆ Credits totaal: ${all.reduce((s,u)=>s+u.credits,0)}\n` +
      `✍ Concepten totaal: ${all.reduce((s,u)=>s+u.concept_count,0)}\n` +
      `📚 Globale kennisitems: ${gklist.length}\n\n` +
      `*Gebruikers:*${list || '\nNog geen gebruikers'}`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '📚 Globale kennisbank beheren', callback_data: 'admin_knowledge'    }],
        [{ text: '+ Credits geven aan gebruiker', callback_data: 'admin_give_credits' }],
        [{ text: '📊 Volledig rapport',           callback_data: 'admin_report'       }],
        [{ text: '🔑 API status',                 callback_data: 'admin_api'          }],
      ]}}
    );
  }

  // ── ADMIN: GLOBALE KENNISBANK ──
  else if (data === 'admin_knowledge' && isAdmin(userId)) {
    const list = await listGlobalKnowledge();
    const listText = list.length > 0
      ? list.map((k,i) => `${i+1}. ${k.title}`).join('\n')
      : 'Nog geen items';
    bot.sendMessage(userId,
      `📚 *Globale kennisbank*\n\nDeze kennis wordt voor ALLE gebruikers meegestuurd.\n\n*Huidige items:*\n${listText}`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '+ Tekst toevoegen', callback_data: 'admin_know_add'    }],
        [{ text: '📄 PDF uploaden',   callback_data: 'admin_know_pdf'    }],
        [{ text: '🗑 Item verwijderen', callback_data: 'admin_know_del'  }],
        [{ text: '← Terug',           callback_data: 'admin'            }],
      ]}}
    );
  }

  else if (data === 'admin_know_add' && isAdmin(userId)) {
    s.step = 'admin_awaiting_knowledge';
    bot.sendMessage(userId,
      '📝 Stuur de tekst die je wil toevoegen aan de globale kennisbank.\n\nBegin je bericht met een titel op de eerste regel:\n\n`Titel van het item\nHier komt de inhoud...`',
      { parse_mode: 'Markdown' }
    );
  }

  else if (data === 'admin_know_pdf' && isAdmin(userId)) {
    s.step = 'admin_awaiting_pdf';
    bot.sendMessage(userId, '📄 Stuur een PDF. De tekst wordt uitgelezen en toegevoegd aan de globale kennisbank.');
  }

  else if (data === 'admin_know_del' && isAdmin(userId)) {
    const list = await listGlobalKnowledge();
    if (list.length === 0) return bot.sendMessage(userId, 'Geen items om te verwijderen.');
    const buttons = list.map(k => [{ text: `🗑 ${k.title}`, callback_data: `admin_del_${k.id}` }]);
    buttons.push([{ text: '← Terug', callback_data: 'admin_knowledge' }]);
    bot.sendMessage(userId, '🗑 *Kies een item om te verwijderen:*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
  }

  else if (data.startsWith('admin_del_') && isAdmin(userId)) {
    const id = parseInt(data.replace('admin_del_', ''));
    await deleteGlobalKnowledge(id);
    bot.sendMessage(userId, '✅ Item verwijderd.', { reply_markup: mainKeyboard(userId) });
  }

  else if (data === 'admin_api' && isAdmin(userId)) {
    bot.sendMessage(userId,
      `🔑 *API status*\n\nModel: claude-sonnet-4-20250514\nKey: \`${ANTHROPIC_KEY ? ANTHROPIC_KEY.slice(0,16)+'••••' : 'Niet ingesteld'}\`\nAnthropisch: ${ANTHROPIC_KEY ? '✅' : '❌'}\nSupabase: ${SUPABASE_URL ? '✅' : '❌'}`,
      { parse_mode: 'Markdown' }
    );
  }

  else if (data === 'admin_give_credits' && isAdmin(userId)) {
    s.step = 'admin_awaiting_credits';
    bot.sendMessage(userId, '👤 Stuur: `TELEGRAM_ID AANTAL`\n\nBijvoorbeeld: `123456789 50`', { parse_mode: 'Markdown' });
  }

  else if (data === 'admin_report' && isAdmin(userId)) {
    const all = await getAllUsers();
    let r = '📊 *Rapport*\n\n';
    all.forEach(u => { r += `*${u.name}* (${u.telegram_id})\n  ${u.credits} cr · ${u.concept_count} concepten · stijl:${u.style_profile?'✓':'✗'} · kennis:${u.user_knowledge?'✓':'✗'}\n\n`; });
    if (r.length > 3800) r = r.slice(0, 3800) + '\n_...meer..._';
    bot.sendMessage(userId, r, { parse_mode: 'Markdown' });
  }

  // ── HOME ──
  else if (data === 'home') {
    s.step = 'idle';
    const fresh = await getUser(userId, first_name);
    bot.sendMessage(userId,
      `✉ *MailMate*\n\nSaldo: *${fresh.credits} credits*\nStijl: ${fresh.style_profile ? '✓' : '✗'} · Kennis: ${fresh.user_knowledge ? '✓' : '✗'}`,
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

  // ── PDF ontvangen ──
  if (msg.document && (s.step === 'awaiting_user_pdf' || s.step === 'admin_awaiting_pdf')) {
    const fileId = msg.document.file_id;
    const fname  = msg.document.file_name || 'document.pdf';
    try {
      const fileUrl = await bot.getFileLink(fileId);
      const res     = await fetch(fileUrl);
      const buffer  = await res.arrayBuffer();
      const pdfParse = require('pdf-parse');
      const pdfData  = await pdfParse(Buffer.from(buffer));
      const extracted = pdfData.text.slice(0, 8000); // max 8000 tekens

      if (s.step === 'awaiting_user_pdf') {
        const updated = ((user.user_knowledge || '') + `\n\n## ${fname}\n${extracted}`).slice(0, 12000);
        await saveUser(userId, { user_knowledge: updated });
        s.step = 'idle';
        bot.sendMessage(userId, `✅ *PDF verwerkt!*\n\n_${fname}_ toegevoegd aan jouw kennisbank.\n${pdfData.numpages} pagina's · ${extracted.length} tekens opgeslagen.`,
          { parse_mode: 'Markdown', reply_markup: mainKeyboard(userId) }
        );
      } else if (s.step === 'admin_awaiting_pdf' && isAdmin(userId)) {
        await addGlobalKnowledge(fname, extracted);
        s.step = 'idle';
        bot.sendMessage(userId, `✅ *PDF toegevoegd aan globale kennisbank!*\n\n_${fname}_\n${pdfData.numpages} pagina's verwerkt.`,
          { parse_mode: 'Markdown', reply_markup: mainKeyboard(userId) }
        );
      }
    } catch(e) {
      s.step = 'idle';
      bot.sendMessage(userId, `❌ Fout bij verwerken PDF: ${e.message}\n\nProbeer de tekst handmatig te plakken.`);
    }
    return;
  }

  if (!text) return;

  // ── ADMIN: credits geven ──
  if (s.step === 'admin_awaiting_credits' && isAdmin(userId)) {
    const [tid, amt] = text.split(' ');
    const targetId = parseInt(tid), amount = parseInt(amt);
    if (!isNaN(targetId) && !isNaN(amount)) {
      const target = await getUser(targetId, '');
      if (target) {
        await saveUser(targetId, { credits: target.credits + amount });
        s.step = 'idle';
        return bot.sendMessage(userId, `✅ ${amount} credits aan ${targetId}. Nieuw saldo: ${target.credits + amount}`, { reply_markup: mainKeyboard(userId) });
      }
    }
    return bot.sendMessage(userId, '⚠️ Formaat: `123456789 50`', { parse_mode: 'Markdown' });
  }

  // ── ADMIN: globale kennis toevoegen ──
  if (s.step === 'admin_awaiting_knowledge' && isAdmin(userId)) {
    const lines = text.split('\n');
    const title = lines[0].trim();
    const content = lines.slice(1).join('\n').trim() || text;
    await addGlobalKnowledge(title, content);
    s.step = 'idle';
    bot.sendMessage(userId, `✅ *"${title}"* toegevoegd aan globale kennisbank.\n\nAlle gebruikers profiteren hier nu van.`,
      { parse_mode: 'Markdown', reply_markup: mainKeyboard(userId) }
    );
    return;
  }

  // ── GEBRUIKER: persoonlijke kennis toevoegen ──
  if (s.step === 'awaiting_user_knowledge') {
    const updated = ((user.user_knowledge || '') + '\n\n' + text).slice(0, 12000);
    await saveUser(userId, { user_knowledge: updated });
    s.step = 'idle';
    bot.sendMessage(userId, `✅ *Toegevoegd aan jouw kennisbank!*\n\n_${text.length} tekens opgeslagen._`,
      { parse_mode: 'Markdown', reply_markup: mainKeyboard(userId) }
    );
    return;
  }

  // ── STIJL TRAINEN ──
  if (s.step === 'awaiting_train') {
    if (text.length < 100) return bot.sendMessage(userId, '⚠️ Te weinig tekst. Stuur meer mails (min 100 tekens).');
    const load = await bot.sendMessage(userId, '◈ _Schrijfstijl analyseren..._', { parse_mode: 'Markdown' });
    try {
      const profile = await callClaude(
        `Analyseer de schrijfstijl van onderstaande e-mails en maak een compact stijlprofiel in max 200 woorden.\nBeschrijf: toon, je/u, aanhef, afsluiting, zinslengte, directheid, assurantie-specifieke uitdrukkingen.\n\nE-MAILS:\n${text}`
      );
      await saveUser(userId, { style_profile: profile, credits: user.credits - 3 });
      s.step = 'idle';
      bot.deleteMessage(userId, load.message_id).catch(()=>{});
      bot.sendMessage(userId,
        `✅ *Stijl getraind!* (3 credits)\n\n*Profiel:*\n_${profile.slice(0,260)}${profile.length>260?'...':''}_\n\nSaldo: *${user.credits-3} credits*`,
        { parse_mode: 'Markdown', reply_markup: mainKeyboard(userId) }
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
      const systemPrompt = await buildSystemPrompt(user);
      const reply = await callClaude(`Schrijf een conceptantwoord op deze inkomende mail:\n\n${text}`, systemPrompt);
      await saveUser(userId, { credits: user.credits - 1, concept_count: user.concept_count + 1 });
      const subj = (text.match(/(?:Onderwerp|Subject):\s*(.+)/)||['','Mail'])[1];
      await addHistory(userId, subj);
      s.step = 'idle';
      bot.deleteMessage(userId, load.message_id).catch(()=>{});
      bot.sendMessage(userId,
        `✉ *Concept antwoord:*\n\n${reply}\n\n_— 1 credit · saldo: ${user.credits-1} —_`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
          [{ text: '↩ Herschrijven', callback_data: 'compose' }, { text: '🏠 Home', callback_data: 'home' }],
          [{ text: '📱 Mini App', web_app: { url: MINI_APP_URL } }],
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

console.log('✉ MailMate v2 gestart — Schrijfstijl + Globale & Persoonlijke Kennisbank');
