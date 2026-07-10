"""Отправка сообщений в Telegram. Нужны секреты TELEGRAM_BOT_TOKEN и
TELEGRAM_CHAT_ID; без них бот просто печатает сообщение в лог."""

import json
import os
import urllib.request


def send(text):
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    # сообщения шлём только из GitHub Actions: локальные и тестовые
    # запуски не должны беспокоить владельца фантомными сделками
    if os.environ.get("GITHUB_ACTIONS") != "true":
        print("[локальный запуск — telegram выключен]\n" + text)
        return False
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


def send_photo(png_bytes, caption=""):
    """Фото с подписью. Multipart собираем вручную, чтобы не тянуть requests."""
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if os.environ.get("GITHUB_ACTIONS") != "true" or not token or not chat_id:
        print(f"[telegram выключен] фото {len(png_bytes)} байт: {caption}")
        return False
    boundary = "----botboundary7351"
    parts = b""
    for name, value in (("chat_id", chat_id), ("caption", caption), ("parse_mode", "HTML")):
        parts += (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
        ).encode()
    parts += (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"photo\"; "
        f"filename=\"chart.png\"\r\nContent-Type: image/png\r\n\r\n"
    ).encode() + png_bytes + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendPhoto",
        data=parts,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode()).get("ok", False)
    except Exception as e:
        print(f"Ошибка отправки фото: {e}")
        return False
