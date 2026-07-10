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

// Торгуемые монеты (топ по капитализации) и полный список наблюдения.
const TRADED = ["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "DOGE-USDT", "TRX-USDT"];
const SYMBOLS = [
  ...TRADED,
  "ADA-USDT", "LINK-USDT", "AVAX-USDT", "DOT-USDT", "LTC-USDT",
  "BCH-USDT", "ETC-USDT",
];

// Чат владельца: только он может ставить бота на паузу.
const OWNER_CHAT = 5480566532;

export default {
  async fetch(request, env) {
    if (request.method === "GET" && new URL(request.url).pathname === "/control") {
      const paused = (await env.CONTROL.get("paused")) === "1";
      return Response.json({ paused });
    }
    if (request.method !== "POST") return new Response("ok");
    if (
      env.WEBHOOK_SECRET &&
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET
    ) {
      return new Response("forbidden", { status: 403 });
    }
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

  // Сторож (Cloudflare cron): GitHub Actions может тихо пропускать
  // запуски по расписанию — если данные протухли, сообщаем владельцу.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(watchdog(env));
  },
};

const STALE_AFTER_MS = 2.5 * 3600 * 1000; // ждём минимум 2 пропущенных часа
const ALERT_COOLDOWN_MS = 6 * 3600 * 1000;

async function watchdog(env) {
  try {
    const state = await getState();
    const points = state.equity_history || [];
    const lastTs = points.length ? points[points.length - 1].ts : 0;
    const age = Date.now() - lastTs;
    if (age < STALE_AFTER_MS) return;
    const lastAlert = parseInt((await env.CONTROL.get("stale_alert_ts")) || "0", 10);
    if (Date.now() - lastAlert < ALERT_COOLDOWN_MS) return;
    await env.CONTROL.put("stale_alert_ts", String(Date.now()));
    const hours = Math.round(age / 3600000);
    await tg(env, "sendMessage", {
      chat_id: OWNER_CHAT,
      parse_mode: "HTML",
      text:
        `⚠️ <b>Часовой бот молчит ~${hours} ч</b>\n\n` +
        "GitHub Actions пропускает запуски по расписанию (у бесплатных " +
        "репозиториев такое бывает). Открытые позиции без присмотра!\n\n" +
        "Запустить вручную: репозиторий → Actions → Paper trading bot → Run workflow\n" +
        "https://github.com/vexenali-prog/-/actions/workflows/paper-bot.yml",
    });
  } catch (e) {
    console.log("watchdog error:", e.stack || e.message);
  }
}

async function handleUpdate(update, env) {
  if (update.callback_query) {
    const cq = update.callback_query;
    let route = cq.data;
    if (route === "tgl") {
      // тумблер паузы: только владелец
      if (cq.message.chat.id === OWNER_CHAT) {
        const paused = (await env.CONTROL.get("paused")) === "1";
        await env.CONTROL.put("paused", paused ? "0" : "1");
      }
      route = "menu";
    }
    const view = await render(route, env);
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
    "/signals": "sg", "/stats": "st", "/help": "hp", "/market": "mk",
  }[cmd] || "menu";
  const view = await render(route, env);
  await tg(env, "sendMessage", {
    chat_id: msg.chat.id,
    text: view.text,
    parse_mode: "HTML",
    reply_markup: view.keyboard,
  });
}

async function render(route, env) {
  const [page, arg] = route.split(":");
  switch (page) {
    case "pf": return viewPortfolio();
    case "px": return arg ? viewCoin(arg) : viewPrices();
    case "sg": return viewSignals();
    case "st": return viewStats();
    case "tr": return viewTrades(parseInt(arg || "0", 10));
    case "mk": return viewMarket();
    case "hp": return viewHelp(arg);
    default: return viewMenu(env);
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

async function viewMenu(env) {
  const paused = env ? (await env.CONTROL.get("paused")) === "1" : false;
  return {
    text:
      "👋 <b>Привет! Я Штурман — твой торговый бот.</b>\n\n" +
      "Слежу за 13 криптовалютами круглосуточно, торгую 6 крупнейшими " +
      "по трендовой стратегии, проверенной на 2 годах истории.\n\n" +
      "🧪 Сейчас — <b>тренировочный режим</b>: деньги виртуальные, цены " +
      "настоящие. Докажу прибыльность — обсудим реальный счёт.\n\n" +
      (paused
        ? "⏸ <b>Покупки на паузе</b> — бот только сопровождает открытые позиции.\n\n"
        : "") +
      "Что показать?",
    keyboard: kb([
      [["💼 Портфель", "pf"], ["📈 Цены", "px"]],
      [["🧭 Сигналы", "sg"], ["🌡 Рынок", "mk"]],
      [["📊 Статистика", "st"], ["🧾 Сделки", "tr:0"]],
      [[paused ? "▶️ Возобновить покупки" : "⏸ Пауза покупок", "tgl"], ["ℹ️ Помощь", "hp"]],
    ]),
  };
}

async function viewMarket() {
  const [tickers, fng] = await Promise.all([
    getTickers(),
    fetch("https://api.alternative.me/fng/?limit=2", { cf: { cacheTtl: 600 } })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  ]);
  let mood = "нет данных";
  if (fng?.data?.length) {
    const v = parseInt(fng.data[0].value, 10);
    const prev = fng.data[1] ? parseInt(fng.data[1].value, 10) : v;
    const label =
      v <= 25 ? "😱 сильный страх" :
      v <= 45 ? "😨 страх" :
      v <= 55 ? "😐 нейтрально" :
      v <= 75 ? "🙂 жадность" : "🤑 сильная жадность";
    mood = `${label} — ${v}/100 (вчера ${prev})`;
  }
  const moves = SYMBOLS
    .map((sym) => {
      const t = tickers[sym];
      return t ? { sym, ch: (t.last / t.open24h - 1) * 100 } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.ch - a.ch);
  const row = (m) => `${m.ch >= 0 ? "🟢" : "🔴"} ${coin(m.sym)} ${signed(m.ch)}%`;
  return {
    text:
      "🌡 <b>Рынок сейчас</b>\n\n" +
      `Индекс страха и жадности: <b>${mood}</b>\n` +
      "<i>Страх — все продают (часто дно), жадность — все скупают (часто пик).</i>\n\n" +
      "<b>Растут за 24ч:</b>\n" + moves.slice(0, 3).map(row).join("\n") + "\n\n" +
      "<b>Падают за 24ч:</b>\n" + moves.slice(-3).reverse().map(row).join("\n"),
    keyboard: kb([[["🔄 Обновить", "mk"], ["🧭 Сигналы", "sg"]], [["← Меню", "menu"]]]),
  };
}

async function viewPortfolio() {
  const [state, tickers] = await Promise.all([getState(), getTickers()]);
  let held = 0;
  const lines = [];
  for (const [sym, pos] of Object.entries(state.positions || {})) {
    const price = tickers[sym]?.last ?? pos.entry;
    const value = pos.qty * price;
    const cost = pos.qty * pos.entry * 1.001; // потрачено с комиссией
    held += value;
    lines.push(
      `${value >= cost ? "🟢" : "🔴"} <b>${coin(sym)}</b> — ` +
      `<b>${signed((value / cost - 1) * 100)}%</b> (${signed2(value - cost)} $)\n` +
      `   куплено ${when(pos.opened_ts)} на ${money(cost)} $, сейчас ${money(value)} $\n` +
      `   ${qty(pos.qty)} монет · цена ${money(pos.entry)} → ${money(price)} $`
    );
  }
  const equity = state.cash + held;
  const total = (equity / START_CASH - 1) * 100;
  return {
    text:
      "💼 <b>Портфель</b> <i>(виртуальный)</i>\n\n" +
      `Всего: <b>${money(equity)} $</b> (${signed(total)}% от старта, ${signed2(equity - START_CASH)} $)\n` +
      `Свободно: ${money(state.cash)} $ · в монетах: ${money(held)} $\n\n` +
      (lines.length ? lines.join("\n\n") : "Открытых позиций нет — сидим в кэше и ждём тренд.") +
      "\n\n<i>Цены — прямо сейчас с биржи. Время — по Баку.</i>",
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

// Вторая биржа для сверки цены: Bybit, а если он недоступен из этого
// дата-центра (гео-блок) — Kraken. Имена пар у Kraken свои.
const KRAKEN_PAIRS = {
  "BTC-USDT": "XBTUSDT", "DOGE-USDT": "XDGUSDT", "TRX-USDT": "TRXUSD",
  "ETC-USDT": "ETCUSD",
};

async function secondOpinion(sym) {
  const bybit = await fetch(
    "https://api.bybit.com/v5/market/tickers?category=spot&symbol=" + sym.replace("-", ""),
    { cf: { cacheTtl: 3 } }
  )
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => parseFloat(d?.result?.list?.[0]?.lastPrice) || null)
    .catch(() => null);
  if (bybit) return { name: "Bybit", price: bybit };
  const pair = KRAKEN_PAIRS[sym] || sym.replace("-", "");
  const kraken = await fetch("https://api.kraken.com/0/public/Ticker?pair=" + pair, {
    cf: { cacheTtl: 3 },
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      const res = d?.result || {};
      const first = res[Object.keys(res)[0]];
      return parseFloat(first?.c?.[0]) || null;
    })
    .catch(() => null);
  return kraken ? { name: "Kraken", price: kraken } : null;
}

async function viewCoin(sym) {
  const [state, tickers, second] = await Promise.all([
    getState(),
    getTickers(),
    secondOpinion(sym),
  ]);
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
      (second
        ? `Сверка бирж: OKX ${money(t.last)} $ · ${second.name} ${money(second.price)} $ ` +
          `(разница ${(Math.abs(t.last - second.price) / t.last * 100).toFixed(2)}%)\n`
        : "") +
      `Диапазон 24ч: ${money(t.low24h)} — ${money(t.high24h)} $\n` +
      `Оборот 24ч: ${short(t.volUsd)} $\n` +
      (trend ? `Тренд: ${trend}\n` : "") +
      (pos
        ? `\n🟢 <b>В портфеле</b>: куплено ${when(pos.opened_ts)} — ` +
          `${qty(pos.qty)} монет на ${money(pos.qty * pos.entry * 1.001)} $\n` +
          `Сейчас это ${money(pos.qty * t.last)} $ (<b>${signed((t.last / pos.entry / 1.001 - 1) * 100)}%</b>)`
        : TRADED.includes(sym)
          ? "\n⚪ Не в портфеле"
          : "\n👁 Наблюдение: показываю, но не торгую") +
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
    if (!TRADED.includes(sym)) {
      return `👁 <b>${coin(sym)}</b> — наблюдаю (${signed(dist)}% к тренду), не торгуется`;
    }
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
  const realized = trades.reduce((s, t) => s + t.pnl, 0);
  const best = trades.length ? Math.max(...trades.map((t) => t.pnl_pct)) : 0;
  const worst = trades.length ? Math.min(...trades.map((t) => t.pnl_pct)) : 0;
  const started = state.equity_history?.[0]?.ts;
  const days = started ? Math.max(1, Math.round((Date.now() - started) / 86400000)) : 0;
  return {
    text:
      "📊 <b>Статистика</b> <i>(виртуальный счёт)</i>\n\n" +
      `Начали с: ${money(START_CASH)} $ (${days} дн. назад)\n` +
      `Сейчас: <b>${money(equity)} $</b>\n` +
      `Итог: <b>${signed((equity / START_CASH - 1) * 100)}%</b> (${signed2(equity - START_CASH)} $)\n\n` +
      `Сделок закрыто: ${trades.length}\n` +
      (trades.length
        ? `Заработано на закрытых: ${signed2(realized)} $\n` +
          `Прибыльных: ${wins.length} из ${trades.length} (${Math.round((wins.length / trades.length) * 100)}%)\n` +
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
    const invested = t.qty * t.entry * 1.001;
    return (
      `${t.pnl > 0 ? "✅" : "🔴"} <b>${coin(t.symbol)}</b> · <b>${signed(t.pnl_pct)}%</b> (${signed2(t.pnl)} $)\n` +
      `   купил ${when(t.opened_ts)} по ${money(t.entry)} $ на ${money(invested)} $\n` +
      `   продал ${when(t.closed_ts)} по ${money(t.exit)} $ — ${t.reason}`
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
        "Торгую 6 крупнейших монет: BTC, ETH, SOL, XRP, DOGE, TRX. Ещё 7 " +
        "наблюдаю, но не торгую — на истории они проигрывают.\n\n" +
        "🛡 <b>Защита денег</b>:\n" +
        "• стоп-лосс — выход при −10% от входа\n" +
        "• трейлинг-стоп — выход при −20% от максимума\n" +
        "• BTC-фильтр — не покупаю, пока биткоин ниже своего тренда\n\n" +
        "Проверка на 2 годах истории (бычий + медвежий рынок): " +
        "<b>+83.5%</b> против +25% у «просто держать те же монеты». " +
        "Максимальная просадка была ~27% — к такому надо быть готовым.\n\n" +
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
      "Я торгую <b>виртуальной</b> $1000 по настоящим ценам. Торгую 6 " +
      "крупнейших монет (BTC, ETH, SOL, XRP, DOGE, TRX), ещё 7 показываю " +
      "в ценах и сигналах, но не торгую.\n\n" +
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

function signed2(x) {
  return (x >= 0 ? "+" : "") + x.toFixed(2);
}

function qty(q) {
  return q.toLocaleString("ru-RU", { maximumSignificantDigits: 6 });
}

// «10 июля, 21:03» по бакинскому времени
function when(ts) {
  const p = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Asia/Baku", day: "numeric", month: "long",
    hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(ts));
  const g = (t) => p.find((x) => x.type === t)?.value ?? "";
  return `${g("day")} ${g("month")}, ${g("hour")}:${g("minute")}`;
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
