"""Часовой запуск paper-бота (GitHub Actions или вручную).

  python -m bot.run

Держит виртуальный портфель в state/paper_state.json: подтягивает свежие
свечи, открывает и закрывает позиции по трендовой стратегии, шлёт сделки
в Telegram и раз в день — сводку.
"""

import json
import os
import urllib.request
from datetime import datetime, timedelta, timezone

from bot import strategy
from bot.chart import equity_png
from bot.data import fetch_history
from bot.notify import send, send_photo
from bot.portfolio import Portfolio

CONTROL_URL = "https://shturman-bot.shturman-vexen.workers.dev/control"
NEAR_SIGNAL = 0.007      # «почти сигнал»: до триггера меньше 0.7%
HEADS_UP_COOLDOWN_H = 12  # не повторять предупреждение чаще, чем раз в 12 ч


def buying_paused():
    """Флаг паузы из меню (Cloudflare KV). При любой ошибке торгуем как обычно."""
    try:
        with urllib.request.urlopen(CONTROL_URL, timeout=10) as r:
            return bool(json.load(r).get("paused"))
    except Exception:
        return False

STATE_PATH = os.path.join(os.path.dirname(__file__), "..", "state", "paper_state.json")
START_CASH = 1000.0
DAILY_REPORT_HOUR_UTC = 6  # 10:00 по Баку
CANDLES_NEEDED = strategy.WARMUP + 40


def load_state():
    if os.path.exists(STATE_PATH):
        with open(STATE_PATH) as f:
            return json.load(f)
    return {
        "cash": START_CASH,
        "positions": {},
        "trades": [],
        "equity_history": [],
        "last_daily_report": "",
        "last_weekly_report": "",
        "baseline_prices": {},
        "heads_up": {},
    }


def save_state(state):
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    with open(STATE_PATH, "w") as f:
        json.dump(state, f, indent=1)


def fmt_money(x):
    """1234.5 -> «1 234,50»: разряды пробелами, десятичные через запятую."""
    return f"{x:,.2f}".replace(",", " ").replace(".", ",")


def fmt_signed_money(x):
    return ("+" if x >= 0 else "−") + fmt_money(abs(x)) + " $"


def fmt_pct(x, digits=1):
    return ("+" if x >= 0 else "−") + f"{abs(x):.{digits}f}".replace(".", ",") + "%"


MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня",
          "июля", "августа", "сентября", "октября", "ноября", "декабря"]


def fmt_dt(ts_ms):
    """Момент времени по Баку (UTC+4): «10 июля, 21:03»."""
    d = datetime.fromtimestamp(ts_ms / 1000, timezone.utc) + timedelta(hours=4)
    return f"{d.day} {MONTHS[d.month - 1]}, {d:%H:%M}"


def fmt_dur(ms):
    hours = round(ms / 3_600_000)
    if hours < 24:
        return f"{hours} ч"
    days = hours // 24
    return f"{days} дн {hours % 24} ч" if hours % 24 else f"{days} дн"


def fmt_qty(q):
    return f"{q:.6g}".replace(".", ",")


def check_heads_up(state, out, sym, ema_val, price, position, ts):
    """Предупреждение «монета в шаге от сигнала», не чаще раза в 12 часов."""
    if ema_val is None:
        return
    if position is None:
        trigger = ema_val * (1 + strategy.BAND)
        near = price < trigger and price > trigger * (1 - NEAR_SIGNAL)
        key, text = sym + ":buy", (
            f"💡 <b>{sym.replace('-USDT', '')}</b> почти дорос до покупки: "
            f"{fmt_money(price)} $, до триггера {fmt_pct((trigger / price - 1) * 100, 2)}"
        )
    else:
        trigger = ema_val * (1 - strategy.BAND)
        near = price > trigger and price < trigger * (1 + NEAR_SIGNAL)
        key, text = sym + ":sell", (
            f"💡 <b>{sym.replace('-USDT', '')}</b> близок к продаже: "
            f"{fmt_money(price)} $, до триггера {fmt_pct((1 - trigger / price) * 100, 2)}"
        )
    if not near:
        return
    last = state.setdefault("heads_up", {}).get(key, 0)
    if ts - last < HEADS_UP_COOLDOWN_H * 3_600_000:
        return
    state["heads_up"][key] = ts
    out.append(text)


def build_daily_summary(state, pf, prices, candles, equity, mkt_ok, now):
    """Утренний брифинг: что изменилось за сутки и что делал бот."""
    total_ret = (equity / START_CASH - 1) * 100
    day_ago_ms = int((now - timedelta(hours=24)).timestamp() * 1000)

    # изменение капитала за сутки — по истории equity
    day_delta = ""
    older = [p for p in state["equity_history"] if p["ts"] <= day_ago_ms]
    if older:
        prev = older[-1]["equity"]
        day_delta = (f"\nЗа сутки: <b>{fmt_signed_money(equity - prev)}</b> "
                     f"({fmt_pct((equity / prev - 1) * 100)})")

    # суточное движение каждой торгуемой монеты — по свечам
    day_moves = {}
    for sym in strategy.SYMBOLS:
        c = candles[sym]
        if len(c) > 25:
            day_moves[sym] = (c[-1]["close"] / c[-25]["close"] - 1) * 100

    lines = [
        f"☀️ <b>Доброе утро! {fmt_dt(int(now.timestamp() * 1000)).split(',')[0]}</b>",
        "",
        f"💼 <b>{fmt_money(equity)} $</b> ({fmt_pct(total_ret)} от старта)" + day_delta,
        "",
    ]

    # что бот делал за сутки
    day_trades = [t for t in state["trades"] if t["closed_ts"] >= day_ago_ms]
    if day_trades:
        pnl = sum(t["pnl"] for t in day_trades)
        names = ", ".join(t["symbol"].replace("-USDT", "") for t in day_trades)
        lines.append(f"🤝 Сделки за сутки: {names} · итог {fmt_signed_money(pnl)}")
    else:
        lines.append(f"🤝 Сделок за сутки нет — сопровождаю {len(pf.positions)} позиций")

    if day_moves:
        best = max(day_moves, key=day_moves.get)
        worst = min(day_moves, key=day_moves.get)
        lines.append(
            f"📈 Движение дня: {best.replace('-USDT', '')} {fmt_pct(day_moves[best])} · "
            f"{worst.replace('-USDT', '')} {fmt_pct(day_moves[worst])}")

    if pf.positions:
        pos_bits = [
            f"{sym.replace('-USDT', '')} {fmt_pct((prices[sym] / p['entry'] - 1) * 100)}"
            for sym, p in sorted(pf.positions.items(),
                                 key=lambda kv: prices[kv[0]] / kv[1]["entry"],
                                 reverse=True)
        ]
        lines.append(f"💰 Позиции ({len(pos_bits)}): " + " · ".join(pos_bits)
                     + f" · кэш {fmt_money(pf.cash)} $")
    else:
        lines.append(f"💰 Позиций нет — {fmt_money(pf.cash)} $ в кэше, жду сигналов")

    lines.append("🌍 Рынок: BTC " + ("выше тренда 🔓 покупки разрешены"
                                     if mkt_ok else "ниже тренда 🔒 покупки закрыты"))
    return "\n".join(lines)


def main():
    state = load_state()
    pf = Portfolio(state["cash"])
    pf.positions = state["positions"]

    candles = {}
    for sym in strategy.WATCHLIST:
        candles[sym] = fetch_history(sym, "1H", CANDLES_NEEDED, confirmed_only=True)
        if len(candles[sym]) < strategy.WARMUP and sym in strategy.SYMBOLS:
            # для торгуемых монет короткая история фатальна; наблюдаемые
            # (свежелистнутые вроде GRAM) просто ждут накопления свечей
            raise RuntimeError(f"{sym}: мало данных ({len(candles[sym])})")

    prices = {sym: candles[sym][-1]["close"] for sym in strategy.SYMBOLS}
    if not state.get("baseline_prices"):  # цены первого запуска — для сравнения с buy&hold
        state["baseline_prices"] = {s: prices[s] for s in strategy.SYMBOLS}
    events = []
    heads_up = []
    paused = buying_paused()
    reset = state.setdefault("need_reset", {})

    btc_ind = strategy.compute(candles["BTC-USDT"])
    mkt_ok = strategy.market_ok(prices["BTC-USDT"], btc_ind["ema"][-1])

    for sym in strategy.SYMBOLS:
        ind = strategy.compute(candles[sym])
        i = len(candles[sym]) - 1
        ts = candles[sym][i]["ts"]
        price = prices[sym]
        pos = pf.positions.get(sym)
        if pos is not None:
            pos["high"] = max(pos.get("high") or pos["entry"], price)
        elif sym in reset:
            # после стопа ждём, пока цена уйдёт под полосу покупки
            e = ind["ema"][i]
            if e is not None and price < e * (1 + strategy.BAND):
                del reset[sym]
            continue

        sig = strategy.signal_at(ind, i, price, pos, allow_buy=mkt_ok and not paused)
        if sig is None:
            check_heads_up(state, heads_up, sym, ind["ema"][i], price, pos, ts)
            continue
        if sig["action"] == "buy":
            pos = pf.buy(sym, price, ts, prices)
            if pos:
                events.append(("buy", {"symbol": sym, **pos}))
        else:
            trade = pf.sell(sym, price, ts, sig["reason"])
            if trade:
                events.append(("sell", trade))
                if sig.get("stop"):
                    reset[sym] = True

    equity = pf.equity(prices)
    now = datetime.now(timezone.utc)
    state["cash"] = pf.cash
    state["positions"] = pf.positions
    # снимок индикаторов для интерактивного меню (Cloudflare Worker):
    # по всем наблюдаемым монетам, не только торгуемым
    state["indicators"] = {
        sym: {
            "ema": round(strategy.compute(candles[sym])["ema"][-1], 6),
            "close": candles[sym][-1]["close"],
            "ts": candles[sym][-1]["ts"],
        }
        for sym in strategy.WATCHLIST
        if len(candles[sym]) >= strategy.WARMUP  # у новых монет тренда ещё нет
    }
    state["trades"].extend(pf.trades)
    state["equity_history"].append({"ts": int(now.timestamp() * 1000), "equity": round(equity, 2)})
    state["equity_history"] = state["equity_history"][-2200:]  # ~3 месяца часовых точек

    lines = []
    for kind, e in events:
        if kind == "buy":
            spent = e["qty"] * e["entry"] * (1 + strategy.FEE)
            lines.append(
                f"🟢 <b>КУПИЛ {e['symbol'].replace('-USDT', '')}</b> · {fmt_dt(e['opened_ts'])} (Баку)\n"
                f"Куплено: {fmt_qty(e['qty'])} монет по {fmt_money(e['entry'])} $\n"
                f"Потрачено: <b>{fmt_money(spent)} $</b> (с комиссией 0.1%)\n"
                f"Почему: цена закрепилась выше тренда"
            )
        else:
            emoji = "✅" if e["pnl"] > 0 else "🔴"
            invested = e["qty"] * e["entry"] * (1 + strategy.FEE)
            received = e["qty"] * e["exit"] * (1 - strategy.FEE)
            lines.append(
                f"{emoji} <b>ПРОДАЛ {e['symbol'].replace('-USDT', '')}</b> · {fmt_dt(e['closed_ts'])} (Баку)\n"
                f"Купил {fmt_dt(e['opened_ts'])} по {fmt_money(e['entry'])} $, "
                f"продал по {fmt_money(e['exit'])} $\n"
                f"Вложено {fmt_money(invested)} $ → получено {fmt_money(received)} $ "
                f"(держал {fmt_dur(e['closed_ts'] - e['opened_ts'])})\n"
                f"Итог: <b>{fmt_signed_money(e['pnl'])} ({fmt_pct(e['pnl_pct'], 2)})</b>\n"
                f"Почему продал: {e['reason']}"
            )
    if lines:
        send(
            "\n\n".join(lines)
            + f"\n\n💼 Портфель: <b>{fmt_money(equity)} $</b>"
            + f" · свободно {fmt_money(pf.cash)} $ (виртуальные)"
        )
    if heads_up:
        send("\n".join(heads_up) + "\n<i>Решение бот примет на закрытии часа.</i>")

    today = now.strftime("%Y-%m-%d")
    if now.hour >= DAILY_REPORT_HOUR_UTC and state["last_daily_report"] != today:
        state["last_daily_report"] = today
        text = build_daily_summary(state, pf, prices, candles, equity, mkt_ok, now)
        png = equity_png(state["equity_history"], START_CASH)
        if not (png and send_photo(png, text)):
            send(text)  # без графика, но сводка дойдёт обязательно

    # недельный отчёт — по воскресеньям, вместе с утренней сводкой
    week_id = f"{now.isocalendar().year}-{now.isocalendar().week}"
    if (now.weekday() == 6 and now.hour >= DAILY_REPORT_HOUR_UTC
            and state.get("last_weekly_report") != week_id):
        state["last_weekly_report"] = week_id
        base = state.get("baseline_prices") or {}
        bh_parts = [prices[s] / base[s] for s in strategy.SYMBOLS if base.get(s)]
        bh_ret = (sum(bh_parts) / len(bh_parts) - 1) * 100 if bh_parts else 0.0
        week_ago = int((now - timedelta(days=7)).timestamp() * 1000)
        week_trades = [t for t in state["trades"] if t["closed_ts"] >= week_ago]
        week_pnl = sum(t["pnl"] for t in week_trades)
        send(
            f"🗓 <b>Итоги недели</b>\n\n"
            f"Портфель: <b>{fmt_money(equity)} $</b> ({fmt_pct((equity / START_CASH - 1) * 100)} "
            f"с самого старта)\n"
            f"Если бы просто купили и держали эти монеты: {fmt_pct(bh_ret)}\n\n"
            f"Сделок за неделю: {len(week_trades)}"
            + (f", результат {fmt_signed_money(week_pnl)}" if week_trades else "")
            + "\n\n<i>Мало сделок — это нормально: трендовая стратегия "
              "ждёт сильных движений, а не торгует каждый день.</i>"
        )

    # месячный отчёт — первого числа: разбор всех сделок прошедшего месяца
    month_id = now.strftime("%Y-%m")
    if (now.day == 1 and now.hour >= DAILY_REPORT_HOUR_UTC
            and state.get("last_monthly_report") != month_id):
        state["last_monthly_report"] = month_id
        month_ago = int((now - timedelta(days=31)).timestamp() * 1000)
        mt = [t for t in state["trades"] if t["closed_ts"] >= month_ago]
        parts = [
            f"🗓 <b>Итоги месяца</b>\n",
            f"Портфель: <b>{fmt_money(equity)} $</b> "
            f"({fmt_pct((equity / START_CASH - 1) * 100)} от старта)",
        ]
        if mt:
            wins_m = [t for t in mt if t["pnl"] > 0]
            stops = [t for t in mt if "стоп" in t["reason"]]
            best = max(mt, key=lambda t: t["pnl"])
            worst = min(mt, key=lambda t: t["pnl"])
            parts += [
                f"Сделок за месяц: {len(mt)}, прибыльных {len(wins_m)}, "
                f"итог {fmt_signed_money(sum(t['pnl'] for t in mt))}",
                f"Сработало стопов: {len(stops)} — они ограничили убытки на "
                f"{fmt_money(sum(-t['pnl'] for t in stops))} $" if stops else "Стопы не понадобились",
                f"Лучшая: {best['symbol'].replace('-USDT', '')} "
                f"{fmt_signed_money(best['pnl'])} ({fmt_pct(best['pnl_pct'])})",
                f"Худшая: {worst['symbol'].replace('-USDT', '')} "
                f"{fmt_signed_money(worst['pnl'])} ({fmt_pct(worst['pnl_pct'])})",
            ]
        else:
            parts.append("Сделок в этом месяце не было — бот ждал сигналов.")
        send("\n".join(parts))

    save_state(state)
    print(f"OK: equity={equity:.2f} USDT, события: {len(events)}")


if __name__ == "__main__":
    main()
