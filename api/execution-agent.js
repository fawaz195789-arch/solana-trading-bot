export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({
      status: "error",
      message: "POST only"
    });
  }

  try {

    const {
      decision,
      confidence,
      riskApproved,
      symbol = "SOL-USDC",
      amount = 0
    } = req.body || {};


    // =========================
    // VALIDATION
    // =========================

    if (!decision) {
      return res.status(400).json({
        status: "error",
        message: "Decision missing"
      });
    }

    const normalizedDecision =
      String(decision).toUpperCase();


    // =========================
    // WAIT = NO TRADE
    // =========================

    if (normalizedDecision === "WAIT") {

      return res.status(200).json({
        status: "ok",
        executed: false,
        mode: "DRY_RUN",
        decision: "WAIT",
        message: "No trade. Agents decided to wait."
      });

    }


    // =========================
    // ALLOW ONLY BUY / SELL
    // =========================

    if (
      normalizedDecision !== "BUY" &&
      normalizedDecision !== "SELL"
    ) {

      return res.status(400).json({
        status: "error",
        executed: false,
        message: "Invalid decision"
      });

    }


    // =========================
    // CONFIDENCE CHECK
    // =========================

    const confidenceNumber =
      Number(confidence);

    if (
      !Number.isFinite(confidenceNumber) ||
      confidenceNumber < 70
    ) {

      return res.status(200).json({
        status: "blocked",
        executed: false,
        mode: "DRY_RUN",
        reason: "LOW_CONFIDENCE",
        confidence: confidenceNumber,
        message: "Trade blocked because confidence is below 70%."
      });

    }


    // =========================
    // RISK AGENT APPROVAL
    // =========================

    if (riskApproved !== true) {

      return res.status(200).json({
        status: "blocked",
        executed: false,
        mode: "DRY_RUN",
        reason: "RISK_REJECTED",
        message: "Trade blocked by Risk Agent."
      });

    }


    // =========================
    // AMOUNT SAFETY CHECK
    // =========================

    const amountNumber =
      Number(amount);

    if (
      !Number.isFinite(amountNumber) ||
      amountNumber <= 0
    ) {

      return res.status(400).json({
        status: "error",
        executed: false,
        message: "Invalid trade amount"
      });

    }


    // =========================
    // DRY RUN ONLY
    // NO REAL OKX ORDER HERE
    // =========================

    const simulatedOrder = {
      symbol,
      side: normalizedDecision,
      amount: amountNumber,
      confidence: confidenceNumber,
      riskApproved: true
    };


    return res.status(200).json({
      status: "ok",
      executed: false,
      mode: "DRY_RUN",
      approved: true,
      order: simulatedOrder,
      message:
        "Trade passed all checks. Simulation only — no real OKX order was sent."
    });


  } catch (error) {

    console.error("Execution Agent Error:", error);

    return res.status(500).json({
      status: "error",
      executed: false,
      message: "Execution Agent failed"
    });

  }

}
