"""График капитала для сводок — фирменный тёмный стиль Vexen Capital.

matplotlib опционален: если его нет (локальный запуск), график
пропускается и сводка уходит текстом.
"""

import io
from datetime import datetime, timedelta, timezone

# палитра (тёмная поверхность бренда + служебные цвета)
BG = "#0d1524"        # фон карточки
SURFACE = "#111b2e"   # поле графика
INK = "#e8edf5"       # основной текст
MUTED = "#8b96a8"     # вторичный текст, оси
GOLD = "#c9a227"      # акцент бренда
UP = "#34d399"        # рост
DOWN = "#f87171"      # падение

MONTHS_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн",
                "июл", "авг", "сен", "окт", "ноя", "дек"]


def _fmt_money(x):
    return f"{x:,.0f}".replace(",", " ")


def equity_png(history, start_cash):
    """PNG-график по equity_history: [{ts, equity}, ...]. None, если нечего рисовать."""
    if len(history) < 2:
        return None
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from matplotlib.ticker import FuncFormatter, MaxNLocator
    except ImportError:
        return None

    xs = [datetime.fromtimestamp(p["ts"] / 1000, timezone.utc) + timedelta(hours=4)
          for p in history]
    ys = [p["equity"] for p in history]
    last = ys[-1]
    up = last >= start_cash
    color = UP if up else DOWN
    total_pct = (last / start_cash - 1) * 100

    fig, ax = plt.subplots(figsize=(10, 5), dpi=140)
    fig.patch.set_facecolor(BG)
    ax.set_facecolor(SURFACE)

    # заголовок в шапке карточки
    fig.text(0.045, 0.955, "VEXEN CAPITAL", color=GOLD, fontsize=11,
             fontweight="bold", va="top")
    days = max(1, round((xs[-1] - xs[0]).total_seconds() / 86400))
    fig.text(0.045, 0.905, f"Капитал портфеля · {days} дн наблюдения",
             color=MUTED, fontsize=9, va="top")
    sign = "+" if total_pct >= 0 else "−"
    fig.text(0.955, 0.955, f"{_fmt_money(last)} $", color=INK, fontsize=16,
             fontweight="bold", va="top", ha="right")
    fig.text(0.955, 0.895, f"{sign}{abs(total_pct):.1f}% от старта".replace(".", ","),
             color=color, fontsize=10, va="top", ha="right")

    # линия старта — тихая, пунктиром, с подписью без рамки
    ax.axhline(start_cash, color=MUTED, linestyle=(0, (4, 4)), linewidth=0.9, alpha=0.6)
    ax.annotate(f"старт {_fmt_money(start_cash)} $",
                xy=(xs[0], start_cash), xytext=(2, 7), textcoords="offset points",
                color=MUTED, fontsize=8, zorder=5)

    # сама линия + мягкая заливка к базовой
    ax.plot(xs, ys, color=color, linewidth=2.2, solid_capstyle="round", zorder=3)
    ax.fill_between(xs, ys, start_cash, color=color, alpha=0.10, zorder=2)

    # точка и прямая подпись последнего значения
    ax.scatter([xs[-1]], [last], s=26, color=color, zorder=4,
               edgecolor=BG, linewidth=1.2)
    ax.annotate(f"{_fmt_money(last)} $",
                xy=(xs[-1], last), xytext=(-4, 10), textcoords="offset points",
                color=INK, fontsize=9, fontweight="bold", ha="right")

    # оси: минимум чернил
    for spine in ax.spines.values():
        spine.set_visible(False)
    ax.grid(axis="y", color=INK, alpha=0.07, linewidth=0.8)
    ax.tick_params(colors=MUTED, labelsize=8, length=0)
    ax.yaxis.set_major_locator(MaxNLocator(4))
    ax.yaxis.set_major_formatter(FuncFormatter(lambda v, _: _fmt_money(v)))

    # немного воздуха вокруг линии
    lo, hi = min(min(ys), start_cash), max(max(ys), start_cash)
    pad = (hi - lo) * 0.15 or 1
    ax.set_ylim(lo - pad, hi + pad * 1.4)

    # даты по-русски, немного меток
    ax.xaxis.set_major_locator(MaxNLocator(6))
    def fmt_date(v, _):
        d = matplotlib.dates.num2date(v)
        return f"{d.day} {MONTHS_SHORT[d.month - 1]}"
    ax.xaxis.set_major_formatter(FuncFormatter(fmt_date))

    fig.subplots_adjust(left=0.075, right=0.965, top=0.82, bottom=0.09)

    buf = io.BytesIO()
    fig.savefig(buf, format="png", facecolor=BG)
    plt.close(fig)
    return buf.getvalue()
