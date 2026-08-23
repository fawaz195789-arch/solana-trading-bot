import {
  getOpenPosition,
  openPosition,
  closePosition,
  get24HourStats,
  getAllTimeStats
} from "../lib/trading-store.js";

const USDC_MINT =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const RPC_URL =
  "https://api.mainnet-beta.solana.com";

// =========================
// TRADING SETTINGS
// =========================

const BUY_USDC_AMOUNT = 5;

// أقصى عدد صفقات مغلقة خلال 24 ساعة
const MAX_TRADES_24H = 20;

// هدف الربح الأساسي
const TAKE_PROFIT_PCT = 0.8;

// وقف الخسارة
const STOP_LOSS_PCT = -0.5;

// حماية ربح صغير عند انعكاس السوق
const PROTECT_PROFIT_PCT = 0.35;

// إيقاف التداول إذا وصلت خسائر 24 ساعة لهذا الرقم
const DAILY_MAX_LOSS_USDC = -1.5;

// الحد الأدنى للدخول
const MIN_ENTRY_MOMENTUM = 0.15;

// لا ندخل إذا السوق شبه ميت
const MIN_VOLATILITY = 0.02;


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
      "Failed to load OKX market candles"
    );
  }

  const closes = [...result.data]
    .reverse()
    .map((candle) => Number(candle[4]))
    .filter(Number.isFinite);

  if (closes.length < 30) {
    throw new Error(
      "Not enough valid market candles"
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
    changes.length
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
  const response =
    await fetch(
      buildApiUrl(
        req,
        "/api/risk-agent"
      ),
      {
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
      }
    );

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
  const response =
    await fetch(
      buildApiUrl(
        req,
        "/api/execution-agent"
      ),
      {
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
      }
    );

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
// ENTRY DECISION
// =========================

function findEntrySignal(
  market,
  balances
) {
  if (
    balances.usdcBalance <
    BUY_USDC_AMOUNT
  ) {
    return {
      decision: "HOLD",
      confidence: 0,
      amount: 0,
      reason:
        "Not enough USDC for 5 USDC trade"
    };
  }

  const bullishTrend =
    market.sma10 >
    market.sma30;

  const strongMomentum =
    market.momentum >
    MIN_ENTRY_MOMENTUM;

  const enoughMovement =
    market.volatility >=
    MIN_VOLATILITY;

  if (
    bullishTrend &&
    strongMomentum &&
    enoughMovement
  ) {
    const confidence =
      market.momentum > 0.35
        ? 85
        : 75;

    return {
      decision: "BUY",
      confidence,
      amount:
        BUY_USDC_AMOUNT,

      reason:
        "Bullish short-term trend with usable volatility"
    };
  }

  return {
    decision: "HOLD",
    confidence: 60,
    amount: 0,
    reason:
      "No strong scalping entry"
  };
}


// =========================
// OPEN POSITION LOGIC
// =========================

function evaluateOpenPosition(
  position,
  market
) {
  const entryPrice =
    Number(
      position.entry_price
    );

  if (
    !Number.isFinite(entryPrice) ||
    entryPrice <= 0
  ) {
    throw new Error(
      "Invalid stored entry price"
    );
  }

  const pnlPct =
    (
      (
        market.currentPrice -
        entryPrice
      ) /
      entryPrice
    ) *
    100;

  // =========================
  // TAKE PROFIT
  // =========================

  if (
    pnlPct >=
    TAKE_PROFIT_PCT
  ) {
    return {
      shouldSell: true,
      reason:
        "TAKE_PROFIT",
      pnlPct
    };
  }

  // =========================
  // STOP LOSS
  // =========================

  if (
    pnlPct <=
    STOP_LOSS_PCT
  ) {
    return {
      shouldSell: true,
      reason:
        "STOP_LOSS",
      pnlPct
    };
  }

  // =========================
  // PROTECT SMALL PROFIT
  // =========================

  const momentumTurningDown =
    market.momentum <= 0;

  const trendTurningDown =
    market.sma10 <
    market.sma30;

  if (
    pnlPct >=
      PROTECT_PROFIT_PCT &&
    (
      momentumTurningDown ||
      trendTurningDown
    )
  ) {
    return {
      shouldSell: true,
      reason:
        "PROTECT_SMALL_PROFIT",
      pnlPct
    };
  }

  return {
    shouldSell: false,
    reason:
      "KEEP_POSITION_OPEN",
    pnlPct
  };
}


// =========================
// MAIN
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
    // LOAD DATA
    // =========================

    const [
      market,
      solBalance,
      usdcBalance,
      openTrade,
      stats24h,
      allTime
    ] = await Promise.all([
      getMarketData(),

      getSolBalance(
        walletAddress
      ),

      getUsdcBalance(
        walletAddress
      ),

      getOpenPosition(
        walletAddress
      ),

      get24HourStats(
        walletAddress
      ),

      getAllTimeStats(
        walletAddress
      )
    ]);

    const balances = {
      solBalance,
      usdcBalance
    };


    // =========================
    // DAILY TRADE LIMIT
    // =========================

    if (
      !openTrade &&
      stats24h.trades >=
        MAX_TRADES_24H
    ) {
      return res.status(200).json({
        status: "paused",
        decision: "HOLD",

        reason:
          "24 hour trade limit reached",

        market,
        balances,

        stats: {
          last24Hours:
            stats24h,

          allTime
        }
      });
    }


    // =========================
    // DAILY LOSS LIMIT
    // =========================

    if (
      !openTrade &&
      stats24h.pnl <=
        DAILY_MAX_LOSS_USDC
    ) {
      return res.status(200).json({
        status: "paused",
        decision: "HOLD",

        reason:
          "Daily loss limit reached",

        market,
        balances,

        stats: {
          last24Hours:
            stats24h,

          allTime
        }
      });
    }


    // ==================================================
    // OPEN POSITION EXISTS
    // ==================================================

    if (openTrade) {
      const positionState =
        evaluateOpenPosition(
          openTrade,
          market
        );

      if (
        !positionState.shouldSell
      ) {
        return res.status(200).json({
          status: "ok",

          decision: "HOLD",

          reason:
            positionState.reason,

          market,

          balances,

          openPosition: {
            ...openTrade,

            currentPnlPct:
              Number(
                positionState
                  .pnlPct
                  .toFixed(3)
              )
          },

          stats: {
            last24Hours:
              stats24h,

            allTime
          }
        });
      }


      // =========================
      // SELL OPEN POSITION
      // =========================

      const sellAmount =
        Number(
          openTrade.entry_sol
        );

      if (
        !Number.isFinite(
          sellAmount
        ) ||
        sellAmount <= 0
      ) {
        throw new Error(
          "Invalid stored SOL amount"
        );
      }

      const sellTrade = {
        decision: "SELL",

        confidence: 90,

        amount:
          sellAmount,

        reason:
          positionState.reason
      };

      const risk =
        await callRiskAgent({
          req,
          trade:
            sellTrade,
          market,
          balances
        });

      if (
        risk.riskApproved !==
        true
      ) {
        return res
          .status(200)
          .json({
            status: "blocked",

            decision: "SELL",

            reason:
              "Risk Agent blocked exit",

            risk,

            openPosition:
              openTrade,

            market,

            balances
          });
      }

      const execution =
        await callExecutionAgent({
          req,
          walletAddress,

          trade:
            sellTrade,

          risk
        });

      if (
        execution.executed !==
        true
      ) {
        throw new Error(
          "SELL was not executed"
        );
      }

      const receivedUsdc =
        Number(
          execution.quote
            ?.outAmount || 0
        ) /
        1e6;

      const closed =
        await closePosition({
          id:
            openTrade.id,

          exitPrice:
            market.currentPrice,

          exitUsdc:
            receivedUsdc,

          signature:
            execution.signature
        });

      const updated24 =
        await get24HourStats(
          walletAddress
        );

      const updatedAll =
        await getAllTimeStats(
          walletAddress
        );

      return res.status(200).json({
        status: "ok",

        executed: true,

        decision: "SELL",

        exitReason:
          positionState.reason,

        execution,

        closedPosition:
          closed,

        stats: {
          last24Hours:
            updated24,

          allTime:
            updatedAll
        },

        message:
          "Position closed and PnL recorded"
      });
    }


    // ==================================================
    // NO OPEN POSITION
    // LOOK FOR BUY
    // ==================================================

    const trade =
      findEntrySignal(
        market,
        balances
      );

    if (
      trade.decision ===
      "HOLD"
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

        stats: {
          last24Hours:
            stats24h,

          allTime
        }
      });
    }


    // =========================
    // BUY RISK
    // =========================

    const risk =
      await callRiskAgent({
        req,
        trade,
        market,
        balances
      });

    if (
      risk.riskApproved !==
      true
    ) {
      return res.status(200).json({
        status: "blocked",

        executed: false,

        decision: "BUY",

        risk,

        market,

        balances,

        stats: {
          last24Hours:
            stats24h,

          allTime
        }
      });
    }


    // =========================
    // EXECUTE BUY
    // =========================

    const execution =
      await callExecutionAgent({
        req,
        walletAddress,
        trade,
        risk
      });

    if (
      execution.executed !== true
    ) {
      throw new Error(
        "BUY was not executed"
      );
    }

    const spentUsdc =
      Number(
        execution.quote
          ?.inAmount || 0
      ) /
      1e6;

    const receivedSol =
      Number(
        execution.quote
          ?.outAmount || 0
      ) /
      1e9;

    if (
      spentUsdc <= 0 ||
      receivedSol <= 0
    ) {
      throw new Error(
        "Invalid executed BUY amounts"
      );
    }

    const position =
      await openPosition({
        walletAddress,

        entryPrice:
          market.currentPrice,

        entrySol:
          receivedSol,

        entryUsdc:
          spentUsdc,

        signature:
          execution.signature
      });

    return res.status(200).json({
      status: "ok",

      executed: true,

      decision: "BUY",

      confidence:
        trade.confidence,

      reason:
        trade.reason,

      execution,

      openPosition:
        position,

      stats: {
        last24Hours:
          stats24h,

        allTime
      },

      message:
        "New position opened and stored"
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
