export default async function handler(req, res) {
  try {
    const host = req.headers.host;
    const protocol = host.includes("localhost") ? "http" : "https";

    const response = await fetch(
      `${protocol}://${host}/api/risk-agent`
    );

    const risk = await response.json();

    if (risk.status !== "ok") {
      return res.status(500).json({
        status: "error",
        message: "Risk Agent unavailable"
      });
    }

    let decision = "WAIT";
    let needsApproval = false;

    if (
      risk.riskDecision === "ALLOW" &&
      risk.marketDecision === "BUY"
    ) {
      decision = "BUY";
      needsApproval = true;
    }

    if (
      risk.riskDecision === "ALLOW" &&
      risk.marketDecision === "SELL"
    ) {
      decision = "SELL";
      needsApproval = true;
    }

    return res.status(200).json({
      status: "ok",
      pair: "SOL-USDC",
      decision,
      confidence: risk.confidence,
      amount: needsApproval ? 5 : 0,
      currency: "USDC",
      needsApproval,
      message: needsApproval
        ? "Trade ready for approval"
        : "No trade",
      createdAt: new Date().toISOString()
    });

  } catch (error) {
    return res.status(500).json({
      status: "error",
      message: error.message
    });
  }
}
