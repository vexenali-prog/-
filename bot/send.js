// Телеграм-бот «Момент»: проверяет рынок и пишет в чат, когда меняется сигнал,
// плюс ежедневная утренняя сводка. Запускается по расписанию GitHub Actions.
// Нужны переменные окружения: TELEGRAM_TOKEN, TELEGRAM_CHAT_ID.

const fs = require('fs');
const path = require('path');

const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const STATE_FILE = path.join(__dirname, 'state.json');
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

function analyse(prices, fng) {
  const cur = prices.at(-1);
  const sma200 = avg(prices.slice(-200));
  const high = Math.max(...prices);
  const discount = (1 - cur / high) * 100;
  const d1 = (cur / prices.at(-2) - 1) * 100;
  const d7 = (cur / prices.at(-8) - 1) * 100;

  let verdict = 'wait', rub = 0;
  if (fng != null && fng <= 20 && discount >= 40) { verdict = 'strong'; rub = 1000; }
  else if (fng != null && fng <= 30 && cur < sma200) { verdict = 'buy'; rub = 500; }
  return { cur, sma200, discount, d1, d7, verdict, rub };
}

function verdictLine(coin, a) {
  const word = a.verdict === 'strong' ? `СИЛЬНЫЙ СИГНАЛ — купить на ${fmtRub(a.rub)}`
    : a.verdict === 'buy' ? `покупать на ${fmtRub(a.rub)}`
    : 'ждём';
  return `${coin.emoji} ${coin.sym}: ${word}`;
}

function coinBlock(coin, a) {
  const arrow = a.d1 >= 0 ? '↑' : '↓';
  return `${coin.emoji} ${coin.name}: ${fmtRub(a.cur)} (${arrow}${Math.abs(a.d1).toFixed(1)}% за сутки, ${a.d7 >= 0 ? '+' : ''}${a.d7.toFixed(1)}% за неделю)\n` +
    `Скидка от максимума года: ${a.discount.toFixed(0)}% · ${a.cur < a.sma200 ? 'ниже' : 'выше'} средней за год`;
}

async function sendTelegram(text) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, disable_web_page_preview: true }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error('Telegram: ' + JSON.stringify(j));
}

(async () => {
  if (!TOKEN || !CHAT_ID) {
    console.error('Не заданы TELEGRAM_TOKEN / TELEGRAM_CHAT_ID (секреты репозитория).');
    process.exit(1);
  }

  const fngData = await getJson('https://api.alternative.me/fng/');
  const fng = fngData && fngData.data && fngData.data[0] ? parseInt(fngData.data[0].value) : null;

  const results = {};
  for (const coin of COINS) {
    const j = await getJson(`https://api.coingecko.com/api/v3/coins/${coin.id}/market_chart?vs_currency=rub&days=365&interval=daily`);
    if (j && j.prices && j.prices.length >= 200) {
      results[coin.sym] = analyse(j.prices.map(p => p[1]), fng);
    }
    await sleep(1500); // бесплатный лимит CoinGecko
  }
  if (!Object.keys(results).length) {
    console.log('Данные не загрузились — пропускаем запуск.');
    return;
  }

  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}

  const signature = COINS.map(c => results[c.sym] ? results[c.sym].verdict : '?').join(',');
  const changed = signature !== prev.signature;
  // утренняя сводка: первый запуск в окне 05:00-05:59 UTC (08:00-08:59 МСК)
  const now = new Date();
  const isMorning = now.getUTCHours() === 5 && prev.lastMorning !== now.toISOString().slice(0, 10);

  if (changed || isMorning) {
    const head = COINS.filter(c => results[c.sym]).map(c => verdictLine(c, results[c.sym])).join('\n');
    const body = COINS.filter(c => results[c.sym]).map(c => coinBlock(c, results[c.sym])).join('\n\n');
    const mood = fng != null
      ? `Настроение рынка: ${fng}/100 ${fng <= 25 ? '(страх — исторически неплохое время закупаться понемногу)' : fng >= 70 ? '(жадность — с покупками осторожнее)' : '(нейтрально)'}`
      : '';
    const title = isMorning && !changed ? '☀️ Утренняя сводка' : '🎯 Сигнал изменился!';
    const text = `${title}\n\n${head}\n\n${body}\n\n${mood}\n\n` +
      `Правила: не больше 1000 ₽ за раз, половина капитала всегда в резерве. Это анализ, а не гарантия прибыли.`;
    await sendTelegram(text);
    console.log('Сообщение отправлено.');
  } else {
    console.log('Сигнал не менялся — молчим (' + signature + ').');
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify({
    signature,
    lastMorning: isMorning ? now.toISOString().slice(0, 10) : (prev.lastMorning || null),
    updatedAt: now.toISOString(),
  }, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
