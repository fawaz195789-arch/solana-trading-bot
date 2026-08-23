const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;

const JUPITER_QUOTE_URL = "https://api.jup.ag/swap/v1/quote";
const JUPITER_SWAP_URL = "https://api.jup.ag/swap/v1/swap";

function jupiterHeaders() {
  const headers = {
    "Content-Type": "application/json"
  };

  if (process.env.JUPITER_API_KEY) {
    headers["x-api-key"] = process.env.JUPITER_API_KEY;
  }

  return headers;
}

function toAtomicAmount(amount, decimals) {
  const numericAmount = Number(amount);

  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error("Invalid amount");
  }

  return Math.floor(
    numericAmount * Math.pow(10, decimals)
  ).toString();
}

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
      amount,
      walletAddress
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
    // WAIT / HOLD
    // =========================

    if (
      normalizedDecision === "WAIT" ||
      normalizedDecision === "HOLD"
    ) {
      return res.status(200).json({
        status: "ok",
        executed: false,
        decision: "HOLD",
        message: "No trade requested."
      });
    }

    // =========================
    // BUY / SELL ONLY
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
        reason: "LOW_CONFIDENCE",
        confidence: confidenceNumber,
        message:
          "Trade blocked because confidence is below 70%."
      });
    }

    // =========================
    // RISK APPROVAL
    // =========================

    if (riskApproved !== true) {
      return res.status(200).json({
        status: "blocked",
        executed: false,
        reason: "RISK_REJECTED",
        message: "Trade blocked by Risk Agent."
      });
    }

    // =========================
    // WALLET
    // =========================

    if (
      !walletAddress ||
      typeof walletAddress !== "string" ||
      walletAddress.length < 30
    ) {
      return res.status(400).json({
        status: "error",
        executed: false,
        message: "Valid walletAddress required"
      });
    }

    // =========================
    // AMOUNT
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

    let inputMint;
    let outputMint;
    let atomicAmount;

    // BUY:
    // USDC -> SOL
    if (normalizedDecision === "BUY") {
      inputMint = USDC_MINT;
      outputMint = SOL_MINT;

      atomicAmount = toAtomicAmount(
        amountNumber,
        USDC_DECIMALS
      );
    }

    // SELL:
    // SOL -> USDC
    if (normalizedDecision === "SELL") {
      inputMint = SOL_MINT;
      outputMint = USDC_MINT;

      atomicAmount = toAtomicAmount(
        amountNumber,
        SOL_DECIMALS
      );
    }

    // =========================
    // GET JUPITER QUOTE
    // =========================

    const quoteParams =
      new URLSearchParams({
        inputMint,
        outputMint,
        amount: atomicAmount,
        slippageBps: "100"
      });

    const quoteResponse = await fetch(
      `${JUPITER_QUOTE_URL}?${quoteParams.toString()}`,
      {
        method: "GET",
        headers: jupiterHeaders()
      }
    );

    const quote = await quoteResponse.json();

    if (!quoteResponse.ok) {
      console.error("Jupiter Quote Error:", quote);

      return res.status(502).json({
        status: "error",
        executed: false,
        message: "Failed to get Jupiter quote",
        details: quote
      });
    }

    if (!quote?.outAmount) {
      return res.status(502).json({
        status: "error",
        executed: false,
        message: "Invalid Jupiter quote"
      });
    }

    // =========================
    // BUILD SWAP TRANSACTION
    // =========================

    const swapResponse = await fetch(
      JUPITER_SWAP_URL,
      {
        method: "POST",
        headers: jupiterHeaders(),
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: walletAddress,

          wrapAndUnwrapSol: true,

          dynamicComputeUnitLimit: true,

          prioritizationFeeLamports: {
            priorityLevelWithMaxLamports: {
              maxLamports: 1000000,
              priorityLevel: "medium"
            }
          }
        })
      }
    );

    const swapData =
      await swapResponse.json();

    if (!swapResponse.ok) {
      console.error(
        "Jupiter Swap Error:",
        swapData
      );

      return res.status(502).json({
        status: "error",
        executed: false,
        message:
          "Failed to build Jupiter swap",
        details: swapData
      });
    }

    if (!swapData?.swapTransaction) {
      return res.status(502).json({
        status: "error",
        executed: false,
        message:
          "Jupiter did not return swapTransaction"
      });
    }

    // =========================
    // RETURN UNSIGNED /
    // USER-SIGNABLE TRANSACTION
    // =========================

    return res.status(200).json({
      status: "ok",

      executed: false,

      requiresWalletApproval: true,

      decision:
        normalizedDecision,

      confidence:
        confidenceNumber,

      amount:
        amountNumber,

      inputMint,
      outputMint,

      quote: {
        inAmount:
          quote.inAmount,

        outAmount:
          quote.outAmount,

        priceImpactPct:
          quote.priceImpactPct || null,

        slippageBps:
          quote.slippageBps || 100
      },

      swapTransaction:
        swapData.swapTransaction,

      lastValidBlockHeight:
        swapData.lastValidBlockHeight || null,

      message:
        "Trade prepared. Wallet approval is required before broadcasting."
    });

  } catch (error) {
    console.error(
      "Execution Agent Error:",
      error
    );

    return res.status(500).json({
      status: "error",
      executed: false,
      message:
        error?.message ||
        "Execution Agent failed"
    });
  }
}
