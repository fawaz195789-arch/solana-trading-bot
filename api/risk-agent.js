const SOL_FLOOR = 0.1;

const MAX_BUY_USDC = 5;
const MAX_SELL_SOL = 1;

const MAX_VOLATILITY = 1.5;
const MAX_MOMENTUM = 3;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      status: "error",
      riskApproved: false,
      message: "POST only"
    });
  }

  try {
    const {
      decision,
      confidence,
      amount,
      solBalance,
      usdcBalance,
      momentum = 0,
      volatility = 0
    } = req.body || {};

    const side = String(decision || "").toUpperCase();

    const confidenceNumber = Number(confidence);
    const amountNumber = Number(amount);
    const sol = Number(solBalance);
    const usdc = Number(usdcBalance);
    const momentumNumber = Number(momentum);
    const volatilityNumber = Number(volatility);

    if (
      side !== "BUY" &&
      side !== "SELL"
    ) {
      return res.status(200).json({
        status: "ok",
        riskApproved: false,
        riskDecision: "BLOCK",
        reason: "No BUY or SELL decision"
      });
    }

    if (
      !Number.isFinite(confidenceNumber) ||
      confidenceNumber < 70
    ) {
      return res.status(200).json({
        status: "ok",
        riskApproved: false,
        riskDecision: "BLOCK",
        reason: "Confidence below 70%"
      });
    }

    if (
      !Number.isFinite(amountNumber) ||
      amountNumber <= 0
    ) {
      return res.status(200).json({
        status: "ok",
        riskApproved: false,
        riskDecision: "BLOCK",
        reason: "Invalid trade amount"
      });
    }

    if (
      !Number.isFinite(sol) ||
      !Number.isFinite(usdc)
    ) {
      return res.status(200).json({
        status: "ok",
        riskApproved: false,
        riskDecision: "BLOCK",
        reason: "Invalid wallet balances"
      });
    }

    if (
      Number.isFinite(momentumNumber) &&
      Math.abs(momentumNumber) > MAX_MOMENTUM
    ) {
      return res.status(200).json({
        status: "ok",
        riskApproved: false,
        riskDecision: "BLOCK",
        reason: "Momentum too extreme"
      });
    }

    if (
      Number.isFinite(volatilityNumber) &&
      volatilityNumber > MAX_VOLATILITY
    ) {
      return res.status(200).json({
        status: "ok",
        riskApproved: false,
        riskDecision: "BLOCK",
        reason: "Market volatility too high"
      });
    }

    // =========================
    // BUY
    // =========================

    if (side === "BUY") {
      if (amountNumber > MAX_BUY_USDC) {
        return res.status(200).json({
          status: "ok",
          riskApproved: false,
          riskDecision: "BLOCK",
          reason:
            `BUY amount exceeds ${MAX_BUY_USDC} USDC limit`
        });
      }

      if (usdc < amountNumber) {
        return res.status(200).json({
          status: "ok",
          riskApproved: false,
          riskDecision: "BLOCK",
          reason: "Not enough USDC"
        });
      }
    }

    // =========================
    // SELL
    // =========================

    if (side === "SELL") {
      if (amountNumber > MAX_SELL_SOL) {
        return res.status(200).json({
          status: "ok",
          riskApproved: false,
          riskDecision: "BLOCK",
          reason:
            `SELL amount exceeds ${MAX_SELL_SOL} SOL limit`
        });
      }

      if (sol < amountNumber) {
        return res.status(200).json({
          status: "ok",
          riskApproved: false,
          riskDecision: "BLOCK",
          reason: "Not enough SOL"
        });
      }

      const remainingSol =
        sol - amountNumber;

      if (remainingSol < SOL_FLOOR) {
        return res.status(200).json({
          status: "ok",
          riskApproved: false,
          riskDecision: "BLOCK",
          reason:
            `SOL balance would fall below ${SOL_FLOOR}`
        });
      }
    }

    return res.status(200).json({
      status: "ok",
      riskApproved: true,
      riskDecision: "ALLOW",
      decision: side,
      amount: amountNumber,
      confidence: confidenceNumber,
      balances: {
        sol,
        usdc
      },
      reason:
        "Trade passed all risk checks"
    });

  } catch (error) {
    console.error(
      "Risk Agent Error:",
      error
    );

    return res.status(500).json({
      status: "error",
      riskApproved: false,
      riskDecision: "BLOCK",
      message:
        error?.message ||
        "Risk Agent failed"
    });
  }
}
