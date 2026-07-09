"""Виртуальный портфель для paper-трейдинга и бэктеста.

Каждой монете выделяется равная доля капитала (1/N монет), комиссия
учитывается за обе стороны сделки.
"""

from bot import strategy


class Portfolio:
    def __init__(self, cash):
        self.cash = cash
        self.positions = {}  # symbol -> {qty, entry, opened_ts}
        self.trades = []

    def equity(self, prices):
        total = self.cash
        for sym, pos in self.positions.items():
            total += pos["qty"] * prices[sym]
        return total

    def buy(self, symbol, price, ts, prices):
        if symbol in self.positions:
            return None
        slots_left = len(strategy.SYMBOLS) - len(self.positions)
        budget = min(self.cash / slots_left, self.equity(prices) / len(strategy.SYMBOLS))
        qty = budget / (price * (1 + strategy.FEE))
        if qty * price < 10:  # не открываем позиции меньше 10 USDT
            return None
        self.cash -= qty * price * (1 + strategy.FEE)
        pos = {"qty": qty, "entry": price, "opened_ts": ts}
        self.positions[symbol] = pos
        return pos

    def sell(self, symbol, price, ts, reason):
        pos = self.positions.pop(symbol, None)
        if pos is None:
            return None
        proceeds = pos["qty"] * price * (1 - strategy.FEE)
        cost = pos["qty"] * pos["entry"] * (1 + strategy.FEE)
        self.cash += proceeds
        trade = {
            "symbol": symbol,
            "entry": pos["entry"],
            "exit": price,
            "qty": pos["qty"],
            "pnl": proceeds - cost,
            "pnl_pct": (proceeds / cost - 1) * 100,
            "opened_ts": pos["opened_ts"],
            "closed_ts": ts,
            "reason": reason,
        }
        self.trades.append(trade)
        return trade
