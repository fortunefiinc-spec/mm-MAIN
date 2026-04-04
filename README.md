# ✉ MailMate

AI-gestuurde e-mailassistent die jouw schrijfstijl leert en conceptantwoorden klaarzet.

**Twee toegangspunten:**
- 📱 **Telegram Mini App** — volledig portaal in Telegram
- 🤖 **Telegram Bot** — snel concept via chat + beheer voor jou

---

## Projectstructuur

```
mailmate/
├── index.html        ← Mini App frontend (→ GitHub Pages)
├── bot.js            ← Telegram bot (→ Railway)
├── package.json
├── .env.example      ← Kopieer naar .env
└── README.md
```

---

## Stap 1 — Telegram Bot aanmaken

1. Open Telegram → zoek **@BotFather**
2. Stuur `/newbot`
3. Geef een naam: `MailMate`
4. Geef een gebruikersnaam: `mailmate_jouwnaam_bot`
5. Kopieer de **Bot Token** → bewaar dit

**Jouw Admin ID vinden:**
1. Open Telegram → zoek **@userinfobot**
2. Stuur `/start`
3. Kopieer je **User ID** (getal)

---

## Stap 2 — GitHub Pages (Mini App frontend)

1. Ga naar [github.com](https://github.com) → **New repository**
2. Naam: `mailmate`
3. Zet op **Public**
4. Upload `index.html` naar de repo
5. Ga naar **Settings → Pages**
6. Source: `Deploy from a branch → main → / (root)`
7. Na ~2 minuten live op: `https://JOUWUSERNAME.github.io/mailmate`

**Mini App registreren bij BotFather:**
```
/newapp
→ Kies je bot
→ Titel: MailMate
→ URL: https://JOUWUSERNAME.github.io/mailmate
```

---

## Stap 3 — Bot deployen op Railway (gratis)

1. Ga naar [railway.app](https://railway.app) → inloggen met GitHub
2. **New Project → Deploy from GitHub repo**
3. Kies je `mailmate` repo
4. Ga naar **Variables** en voeg toe:

| Variable | Waarde |
|---|---|
| `BOT_TOKEN` | Jouw bot token van BotFather |
| `ADMIN_ID` | Jouw Telegram user ID |
| `ANTHROPIC_KEY` | `sk-ant-api03-...` |
| `MINI_APP_URL` | `https://JOUWUSERNAME.github.io/mailmate` |
| `WEBHOOK_URL` | `https://JOUW-APP.up.railway.app` (zie Railway dashboard) |

5. Railway deployt automatisch → bot is live

---

## Stap 4 — Lokaal testen (optioneel)

```bash
# Installeer dependencies
npm install

# Kopieer en vul .env in
cp .env.example .env
# → Bewerk .env met jouw waarden

# Start de bot (polling mode, geen webhook nodig)
npm run dev
```

Bot reageert nu op berichten in Telegram.

---

## Gebruik

### Als gebruiker
| Actie | Credits |
|---|---|
| `/start` | Gratis welkomst |
| Agent trainen | 3 credits |
| Concept genereren | 1 credit |
| Credits kopen | — |

**Flow:**
1. `/start` → kies **Agent trainen**
2. Plak je eigen e-mails → agent leert je stijl
3. Kies **Concept schrijven** → plak inkomende mail
4. Bot stuurt concept terug in jóuw stijl

### Als beheerder
Via **Admin paneel** knop (alleen zichtbaar voor jou):
- Alle gebruikers + credits inzien
- Credits handmatig toewijzen
- API key status checken
- Rapport opvragen

---

## Mini App (index.html) aanpassen

De Mini App heeft bovenaan in de `<script>` twee variabelen die je moet instellen:

```javascript
const IS_ADMIN = (TG_USER.id === parseInt(window.ADMIN_ID || '0'))
```

In productie wil je de API key **server-side** afhandelen. Bouw een simpele `/api/chat` endpoint in je bot.js die de Claude call doet, zodat de key nooit in de browser zit.

---

## Productie-upgrade (Supabase)

Voor echte gebruikers vervang je de in-memory `Map` in bot.js door Supabase:

```bash
npm install @supabase/supabase-js
```

```javascript
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Gebruiker opslaan
await supabase.from('users').upsert({ telegram_id: userId, credits: 10 });

// Gebruiker ophalen
const { data } = await supabase.from('users').select('*').eq('telegram_id', userId).single();
```

Gratis Supabase tier is voldoende voor honderden gebruikers.

---

## Kosten overzicht

| Service | Kosten |
|---|---|
| GitHub Pages | Gratis |
| Railway (bot hosting) | Gratis tot $5/maand |
| Supabase | Gratis tot 50.000 rows |
| Anthropic API | ~€0.01 per concept |
| Telegram Bot API | Gratis |

**Totaal voor MVP: €0 — €5/maand**

---

## Vragen?

Gebouwd met Claude · MailMate © 2025
