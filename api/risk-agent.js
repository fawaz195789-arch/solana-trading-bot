export default async function handler(req, res) {
  try {
    const response = await fetch(
      "https://www.okx.com/api/v5/market/candles?instId=SOL-USDC&bar=5m&limit=100"
    );

    const result = await response.json();

    if (result.code !== "0" || !result.data) {
      return res.status(500).json({
        status: "error",
        message: "Failed to load OKX market data"
      });
    }

    const candles = result.data.reverse();
    const closes = candles.map(c => Number(c[4]));

    const currentPrice = closes[closes.length - 1];

    const sma10 =
      closes.slice(-10).reduce((a, b) => a + b, 0) / 10;

    const sma30 =
      closes.slice(-30).reduce((a, b) => a + b, 0) / 30;

    const previousPrice = closes[closes.length - 6];

    const momentum =
      ((currentPrice - previousPrice) / previousPrice) * 100;

    let marketDecision = "WAIT";
    let confidence = 50;

    if (sma10 > sma30 && momentum > 0.15) {
      marketDecision = "BUY";
      confidence = Math.min(
        90,
        Math.round(65 + momentum * 10)
      );
    } else if (sma10 < sma30 && momentum < -0.15) {
      marketDecision = "SELL";
      confidence = Math.min(
        90,
        Math.round(65 + Math.abs(momentum) * 10)
      );
    }

    let riskDecision = "BLOCK";
    let reason = "No strong trade";

    if (
      marketDecision !== "WAIT" &&
      confidence >= 70
    ) {
      riskDecision = "ALLOW";
      reason = "Signal passed risk checks";
    }

    return res.status(200).json({
      status: "ok",
      pair: "SOL-USDC",
      currentPrice,
      marketDecision,
      confidence,
      momentum: Number(momentum.toFixed(3)),
      riskDecision,
      amount: riskDecision === "ALLOW" ? 5 : 0,
      reason,
      finalStatus:
        riskDecision === "ALLOW"
          ? "waiting_approval"
          : "no_trade"
    });

  } catch (error) {
    return res.status(500).json({
      status: "error",
      message: error.message
    });
  }
}
