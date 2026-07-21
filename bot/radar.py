"""Еженедельный радар рынка и авто-экзамены созревших монет.

Запускается из часового цикла по понедельникам (~09:00 Баку):
1) radar — скан всех ликвидных пар OKX (>1 млн $/сут): кто в подтверждённом
   восходящем тренде; новые имена предлагаются в наблюдение.
2) auto_exams — наблюдаемые монеты, у которых накопился год истории,
   автоматически проходят экзамен боевой конфигурацией; вердикт в Telegram.
"""

import json
import time
import urllib.request

from bot import strategy
from bot.data import fetch_history
from bot.indicators import ema

MIN_VOL_USD = 1_000_000
STABLES = {"USDC", "USDG", "DAI", "TUSD", "USDP", "EURT", "FDUSD", "PYUSD"}

# Уже экзаменованные вручную (сессии 10-21 июля) — авто-экзамен пропускает.
EXAMINED = {
    "ADA-USDT": "-8%", "LINK-USDT": "-25%", "AVAX-USDT": "-25%",
    "DOT-USDT": "-30%", "LTC-USDT": "-56%", "BCH-USDT": "+1%",
    "ETC-USDT": "-65%", "PEPE-USDT": "+37% (в корзине не помог)",
    "BNB-USDT": "+23% (в корзину не прошёл)", "NEAR-USDT": "+23% (не прошёл)",
    "HBAR-USDT": "+20% (не прошёл)", "UNI-USDT": "-33%",
    "SHIB-USDT": "-33%", "OP-USDT": "-50%", "APT-USDT": "-31%",
    "ICP-USDT": "-50%", "ALGO-USDT": "-26%", "INJ-USDT": "-18%",
    "ONDO-USDT": "-29%", "TIA-USDT": "-64%", "JUP-USDT": "-60%",
    "AAVE-USDT": "-6%",
}


def _get(url, retries=3):
    req = urllib.request.Request(url, headers={"User-Agent": "vexen-radar/1.0"})
    for a in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.load(r).get("data", [])
        except Exception:
            if a == retries:
                return []
            time.sleep(2 * (a + 1))


def weekly_radar():
    """Текст отчёта радара (или None, если рынок пуст)."""
    tickers = _get("https://www.okx.com/api/v5/market/tickers?instType=SPOT")
    liquid = []
    for t in tickers:
        iid = t["instId"]
        if not iid.endswith("-USDT"):
            continue
        base = iid[:-5]
        if base in STABLES or base.endswith(("3L", "3S", "5L", "5S")):
            continue
        vol = float(t.get("volCcy24h") or 0)
        if vol >= MIN_VOL_USD:
            liquid.append((iid, vol))

    rows = []
    for iid, vol in liquid:
        d = _get(f"https://www.okx.com/api/v5/market/candles?instId={iid}&bar=1D&limit=100")
        time.sleep(0.12)
        if len(d) < 95:
            continue
        closes = [float(x[4]) for x in reversed(d)]
        last = closes[-1]
        sma90 = sum(closes[-90:]) / 90
        m30 = last / closes[-31] - 1
        m90 = last / closes[0] - 1
        if last > sma90 and m30 > 0 and m90 > 0:
            rows.append((m90, iid, vol))
    rows.sort(reverse=True)

    known = set(strategy.WATCHLIST)
    lines = [f"📡 <b>Недельный радар</b> · ликвидных пар: {len(liquid)}, "
             f"в восходящем тренде: {len(rows)}", ""]
    for m90, iid, vol in rows[:12]:
        base = iid.replace("-USDT", "")
        tag = ("🟢 торгуем" if iid in strategy.SYMBOLS
               else "👁 наблюдаем" if iid in known else "✨ НОВАЯ")
        lines.append(f"{base}: +{m90 * 100:.0f}% за 90д · {vol / 1e6:.1f}М$/сут · {tag}")
    new = [iid for _, iid, _ in rows if iid not in known]
    if new:
        lines += ["", "✨ Новые кандидаты в наблюдение: "
                  + ", ".join(i.replace("-USDT", "") for i in new)
                  + " — скажи Claude, добавим и заведём на экзамен."]
    return "\n".join(lines)


def _exam_solo(candles, btc_candles):
    """Соло-экзамен боевой конфигурацией (без пирамидинга ради простоты)."""
    closes = [c["close"] for c in candles]
    vols = [c["volume"] for c in candles]
    e_arr = ema(closes, strategy.EMA_PERIOD)
    btc_by_ts = {c["ts"]: c["close"] for c in btc_candles}
    btc_seq = []
    last = None
    for c in candles:
        last = btc_by_ts.get(c["ts"], last)
        btc_seq.append(last)
    btc_ema = ema([b or 0 for b in btc_seq], strategy.EMA_PERIOD)

    cash, qty, entry, high = 1000.0, 0.0, 0.0, 0.0
    reset = False
    trades = wins = 0
    curve = []
    for i, p in enumerate(closes):
        e = e_arr[i]
        if e is None:
            continue
        if qty == 0:
            if reset:
                if p < e * (1 + strategy.BAND):
                    reset = False
            else:
                lo = max(0, i - strategy.VOLUME_WINDOW)
                win = vols[lo:i]
                vol_ok = (len(win) >= strategy.VOLUME_WINDOW // 2
                          and vols[i] > strategy.VOLUME_MULT * (sum(win) / len(win)))
                btc_ok = (btc_seq[i] is not None and btc_ema[i] is not None
                          and btc_seq[i] > btc_ema[i])
                if vol_ok and btc_ok and p > e * (1 + strategy.BAND):
                    qty = cash / (p * (1 + strategy.FEE))
                    cash = 0.0
                    entry = high = p
        else:
            high = max(high, p)
            why = None
            if p < e * (1 - strategy.BAND):
                why = "trend"
            elif p < entry * (1 - strategy.STOP):
                why = "stop"
            elif p < high * (1 - strategy.TRAIL):
                why = "trail"
            if why:
                cash = qty * p * (1 - strategy.FEE)
                wins += p > entry
                trades += 1
                qty = 0.0
                reset = why != "trend"
        curve.append(cash + qty * p)
    if not curve:
        return None
    peak, mdd = curve[0], 0.0
    for v in curve:
        peak = max(peak, v)
        mdd = max(mdd, (peak - v) / peak)
    ret = curve[-1] / 1000 * 100 - 100
    start_i = next(i for i in range(len(closes)) if e_arr[i] is not None)
    bh = (closes[-1] / closes[start_i] - 1) * 100
    return ret, mdd * 100, trades, bh


def auto_exams(state, max_exams=2):
    """Экзамены для созревших наблюдаемых. Возвращает список сообщений."""
    done = state.setdefault("exam_done", {})
    out = []
    candidates = [s for s in strategy.WATCHLIST
                  if s not in strategy.SYMBOLS
                  and s not in EXAMINED and s not in done]
    examined_now = 0
    btc_cache = None
    for sym in candidates:
        if examined_now >= max_exams:  # не растягиваем часовой запуск
            break
        probe = _get(f"https://www.okx.com/api/v5/market/candles?instId={sym}&bar=1D&limit=300")
        time.sleep(0.2)
        if len(probe) < 300:  # 300 дневных свечей нет — точно меньше года...
            # (limit=300 отдаёт максимум 300; если меньше — истории меньше 300д)
            continue
        # зрелость подтверждаем часовой историей
        candles = fetch_history(sym, "1H", 9200)
        if len(candles) < 8760:
            continue
        if btc_cache is None:
            btc_cache = fetch_history("BTC-USDT", "1H", 9200)
        res = _exam_solo(candles, btc_cache)
        examined_now += 1
        if res is None:
            continue
        ret, dd, trades, bh = res
        verdict = ("сдал — обсуди с Claude включение в торговлю"
                   if ret > 15 and ret > bh and dd < 45 else "не сдал — остаётся в наблюдении")
        done[sym] = f"{ret:+.0f}%"
        out.append(
            f"🎓 <b>{sym.replace('-USDT', '')} созрел для экзамена</b> (год истории)\n"
            f"Стратегия: {ret:+.1f}% · просадка -{dd:.1f}% · сделок {trades}\n"
            f"Просто держать: {bh:+.1f}%\n"
            f"Вердикт: {verdict}")
    return out
