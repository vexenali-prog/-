// Телеграм-бот «Момент» v3.
// Формат «что делать»: вердикт, срок покупки, уровни продажи в рублях.
// Каждые ~30 минут (GitHub Actions): смена сигнала, резкие движения, команды,
// утренняя сводка с ИИ-разбором (bot/briefing.json), недельный отчёт.
// Секреты: TELEGRAM_TOKEN, TELEGRAM_CHAT_ID.

const fs = require('fs');
const path = require('path');

const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MANUAL = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
const STATE_FILE = path.join(__dirname, 'state.json');
const BRIEFING_FILE = path.join(__dirname, 'briefing.json');
const COINS = [
  { id: 'bitcoin', sym: 'BTC', name: 'Биткоин', emoji: '🟠' },
  { id: 'the-open-network', sym: 'TON', name: 'Тонкоин', emoji: '💎' },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'moment-bot' } });
      if (res.ok) return await res.json();
    } catch {}
    await sleep(2000 * (i + 1));
  }
  return null;
}

const avg = a => a.reduce((s, v) => s + v, 0) / a.length;
const fmtRub = v => Math.round(v).toLocaleString('ru-RU') + ' ₽';
const pct = v => (v >= 0 ? '+' : '') + v.toFixed(1) + '%';

// ---------- Индикаторы ----------
function rsi14(prices) {
  const p = prices.slice(-15);
  if (p.length < 15) return null;
  let g = 0, l = 0;
  for (let i = 1; i < p.length; i++) {
    const d = p[i] - p[i - 1];
    if (d >= 0) g += d; else l -= d;
  }
  if (g === 0 && l === 0) return 50;
  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
}

// Средний дневной размах (по ценам закрытия) — для целей продажи и защиты
function avgDailyMove(prices, period = 14) {
  const p = prices.slice(-(period + 1));
  let s = 0;
  for (let i = 1; i < p.length; i++) s += Math.abs(p[i] - p[i - 1]);
  return s / (p.length - 1);
}

function analyse(prices, fng) {
  const cur = prices.at(-1);
  const sma200 = avg(prices.slice(-200));
  const sma50 = avg(prices.slice(-50));
  const high = Math.max(...prices);
  const discount = (1 - cur / high) * 100;
  const d1 = (cur / prices.at(-2) - 1) * 100;
  const d7 = (cur / prices.at(-8) - 1) * 100;
  const d30 = prices.length > 31 ? (cur / prices.at(-31) - 1) * 100 : null;
  const month = prices.slice(-30);
  const corridor = { lo: Math.min(...month), hi: Math.max(...month) };
  const rsi = rsi14(prices);
  const move = avgDailyMove(prices);

  let verdict = 'wait', rub = 0;
  if (fng != null && fng <= 20 && discount >= 40) { verdict = 'strong'; rub = 1000; }
  else if (fng != null && fng <= 30 && cur < sma200) { verdict = 'buy'; rub = 500; }

  // цели для покупки: продажа части и уровень пересмотра.
  // На спокойном рынке дневной размах маленький — держим минимум +8% / −5%,
  // иначе цели получаются несерьёзными для покупки «на недели-месяцы»
  const movePct = move / cur * 100;
  const target = cur * (1 + Math.max(2.5 * movePct, 8) / 100);
  const floor = cur * (1 - Math.max(1.5 * movePct, 5) / 100);
  return { cur, sma200, sma50, discount, d1, d7, d30, corridor, rsi, move, target, floor, verdict, rub };
}

// На какой срок покупать — по состоянию трендов
function horizon(a) {
  if (a.cur > a.sma200 && a.cur > a.sma50) {
    return 'на 2–8 недель (годовой тренд поддерживает)';
  }
  if (a.d30 != null && a.d30 > 0) {
    return 'недели–месяцы (падение замедлилось, возможен разворот)';
  }
  return 'в долгую, на месяцы (тренд ещё вниз — берём маленькими порциями)';
}

// Почему «ждём» — одной фразой
function waitReason(a, fng) {
  const parts = [];
  if (fng != null && fng > 30) parts.push('страх отступил — скидки «за страх» больше нет');
  if (a.cur >= a.sma200) parts.push('цена выше средней за год — входить невыгодно');
  if (!parts.length) parts.push('условия на грани — лучше дождаться более явного момента');
  return parts.join('; ');
}

// Пора ли продавать (общий сигнал перегрева)
function sellSignal(a, fng) {
  return fng != null && fng >= 70 && a.cur > a.sma200 * 1.2;
}

// Проверка по истории: похожие условия за год -> что было через 30 дней
function evidence(prices, fngHist) {
  if (!fngHist || prices.length < 240) return null;
  const n = prices.length;
  const fngAt = i => {
    const j = fngHist.length - (n - i);
    return j >= 0 && j < fngHist.length ? fngHist[j] : null;
  };
  const prefix = [0];
  for (const p of prices) prefix.push(prefix.at(-1) + p);
  const sma200At = i => (prefix[i + 1] - prefix[i - 199]) / 200;
  let runMax = -Infinity;
  const rets = [];
  for (let i = 0; i < n; i++) {
    runMax = Math.max(runMax, prices[i]);
    if (i < 200 || i > n - 31) continue;
    const f = fngAt(i);
    if (f == null) continue;
    const disc = (1 - prices[i] / runMax) * 100;
    const isSignal = (f <= 20 && disc >= 40) || (f <= 30 && prices[i] < sma200At(i));
    if (isSignal) rets.push(prices[i + 30] / prices[i] - 1);
  }
  if (!rets.length) return { count: 0 };
  return {
    count: rets.length,
    wins: rets.filter(r => r > 0).length,
    avgRet: avg(rets) * 100,
  };
}

// ---------- Телеграм ----------
async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}
async function send(text) {
  const j = await tg('sendMessage', { chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true });
  if (!j.ok) throw new Error('Telegram: ' + JSON.stringify(j));
}

// ---------- Блоки сообщений ----------
const moodBar = f => '●'.repeat(Math.round(f / 10)) + '○'.repeat(10 - Math.round(f / 10));
const moodWord = f => f <= 25 ? 'страх: исторически неплохое время закупаться понемногу'
  : f <= 45 ? 'осторожность'
  : f < 60 ? 'нейтрально'
  : f < 75 ? 'оптимизм: с покупками аккуратнее'
  : 'жадность: время думать о продаже, не о покупке';

function actionBlock(coin, a, fng, ev, full) {
  const L = [];
  if (sellSignal(a, fng)) {
    L.push(`${coin.emoji} <b>${coin.name} — ПРОДАТЬ ЧАСТЬ</b>`);
    L.push(`Рынок перегрет (жадность ${fng}/100, цена сильно выше средней за год) — разумно зафиксировать 25–30% позиции, если она в плюсе.`);
  } else if (a.verdict === 'strong' || a.verdict === 'buy') {
    L.push(`${coin.emoji} <b>${coin.name} — ${a.verdict === 'strong' ? 'СИЛЬНЫЙ СИГНАЛ: купить' : 'ПОКУПАТЬ'} на ${fmtRub(a.rub)}</b>`);
    L.push(`Цена: ${fmtRub(a.cur)} · скидка ${a.discount.toFixed(0)}% от максимума года`);
    L.push(`⏳ Срок: ${horizon(a)}`);
    L.push(`🎯 Если купил: продай часть при ${fmtRub(a.target)} (${pct((a.target / a.cur - 1) * 100)}), пересмотри план, если упадёт до ${fmtRub(a.floor)} (${pct((a.floor / a.cur - 1) * 100)})`);
  } else {
    L.push(`${coin.emoji} <b>${coin.name} — ЖДАТЬ</b>`);
    L.push(`Цена: ${fmtRub(a.cur)} · ${waitReason(a, fng)}`);
    L.push(`💤 Продавать тоже не время: жадности на рынке нет, фиксировать нечего.`);
  }
  if (full) {
    L.push(`Динамика: ${pct(a.d1)} сутки · ${pct(a.d7)} неделя${a.d30 != null ? ` · ${pct(a.d30)} месяц` : ''}`);
    if (a.rsi != null && (a.rsi < 30 || a.rsi > 70)) {
      L.push(a.rsi < 30 ? 'Перепродан (RSI < 30) — отскоки отсюда случаются часто' : 'Перегрет (RSI > 70) — откаты отсюда случаются часто');
    }
    if (ev && ev.count > 0) {
      L.push(`📊 Похожие моменты за год: ${ev.count} раз, через месяц плюс в ${ev.wins} из ${ev.count} (в среднем ${pct(ev.avgRet)})`);
    }
  }
  return L.join('\n');
}

function statusMessage(title, results, fng, fngWeekAgo, evByCoin, full) {
  const blocks = COINS.filter(c => results[c.sym])
    .map(c => actionBlock(c, results[c.sym], fng, evByCoin[c.sym], full));
  let mood = '';
  if (fng != null) {
    mood = `😨 Настроение рынка: ${moodBar(fng)} ${fng}/100 — ${moodWord(fng)}`;
    if (fngWeekAgo != null && Math.abs(fng - fngWeekAgo) >= 5) {
      mood += `\nЗа неделю: ${fngWeekAgo} → ${fng} (${fng < fngWeekAgo ? 'страх усиливается' : 'страх отступает'})`;
    }
  }
  return `<b>${title}</b>\n\n${blocks.join('\n\n')}\n\n${mood}\n📌 Не больше 1000 ₽ за раз · половина капитала в резерве · это анализ, не гарантия`;
}

// ---------- Команды из чата ----------
async function processCommands(state, buildStatus) {
  let j;
  try { j = await tg('getUpdates', { offset: (state.lastUpdateId || 0) + 1, timeout: 0 }); } catch { return; }
  if (!j.ok || !j.result) return;
  for (const u of j.result) {
    state.lastUpdateId = Math.max(state.lastUpdateId || 0, u.update_id);
    const msg = u.message;
    if (!msg || !msg.text || String(msg.chat.id) !== String(CHAT_ID)) continue;
    const cmd = msg.text.trim().split(/[\s@]/)[0].toLowerCase();
    if (cmd === '/now' || cmd === '/сейчас') {
      await send(buildStatus('📡 Текущее состояние (по запросу)'));
    } else if (cmd === '/help' || cmd === '/start') {
      await send('🎯 Я слежу за BTC и TON и пишу сам, когда меняется сигнал: что делать, на какой срок и когда продавать.\n\n' +
        'Команды (отвечаю при ближайшей проверке, до 30 минут):\n' +
        '/now — текущее состояние рынка\n' +
        '/help — эта справка\n\n' +
        'Каждое утро ~8:00 МСК — сводка + разбор от ИИ. По воскресеньям — итоги недели.\n' +
        'Ночью (23:00–08:00 МСК) не беспокою — всё важное придёт утром.');
    }
  }
}

// ---------- Главное ----------
(async () => {
  if (!TOKEN || !CHAT_ID) {
    console.error('Не заданы TELEGRAM_TOKEN / TELEGRAM_CHAT_ID (секреты репозитория).');
    process.exit(1);
  }

  const fngData = await getJson('https://api.alternative.me/fng/?limit=365');
  let fng = null, fngWeekAgo = null, fngHist = null;
  if (fngData && fngData.data && fngData.data.length) {
    fngHist = fngData.data.map(d => parseInt(d.value)).reverse();
    fng = fngHist.at(-1);
    fngWeekAgo = fngHist.at(-8) ?? null;
  }

  const results = {}, evByCoin = {};
  for (const coin of COINS) {
    const j = await getJson(`https://api.coingecko.com/api/v3/coins/${coin.id}/market_chart?vs_currency=rub&days=365&interval=daily`);
    if (j && j.prices && j.prices.length >= 200) {
      const prices = j.prices.map(p => p[1]);
      results[coin.sym] = analyse(prices, fng);
      evByCoin[coin.sym] = evidence(prices, fngHist);
    }
    await sleep(1500); // бесплатный лимит CoinGecko
  }
  if (!Object.keys(results).length) {
    console.log('Данные не загрузились — пропускаем запуск (не спамим ошибками).');
    return;
  }

  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const hourUTC = now.getUTCHours();
  const quiet = hourUTC >= 20 || hourUTC < 5;        // 23:00–07:59 МСК — тихие часы
  const morning = hourUTC === 5;                     // 08:00–08:59 МСК
  const sunday = now.getUTCDay() === 0;

  const buildStatus = title => statusMessage(title, results, fng, fngWeekAgo, evByCoin, true);

  // 1) Команды из чата (/now, /help) — отвечаем в любое время
  await processCommands(state, buildStatus);

  // 2) Разбор от ИИ: ежедневная сессия Claude кладёт bot/briefing.json
  try {
    const b = JSON.parse(fs.readFileSync(BRIEFING_FILE, 'utf8'));
    if (b && b.date === today && state.briefingSent !== b.date && b.text) {
      await send('🧠 <b>Утренний разбор от ИИ</b>\n\n' + b.text);
      state.briefingSent = b.date;
    }
  } catch {}

  // 3) Резкое движение за сутки (>8%) — сразу, но не чаще раза в 12 часов на монету
  state.volAlert = state.volAlert || {};
  if (!quiet) {
    for (const coin of COINS) {
      const a = results[coin.sym];
      if (!a || Math.abs(a.d1) < 8) continue;
      const last = state.volAlert[coin.sym] || 0;
      if (Date.now() - last < 12 * 3600 * 1000) continue;
      await send(`⚡ <b>${coin.name} ${a.d1 > 0 ? 'вырос' : 'упал'} на ${Math.abs(a.d1).toFixed(1)}% за сутки</b> — сейчас ${fmtRub(a.cur)}.\n` +
        (a.d1 < 0 ? 'Резкие падения — не повод паниковать: план и лимиты важнее эмоций.' :
          'Резкий рост — не повод догонять: покупки на эйфории чаще всего убыточны.'));
      state.volAlert[coin.sym] = Date.now();
    }
  }

  // 4) Смена сигнала — в любое время, кроме тихих часов (ночные изменения придут утром)
  const signature = COINS.map(c => results[c.sym] ? results[c.sym].verdict : '?').join(',');
  const changed = signature !== state.signature;
  if (changed && !quiet && !MANUAL) {
    await send(statusMessage('🎯 Сигнал изменился!', results, fng, fngWeekAgo, evByCoin, false));
    state.signature = signature;
  } else if (changed && (quiet || MANUAL)) {
    state.signature = signature; // запомним; подробности придут в сводке/статусе
  }

  // 5) Утренняя сводка (и недельный отчёт по воскресеньям)
  if (morning && state.lastMorning !== today) {
    const title = sunday ? '📅 Итоги недели' : '☀️ Утренняя сводка';
    let text = buildStatus(title);
    if (sunday) {
      const weekLines = COINS.filter(c => results[c.sym])
        .map(c => `${c.emoji} ${c.sym}: ${pct(results[c.sym].d7)} за неделю`).join('\n');
      text += `\n\nНеделя коротко:\n${weekLines}`;
    }
    await send(text);
    state.lastMorning = today;
  }

  // 6) Ручной запуск — полный статус, чтобы можно было проверить бота в любой момент
  if (MANUAL) {
    await send(buildStatus('🔧 Ручная проверка — всё работает'));
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...state, signature, updatedAt: now.toISOString() }, null, 2));
  console.log('OK. signature=' + signature + (changed ? ' (изменился)' : ''));
})().catch(e => { console.error(e); process.exit(1); });
