"""Стратегия: покупка просадок внутри восходящего тренда, часовые свечи.

Вход (только лонг, только спот):
  - тренд вверх: EMA50 > EMA200
  - перепроданность: RSI14 < 35

Выход:
  - стоп-лосс: цена <= вход - 2*ATR14 (на момент входа)
  - тейк-профит: цена >= вход + 2.5*ATR14
  - перегрев: RSI14 > 70
  - слом тренда: EMA50 < EMA200
"""

from bot.indicators import atr, ema, rsi

SYMBOLS = ["BTC-USDT", "ETH-USDT", "SOL-USDT"]

EMA_FAST = 50
EMA_SLOW = 200
RSI_PERIOD = 14
ATR_PERIOD = 14
RSI_BUY = 35
RSI_SELL = 70
STOP_ATR = 2.0
TAKE_ATR = 2.5

RISK_PER_TRADE = 0.015   # риск на сделку: 1.5% капитала
MAX_POSITION_FRAC = 0.30  # максимум 30% капитала в одной монете
MAX_POSITIONS = 3
FEE = 0.001               # 0.1% за сторону (тейкер на споте)

WARMUP = EMA_SLOW + 10  # минимум свечей до первого сигнала


def compute(candles):
    closes = [c["close"] for c in candles]
    highs = [c["high"] for c in candles]
    lows = [c["low"] for c in candles]
    return {
        "ema_fast": ema(closes, EMA_FAST),
        "ema_slow": ema(closes, EMA_SLOW),
        "rsi": rsi(closes, RSI_PERIOD),
        "atr": atr(highs, lows, closes, ATR_PERIOD),
    }


def signal_at(ind, i, position):
    """Сигнал на закрытии свечи i. position = dict позиции или None."""
    ef, es = ind["ema_fast"][i], ind["ema_slow"][i]
    r, a = ind["rsi"][i], ind["atr"][i]
    if None in (ef, es, r, a):
        return None
    uptrend = ef > es
    if position is None:
        if uptrend and r < RSI_BUY:
            return {"action": "buy", "atr": a}
        return None
    if r > RSI_SELL:
        return {"action": "sell", "reason": "RSI перегрет"}
    if not uptrend:
        return {"action": "sell", "reason": "слом тренда"}
    return None
