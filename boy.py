import asyncio, hashlib, hmac, json, os, sqlite3, time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qsl

from aiohttp import web
from aiogram import Bot, Dispatcher, F
from aiogram.filters import CommandStart
from aiogram.types import (CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup,
                           MenuButtonWebApp, Message, WebAppInfo)

TOKEN = os.environ["BOT_TOKEN"]          # токен от @BotFather
WEBAPP_URL = os.environ["WEBAPP_URL"]    # https-адрес, где живёт этот сервер
PORT = int(os.getenv("PORT", 8080))

bot = Bot(TOKEN)
dp = Dispatcher()

db = sqlite3.connect("coach.db", check_same_thread=False)
db.row_factory = sqlite3.Row
db.executescript("""
create table if not exists users(
  id integer primary key, name text, notify int default 0,
  ntime text default '20:00', tz int default 0, last_sent text default '');
create table if not exists reviews(
  id integer primary key autoincrement, uid int, name text, stars int, text text, ts real);
""")


# ---------- проверка, что запрос пришёл из Telegram ----------
def auth(req: web.Request) -> dict:
    data = dict(parse_qsl(req.headers.get("X-Init", "")))
    got = data.pop("hash", "")
    check = "\n".join(f"{k}={v}" for k, v in sorted(data.items()))
    key = hmac.new(b"WebAppData", TOKEN.encode(), hashlib.sha256).digest()
    ok = hmac.compare_digest(hmac.new(key, check.encode(), hashlib.sha256).hexdigest(), got)
    if not ok or time.time() - int(data.get("auth_date", 0)) > 86400 * 7:
        raise web.HTTPUnauthorized()
    return json.loads(data["user"])


# ---------- API ----------
async def settings(req):
    u, b = auth(req), await req.json()
    t = str(b.get("time", "20:00"))[:5]
    db.execute("""insert into users(id,name,notify,ntime,tz) values(?,?,?,?,?)
        on conflict(id) do update set name=excluded.name, notify=excluded.notify,
        ntime=excluded.ntime, tz=excluded.tz""",
               (u["id"], b.get("name") or u.get("first_name", ""), int(bool(b.get("notify"))), t, int(b.get("tz", 0))))
    db.commit()
    return web.json_response({"ok": True})


async def reviews_get(req):
    auth(req)
    rows = db.execute("select name,stars,text from reviews order by id desc limit 30").fetchall()
    return web.json_response([dict(r) for r in rows])


async def reviews_post(req):
    u, b = auth(req), await req.json()
    text = str(b.get("text", "")).strip()[:500]
    stars = min(5, max(1, int(b.get("stars", 5))))
    if len(text) < 3:
        raise web.HTTPBadRequest()
    db.execute("insert into reviews(uid,name,stars,text,ts) values(?,?,?,?,?)",
               (u["id"], u.get("first_name", "Аноним"), stars, text, time.time()))
    db.commit()
    return web.json_response({"ok": True})


async def index(_):
    return web.FileResponse(Path(__file__).with_name("index.html"))


# ---------- бот ----------
@dp.message(CommandStart())
async def start(m: Message):
    kb = InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="🚀 Открыть CoachBot", web_app=WebAppInfo(url=WEBAPP_URL))]])
    await m.answer("Привет! Я CoachBot 💪\nСчитаю КБЖУ, составляю тренировки и питание под твою цель.", reply_markup=kb)


@dp.callback_query(F.data.startswith("d:"))
async def mood(c: CallbackQuery):
    answers = {
        "great": "🔥 Отлично! Так держать, серия растёт. Не забудь отметить день в приложении.",
        "ok": "👍 Нормальный день — тоже результат. Завтра чуть лучше!",
        "hard": "🫶 Бывает. Отдохни, выпей воды и выспись — завтра новый день.",
    }
    await c.message.edit_text(answers.get(c.data[2:], "Спасибо!"))
    await c.answer()


async def notifier():
    """Раз в 30 сек проверяет, кому пора отправить вопрос «как прошёл день?»."""
    kb = InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="🔥 Отлично", callback_data="d:great"),
        InlineKeyboardButton(text="👍 Норм", callback_data="d:ok"),
        InlineKeyboardButton(text="😮‍💨 Тяжело", callback_data="d:hard")]])
    while True:
        try:
            now = datetime.now(timezone.utc)
            for u in db.execute("select * from users where notify=1").fetchall():
                local = now - timedelta(minutes=u["tz"])  # tz = getTimezoneOffset() из браузера
                day = local.strftime("%Y-%m-%d")
                if u["last_sent"] != day and local.strftime("%H:%M") >= u["ntime"]:
                    db.execute("update users set last_sent=? where id=?", (day, u["id"]))
                    db.commit()
                    try:
                        await bot.send_message(u["id"], f"{u['name'] or 'Привет'}, как прошёл день? 💬", reply_markup=kb)
                    except Exception:
                        db.execute("update users set notify=0 where id=?", (u["id"],))  # бот заблокирован
                        db.commit()
        except Exception as e:
            print("notifier:", e)
        await asyncio.sleep(30)


async def main():
    app = web.Application()
    app.add_routes([web.get("/", index), web.post("/api/settings", settings),
                    web.get("/api/reviews", reviews_get), web.post("/api/reviews", reviews_post)])
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", PORT).start()
    await bot.set_chat_menu_button(menu_button=MenuButtonWebApp(text="CoachBot", web_app=WebAppInfo(url=WEBAPP_URL)))
    asyncio.create_task(notifier())
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
