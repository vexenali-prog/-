"""Отправка сообщений в Telegram. Нужны секреты TELEGRAM_BOT_TOKEN и
TELEGRAM_CHAT_ID; без них бот просто печатает сообщение в лог."""

import json
import os
import urllib.request


def send(text):
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        print("[telegram выключен]\n" + text)
        return False
    payload = json.dumps({
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }).encode()
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            ok = json.loads(resp.read().decode()).get("ok", False)
        if not ok:
            print("Telegram вернул ошибку")
        return ok
    except Exception as e:  # уведомление не должно ронять запуск
        print(f"Ошибка отправки в Telegram: {e}")
        return False
