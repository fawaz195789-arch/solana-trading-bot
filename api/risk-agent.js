export default async function handler(req, res) {
  try {
    const host = req.headers.host;
    const protocol = host.includes("localhost") ? "http" : "https";

    const response = await fetch(
      `${protocol}://${host}/api/api/market-agent`
    );

    const data = await response.json();

    if (data.status !== "ok") {
      return res.status(500).json({
        status: "error",
        message: "Market Agent unavailable"
      });
    }

    const signal = data.signal;

    let riskDecision = "BLOCK";
    let reason = "Signal is not strong enough";

    if (signal.action === "WAIT") {
      riskDecision = "BLOCK";
      reason = "Market Agent recommends waiting";
    } else if (signal.confidence >= 70) {
      riskDecision = "ALLOW";
      reason = "Signal passed risk checks";
    }

    return res.status(200).json({
      status: "ok",
      pair: "SOL-USDC",
      marketDecision: signal.action,
      confidence: signal.confidence,
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
