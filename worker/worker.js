/**
 * Штурман · Крипто-бот — интерактивное меню в Telegram.
 *
 * Cloudflare Worker принимает вебхуки Telegram и отвечает мгновенно.
 * Данные:
 *  - живые цены: публичный API OKX (в момент нажатия кнопки)
 *  - портфель/сделки/индикаторы: state/paper_state.json из репозитория
 *    (обновляется часовым ботом в GitHub Actions)
 *
 * Секреты воркера: BOT_TOKEN (токен Telegram-бота).
 */

const STATE_URL =
  "https://raw.githubusercontent.com/vexenali-prog/-/main/state/paper_state.json";
const OKX_TICKERS = "https://www.okx.com/api/v5/market/tickers?instType=SPOT";
const START_CASH = 1000;
const BAND = 0.02;

const SYMBOLS = [
  "BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "DOGE-USDT",
  "ADA-USDT", "LINK-USDT", "AVAX-USDT", "DOT-USDT", "LTC-USDT",
  "TRX-USDT", "BCH-USDT", "ETC-USDT",
];

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("ok");
    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("bad request", { status: 400 });
    }
    try {
      await handleUpdate(update, env);
    } catch (e) {
      console.log("handleUpdate error:", e.stack || e.message);
    }
    return new Response("ok");
  },
};

async function handleUpdate(update, env) {
  if (update.callback_query) {
    const cq = update.callback_query;
    const view = await render(cq.data);
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
    await tg(env, "editMessageText", {
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id,
      text: view.text,
      parse_mode: "HTML",
      reply_markup: view.keyboard,
    });
    return;
  }
  const msg = update.message;
  if (!msg || !msg.text) return;
  const cmd = msg.text.split(/[@\s]/)[0];
  const route = {
    "/start": "menu", "/portfolio": "pf", "/prices": "px",
    "/signals": "sg", "/stats": "st", "/help": "hp",
  }[cmd] || "menu";
  const view = await render(route);
  await tg(env, "sendMessage", {
    chat_id: msg.chat.id,
    text: view.text,
    parse_mode: "HTML",
    reply_markup: view.keyboard,
  });
}

async function render(route) {
  const [page, arg] = route.split(":");
  switch (page) {
    case "pf": return viewPortfolio();
    case "px": return arg ? viewCoin(arg) : viewPrices();
    case "sg": return viewSignals();
    case "st": return viewStats();
    case "tr": return viewTrades(parseInt(arg || "0", 10));
    case "hp": return viewHelp(arg);
    default: return viewMenu();
  }
}

// ---------- источники данных ----------

async function getState() {
  const r = await fetch(STATE_URL, { cf: { cacheTtl: 30 } });
  if (!r.ok) throw new Error("state fetch failed: " + r.status);
  return r.json();
}

async function getTickers() {
  const r = await fetch(OKX_TICKERS, { cf: { cacheTtl: 3 } });
  if (!r.ok) throw new Error("okx fetch failed: " + r.status);
  const data = (await r.json()).data || [];
  const out = {};
  for (const t of data) {
    if (SYMBOLS.includes(t.instId)) {
      out[t.instId] = {
        last: parseFloat(t.last),
        open24h: parseFloat(t.open24h),
        high24h: parseFloat(t.high24h),
        low24h: parseFloat(t.low24h),
        volUsd: parseFloat(t.volCcy24h),
      };
    }
  }
  return out;
}

// ---------- экраны ----------

function viewMenu() {
  return {
    text:
      "👋 <b>Привет! Я Штурман — твой торговый бот.</b>\n\n" +
      "Слежу за 13 криптовалютами круглосуточно и торгую по трендовой " +
      "стратегии, проверенной на 2 годах истории.\n\n" +
      "🧪 Сейчас — <b>тренировочный режим</b>: деньги виртуальные, цены " +
      "настоящие. Докажу прибыльность — обсудим реальный счёт.\n\n" +
      "Что показать?",
    keyboard: kb([
      [["💼 Портфель", "pf"], ["📈 Цены", "px"]],
      [["🧭 Сигналы", "sg"], ["📊 Статистика", "st"]],
      [["🧾 Сделки", "tr:0"], ["ℹ️ Помощь", "hp"]],
    ]),
  };
}

async function viewPortfolio() {
  const [state, tickers] = await Promise.all([getState(), getTickers()]);
  let invested = 0;
  const lines = [];
  for (const [sym, pos] of Object.entries(state.positions || {})) {
    const price = tickers[sym]?.last ?? pos.entry;
    const value = pos.qty * price;
    const pnlPct = (price / pos.entry - 1) * 100;
    invested += value;
    lines.push(
      `${pnlPct >= 0 ? "🟢" : "🔴"} <b>${coin(sym)}</b>: ${money(value)} $ ` +
      `(вход ${money(pos.entry)} → ${money(price)}, <b>${signed(pnlPct)}%</b>)`
    );
  }
  const equity = state.cash + invested;
  const total = (equity / START_CASH - 1) * 100;
  return {
    text:
      "💼 <b>Портфель</b> <i>(виртуальный)</i>\n\n" +
      `Всего: <b>${money(equity)} $</b> (${signed(total)}% от старта)\n` +
      `Свободно: ${money(state.cash)} $\n` +
      `В позициях: ${money(invested)} $\n\n` +
      (lines.length ? lines.join("\n") : "Открытых позиций нет — сидим в кэше и ждём тренд.") +
      "\n\n<i>Цены — прямо сейчас с биржи.</i>",
    keyboard: kb([
      [["🔄 Обновить", "pf"], ["🧾 Сделки", "tr:0"]],
      [["← Меню", "menu"]],
    ]),
  };
}

async function viewPrices() {
  const tickers = await getTickers();
  const rows = SYMBOLS.map((sym) => {
    const t = tickers[sym];
    if (!t) return [[coin(sym) + " —", "px:" + sym]];
    const ch = (t.last / t.open24h - 1) * 100;
    return [[`${ch >= 0 ? "🟢" : "🔴"} ${coin(sym)}  ${money(t.last)} $  ${signed(ch)}%`, "px:" + sym]];
  });
  return {
    text:
      "📈 <b>Живые цены</b> — прямо сейчас с биржи\n" +
      "<i>Изменение за 24 часа. Нажми монету — покажу детали.</i>",
    keyboard: kb([...rows, [["🔄 Обновить", "px"], ["← Меню", "menu"]]]),
  };
}

async function viewCoin(sym) {
  const [state, tickers] = await Promise.all([getState(), getTickers()]);
  const t = tickers[sym];
  if (!t) return { text: "Нет данных по " + coin(sym), keyboard: kb([[["← Цены", "px"]]]) };
  const ch = (t.last / t.open24h - 1) * 100;
  const ind = (state.indicators || {})[sym];
  const pos = (state.positions || {})[sym];
  let trend = "";
  if (ind) {
    const dist = (t.last / ind.ema - 1) * 100;
    trend = dist >= 0
      ? `выше тренда на ${dist.toFixed(1)}%`
      : `ниже тренда на ${(-dist).toFixed(1)}%`;
  }
  return {
    text:
      `<b>${coin(sym)}</b>\n\n` +
      `Цена: <b>${money(t.last)} $</b> (${signed(ch)}% за 24ч)\n` +
      `Диапазон 24ч: ${money(t.low24h)} — ${money(t.high24h)} $\n` +
      `Оборот 24ч: ${short(t.volUsd)} $\n` +
      (trend ? `Тренд: ${trend}\n` : "") +
      (pos
        ? `\n🟢 <b>В портфеле</b>: вход ${money(pos.entry)} $, сейчас ${signed((t.last / pos.entry - 1) * 100)}%`
        : "\n⚪ Не в портфеле") +
      "\n\n<i>Цена живая; тренд — по последнему часовому расчёту.</i>",
    keyboard: kb([[["🔄 Обновить", "px:" + sym], ["← Цены", "px"]], [["← Меню", "menu"]]]),
  };
}

async function viewSignals() {
  const [state, tickers] = await Promise.all([getState(), getTickers()]);
  const lines = SYMBOLS.map((sym) => {
    const t = tickers[sym];
    const ind = (state.indicators || {})[sym];
    const pos = (state.positions || {})[sym];
    if (!t || !ind) return `⚪ <b>${coin(sym)}</b> — ждём первого расчёта`;
    const dist = (t.last / ind.ema - 1) * 100;
    if (pos) {
      return dist < -BAND * 100
        ? `🟠 <b>${coin(sym)}</b> — держим, но цена под трендом: бот продаст на закрытии часа`
        : `🟢 <b>${coin(sym)}</b> — держим (${signed(dist)}% к тренду)`;
    }
    if (dist > BAND * 100) {
      return `🟡 <b>${coin(sym)}</b> — выше тренда: бот купит на закрытии часа`;
    }
    return `⚪ <b>${coin(sym)}</b> — ниже тренда (${signed(dist)}%), ждём`;
  });
  return {
    text:
      "🧭 <b>Сигналы по монетам</b>\n\n" + lines.join("\n") +
      "\n\n<i>Бот решает раз в час по закрытой свече — так задумано, " +
      "это защита от рыночного шума.</i>",
    keyboard: kb([[["🔄 Обновить", "sg"], ["💼 Портфель", "pf"]], [["← Меню", "menu"]]]),
  };
}

async function viewStats() {
  const [state, tickers] = await Promise.all([getState(), getTickers()]);
  let invested = 0;
  for (const [sym, pos] of Object.entries(state.positions || {})) {
    invested += pos.qty * (tickers[sym]?.last ?? pos.entry);
  }
  const equity = state.cash + invested;
  const trades = state.trades || [];
  const wins = trades.filter((t) => t.pnl > 0);
  const best = trades.length ? Math.max(...trades.map((t) => t.pnl_pct)) : 0;
  const worst = trades.length ? Math.min(...trades.map((t) => t.pnl_pct)) : 0;
  const started = state.equity_history?.[0]?.ts;
  const days = started ? Math.max(1, Math.round((Date.now() - started) / 86400000)) : 0;
  return {
    text:
      "📊 <b>Статистика</b> <i>(paper-режим)</i>\n\n" +
      `Портфель: <b>${money(equity)} $</b>\n` +
      `Результат: <b>${signed((equity / START_CASH - 1) * 100)}%</b> за ${days} дн.\n\n` +
      `Сделок закрыто: ${trades.length}\n` +
      (trades.length
        ? `Прибыльных: ${wins.length} (${Math.round((wins.length / trades.length) * 100)}%)\n` +
          `Лучшая: ${signed(best)}% · Худшая: ${signed(worst)}%\n`
        : "") +
      "\n<i>Трендовая стратегия зарабатывает редкими крупными выигрышами — " +
      "низкий процент прибыльных сделок это норма.</i>",
    keyboard: kb([[["🔄 Обновить", "st"], ["🧾 Сделки", "tr:0"]], [["← Меню", "menu"]]]),
  };
}

async function viewTrades(page) {
  const state = await getState();
  const trades = (state.trades || []).slice().reverse();
  const PER = 5;
  const chunk = trades.slice(page * PER, page * PER + PER);
  const lines = chunk.map((t) => {
    const d = new Date(t.closed_ts).toISOString().slice(0, 10);
    return (
      `${t.pnl > 0 ? "✅" : "🔴"} <b>${coin(t.symbol)}</b> ${d}\n` +
      `   ${money(t.entry)} → ${money(t.exit)} $ · <b>${signed(t.pnl_pct)}%</b> (${t.reason})`
    );
  });
  const nav = [];
  if (page > 0) nav.push(["← Новее", "tr:" + (page - 1)]);
  if ((page + 1) * PER < trades.length) nav.push(["Старее →", "tr:" + (page + 1)]);
  return {
    text:
      "🧾 <b>История сделок</b>\n\n" +
      (lines.length ? lines.join("\n") : "Закрытых сделок пока нет — бот только начал.") +
      (trades.length ? `\n\nВсего: ${trades.length}` : ""),
    keyboard: kb([...(nav.length ? [nav] : []), [["📊 Статистика", "st"], ["← Меню", "menu"]]]),
  };
}

function viewHelp(arg) {
  if (arg === "strategy") {
    return {
      text:
        "📖 <b>Стратегия</b>\n\n" +
        "Следование за трендом: покупаю монету, когда её цена закрепляется " +
        "<b>выше</b> месячной средней (+2%), продаю — когда уходит <b>ниже</b> (−2%).\n\n" +
        "Каждой монете — равная доля капитала. Только спот, без плеча.\n\n" +
        "Проверка на 2 годах истории (бычий + медвежий рынок): " +
        "<b>+47.6%</b> против −27% у «просто держать». Максимальная " +
        "просадка была ~30% — к такому надо быть готовым.\n\n" +
        "⚠️ Прошлые результаты не гарантируют будущих.",
      keyboard: kb([[["⏰ Расписание", "hp:schedule"], ["← Помощь", "hp"]], [["← Меню", "menu"]]]),
    };
  }
  if (arg === "schedule") {
    return {
      text:
        "⏰ <b>Расписание</b>\n\n" +
        "• Каждый час в :03 — бот проверяет рынок и торгует\n" +
        "• Сообщение о сделке — сразу, как она случилась\n" +
        "• Дневная сводка — каждое утро ~10:00 по Баку\n" +
        "• Кнопки меню — отвечают мгновенно, цены живые\n\n" +
        "Если сделок нет несколько дней — это нормально: " +
        "бот ждёт подходящий тренд, а не торгует ради торговли.",
      keyboard: kb([[["📖 Стратегия", "hp:strategy"], ["← Помощь", "hp"]], [["← Меню", "menu"]]]),
    };
  }
  return {
    text:
      "ℹ️ <b>Как всё устроено</b>\n\n" +
      "Я торгую <b>виртуальной</b> $1000 по настоящим ценам 13 монет: " +
      "BTC, ETH, SOL, XRP, DOGE, ADA, LINK, AVAX, DOT, LTC, TRX, BCH, ETC.\n\n" +
      "Это тренировка: за 3–4 недели станет видно, зарабатывает ли " +
      "стратегия вживую. Если да — подключим реальный счёт с маленькой " +
      "суммой. Если нет — ты потерял ноль.\n\n" +
      "Выбери, что рассказать подробнее:",
    keyboard: kb([
      [["📖 Стратегия", "hp:strategy"], ["⏰ Расписание", "hp:schedule"]],
      [["← Меню", "menu"]],
    ]),
  };
}

// ---------- утилиты ----------

function kb(rows) {
  return {
    inline_keyboard: rows.map((r) => r.map(([text, data]) => ({ text, callback_data: data }))),
  };
}

function coin(sym) {
  return sym.replace("-USDT", "");
}

function money(x) {
  if (x >= 1000) return x.toLocaleString("ru-RU", { maximumFractionDigits: 0 });
  if (x >= 1) return x.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
  return x.toLocaleString("ru-RU", { maximumFractionDigits: 5 });
}

function signed(x) {
  return (x >= 0 ? "+" : "") + x.toFixed(1);
}

function short(x) {
  if (x >= 1e9) return (x / 1e9).toFixed(1) + " млрд";
  if (x >= 1e6) return (x / 1e6).toFixed(1) + " млн";
  return Math.round(x).toLocaleString("ru-RU");
}

async function tg(env, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!data.ok) console.log(`telegram ${method} error:`, JSON.stringify(data));
  return data;
}
