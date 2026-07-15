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
        budget = min(self.cash, self.equity(prices) / len(strategy.SYMBOLS))
        qty = budget / (price * (1 + strategy.FEE))
        if qty * price < 10:  # не открываем позиции меньше 10 USDT
            return None
        self.cash -= qty * price * (1 + strategy.FEE)
        pos = {"qty": qty, "entry": price, "opened_ts": ts, "high": price}
        self.positions[symbol] = pos
        return pos

    def add_to(self, symbol, price, ts, prices):
        """Пирамидинг: докупка PYRAMID_FRAC стандартной доли, один раз.

        Вход усредняется — стоп-лосс дальше считается от среднего входа.
        Возвращает (кол-во, потрачено) или None.
        """
        pos = self.positions.get(symbol)
        if pos is None or pos.get("pyramided"):
            return None
        budget = min(self.cash,
                     self.equity(prices) / len(strategy.SYMBOLS) * strategy.PYRAMID_FRAC)
        qty = budget / (price * (1 + strategy.FEE))
        if qty * price < 10:
            return None
        spent = qty * price * (1 + strategy.FEE)
        self.cash -= spent
        total = pos["qty"] + qty
        pos["entry"] = (pos["entry"] * pos["qty"] + price * qty) / total
        pos["qty"] = total
        pos["pyramided"] = True
        return qty, spent

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
