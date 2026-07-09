"""Виртуальный портфель для paper-трейдинга и бэктеста.

Учитывает комиссию за обе стороны сделки. Размер позиции считается от
риска: (капитал * RISK_PER_TRADE) / дистанция до стопа, с потолком
MAX_POSITION_FRAC от капитала.
"""

from bot import strategy


class Portfolio:
    def __init__(self, cash):
        self.cash = cash
        self.positions = {}  # symbol -> {qty, entry, stop, target, opened_ts}
        self.trades = []

    def equity(self, prices):
        total = self.cash
        for sym, pos in self.positions.items():
            total += pos["qty"] * prices[sym]
        return total

    def position_size(self, price, atr_value, prices):
        eq = self.equity(prices)
        stop_dist = strategy.STOP_ATR * atr_value
        if stop_dist <= 0:
            return 0.0
        qty = (eq * strategy.RISK_PER_TRADE) / stop_dist
        max_notional = eq * strategy.MAX_POSITION_FRAC
        qty = min(qty, max_notional / price)
        cost = qty * price * (1 + strategy.FEE)
        if cost > self.cash:
            qty = self.cash / (price * (1 + strategy.FEE))
        return qty

    def buy(self, symbol, price, atr_value, ts, prices):
        if symbol in self.positions or len(self.positions) >= strategy.MAX_POSITIONS:
            return None
        qty = self.position_size(price, atr_value, prices)
        if qty * price < 10:  # не открываем позиции меньше 10 USDT
            return None
        self.cash -= qty * price * (1 + strategy.FEE)
        pos = {
            "qty": qty,
            "entry": price,
            "stop": price - strategy.STOP_ATR * atr_value,
            "target": price + strategy.TAKE_ATR * atr_value,
            "opened_ts": ts,
        }
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

    def check_stops(self, symbol, high, low, ts):
        """Проверка стопа/тейка внутри свечи. Консервативно: стоп первым."""
        pos = self.positions.get(symbol)
        if pos is None:
            return None
        if low <= pos["stop"]:
            return self.sell(symbol, pos["stop"], ts, "стоп-лосс")
        if high >= pos["target"]:
            return self.sell(symbol, pos["target"], ts, "тейк-профит")
        return None
