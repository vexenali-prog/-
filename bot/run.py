"""Часовой запуск paper-бота (GitHub Actions или вручную).

  python -m bot.run

Держит виртуальный портфель в state/paper_state.json: подтягивает свежие
свечи, открывает и закрывает позиции по трендовой стратегии, шлёт сделки
в Telegram и раз в день — сводку.
"""

import json
import os
from datetime import datetime, timedelta, timezone

from bot import strategy
from bot.data import fetch_history
from bot.notify import send
from bot.portfolio import Portfolio

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
    }


def save_state(state):
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    with open(STATE_PATH, "w") as f:
        json.dump(state, f, indent=1)


def fmt_money(x):
    return f"{x:,.2f}".replace(",", " ")


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
    return f"{q:.6g}"


def main():
    state = load_state()
    pf = Portfolio(state["cash"])
    pf.positions = state["positions"]

    candles = {}
    for sym in strategy.WATCHLIST:
        candles[sym] = fetch_history(sym, "1H", CANDLES_NEEDED, confirmed_only=True)
        if len(candles[sym]) < strategy.WARMUP:
            raise RuntimeError(f"{sym}: мало данных ({len(candles[sym])})")

    prices = {sym: candles[sym][-1]["close"] for sym in strategy.SYMBOLS}
    events = []

    for sym in strategy.SYMBOLS:
        ind = strategy.compute(candles[sym])
        i = len(candles[sym]) - 1
        ts = candles[sym][i]["ts"]
        sig = strategy.signal_at(ind, i, prices[sym], pf.positions.get(sym))
        if sig is None:
            continue
        if sig["action"] == "buy":
            pos = pf.buy(sym, prices[sym], ts, prices)
            if pos:
                events.append(("buy", {"symbol": sym, **pos}))
        else:
            trade = pf.sell(sym, prices[sym], ts, sig["reason"])
            if trade:
                events.append(("sell", trade))

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
                f"Итог: <b>{e['pnl']:+.2f} $ ({e['pnl_pct']:+.2f}%)</b>\n"
                f"Почему продал: {e['reason']}"
            )
    if lines:
        send(
            "\n\n".join(lines)
            + f"\n\n💼 Портфель: <b>{fmt_money(equity)} $</b>"
            + f" · свободно {fmt_money(pf.cash)} $ (виртуальные)"
        )

    today = now.strftime("%Y-%m-%d")
    if now.hour >= DAILY_REPORT_HOUR_UTC and state["last_daily_report"] != today:
        state["last_daily_report"] = today
        total_ret = (equity / START_CASH - 1) * 100
        closed = state["trades"]
        wins = sum(1 for t in closed if t["pnl"] > 0)
        pos_lines = [
            f"• <b>{sym.replace('-USDT', '')}</b>: куплено {fmt_dt(p['opened_ts'])} "
            f"на {fmt_money(p['qty'] * p['entry'] * (1 + strategy.FEE))} $ → "
            f"сейчас {fmt_money(p['qty'] * prices[sym])} $ "
            f"({(prices[sym] / p['entry'] - 1) * 100:+.1f}%)"
            for sym, p in pf.positions.items()
        ] or ["• нет открытых позиций — сидим в кэше и ждём тренда"]
        send(
            f"📊 <b>Утренняя сводка</b> <i>(виртуальный счёт)</i>\n\n"
            f"Портфель: <b>{fmt_money(equity)} $</b> ({total_ret:+.1f}% от старта, "
            f"{equity - START_CASH:+.2f} $)\n"
            f"Свободно: {fmt_money(pf.cash)} $\n\n"
            f"Что держим:\n" + "\n".join(pos_lines) + "\n\n"
            f"Сделок закрыто: {len(closed)}"
            + (f", прибыльных {wins} ({wins / len(closed) * 100:.0f}%), "
               f"итог по ним {sum(t['pnl'] for t in closed):+.2f} $" if closed else "")
        )

    save_state(state)
    print(f"OK: equity={equity:.2f} USDT, события: {len(events)}")


if __name__ == "__main__":
    main()
