"""Часовой запуск paper-бота (GitHub Actions или вручную).

  python -m bot.run

Держит виртуальный портфель в state/paper_state.json: подтягивает свежие
свечи, открывает и закрывает позиции по трендовой стратегии, шлёт сделки
в Telegram и раз в день — сводку.
"""

import json
import os
from datetime import datetime, timezone

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


def main():
    state = load_state()
    pf = Portfolio(state["cash"])
    pf.positions = state["positions"]

    candles = {}
    for sym in strategy.SYMBOLS:
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
    # снимок индикаторов для интерактивного меню (Cloudflare Worker)
    state["indicators"] = {
        sym: {
            "ema": round(strategy.compute(candles[sym])["ema"][-1], 6),
            "close": candles[sym][-1]["close"],
            "ts": candles[sym][-1]["ts"],
        }
        for sym in strategy.SYMBOLS
    }
    state["trades"].extend(pf.trades)
    state["equity_history"].append({"ts": int(now.timestamp() * 1000), "equity": round(equity, 2)})
    state["equity_history"] = state["equity_history"][-2200:]  # ~3 месяца часовых точек

    lines = []
    for kind, e in events:
        if kind == "buy":
            lines.append(
                f"🟢 <b>Покупка {e['symbol']}</b>\n"
                f"Цена {fmt_money(e['entry'])}, объём {fmt_money(e['qty'] * e['entry'])} USDT\n"
                f"Причина: цена закрепилась выше тренда"
            )
        else:
            emoji = "✅" if e["pnl"] > 0 else "🔴"
            lines.append(
                f"{emoji} <b>Продажа {e['symbol']}</b> — {e['reason']}\n"
                f"Вход {fmt_money(e['entry'])} → выход {fmt_money(e['exit'])}\n"
                f"Результат: {e['pnl']:+.2f} USDT ({e['pnl_pct']:+.2f}%)"
            )
    if lines:
        send("\n\n".join(lines) + f"\n\n💼 Портфель: {fmt_money(equity)} USDT (виртуальный)")

    today = now.strftime("%Y-%m-%d")
    if now.hour >= DAILY_REPORT_HOUR_UTC and state["last_daily_report"] != today:
        state["last_daily_report"] = today
        total_ret = (equity / START_CASH - 1) * 100
        closed = state["trades"]
        wins = sum(1 for t in closed if t["pnl"] > 0)
        pos_lines = [
            f"  {sym}: вход {fmt_money(p['entry'])}, сейчас {fmt_money(prices[sym])} "
            f"({(prices[sym] / p['entry'] - 1) * 100:+.1f}%)"
            for sym, p in pf.positions.items()
        ] or ["  нет открытых позиций — сидим в кэше"]
        send(
            f"📊 <b>Дневная сводка (paper)</b>\n"
            f"Портфель: {fmt_money(equity)} USDT ({total_ret:+.1f}% от старта)\n"
            f"Свободно: {fmt_money(pf.cash)} USDT\n"
            f"Позиции:\n" + "\n".join(pos_lines) + "\n"
            f"Сделок всего: {len(closed)}"
            + (f", прибыльных {wins} ({wins / len(closed) * 100:.0f}%)" if closed else "")
        )

    save_state(state)
    print(f"OK: equity={equity:.2f} USDT, события: {len(events)}")


if __name__ == "__main__":
    main()
