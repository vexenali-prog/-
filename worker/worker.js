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
const STOP = 0.10;   // те же параметры, что в bot/strategy.py
const TRAIL = 0.20;

// Торгуемые монеты (топ по капитализации) и полный список наблюдения.
const TRADED = ["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "DOGE-USDT", "TRX-USDT"];
const SYMBOLS = [
  ...TRADED,
  "ADA-USDT", "LINK-USDT", "AVAX-USDT", "DOT-USDT", "LTC-USDT",
  "BCH-USDT", "ETC-USDT", "GRAM-USDT",
];

// Чат владельца: только он может ставить бота на паузу.
const OWNER_CHAT = 5480566532;

export default {
  async fetch(request, env) {
    if (request.method === "GET" && new URL(request.url).pathname === "/control") {
      const paused = (await env.CONTROL.get("paused")) === "1";
      return Response.json({ paused });
    }
    if (request.method === "GET") {
      const path = new URL(request.url).pathname;
      if (path === "/" || path === "/index.html") {
        return new Response(await dashboardHtml(env), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "public, max-age=60",
          },
        });
      }
      return new Response("ok");
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

  // Крон Cloudflare (каждые 5 минут): проверка ценовых алертов
  // и сторож часового бота в GitHub Actions.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([watchdog(env), checkAlerts(env)]));
  },
};

// Перезапускаем бота уже после ~80 минут тишины (один пропущенный час),
// владельца тревожим только если тишина затянулась на 3.5 часа.
const STALE_AFTER_MS = 80 * 60 * 1000;
const ALERT_AFTER_MS = 3.5 * 3600 * 1000;
const ALERT_COOLDOWN_MS = 6 * 3600 * 1000;
const DISPATCH_COOLDOWN_MS = 25 * 60 * 1000;

// Сторож: GitHub Actions может тихо пропускать запуски по расписанию.
// Если есть GH_TOKEN — сторож сам перезапускает workflow; сообщение
// владельцу шлётся только когда перезапуск невозможен или не помогает.
async function watchdog(env) {
  try {
    const state = await getState();
    // страховочная копия для дашборда: если GitHub не откроется из
    // какого-то региона, страница возьмёт данные отсюда
    await env.CONTROL.put("state_cache", JSON.stringify(state));
    const points = state.equity_history || [];
    const lastTs = points.length ? points[points.length - 1].ts : 0;
    const age = Date.now() - lastTs;
    if (age < STALE_AFTER_MS) return;

    if (env.GH_TOKEN) {
      const lastDispatch = parseInt((await env.CONTROL.get("dispatch_ts")) || "0", 10);
      if (Date.now() - lastDispatch > DISPATCH_COOLDOWN_MS) {
        const r = await fetch(
          "https://api.github.com/repos/vexenali-prog/-/actions/workflows/paper-bot.yml/dispatches",
          {
            method: "POST",
            headers: {
              Authorization: "Bearer " + env.GH_TOKEN,
              Accept: "application/vnd.github+json",
              "User-Agent": "shturman-bot-watchdog",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ ref: "main" }),
          }
        );
        if (r.status === 204) {
          await env.CONTROL.put("dispatch_ts", String(Date.now()));
          if (age < ALERT_AFTER_MS) return; // перезапустили сами, владельца не беспокоим
        } else {
          console.log("dispatch failed:", r.status, await r.text());
        }
      } else if (age < ALERT_AFTER_MS) {
        return; // недавно перезапускали — ждём результата
      }
    }
    if (age < ALERT_AFTER_MS) return;

    const lastAlert = parseInt((await env.CONTROL.get("stale_alert_ts")) || "0", 10);
    if (Date.now() - lastAlert < ALERT_COOLDOWN_MS) return;
    await env.CONTROL.put("stale_alert_ts", String(Date.now()));
    const hours = Math.round(age / 3600000);
    await tg(env, "sendMessage", {
      chat_id: OWNER_CHAT,
      parse_mode: "HTML",
      text:
        `⚠️ <b>Часовой бот молчит ~${hours} ч</b>` +
        (env.GH_TOKEN ? " (автоперезапуск не помог)" : "") +
        "\n\nGitHub Actions пропускает запуски по расписанию. " +
        "Открытые позиции без присмотра!\n\n" +
        "Запустить вручную: Actions → Paper trading bot → Run workflow\n" +
        "https://github.com/vexenali-prog/-/actions/workflows/paper-bot.yml",
    });
  } catch (e) {
    console.log("watchdog error:", e.stack || e.message);
  }
}

async function checkAlerts(env) {
  try {
    const alerts = await getAlerts(env);
    if (!alerts.length) return;
    const tickers = await getTickers();
    const keep = [];
    for (const a of alerts) {
      const p = tickers[a.sym]?.last;
      const hit = p && (a.dir === "above" ? p >= a.target : p <= a.target);
      if (!hit) {
        keep.push(a);
        continue;
      }
      await tg(env, "sendMessage", {
        chat_id: OWNER_CHAT,
        parse_mode: "HTML",
        text:
          `🔔 <b>${coin(a.sym)}</b> ${a.dir === "above" ? "поднялся выше" : "опустился ниже"} ` +
          `<b>${money(a.target)} $</b>\nСейчас: ${money(p)} $`,
      });
    }
    if (keep.length !== alerts.length) {
      await env.CONTROL.put("alerts", JSON.stringify(keep));
    }
  } catch (e) {
    console.log("checkAlerts error:", e.stack || e.message);
  }
}

function errorView(route) {
  return {
    text:
      "⚠️ <b>Данные временно недоступны</b>\n\n" +
      "Не дозвонился до источника данных — такое бывает на несколько " +
      "секунд. Торговля при этом идёт как обычно.\n\nНажми «Ещё раз».",
    keyboard: kb([[["🔄 Ещё раз", route], ["← Меню", "menu"]]]),
  };
}

async function handleUpdate(update, env) {
  if (update.callback_query) {
    const cq = update.callback_query;
    let route = cq.data;
    // менять алерты может только владелец, остальным — просто список
    if (/^al:(add|del|new)/.test(route) && cq.message.chat.id !== OWNER_CHAT) {
      route = "al";
    }
    if (route === "tgl") {
      // тумблер паузы: только владелец
      if (cq.message.chat.id === OWNER_CHAT) {
        const paused = (await env.CONTROL.get("paused")) === "1";
        await env.CONTROL.put("paused", paused ? "0" : "1");
      }
      route = "menu";
    }
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
    let view;
    try {
      view = await render(route, env);
    } catch (e) {
      console.log("render error:", route, e.stack || e.message);
      view = errorView(route);
    }
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

  // текстовая команда «алерт BTC 70000» (только владелец)
  const m = msg.text.match(/^\/?(?:алерт|alert)\s+([a-zа-яё]+)\s+([\d\s.,]+)$/i);
  if (m && msg.chat.id === OWNER_CHAT) {
    const sym = m[1].toUpperCase() + "-USDT";
    const target = parseFloat(m[2].replace(/\s/g, "").replace(",", "."));
    let text;
    if (!SYMBOLS.includes(sym)) {
      text = `Не знаю монету «${m[1]}». Я слежу за: ${SYMBOLS.map(coin).join(", ")}.`;
    } else if (!target || target <= 0) {
      text = "Не понял цену. Пример: <code>алерт BTC 70000</code>";
    } else {
      const price = (await getTickersSafe())[sym]?.last;
      const dir = target >= price ? "above" : "below";
      const alerts = await getAlerts(env);
      alerts.push({ sym, target, dir });
      await env.CONTROL.put("alerts", JSON.stringify(alerts.slice(0, 20)));
      text =
        `🔔 Готово! Сообщу, когда <b>${coin(sym)}</b> ` +
        `${dir === "above" ? "поднимется выше" : "опустится ниже"} ` +
        `<b>${money(target)} $</b> (сейчас ${money(price)} $).`;
    }
    await tg(env, "sendMessage", { chat_id: msg.chat.id, text, parse_mode: "HTML" });
    return;
  }

  const cmd = msg.text.split(/[@\s]/)[0];
  const route = {
    "/start": "menu", "/portfolio": "pf", "/prices": "px",
    "/signals": "sg", "/stats": "st", "/help": "hp", "/market": "mk",
    "/alerts": "al",
  }[cmd] || "menu";
  let view;
  try {
    view = await render(route, env);
  } catch (e) {
    console.log("render error:", route, e.stack || e.message);
    view = errorView(route);
  }
  await tg(env, "sendMessage", {
    chat_id: msg.chat.id,
    text: view.text,
    parse_mode: "HTML",
    reply_markup: view.keyboard,
  });
}

async function render(route, env) {
  const [page, ...rest] = route.split(":");
  const arg = rest[0];
  switch (page) {
    case "pf": return viewPortfolio(env);
    case "px": return arg ? viewCoin(env, arg) : viewPrices();
    case "sg": return viewSignals(env);
    case "st": return viewStats(env);
    case "tr": return viewTrades(env, parseInt(arg || "0", 10));
    case "mk": return viewMarket();
    case "al": return viewAlerts(env, rest);
    case "dc": return viewDecisions(env);
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

// Состояние с запасным источником: если GitHub не отвечает из этого
// дата-центра, берём копию из KV (сторож обновляет её каждые 5 минут).
async function getStateSafe(env) {
  try {
    return await getState();
  } catch (e) {
    const cached = env && (await env.CONTROL.get("state_cache"));
    if (cached) return JSON.parse(cached);
    throw e;
  }
}

// Живые цены — украшение, а не необходимость: при сбое вернём пусто,
// экраны покажут последние известные цены из часового расчёта.
async function getTickersSafe() {
  try {
    return await getTickers();
  } catch {
    return {};
  }
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
      "💼 <b>VEXEN CAPITAL</b>\n" +
      "<i>Алгоритмическая торговая система</i>\n\n" +
      "Торговля 6 крупнейшими криптоактивами по трендовой модели, " +
      "проверенной на двух годах исторических данных. Управление риском: " +
      "стоп-лосс, трейлинг-стоп, фильтр рыночного режима.\n\n" +
      "Режим: <b>тестовый</b> — виртуальный капитал, реальные рыночные цены.\n\n" +
      (paused
        ? "⏸ <b>Покупки приостановлены</b> — система сопровождает только открытые позиции.\n\n"
        : "") +
      "Выберите раздел:",
    keyboard: kb([
      [["💼 Портфель", "pf"], ["📈 Цены", "px"]],
      [["🧭 Сигналы", "sg"], ["🌡 Рынок", "mk"]],
      [["📊 Статистика", "st"], ["🧾 Сделки", "tr:0"]],
      [["🔔 Алерты", "al"], [paused ? "▶️ Возобновить" : "⏸ Пауза", "tgl"]],
      [["🧠 Решения", "dc"], ["ℹ️ Помощь", "hp"]],
    ]),
  };
}

// ---------- ценовые алерты (хранятся в KV, проверяются кроном) ----------

async function getAlerts(env) {
  try {
    return JSON.parse((await env.CONTROL.get("alerts")) || "[]");
  } catch {
    return [];
  }
}

async function viewAlerts(env, args) {
  const [action, p1, p2] = args || [];
  let alerts = await getAlerts(env);

  if (action === "new" && p1) {
    const tickers = await getTickersSafe();
    const price = tickers[p1]?.last;
    if (!price) return errorView("al:new:" + p1);
    const presets = [-10, -5, -3, 3, 5, 10];
    return {
      text:
        `🔔 <b>Алерт по ${coin(p1)}</b>\n\n` +
        `Сейчас: <b>${money(price)} $</b>\n\n` +
        "О какой цене сообщить? Выбери уровень от текущей цены — " +
        "или напиши сообщением свою, например:\n" +
        `<code>алерт ${coin(p1)} ${money(price * 1.07).replace(/ /g, " ")}</code>`,
      keyboard: kb([
        presets.slice(0, 3).map((p) => [`${p}%`, `al:add:${p1}:${p}`]),
        presets.slice(3).map((p) => [`+${p}%`, `al:add:${p1}:${p}`]),
        [["← Монета", "px:" + p1], ["← Алерты", "al"]],
      ]),
    };
  }

  if (action === "add" && p1 && p2) {
    const tickers = await getTickersSafe();
    const price = tickers[p1]?.last;
    if (price) {
      const pct = parseFloat(p2);
      const target = price * (1 + pct / 100);
      alerts.push({ sym: p1, target, dir: pct >= 0 ? "above" : "below" });
      await env.CONTROL.put("alerts", JSON.stringify(alerts.slice(0, 20)));
    }
  }

  if (action === "del" && p1 !== undefined) {
    alerts.splice(parseInt(p1, 10), 1);
    await env.CONTROL.put("alerts", JSON.stringify(alerts));
  }

  const tickers = alerts.length ? await getTickersSafe() : {};
  const lines = alerts.map((a, i) => {
    const now = tickers[a.sym]?.last;
    return (
      `${i + 1}. <b>${coin(a.sym)}</b> ${a.dir === "above" ? "выше" : "ниже"} ` +
      `${money(a.target)} $` + (now ? ` <i>(сейчас ${money(now)} $)</i>` : "")
    );
  });
  const delRow = alerts.map((a, i) => [`❌ ${i + 1}`, `al:del:${i}`]);
  return {
    text:
      "🔔 <b>Ценовые алерты</b>\n\n" +
      (lines.length
        ? lines.join("\n") + "\n\n<i>Проверяю каждые 5 минут, сообщу и удалю сработавший.</i>"
        : "Пока нет ни одного. Открой монету в «Ценах» и нажми «🔔 Алерт», " +
          "или напиши сообщением, например: <code>алерт BTC 70000</code>"),
    keyboard: kb([
      ...(delRow.length ? [delRow] : []),
      [["📈 Цены", "px"], ["← Меню", "menu"]],
    ]),
  };
}

// «Почему система сейчас делает именно это» — по каждой торгуемой монете.
async function viewDecisions(env) {
  const [state, tickers, paused] = await Promise.all([
    getStateSafe(env),
    getTickersSafe(),
    env ? env.CONTROL.get("paused").then((v) => v === "1") : false,
  ]);
  const ind = state.indicators || {};
  const btc = ind["BTC-USDT"];
  const btcLive = tickers["BTC-USDT"]?.last ?? btc?.close;
  const btcOk = btc && btcLive ? btcLive > btc.ema : true;

  const head = [];
  if (paused) head.push("⏸ Покупки приостановлены вручную (кнопка «Пауза»).");
  head.push(
    btcOk
      ? "🔓 Рыночный фильтр: BTC выше тренда — новые покупки разрешены."
      : "🔒 Рыночный фильтр: BTC ниже тренда — новые покупки запрещены, только сопровождение позиций."
  );

  const lines = TRADED.map((sym) => {
    const i = ind[sym];
    const t = tickers[sym] || (i && { last: i.close });
    const pos = (state.positions || {})[sym];
    if (!t || !i) return `• <b>${coin(sym)}</b> — жду первого расчёта`;

    if (pos) {
      const high = pos.high || pos.entry;
      const exitTrend = i.ema * (1 - BAND);
      const exitStop = pos.entry * (1 - STOP);
      const exitTrail = high * (1 - TRAIL);
      const exits = [
        [exitTrend, "тренд"],
        [exitStop, "стоп"],
        [exitTrail, "трейлинг"],
      ].sort((a, b) => b[0] - a[0]);
      const [lvl, why] = exits[0];
      return (
        `🟢 <b>${coin(sym)}</b> — в портфеле (${signed((t.last / pos.entry - 1) * 100)}%)\n` +
        `   продажа, если цена закрепится ниже ${money(lvl)} $ (${why}); ` +
        `запас ${signed((t.last / lvl - 1) * 100)}%`
      );
    }
    if ((state.need_reset || {})[sym]) {
      return (
        `🔄 <b>${coin(sym)}</b> — вышли по стопу, сигнал «перезаряжается»:\n` +
        `   жду отката ниже ${money(i.ema * (1 + BAND))} $, потом можно заново`
      );
    }
    const trigger = i.ema * (1 + BAND);
    const gap = (trigger / t.last - 1) * 100;
    if (gap <= 0) {
      return (
        `🟡 <b>${coin(sym)}</b> — цена уже выше триггера ${money(trigger)} $:\n` +
        `   покупка на ближайшем закрытии часа` +
        (btcOk && !paused ? "" : " (как только снимутся ограничения выше)")
      );
    }
    return (
      `⚪ <b>${coin(sym)}</b> — вне рынка\n` +
      `   куплю выше ${money(trigger)} $, до триггера ${signed(gap)}%`
    );
  });

  return {
    text:
      "🧠 <b>Дневник решений</b>\n\n" +
      head.join("\n") + "\n\n" +
      lines.join("\n") +
      "\n\n<i>Решения принимаются раз в час по закрытой свече. " +
      "Уровни пересчитываются каждый час.</i>",
    keyboard: kb([[["🔄 Обновить", "dc"], ["💼 Портфель", "pf"]], [["← Меню", "menu"]]]),
  };
}

async function viewMarket() {
  const [tickers, fng] = await Promise.all([
    getTickersSafe(),
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

async function viewPortfolio(env) {
  const [state, tickers] = await Promise.all([getStateSafe(env), getTickersSafe()]);
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

async function viewCoin(env, sym) {
  const [state, tickers, second] = await Promise.all([
    getStateSafe(env),
    getTickersSafe(),
    secondOpinion(sym),
  ]);
  const ind0 = (state.indicators || {})[sym];
  // без живой цены показываем последнюю известную из часового расчёта
  const t = tickers[sym] ||
    (ind0 && { last: ind0.close, open24h: ind0.close, high24h: ind0.close,
               low24h: ind0.close, volUsd: 0 });
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
    keyboard: kb([
      [["🔄 Обновить", "px:" + sym], ["🔔 Алерт", "al:new:" + sym]],
      [["← Цены", "px"], ["← Меню", "menu"]],
    ]),
  };
}

async function viewSignals(env) {
  const [state, tickers] = await Promise.all([getStateSafe(env), getTickersSafe()]);
  const lines = SYMBOLS.map((sym) => {
    const ind = (state.indicators || {})[sym];
    const t = tickers[sym] || (ind && { last: ind.close });
    const pos = (state.positions || {})[sym];
    if (!t || !ind) {
      return `👁 <b>${coin(sym)}</b> — новая монета, накапливаю историю тренда (~30 дней)`;
    }
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

async function viewStats(env) {
  const [state, tickers] = await Promise.all([getStateSafe(env), getTickersSafe()]);
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

async function viewTrades(env, page) {
  const state = await getStateSafe(env);
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
  if (arg === "real") {
    return {
      text:
        "🚀 <b>Чек-лист перехода на реальный счёт</b>\n\n" +
        "Когда paper-режим отработает месяц и результат будет на уровне " +
        "или лучше «купи и держи» — вот безопасный путь:\n\n" +
        "1️⃣ <b>Сумма</b> — начать со 100–200 $, которые не страшно потерять " +
        "целиком. Не больше, какими бы красивыми ни были цифры теста.\n\n" +
        "2️⃣ <b>API-ключи биржи</b> — с правами только «чтение + торговля». " +
        "Право «вывод средств» НЕ давать никому и никогда, включая бота.\n\n" +
        "3️⃣ <b>Лимит потерь</b> — заранее решить: минус 25% от стартовой " +
        "суммы — стоп, разбор полётов, а не «сейчас отыграется».\n\n" +
        "4️⃣ <b>Месяц параллельно</b> — реальный счёт торгует рядом с " +
        "виртуальным: сверяем, совпадают ли сделки и цены исполнения.\n\n" +
        "5️⃣ <b>Только спот, без плеча</b> — маржа и фьючерсы умеют " +
        "обнулить счёт быстрее, чем сработает любой стоп.\n\n" +
        "⚠️ И главное: даже после всех проверок прибыль не гарантирована. " +
        "Торгуй только тем, что готов потерять.",
      keyboard: kb([[["📖 Стратегия", "hp:strategy"], ["← Помощь", "hp"]], [["← Меню", "menu"]]]),
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
      "ℹ️ <b>О системе</b>\n\n" +
      "Vexen Capital управляет тестовым портфелем в 1 000 $ (виртуальный " +
      "капитал, реальные рыночные цены). Торгуются 6 крупнейших активов: " +
      "BTC, ETH, SOL, XRP, DOGE, TRX; ещё 7 находятся под наблюдением.\n\n" +
      "Цель тестового периода — подтвердить результаты стратегии на живом " +
      "рынке за 3–4 недели. При положительном результате возможен переход " +
      "на реальный счёт (см. чек-лист). Риск тестового периода — ноль.\n\n" +
      "Подробнее:",
    keyboard: kb([
      [["📖 Стратегия", "hp:strategy"], ["⏰ Расписание", "hp:schedule"]],
      [["🚀 Реальный счёт", "hp:real"], ["← Меню", "menu"]],
    ]),
  };
}

// ---------- веб-дашборд (GET /) ----------

function svgChart(points, w, h) {
  if (points.length < 2) return "";
  const vals = points.map((p) => p.equity);
  const min = Math.min(...vals, START_CASH);
  const max = Math.max(...vals, START_CASH);
  const pad = (max - min) * 0.1 || 1;
  const y = (v) => h - ((v - min + pad) / (max - min + 2 * pad)) * h;
  const x = (i) => (i / (points.length - 1)) * w;
  const line = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const up = vals[vals.length - 1] >= START_CASH;
  const color = up ? "#22c55e" : "#ef4444";
  const yStart = y(START_CASH).toFixed(1);
  return (
    `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">` +
    `<line x1="0" y1="${yStart}" x2="${w}" y2="${yStart}" stroke="#3b4658" stroke-dasharray="6 6" stroke-width="1"/>` +
    `<polyline points="${line}" fill="none" stroke="${color}" stroke-width="2.5" ` +
    `stroke-linejoin="round" stroke-linecap="round"/></svg>`
  );
}

async function dashboardHtml(env) {
  // Состояние: GitHub, при сбое — страховочная копия из KV (её каждые
  // 5 минут обновляет сторож). Живые цены — необязательное украшение.
  let state = null, tickers = {};
  try {
    state = await getState();
  } catch {
    try {
      const cached = env && (await env.CONTROL.get("state_cache"));
      if (cached) state = JSON.parse(cached);
    } catch {}
  }
  try {
    tickers = await getTickers();
  } catch {}

  if (!state) {
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vexen Capital</title><style>:root{color-scheme:dark}
body{background:#0a1220;color:#edf0f5;font:16px/1.6 -apple-system,'Segoe UI',Roboto,sans-serif;
display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center}
h1{font-size:24px;letter-spacing:3px}h1 span{color:#c9a227}p{color:#8b96a8}</style></head>
<body><div><h1>VEXEN <span>CAPITAL</span></h1>
<p>Данные временно недоступны — обнови страницу через минуту.<br>Торговля при этом идёт как обычно.</p>
</div></body></html>`;
  }

  const positions = Object.entries(state.positions || {});
  let held = 0;
  const rows = positions.map(([sym, pos]) => {
    const price = tickers[sym]?.last ?? pos.entry;
    const value = pos.qty * price;
    const cost = pos.qty * pos.entry * 1.001;
    held += value;
    const pnl = (value / cost - 1) * 100;
    return (
      `<tr><td>${coin(sym)}</td><td>${when(pos.opened_ts)}</td>` +
      `<td>${money(cost)} $</td><td>${money(value)} $</td>` +
      `<td class="${pnl >= 0 ? "up" : "down"}">${signed(pnl)}%</td></tr>`
    );
  });
  const equity = (state.cash || 0) + held;
  const total = (equity / START_CASH - 1) * 100;
  const trades = state.trades || [];
  const wins = trades.filter((t) => t.pnl > 0).length;
  const hist = state.equity_history || [];
  const upd = hist.length ? when(hist[hist.length - 1].ts) : "—";

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vexen Capital</title><style>
:root{color-scheme:dark}
*{margin:0;box-sizing:border-box}
body{background:#0a1220;color:#edf0f5;font:16px/1.55 -apple-system,'Segoe UI',Roboto,sans-serif;padding:24px 16px 48px;max-width:760px;margin:0 auto}
h1{font-size:26px;letter-spacing:3px;margin-top:8px}
h1 span{color:#c9a227}
.sub{color:#8b96a8;font-size:13px;letter-spacing:1px;text-transform:uppercase;margin-bottom:28px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:24px}
.card{background:#111b2e;border:1px solid #1e2a40;border-radius:12px;padding:14px 16px}
.card .l{color:#8b96a8;font-size:12px;text-transform:uppercase;letter-spacing:1px}
.card .v{font-size:22px;font-weight:600;margin-top:4px}
.up{color:#22c55e}.down{color:#ef4444}
.chart{background:#111b2e;border:1px solid #1e2a40;border-radius:12px;padding:16px;margin-bottom:24px}
.chart svg{width:100%;height:180px;display:block}
table{width:100%;border-collapse:collapse;background:#111b2e;border:1px solid #1e2a40;border-radius:12px;overflow:hidden}
th,td{padding:10px 12px;text-align:left;font-size:14px}
th{color:#8b96a8;font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #1e2a40}
tr+tr td{border-top:1px solid #17233a}
.note{color:#8b96a8;font-size:13px;margin-top:24px}
h2{font-size:15px;color:#8b96a8;text-transform:uppercase;letter-spacing:1px;margin:0 0 10px}
</style></head><body>
<h1>VEXEN <span>CAPITAL</span></h1>
<div class="sub">Алгоритмическая торговая система · тестовый режим</div>
<div class="cards">
<div class="card"><div class="l">Капитал</div><div class="v">${money(equity)} $</div></div>
<div class="card"><div class="l">Результат</div><div class="v ${total >= 0 ? "up" : "down"}">${signed(total)}%</div></div>
<div class="card"><div class="l">Свободно</div><div class="v">${money(state.cash || 0)} $</div></div>
<div class="card"><div class="l">Сделок закрыто</div><div class="v">${trades.length}${trades.length ? ` <small style="font-size:13px;color:#8b96a8">(${Math.round((wins / trades.length) * 100)}% в плюс)</small>` : ""}</div></div>
</div>
<div class="chart"><h2>Динамика капитала</h2>${svgChart(hist, 700, 180) || '<div class="note">Недостаточно данных для графика — история накапливается.</div>'}</div>
<h2>Открытые позиции</h2>
${rows.length
    ? `<table><tr><th>Актив</th><th>Открыта</th><th>Вложено</th><th>Сейчас</th><th>P&L</th></tr>${rows.join("")}</table>`
    : '<div class="note">Открытых позиций нет — капитал в резерве, система ждёт сигналов.</div>'}
<div class="note">Виртуальный капитал, реальные рыночные цены (OKX). Стратегия: следование за трендом
со стоп-лоссом, трейлинг-стопом и фильтром рыночного режима. Обновлено: ${upd} (Баку).
Время на странице — бакинское. Не является инвестиционной рекомендацией.</div>
</body></html>`;
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
  return ((x >= 0 ? "+" : "") + x.toFixed(1)).replace(".", ",");
}

function signed2(x) {
  const s = (x >= 0 ? "+" : "") + Math.abs(x).toLocaleString("ru-RU", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  return x < 0 ? s.replace("+", "−") : s;
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
