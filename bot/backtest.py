"""Бэктест стратегии на исторических часовых свечах OKX.

Запуск:  python -m bot.backtest [часов_истории]
"""

import json
import os
import sys

from bot import strategy
from bot.data import fetch_history
from bot.portfolio import Portfolio

START_CASH = 1000.0


def load_data(hours, cache_dir=None):
    data = {}
    for sym in strategy.SYMBOLS:
        cache = os.path.join(cache_dir, f"{sym}_{hours}.json") if cache_dir else None
        if cache and os.path.exists(cache):
            with open(cache) as f:
                data[sym] = json.load(f)
        else:
            print(f"Скачиваю {sym}: {hours} часовых свечей...", flush=True)
            data[sym] = fetch_history(sym, "1H", hours)
            if cache:
                os.makedirs(cache_dir, exist_ok=True)
                with open(cache, "w") as f:
                    json.dump(data[sym], f)
        print(f"  {sym}: {len(data[sym])} свечей", flush=True)
    return data


def run(data):
    indicators = {sym: strategy.compute(candles) for sym, candles in data.items()}
    index = {sym: {c["ts"]: i for i, c in enumerate(candles)} for sym, candles in data.items()}

    # общая шкала времени: метки, где есть данные по всем монетам
    common_ts = sorted(set.intersection(*(set(index[s]) for s in strategy.SYMBOLS)))
    warmup_ts = common_ts[strategy.WARMUP]

    pf = Portfolio(START_CASH)
    equity_curve = []

    for ts in common_ts:
        if ts < warmup_ts:
            continue
        prices = {}
        for sym in strategy.SYMBOLS:
            i = index[sym][ts]
            c = data[sym][i]
            prices[sym] = c["close"]
            pf.check_stops(sym, c["high"], c["low"], ts)
        for sym in strategy.SYMBOLS:
            i = index[sym][ts]
            sig = strategy.signal_at(indicators[sym], i, pf.positions.get(sym))
            if sig is None:
                continue
            if sig["action"] == "buy":
                pf.buy(sym, prices[sym], sig["atr"], ts, prices)
            else:
                pf.sell(sym, prices[sym], ts, sig["reason"])
        equity_curve.append(pf.equity(prices))

    return pf, equity_curve, common_ts[common_ts.index(warmup_ts):]


def max_drawdown(curve):
    peak, mdd = curve[0], 0.0
    for v in curve:
        peak = max(peak, v)
        mdd = max(mdd, (peak - v) / peak)
    return mdd * 100


def buy_and_hold(data, timeline):
    """Равные доли трёх монет, куплены в первый бар таймлайна."""
    first, last = timeline[0], timeline[-1]
    total = 0.0
    for sym in strategy.SYMBOLS:
        by_ts = {c["ts"]: c["close"] for c in data[sym]}
        share = START_CASH / len(strategy.SYMBOLS) * (1 - strategy.FEE)
        total += share * by_ts[last] / by_ts[first]
    return (total / START_CASH - 1) * 100


def report(pf, curve, timeline, data):
    final = curve[-1]
    days = (timeline[-1] - timeline[0]) / 86_400_000
    wins = [t for t in pf.trades if t["pnl"] > 0]
    print()
    print(f"Период:            {days:.0f} дней")
    print(f"Старт:             {START_CASH:.2f} USDT")
    print(f"Финиш:             {final:.2f} USDT")
    print(f"Доходность:        {final / START_CASH * 100 - 100:+.1f}%")
    print(f"Buy-and-hold:      {buy_and_hold(data, timeline):+.1f}%  (для сравнения)")
    print(f"Макс. просадка:    -{max_drawdown(curve):.1f}%")
    print(f"Сделок закрыто:    {len(pf.trades)}")
    if pf.trades:
        print(f"Прибыльных:        {len(wins)} ({len(wins) / len(pf.trades) * 100:.0f}%)")
        print(f"Средняя сделка:    {sum(t['pnl_pct'] for t in pf.trades) / len(pf.trades):+.2f}%")
    by_reason = {}
    for t in pf.trades:
        by_reason.setdefault(t["reason"], []).append(t["pnl"])
    for reason, pnls in sorted(by_reason.items()):
        print(f"  выходов «{reason}»: {len(pnls)}, суммарно {sum(pnls):+.1f} USDT")


if __name__ == "__main__":
    hours = int(sys.argv[1]) if len(sys.argv) > 1 else 9000
    cache_dir = os.environ.get("BACKTEST_CACHE")
    data = load_data(hours, cache_dir)
    pf, curve, timeline = run(data)
    report(pf, curve, timeline, data)
