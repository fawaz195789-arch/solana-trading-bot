export default async function handler(req, res) {
  try {

    // =========================
    // LOAD OKX MARKET DATA
    // =========================

    const response = await fetch(
      "https://www.okx.com/api/v5/market/candles?instId=SOL-USDC&bar=5m&limit=100"
    );

    const result = await response.json();

    if (
      result.code !== "0" ||
      !Array.isArray(result.data) ||
      result.data.length < 30
    ) {
      return res.status(500).json({
        status: "error",
        riskApproved: false,
        message: "Failed to load enough OKX market data"
      });
    }


    // OKX returns newest candle first
    const candles = [...result.data].reverse();

    const closes = candles
      .map(c => Number(c[4]))
      .filter(Number.isFinite);


    if (closes.length < 30) {
      return res.status(500).json({
        status: "error",
        riskApproved: false,
        message: "Not enough valid candles"
      });
    }


    // =========================
    // PRICE DATA
    // =========================

    const currentPrice =
      closes[closes.length - 1];

    const previousPrice =
      closes[closes.length - 6];


    if (
      !Number.isFinite(currentPrice) ||
      !Number.isFinite(previousPrice) ||
      previousPrice <= 0
    ) {
      return res.status(500).json({
        status: "error",
        riskApproved: false,
        message: "Invalid market prices"
      });
    }


    // =========================
    // MOVING AVERAGES
    // =========================

    const sma10 =
      closes
        .slice(-10)
        .reduce((a, b) => a + b, 0) / 10;

    const sma30 =
      closes
        .slice(-30)
        .reduce((a, b) => a + b, 0) / 30;


    // =========================
    // MOMENTUM
    // =========================

    const momentum =
      ((currentPrice - previousPrice) /
        previousPrice) * 100;


    // =========================
    // SHORT-TERM VOLATILITY
    // =========================

    const recentCloses =
      closes.slice(-12);

    const changes = [];

    for (let i = 1; i < recentCloses.length; i++) {

      const previous =
        recentCloses[i - 1];

      const current =
        recentCloses[i];

      if (previous > 0) {

        changes.push(
          Math.abs(
            ((current - previous) /
              previous) * 100
          )
        );

      }

    }

    const volatility =
      changes.length > 0
        ? changes.reduce(
            (a, b) => a + b,
            0
          ) / changes.length
        : 0;


    // =========================
    // MARKET SIGNAL
    // =========================

    let marketDecision = "WAIT";
    let confidence = 50;


    // BUY conditions
    if (
      sma10 > sma30 &&
      momentum > 0.15
    ) {

      marketDecision = "BUY";

      confidence = Math.min(
        90,
        Math.round(
          65 + momentum * 10
        )
      );

    }


    // SELL conditions
    else if (
      sma10 < sma30 &&
      momentum < -0.15
    ) {

      marketDecision = "SELL";

      confidence = Math.min(
        90,
        Math.round(
          65 +
          Math.abs(momentum) * 10
        )
      );

    }


    // =========================
    // RISK AGENT
    // =========================

    let riskApproved = false;
    let riskDecision = "BLOCK";
    let reason = "No strong trade";


    // No trade if agents say WAIT
    if (marketDecision === "WAIT") {

      reason =
        "Market signal is not strong enough";

    }


    // Minimum confidence
    else if (confidence < 70) {

      reason =
        "Confidence below 70%";

    }


    // Avoid abnormal short-term movement
    else if (Math.abs(momentum) > 3) {

      reason =
        "Momentum too extreme";

    }


    // Avoid unusually volatile market
    else if (volatility > 1.5) {

      reason =
        "Market volatility too high";

    }


    // Passed all checks
    else {

      riskApproved = true;
      riskDecision = "ALLOW";

      reason =
        "Signal passed all risk checks";

    }


    // =========================
    // TRADE SIZE
    // =========================

    // Still only for DRY_RUN.
    // This is NOT a real OKX order size yet.
    const amount =
      riskApproved ? 5 : 0;


    // =========================
    // RESPONSE
    // =========================

    return res.status(200).json({

      status: "ok",

      pair: "SOL-USDC",

      currentPrice:
        Number(currentPrice.toFixed(6)),

      sma10:
        Number(sma10.toFixed(6)),

      sma30:
        Number(sma30.toFixed(6)),

      momentum:
        Number(momentum.toFixed(3)),

      volatility:
        Number(volatility.toFixed(3)),

      marketDecision,

      confidence,

      riskDecision,

      riskApproved,

      amount,

      reason,

      finalStatus:
        riskApproved
          ? "approved_for_dry_run"
          : "no_trade"

    });


  } catch (error) {

    console.error(
      "Risk Agent Error:",
      error
    );

    return res.status(500).json({

      status: "error",

      riskApproved: false,

      message:
        error.message ||
        "Risk Agent failed"

    });

  }
}
