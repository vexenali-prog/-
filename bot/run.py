"""Часовой запуск paper-бота (GitHub Actions или вручную).

  python -m bot.run

Держит виртуальный портфель в state/paper_state.json: подтягивает свежие
свечи, проверяет стопы/тейки, открывает и закрывает позиции по стратегии,
шлёт сделки в Telegram и раз в день — сводку.
"""

import json
import os
from datetime import datetime, timezone

from bot import strategy
from bot.data import fetch_recent
from bot.notify import send
from bot.portfolio import Portfolio

STATE_PATH = os.path.join(os.path.dirname(__file__), "..", "state", "paper_state.json")
START_CASH = 1000.0
DAILY_REPORT_HOUR_UTC = 6  # 09:00 по Баку, 09:00 МСК летом


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
        "last_processed_ts": {},
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
    pf.trades = []

    candles = {}
    for sym in strategy.SYMBOLS:
        candles[sym] = fetch_recent(sym, "1H", 300)
        if len(candles[sym]) < strategy.WARMUP:
            # 300 подтверждённых свечей хватает: WARMUP=210
            raise RuntimeError(f"{sym}: мало данных ({len(candles[sym])})")

    prices = {sym: candles[sym][-1]["close"] for sym in strategy.SYMBOLS}
    events = []

    for sym in strategy.SYMBOLS:
        last = candles[sym][-1]
        # свечи, которых бот ещё не видел — для проверки стопов без пропусков
        seen = state["last_processed_ts"].get(sym, 0)
        for c in candles[sym]:
            if c["ts"] <= seen:
                continue
            trade = pf.check_stops(sym, c["high"], c["low"], c["ts"])
            if trade:
                events.append(("sell", trade))
        state["last_processed_ts"][sym] = last["ts"]

        ind = strategy.compute(candles[sym])
        i = len(candles[sym]) - 1
        sig = strategy.signal_at(ind, i, pf.positions.get(sym))
        if sig is None:
            continue
        if sig["action"] == "buy":
            pos = pf.buy(sym, prices[sym], sig["atr"], last["ts"], prices)
            if pos:
                events.append(("buy", {"symbol": sym, **pos}))
        else:
            trade = pf.sell(sym, prices[sym], last["ts"], sig["reason"])
            if trade:
                events.append(("sell", trade))

    equity = pf.equity(prices)
    now = datetime.now(timezone.utc)
    state["cash"] = pf.cash
    state["positions"] = pf.positions
    state["trades"].extend(pf.trades)
    state["equity_history"].append({"ts": int(now.timestamp() * 1000), "equity": round(equity, 2)})
    state["equity_history"] = state["equity_history"][-2200:]  # ~3 месяца часовых точек

    lines = []
    for kind, e in events:
        if kind == "buy":
            lines.append(
                f"🟢 <b>Покупка {e['symbol']}</b>\n"
                f"Цена {fmt_money(e['entry'])}, объём {fmt_money(e['qty'] * e['entry'])} USDT\n"
                f"Стоп {fmt_money(e['stop'])} · Тейк {fmt_money(e['target'])}"
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
        ] or ["  нет открытых позиций"]
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
