import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { Bot, InlineKeyboard, GrammyError, webhookCallback } from 'grammy';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ===== Настройки из переменных окружения ===== */
const { BOT_TOKEN, DATABASE_URL } = process.env;
const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) throw new Error('Не задан BOT_TOKEN');
if (!DATABASE_URL) throw new Error('Не задан DATABASE_URL');

// Секрет для вебхука выводим из токена (в Telegram допустимы только A-Za-z0-9_-)
const WEBHOOK_SECRET = crypto.createHash('sha256').update('wh:' + BOT_TOKEN).digest('hex');

/* ===== База данных ===== */
const local = /localhost|127\.0\.0\.1/.test(DATABASE_URL) || process.env.PGSSL === 'disable';
const db = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: local ? false : { rejectUnauthorized: false },
  max: 5,
});

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      tg_id       BIGINT PRIMARY KEY,
      name        TEXT,
      lang        TEXT NOT NULL DEFAULT 'ru',
      notify      BOOLEAN NOT NULL DEFAULT FALSE,
      notify_time TEXT NOT NULL DEFAULT '20:00',
      tz          INT NOT NULL DEFAULT 0,
      last_sent   TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id         SERIAL PRIMARY KEY,
      tg_id      BIGINT NOT NULL,
      name       TEXT,
      stars      INT NOT NULL,
      text       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS reviews_created_idx ON reviews (created_at DESC);
  `);
}

/* ===== Проверка подписи Telegram initData ===== */
function verifyInitData(raw) {
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheck = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');

  const a = Buffer.from(calc);
  const b = Buffer.from(hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const age = Date.now() / 1000 - Number(params.get('auth_date') || 0);
  if (!(age < 86400)) return null; // подпись старше суток — отклоняем

  try {
    const user = JSON.parse(params.get('user'));
    return user && user.id ? user : null;
  } catch {
    return null;
  }
}

function auth(req, res, next) {
  const user = verifyInitData(req.get('X-Init'));
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.user = user;
  next();
}

/* ===== Язык ===== */
const LANGS = ['ru', 'en', 'kk'];
const fromCode = (code) => (code === 'ru' ? 'ru' : code === 'kk' ? 'kk' : 'en');

async function userLang(id, code) {
  const { rows } = await db.query('SELECT lang FROM users WHERE tg_id = $1', [id]);
  return rows[0]?.lang || fromCode(code);
}

/* ===== Тексты бота ===== */
const TXT = {
  ru: {
    start: (n) => `Привет, ${n}! 👋\nЯ CoachBot: считаю норму калорий, веду тренировки и питание, напоминаю про воду. Жми кнопку ниже.`,
    open: '🚀 Открыть CoachBot',
    ask: 'Как прошёл день? Тренировка, питание, вода — всё по плану?',
    good: '✅ Всё по плану', mid: '😐 Частично', bad: '❌ Не вышло',
    rGood: 'Отлично! 🔥 Отметьте день завершённым в приложении, чтобы сохранить серию.',
    rMid: 'Нормально, бывает. Завтра продолжим — главное не бросать. 💪',
    rBad: 'Бывает у всех. Завтра новый день — начните с одного маленького шага. 🌱',
    other: 'Всё самое важное — в приложении 👇',
  },
  en: {
    start: (n) => `Hi, ${n}! 👋\nI'm CoachBot: I calculate your calories, guide workouts and nutrition, and remind you to drink water. Tap the button below.`,
    open: '🚀 Open CoachBot',
    ask: 'How did your day go? Workout, food, water — all on plan?',
    good: '✅ All on plan', mid: '😐 Partly', bad: '❌ Missed it',
    rGood: 'Great! 🔥 Mark the day as finished in the app to keep your streak.',
    rMid: 'That’s fine, it happens. We continue tomorrow — the key is not to quit. 💪',
    rBad: 'Happens to everyone. Tomorrow is a new day — start with one small step. 🌱',
    other: 'Everything important is in the app 👇',
  },
  kk: {
    start: (n) => `Сәлем, ${n}! 👋\nМен CoachBot: калория нормасын есептеймін, жаттығу мен тамақтануды жүргіземін, су ішуді еске саламын. Төмендегі батырманы басыңыз.`,
    open: '🚀 CoachBot ашу',
    ask: 'Күніңіз қалай өтті? Жаттығу, тамақ, су — бәрі жоспар бойынша ма?',
    good: '✅ Бәрі жоспар бойынша', mid: '😐 Ішінара', bad: '❌ Болмады',
    rGood: 'Керемет! 🔥 Қатарды сақтау үшін күнді қосымшада аяқталды деп белгілеңіз.',
    rMid: 'Ештеңе етпейді, болады. Ертең жалғастырамыз — маңыздысы тоқтамау. 💪',
    rBad: 'Бәрінде болады. Ертең жаңа күн — кішкентай қадамнан бастаңыз. 🌱',
    other: 'Ең маңыздысы — қосымшада 👇',
  },
};

/* ===== Бот ===== */
const bot = new Bot(BOT_TOKEN);

// Кнопка мини-приложения. ?lang= подхватывает index.html
const openKb = (lang, extra) => {
  if (!BASE_URL) return undefined; // без https-адреса web_app-кнопки не работают
  const kb = extra || new InlineKeyboard();
  return kb.webApp(TXT[lang].open, `${BASE_URL}/?lang=${lang}`);
};

async function sendStart(ctx) {
  const u = ctx.from;
  const lang = fromCode(u.language_code);
  // Новый пользователь получает язык из настроек Telegram, старого не трогаем
  await db.query(
    `INSERT INTO users (tg_id, name, lang) VALUES ($1, $2, $3)
     ON CONFLICT (tg_id) DO UPDATE SET name = EXCLUDED.name`,
    [u.id, u.first_name || '', lang],
  );
  const l = await userLang(u.id, u.language_code);
  await ctx.reply(TXT[l].start(u.first_name || ''), { reply_markup: openKb(l) });
}

bot.command(['start', 'app'], sendStart);

bot.callbackQuery(/^d:(good|mid|bad)$/, async (ctx) => {
  const l = await userLang(ctx.from.id, ctx.from.language_code);
  const key = { good: 'rGood', mid: 'rMid', bad: 'rBad' }[ctx.match[1]];
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(TXT[l][key], { reply_markup: openKb(l) });
});

bot.on('message', async (ctx) => {
  const l = await userLang(ctx.from.id, ctx.from.language_code);
  await ctx.reply(TXT[l].other, { reply_markup: openKb(l) });
});

bot.catch((err) => console.error('Ошибка бота:', err.error?.message || err.message));

/* ===== Вечерние напоминания ===== */
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const { rows } = await db.query(
      'SELECT tg_id, lang, notify_time, tz, last_sent FROM users WHERE notify',
    );
    const now = Date.now();
    for (const u of rows) {
      // tz — это getTimezoneOffset() из браузера (для UTC+5 это -300)
      const localNow = new Date(now - u.tz * 60000);
      const date = localNow.toISOString().slice(0, 10);
      const mins = localNow.getUTCHours() * 60 + localNow.getUTCMinutes();
      const [h, m] = u.notify_time.split(':').map(Number);
      const diff = mins - (h * 60 + m);

      // Окно 90 минут: если сервис «спал» на бесплатном тарифе, напоминание не потеряется
      if (u.last_sent === date || diff < 0 || diff > 90) continue;

      const l = LANGS.includes(u.lang) ? u.lang : 'ru';
      const kb = new InlineKeyboard()
        .text(TXT[l].good, 'd:good').text(TXT[l].mid, 'd:mid').text(TXT[l].bad, 'd:bad').row();
      try {
        await bot.api.sendMessage(u.tg_id, TXT[l].ask, { reply_markup: openKb(l, kb) });
        await db.query('UPDATE users SET last_sent = $1 WHERE tg_id = $2', [date, u.tg_id]);
      } catch (e) {
        if (e instanceof GrammyError && (e.error_code === 403 || e.error_code === 400)) {
          // пользователь заблокировал бота или чата нет — выключаем напоминания
          await db.query('UPDATE users SET notify = FALSE WHERE tg_id = $1', [u.tg_id]);
        } else {
          console.error('Не удалось отправить напоминание:', e.message);
        }
      }
    }
  } catch (e) {
    console.error('Ошибка планировщика:', e.message);
  } finally {
    ticking = false;
  }
}

/* ===== HTTP-сервер ===== */
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));

app.get('/health', (_req, res) => res.send('ok'));

if (BASE_URL) {
  app.post('/webhook', webhookCallback(bot, 'express', { secretToken: WEBHOOK_SECRET }));
}

// Отзывы
app.get('/api/reviews', auth, async (_req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT name, stars, text, created_at FROM reviews ORDER BY created_at DESC LIMIT 50',
    );
    res.json(rows);
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: 'server' });
  }
});

app.post('/api/reviews', auth, async (req, res) => {
  const stars = Number(req.body?.stars);
  const text = String(req.body?.text ?? '').trim();
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return res.status(400).json({ error: 'stars' });
  if (text.length < 3 || text.length > 500) return res.status(400).json({ error: 'text' });

  try {
    // Не чаще одного отзыва в сутки с аккаунта
    const recent = await db.query(
      `SELECT 1 FROM reviews WHERE tg_id = $1 AND created_at > now() - interval '24 hours' LIMIT 1`,
      [req.user.id],
    );
    if (recent.rowCount) return res.status(429).json({ error: 'too_often' });

    await db.query('INSERT INTO reviews (tg_id, name, stars, text) VALUES ($1, $2, $3, $4)', [
      req.user.id,
      String(req.user.first_name || 'User').slice(0, 64),
      stars,
      text,
    ]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: 'server' });
  }
});

// Настройки и напоминания
app.post('/api/settings', auth, async (req, res) => {
  const b = req.body || {};
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(b.time) ? b.time : '20:00';
  const tz = Number.isInteger(b.tz) && Math.abs(b.tz) <= 840 ? b.tz : 0;
  const lang = LANGS.includes(b.lang) ? b.lang : fromCode(req.user.language_code);
  const name = String(b.name || req.user.first_name || '').slice(0, 64);

  try {
    await db.query(
      `INSERT INTO users (tg_id, name, lang, notify, notify_time, tz)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tg_id) DO UPDATE SET
         name = EXCLUDED.name, lang = EXCLUDED.lang, notify = EXCLUDED.notify,
         notify_time = EXCLUDED.notify_time, tz = EXCLUDED.tz`,
      [req.user.id, name, lang, !!b.notify, time, tz],
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: 'server' });
  }
});

// Мини-приложение (public/index.html)
app.use(express.static(path.join(__dirname, 'public')));

/* ===== Запуск ===== */
await initDb();
await bot.init();

app.listen(PORT, async () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  try {
    if (BASE_URL) {
      await bot.api.setWebhook(`${BASE_URL}/webhook`, {
        secret_token: WEBHOOK_SECRET,
        allowed_updates: ['message', 'callback_query'],
      });
      await bot.api.setChatMenuButton({
        menu_button: { type: 'web_app', text: 'CoachBot', web_app: { url: `${BASE_URL}/` } },
      });
      console.log('Вебхук установлен:', `${BASE_URL}/webhook`);
    } else {
      console.log('BASE_URL не задан — бот работает через long polling (без кнопки мини-приложения)');
      await bot.api.deleteWebhook();
      bot.start();
    }
    await bot.api.setMyCommands([{ command: 'start', description: 'Открыть CoachBot' }]);
  } catch (e) {
    console.error('Ошибка настройки бота:', e.message);
  }
});

const timer = setInterval(tick, 60 * 1000);
process.on('SIGTERM', () => {
  clearInterval(timer);
  process.exit(0);
});
