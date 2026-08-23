const USDC_MINT =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const RPC_URL =
  "https://api.mainnet-beta.solana.com";

const BUY_USDC_AMOUNT = 0.5;
const SELL_SOL_AMOUNT = 0.005;

const SOL_FLOOR = 0.1;
const MIN_USDC_TO_BUY = 0.55;


// =========================
// MARKET DATA
// =========================

async function getMarketData() {
  const response = await fetch(
    "https://www.okx.com/api/v5/market/candles?instId=SOL-USDC&bar=5m&limit=100"
  );

  const result = await response.json();

  if (
    !response.ok ||
    result.code !== "0" ||
    !Array.isArray(result.data) ||
    result.data.length < 30
  ) {
    throw new Error(
      "Failed to load market candles"
    );
  }

  const closes = [...result.data]
    .reverse()
    .map((candle) => Number(candle[4]))
    .filter(Number.isFinite);

  if (closes.length < 30) {
    throw new Error(
      "Not enough valid candles"
    );
  }

  const currentPrice =
    closes[closes.length - 1];

  const previousPrice =
    closes[closes.length - 6];

  if (
    !Number.isFinite(currentPrice) ||
    !Number.isFinite(previousPrice) ||
    previousPrice <= 0
  ) {
    throw new Error(
      "Invalid market prices"
    );
  }

  const sma10 =
    closes
      .slice(-10)
      .reduce((a, b) => a + b, 0) / 10;

  const sma30 =
    closes
      .slice(-30)
      .reduce((a, b) => a + b, 0) / 30;

  const momentum =
    ((currentPrice - previousPrice) /
      previousPrice) *
    100;

  const recentCloses =
    closes.slice(-12);

  const changes = [];

  for (
    let i = 1;
    i < recentCloses.length;
    i++
  ) {
    const previous =
      recentCloses[i - 1];

    const current =
      recentCloses[i];

    if (previous > 0) {
      changes.push(
        Math.abs(
          ((current - previous) /
            previous) *
            100
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

  return {
    currentPrice:
      Number(currentPrice.toFixed(6)),

    sma10:
      Number(sma10.toFixed(6)),

    sma30:
      Number(sma30.toFixed(6)),

    momentum:
      Number(momentum.toFixed(3)),

    volatility:
      Number(volatility.toFixed(3))
  };
}


// =========================
// SOL BALANCE
// =========================

async function getSolBalance(
  walletAddress
) {
  const response = await fetch(
    RPC_URL,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json"
      },

      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getBalance",
        params: [walletAddress]
      })
    }
  );

  const result =
    await response.json();

  const lamports =
    result?.result?.value;

  if (!Number.isFinite(lamports)) {
    throw new Error(
      "Failed to load SOL balance"
    );
  }

  return lamports / 1e9;
}


// =========================
// USDC BALANCE
// =========================

async function getUsdcBalance(
  walletAddress
) {
  const response = await fetch(
    RPC_URL,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json"
      },

      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,

        method:
          "getTokenAccountsByOwner",

        params: [
          walletAddress,

          {
            mint: USDC_MINT
          },

          {
            encoding: "jsonParsed"
          }
        ]
      })
    }
  );

  const result =
    await response.json();

  const accounts =
    result?.result?.value || [];

  let total = 0;

  for (const account of accounts) {
    const amount =
      account?.account?.data?.parsed
        ?.info?.tokenAmount?.uiAmount;

    if (Number.isFinite(amount)) {
      total += amount;
    }
  }

  return total;
}


// =========================
// DECISION
// =========================

function makeDecision(
  market,
  balances
) {
  const {
    sma10,
    sma30,
    momentum
  } = market;

  const {
    solBalance,
    usdcBalance
  } = balances;

  const bullishTrend =
    sma10 > sma30;

  const positiveMomentum =
    momentum > 0.15;

  if (
    bullishTrend &&
    positiveMomentum &&
    usdcBalance >=
      MIN_USDC_TO_BUY
  ) {
    return {
      decision: "BUY",

      confidence:
        momentum > 0.35
          ? 85
          : 75,

      amount:
        BUY_USDC_AMOUNT,

      reason:
        "Bullish trend with positive momentum"
    };
  }

  const bearishTrend =
    sma10 < sma30;

  const negativeMomentum =
    momentum < -0.15;

  const canSell =
    solBalance -
      SELL_SOL_AMOUNT >=
    SOL_FLOOR;

  if (
    bearishTrend &&
    negativeMomentum &&
    canSell
  ) {
    return {
      decision: "SELL",

      confidence:
        momentum < -0.35
          ? 85
          : 75,

      amount:
        SELL_SOL_AMOUNT,

      reason:
        "Bearish trend with negative momentum"
    };
  }

  return {
    decision: "HOLD",
    confidence: 60,
    amount: 0,
    reason:
      "No strong trading setup"
  };
}


// =========================
// INTERNAL API URL
// =========================

function buildApiUrl(
  req,
  path
) {
  const host =
    req.headers.host;

  if (!host) {
    throw new Error(
      "Host missing"
    );
  }

  const protocol =
    host.includes("localhost")
      ? "http"
      : "https";

  return `${protocol}://${host}${path}`;
}


// =========================
// RISK AGENT
// =========================

async function callRiskAgent({
  req,
  trade,
  market,
  balances
}) {
  const url =
    buildApiUrl(
      req,
      "/api/risk-agent"
    );

  const response =
    await fetch(url, {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json"
      },

      body: JSON.stringify({
        decision:
          trade.decision,

        confidence:
          trade.confidence,

        amount:
          trade.amount,

        solBalance:
          balances.solBalance,

        usdcBalance:
          balances.usdcBalance,

        momentum:
          market.momentum,

        volatility:
          market.volatility
      })
    });

  const data =
    await response.json();

  if (!response.ok) {
    throw new Error(
      data?.message ||
      "Risk Agent failed"
    );
  }

  return data;
}


// =========================
// EXECUTION AGENT
// =========================

async function callExecutionAgent({
  req,
  walletAddress,
  trade,
  risk
}) {
  const url =
    buildApiUrl(
      req,
      "/api/execution-agent"
    );

  const response =
    await fetch(url, {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json"
      },

      body: JSON.stringify({
        decision:
          trade.decision,

        confidence:
          trade.confidence,

        riskApproved:
          risk.riskApproved === true,

        amount:
          trade.amount,

        walletAddress
      })
    });

  const data =
    await response.json();

  if (!response.ok) {
    throw new Error(
      data?.message ||
      "Execution Agent failed"
    );
  }

  return data;
}


// =========================
// MAIN HANDLER
// =========================

export default async function handler(
  req,
  res
) {
  if (req.method !== "POST") {
    return res.status(405).json({
      status: "error",
      message: "POST only"
    });
  }

  try {
    const {
      walletAddress
    } = req.body || {};

    if (
      !walletAddress ||
      typeof walletAddress !==
        "string" ||
      walletAddress.length < 30
    ) {
      return res.status(400).json({
        status: "error",

        message:
          "Valid walletAddress required"
      });
    }

    // =========================
    // LOAD EVERYTHING
    // =========================

    const [
      market,
      solBalance,
      usdcBalance
    ] = await Promise.all([
      getMarketData(),

      getSolBalance(
        walletAddress
      ),

      getUsdcBalance(
        walletAddress
      )
    ]);

    const balances = {
      solBalance,
      usdcBalance
    };

    // =========================
    // MAKE DECISION
    // =========================

    const trade =
      makeDecision(
        market,
        balances
      );

    // =========================
    // HOLD
    // =========================

    if (
      trade.decision === "HOLD"
    ) {
      return res.status(200).json({
        status: "ok",

        executed: false,

        decision: "HOLD",

        confidence:
          trade.confidence,

        reason:
          trade.reason,

        market,

        balances,

        message:
          "No trade right now"
      });
    }

    // =========================
    // RISK CHECK
    // =========================

    const risk =
      await callRiskAgent({
        req,
        trade,
        market,
        balances
      });

    if (
      risk.riskApproved !== true
    ) {
      return res.status(200).json({
        status: "blocked",

        executed: false,

        decision:
          trade.decision,

        confidence:
          trade.confidence,

        reason:
          trade.reason,

        risk,

        market,

        balances,

        message:
          "Trade blocked by Risk Agent"
      });
    }

    // =========================
    // PREPARE EXECUTION
    // =========================

    const execution =
      await callExecutionAgent({
        req,
        walletAddress,
        trade,
        risk
      });

    // =========================
    // RESPONSE
    // =========================

    return res.status(200).json({
      status: "ok",

      decision:
        trade.decision,

      confidence:
        trade.confidence,

      reason:
        trade.reason,

      market,

      balances,

      risk,

      execution,

      message:
        execution
          ?.requiresWalletApproval
          ? "Trade passed all agents and is ready for wallet approval"
          : "Trade processed"
    });

  } catch (error) {
    console.error(
      "Trade Orchestrator Error:",
      error
    );

    return res.status(500).json({
      status: "error",

      executed: false,

      message:
        error?.message ||
        "Trade orchestrator failed"
    });
  }
}
