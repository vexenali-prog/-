"""Трендовая стратегия на часовых свечах (следование за трендом).

Идея: держать монету, пока она торгуется выше своей длинной EMA, и сидеть
в кэше, когда ниже. Гистерезис (полоса ±BAND вокруг EMA) защищает от
дёрганья туда-сюда на шуме.

Вход:  close > EMA(700) * (1 + BAND)
Выход: close < EMA(700) * (1 - BAND)

Выбор параметров: бэктест на 2 годах (бычий + медвежий) показал устойчивое
плато период 600-800 / полоса 1-2%; взята середина. На тех же данных
активная стратегия «покупай просадки по RSI» стабильно теряла деньги.

Только лонг, только спот, без плеча. Каждой монете — равная доля капитала.
"""

from bot.indicators import ema

SYMBOLS = ["BTC-USDT", "ETH-USDT", "SOL-USDT"]

EMA_PERIOD = 700   # ~29 дней на часовых свечах
BAND = 0.02        # гистерезис ±2%
FEE = 0.001        # 0.1% за сторону (тейкер на споте)

WARMUP = EMA_PERIOD + 10  # минимум свечей до первого сигнала


def compute(candles):
    closes = [c["close"] for c in candles]
    return {"ema": ema(closes, EMA_PERIOD)}


def signal_at(ind, i, price, position):
    """Сигнал на закрытии свечи i. position = dict позиции или None."""
    e = ind["ema"][i]
    if e is None:
        return None
    if position is None:
        if price > e * (1 + BAND):
            return {"action": "buy"}
        return None
    if price < e * (1 - BAND):
        return {"action": "sell", "reason": "цена ушла под тренд"}
    return None
