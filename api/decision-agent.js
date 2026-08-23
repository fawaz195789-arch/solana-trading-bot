export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      status: "error",
      message: "POST only"
    });
  }

  try {
    const {
      currentPrice,
      sma10,
      sma30,
      momentum
    } = req.body || {};

    const price = Number(currentPrice);
    const shortMA = Number(sma10);
    const longMA = Number(sma30);
    const mom = Number(momentum);

    if (
      !Number.isFinite(price) ||
      !Number.isFinite(shortMA) ||
      !Number.isFinite(longMA) ||
      !Number.isFinite(mom)
    ) {
      return res.status(400).json({
        status: "error",
        message: "Invalid market data"
      });
    }

    let decision = "HOLD";
    let confidence = 60;
    let reason = "No strong setup.";

    // =========================
    // BUY
    // =========================

    if (
      shortMA > longMA &&
      mom > 0.15
    ) {
      decision = "BUY";

      confidence =
        mom > 0.35 ? 85 : 75;

      reason =
        "Bullish SMA crossover with positive momentum.";
    }

    // =========================
    // SELL
    // =========================

    else if (
      shortMA < longMA &&
      mom < -0.15
    ) {
      decision = "SELL";

      confidence =
        mom < -0.35 ? 85 : 75;

      reason =
        "Bearish SMA crossover with negative momentum.";
    }

    return res.status(200).json({
      status: "ok",
      pair: "SOL-USDC",
      decision,
      confidence,
      reason,
      market: {
        currentPrice: price,
        sma10: shortMA,
        sma30: longMA,
        momentum: mom
      },
      createdAt: new Date().toISOString()
    });

  } catch (error) {
    console.error(
      "Decision Agent Error:",
      error
    );

    return res.status(500).json({
      status: "error",
      message:
        error?.message ||
        "Decision Agent failed"
    });
  }
}
