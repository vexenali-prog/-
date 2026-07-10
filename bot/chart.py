"""График стоимости портфеля для сводок. matplotlib опционален:
если его нет (локальный запуск), график просто пропускается."""

import io
from datetime import datetime, timedelta, timezone


def equity_png(history, start_cash):
    """PNG-график по equity_history: [{ts, equity}, ...]. None, если нечего рисовать."""
    if len(history) < 2:
        return None
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        return None

    xs = [datetime.fromtimestamp(p["ts"] / 1000, timezone.utc) + timedelta(hours=4)
          for p in history]
    ys = [p["equity"] for p in history]

    fig, ax = plt.subplots(figsize=(8, 4), dpi=110)
    up = ys[-1] >= start_cash
    ax.plot(xs, ys, color="#16a34a" if up else "#dc2626", linewidth=1.8)
    ax.axhline(start_cash, color="#9ca3af", linestyle="--", linewidth=1,
               label=f"старт {start_cash:.0f} $")
    ax.fill_between(xs, ys, start_cash, alpha=0.12,
                    color="#16a34a" if up else "#dc2626")
    ax.set_title("Стоимость портфеля, $ (время по Баку)")
    ax.legend(loc="best", frameon=False)
    ax.grid(alpha=0.25)
    fig.autofmt_xdate()
    fig.tight_layout()

    buf = io.BytesIO()
    fig.savefig(buf, format="png")
    plt.close(fig)
    return buf.getvalue()
