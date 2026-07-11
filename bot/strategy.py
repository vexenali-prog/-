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

# Торгуемые монеты. Ядро — топ по капитализации (на 4.2 годах истории
# +237% при просадке -27%). SUI/ARB/XLM добавлены по скринингу 14
# кандидатов: каждая в одиночку обыгрывает «купи и держи», а корзина
# из 9 монет на общем 2-летнем окне даёт +116% против +82% у шестёрки
# при той же просадке. Мелкие шумные альты по-прежнему в игнор-листе:
# корзина из всех 13 старых монет давала лишь +9.8% при просадке -48%.
SYMBOLS = [
    "BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "DOGE-USDT", "TRX-USDT",
    "SUI-USDT", "ARB-USDT", "XLM-USDT",
]

# Наблюдаемые монеты: показываются в меню (цены, тренд), но не торгуются.
# GRAM (бывший TON) залистлен на OKX заново в июне 2026 — истории мало,
# тренд появится, когда накопится ~30 дней свечей.
WATCHLIST = SYMBOLS + [
    "ADA-USDT", "LINK-USDT", "AVAX-USDT", "DOT-USDT", "LTC-USDT",
    "BCH-USDT", "ETC-USDT", "GRAM-USDT",
    "PEPE-USDT", "BNB-USDT", "NEAR-USDT", "HBAR-USDT", "UNI-USDT", "TAO-USDT",
]

EMA_PERIOD = 700   # ~29 дней на часовых свечах
BAND = 0.02        # гистерезис ±2%
FEE = 0.001        # 0.1% за сторону (тейкер на споте)

# Защита. На 2 годах истории тройка «BTC-фильтр + трейлинг + стоп» подняла
# доходность корзины с +67% до +83.5% и снизила просадку с -35% до -27%.
# Соседние значения параметров дают близкие результаты (эффект устойчив).
STOP = 0.10    # стоп-лосс: выход при -10% от входа
TRAIL = 0.20   # трейлинг-стоп: выход при -20% от максимума с момента входа
BTC_FILTER = True  # покупки только когда BTC выше своей EMA

WARMUP = EMA_PERIOD + 10  # минимум свечей до первого сигнала


def compute(candles):
    closes = [c["close"] for c in candles]
    return {"ema": ema(closes, EMA_PERIOD)}


def market_ok(btc_price, btc_ema):
    """BTC-фильтр: когда биткоин ниже своего тренда, новые покупки запрещены."""
    if not BTC_FILTER:
        return True
    return btc_ema is not None and btc_price > btc_ema


def signal_at(ind, i, price, position, allow_buy=True):
    """Сигнал на закрытии свечи i. position = dict позиции или None.

    Вызывающий обновляет position["high"] (максимум с входа) и после
    выхода по стопу не покупает снова, пока цена не «перезарядится» —
    не уйдёт под полосу покупки (иначе бот тут же откупит на пике).
    """
    e = ind["ema"][i]
    if e is None:
        return None
    if position is None:
        if allow_buy and price > e * (1 + BAND):
            return {"action": "buy"}
        return None
    if price < e * (1 - BAND):
        return {"action": "sell", "reason": "цена ушла под тренд"}
    if STOP and price < position["entry"] * (1 - STOP):
        return {"action": "sell", "reason": f"стоп-лосс: -{STOP:.0%} от входа", "stop": True}
    high = position.get("high") or position["entry"]
    if TRAIL and price < high * (1 - TRAIL):
        return {"action": "sell", "reason": f"трейлинг-стоп: -{TRAIL:.0%} от пика", "stop": True}
    return None
