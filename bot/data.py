"""Загрузка свечей с публичного API OKX (без ключей).

Цены пар BTC/ETH/SOL-USDT на OKX совпадают с Bybit с точностью до сотых
процента, а API OKX доступен и отсюда, и из GitHub Actions.
"""

import json
import time
import urllib.request

BASE = "https://www.okx.com"


def _get(path, params, retries=4):
    query = "&".join(f"{k}={v}" for k, v in params.items())
    req = urllib.request.Request(
        f"{BASE}{path}?{query}",
        headers={"User-Agent": "paper-trading-bot/1.0"},
    )
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                payload = json.loads(resp.read().decode())
            if payload.get("code") != "0":
                raise RuntimeError(f"OKX API error: {payload.get('msg')} ({payload.get('code')})")
            return payload["data"]
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if attempt == retries:
                raise
            time.sleep(2 ** attempt * 2)  # 2, 4, 8, 16 секунд


def _parse(rows, confirmed_only=True):
    candles = []
    for row in rows:
        # [ts, open, high, low, close, vol, volCcy, volCcyQuote, confirm]
        if confirmed_only and row[8] != "1":
            continue
        candles.append({
            "ts": int(row[0]),
            "open": float(row[1]),
            "high": float(row[2]),
            "low": float(row[3]),
            "close": float(row[4]),
            "volume": float(row[5]),
        })
    return candles


def fetch_recent(inst_id, bar="1H", limit=300):
    """Последние свечи (новые → старые у API; возвращаем старые → новые)."""
    rows = _get("/api/v5/market/candles", {"instId": inst_id, "bar": bar, "limit": limit})
    return sorted(_parse(rows), key=lambda c: c["ts"])


def fetch_history(inst_id, bar="1H", total=9000, confirmed_only=False):
    """Глубокая история постранично через history-candles (100 свечей за запрос).

    confirmed_only=True отбрасывает текущую незакрытую свечу — обязательно
    для живых сигналов, иначе решение принимается по недорисованной свече.
    """
    candles = []
    after = ""
    while len(candles) < total:
        params = {"instId": inst_id, "bar": bar, "limit": 100}
        if after:
            params["after"] = after
        rows = _get("/api/v5/market/history-candles", params)
        if not rows:
            break
        batch = _parse(rows, confirmed_only=confirmed_only)
        candles.extend(batch)
        after = rows[-1][0]  # самая старая метка в пачке
        time.sleep(0.25)  # лимит OKX: 10 запросов / 2 сек
    return sorted(candles, key=lambda c: c["ts"])
