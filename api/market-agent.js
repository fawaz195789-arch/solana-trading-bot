export default async function handler(req, res) {
  try {
    // بيانات SOL/USDC من OKX
    const response = await fetch(
      "https://www.okx.com/api/v5/market/candles?instId=SOL-USDC&bar=5m&limit=100"
    );

    const result = await response.json();

    if (result.code !== "0" || !result.data) {
      return res.status(500).json({
        status: "error",
        message: "Failed to load market data"
      });
    }

    // OKX يعيد الأحدث أولاً، نعكسها
    const candles = result.data.reverse();

    const closes = candles.map(c => Number(c[4]));

    // متوسط 10 شمعات
    const sma10 =
      closes.slice(-10).reduce((a, b) => a + b, 0) / 10;

    // متوسط 30 شمعة
    const sma30 =
      closes.slice(-30).reduce((a, b) => a + b, 0) / 30;

    const currentPrice = closes[closes.length - 1];

    // زخم آخر 5 شمعات
    const previousPrice = closes[closes.length - 6];

    const momentum =
      ((currentPrice - previousPrice) / previousPrice) * 100;

    let action = "WAIT";
    let confidence = 50;
    let reason = "No strong setup";

    // إشارة شراء
    if (sma10 > sma30 && momentum > 0.15) {
      action = "BUY";

      confidence = Math.min(
        90,
        Math.round(65 + momentum * 10)
      );

      reason =
        "Short-term trend is above long-term trend with positive momentum";
    }

    // إشارة بيع
    else if (sma10 < sma30 && momentum < -0.15) {
      action = "SELL";

      confidence = Math.min(
        90,
        Math.round(65 + Math.abs(momentum) * 10)
      );

      reason =
        "Short-term trend is below long-term trend with negative momentum";
    }

    return res.status(200).json({
      status: "ok",

      signal: {
        signalId: crypto.randomUUID(),

        pair: "SOL-USDC",

        action,

        amount: 5,

        currency: "USDC",

        confidence,

        currentPrice,

        sma10,

        sma30,

        momentum: Number(momentum.toFixed(3)),

        reason,

        status:
          action === "WAIT"
            ? "no_trade"
            : "waiting_approval",

        createdAt: new Date().toISOString()
      }
    });

  } catch (error) {
    return res.status(500).json({
      status: "error",
      message: error.message
    });
  }
}
