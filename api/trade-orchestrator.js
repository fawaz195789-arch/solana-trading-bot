// /api/trade-orchestrator.js
// FAWAZ AI BOT
// Parallel Micro Scalper Orchestrator v4.1

import {
  evaluateRisk,
  getDynamicRiskMode
} from "./risk-agent.js";

import {
  getOpenPositions,
  getFreeSlot,
  openPosition,
  closePosition,
  updateHighestPrice,
  activateTrailing,
  getRecentClosedTrades,
  getTradingDashboard
} from "./trading-store.js";


// ======================================================
// CONSTANTS
// ======================================================

const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;

const CONFIG = {
  maxSlots: 4,

  defaultSlotUsd: 5,

  reservePct: 0.20,

  calmTargetBps: 30,
  normalTargetBps: 45,
  fastTargetBps: 70,

  trailingActivationPct: 0.65,
  trailingDistancePct: 0.30,

  stopLossBps: 45,

  maxSlippageBps: 30,

  minNetEdgeBps: 12,

  maxMarketSpreadBps: 20,

  maxNewSlotsPerCycle: 4
};


// ======================================================
// HELPERS
// ======================================================

function number(value, fallback = 0) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}

function clamp(value, min, max) {
  return Math.max(
    min,
    Math.min(max, value)
  );
}

function toBps(value) {
  return value * 10000;
}

function atomicToAmount(
  atomic,
  decimals
) {
  const n = number(atomic);

  return (
    n /
    Math.pow(10, decimals)
  );
}


// ======================================================
// AUTH
// ======================================================

function authorize(req) {
  const expected =
    process.env.AUTO_TRADER_SECRET;

  if (!expected) {
    return {
      ok: false,
      status: 500,
      reason:
        "AUTO_TRADER_SECRET_MISSING"
    };
  }

  const header =
    req.headers.authorization ||
    req.headers.Authorization;

  if (
    header !==
    `Bearer ${expected}`
  ) {
    return {
      ok: false,
      status: 401,
      reason: "UNAUTHORIZED"
    };
  }

  return {
    ok: true
  };
}


// ======================================================
// WALLET ADDRESS
// NEW:
// BOT_PUBLIC_WALLET is checked first
// ======================================================

function getWalletAddress() {
  const wallet =
    process.env.BOT_PUBLIC_WALLET ||
    process.env.BOT_WALLET_ADDRESS ||
    process.env.SOLANA_WALLET_ADDRESS ||
    process.env.WALLET_ADDRESS;

  if (!wallet) {
    throw new Error(
      "BOT wallet address is missing"
    );
  }

  return wallet.trim();
}


// ======================================================
// BASE URL
// ======================================================

function getBaseUrl(req) {
  if (
    process.env.APP_BASE_URL
  ) {
    return process.env
      .APP_BASE_URL
      .replace(/\/$/, "");
  }

  if (
    process.env
      .VERCEL_PROJECT_PRODUCTION_URL
  ) {
    return (
      "https://" +
      process.env
        .VERCEL_PROJECT_PRODUCTION_URL
    );
  }

  if (
    process.env.VERCEL_URL
  ) {
    return (
      "https://" +
      process.env.VERCEL_URL
    );
  }

  const host =
    req.headers.host;

  if (!host) {
    throw new Error(
      "Unable to determine application URL"
    );
  }

  return `https://${host}`;
}


// ======================================================
// INTERNAL API REQUEST
// ======================================================

async function fetchJson(
  url,
  options = {}
) {
  const response =
    await fetch(
      url,
      options
    );

  const text =
    await response.text();

  let data;

  try {
    data =
      JSON.parse(text);
  } catch {
    data = {
      raw: text
    };
  }

  if (!response.ok) {
    throw new Error(
      `HTTP_${response.status}:${JSON.stringify(
        data
      )}`
    );
  }

  return data;
}


// ======================================================
// GET FAST MARKET DATA
// ======================================================

async function getMarketData(req) {
  const baseUrl =
    getBaseUrl(req);

  const result =
    await fetchJson(
      `${baseUrl}/api/market-agent`,
      {
        method: "GET",

        headers: {
          Accept:
            "application/json"
        }
      }
    );

  if (
    result?.status !== "ok" ||
    !result?.market
  ) {
    throw new Error(
      "MARKET_AGENT_INVALID_RESPONSE"
    );
  }

  return result;
}


// ======================================================
// EXECUTION AGENT
// ======================================================

async function executeTrade({
  req,
  side,
  slotId,
  amountUsd = 0,
  amountSol = 0,
  slippageBps
}) {
  const baseUrl =
    getBaseUrl(req);

  const secret =
    process.env.AUTO_TRADER_SECRET;

  const payload = {
    side,
    slotId,

    amountUsd:
      number(amountUsd),

    amountSol:
      number(amountSol),

    slippageBps:
      clamp(
        Math.floor(
          number(
            slippageBps,
            20
          )
        ),
        1,
        CONFIG.maxSlippageBps
      )
  };

  const result =
    await fetchJson(
      `${baseUrl}/api/execution-agent`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          Authorization:
            `Bearer ${secret}`
        },

        body:
          JSON.stringify(
            payload
          )
      }
    );

  if (
    result?.executed !== true
  ) {
    return {
      success: false,
      response: result
    };
  }

  return {
    success: true,
    response: result
  };
}


// ======================================================
// SLOT SIZE
// ======================================================

function getSlotUsd() {
  const configured =
    number(
      process.env
        .SCALPER_SLOT_USD
    );

  if (configured > 0) {
    return configured;
  }

  const totalCapital =
    number(
      process.env
        .SCALPER_CAPITAL_USD
    );

  if (totalCapital > 0) {
    return (
      totalCapital *
      (1 - CONFIG.reservePct)
    ) / CONFIG.maxSlots;
  }

  return CONFIG.defaultSlotUsd;
}

function getTotalCapitalUsd() {
  const configured =
    number(
      process.env
        .SCALPER_CAPITAL_USD
    );

  if (configured > 0) {
    return configured;
  }

  return (
    getSlotUsd() *
    CONFIG.maxSlots
  ) / (1 - CONFIG.reservePct);
}


// ======================================================
// DYNAMIC PROFIT TARGET
// ======================================================

function getTargetBps(
  market,
  riskMode
) {
  let target =
    CONFIG.calmTargetBps;

  if (
    market.mode === "NORMAL"
  ) {
    target =
      CONFIG.normalTargetBps;
  }

  if (
    market.mode === "FAST"
  ) {
    target =
      CONFIG.fastTargetBps;
  }

  if (
    riskMode === "FAST"
  ) {
    target *= 1.10;
  }

  if (
    riskMode === "DEFENSIVE"
  ) {
    target *= 0.80;
  }

  return Math.round(
    clamp(
      target,
      20,
      100
    )
  );
}


// ======================================================
// HOW MANY NEW SLOTS
// ======================================================

function calculateEntriesToOpen(
  market,
  freeSlots
) {
  if (
    freeSlots <= 0
  ) {
    return 0;
  }

  const score =
    number(
      market.scalpingScore
    );

  let count = 1;

  if (score >= 65) {
    count = 2;
  }

  if (score >= 80) {
    count = 3;
  }

  if (
    score >= 90 &&
    market.mode === "FAST"
  ) {
    count = 4;
  }

  return Math.min(
    count,
    freeSlots,
    CONFIG.maxNewSlotsPerCycle
  );
}


// ======================================================
// ENTRY CONDITIONS
// ======================================================

function analyzeEntry({
  marketResult,
  riskMode
}) {
  const market =
    marketResult.market;

  const signal =
    marketResult.signal;

  if (
    signal?.action !== "BUY"
  ) {
    return {
      allowed: false,
      reason:
        "MARKET_SIGNAL_WAIT"
    };
  }

  if (
    riskMode === "PAUSED"
  ) {
    return {
      allowed: false,
      reason:
        "RISK_MODE_PAUSED"
    };
  }

  if (
    number(
      market.scalpingScore
    ) < 45
  ) {
    return {
      allowed: false,
      reason:
        "SCALPING_SCORE_LOW"
    };
  }

  if (
    number(
      market.volatilityBps
    ) < 3
  ) {
    return {
      allowed: false,
      reason:
        "VOLATILITY_TOO_LOW"
    };
  }

  if (
    number(
      market.spreadBps
    ) >
    CONFIG.maxMarketSpreadBps
  ) {
    return {
      allowed: false,
      reason:
        "MARKET_SPREAD_TOO_WIDE"
    };
  }

  return {
    allowed: true,
    reason:
      "MICRO_SCALP_SETUP"
  };
}


// ======================================================
// MANAGE EXISTING POSITIONS
// ======================================================

async function managePositions({
  req,
  walletAddress,
  positions,
  market
}) {
  const events = [];

  const currentPrice =
    number(
      market.price
    );

  for (
    const position
    of positions
  ) {
    try {
      const entryPrice =
        number(
          position.entry_price
        );

      const entrySol =
        number(
          position.entry_sol
        );

      if (
        entryPrice <= 0 ||
        entrySol <= 0
      ) {
        events.push({
          positionId:
            position.id,

          slotId:
            position.slot_id,

          event:
            "INVALID_POSITION_DATA"
        });

        continue;
      }

      const pnlBps =
        toBps(
          (
            currentPrice -
            entryPrice
          ) /
          entryPrice
        );

      let highestPrice =
        number(
          position.highest_price,
          entryPrice
        );

      // UPDATE HIGH

      if (
        currentPrice >
        highestPrice
      ) {
        highestPrice =
          currentPrice;

        await updateHighestPrice({
          id:
            position.id,

          highestPrice
        });
      }

      const targetBps =
        number(
          position.target_bps,
          CONFIG.normalTargetBps
        );

      const activationBps =
        targetBps *
        CONFIG
          .trailingActivationPct;

      let trailingActive =
        position
          .trailing_active === true;

      // ENABLE TRAILING

      if (
        !trailingActive &&
        pnlBps >=
          activationBps
      ) {
        await activateTrailing({
          id:
            position.id,

          highestPrice
        });

        trailingActive =
          true;

        events.push({
          positionId:
            position.id,

          slotId:
            position.slot_id,

          event:
            "TRAILING_ACTIVATED",

          pnlBps:
            Number(
              pnlBps.toFixed(2)
            )
        });
      }

      // STOP LOSS

      if (
        pnlBps <=
        -CONFIG.stopLossBps
      ) {
        const execution =
          await executeTrade({
            req,

            side: "SELL",

            slotId:
              position.slot_id,

            amountSol:
              entrySol,

            slippageBps:
              CONFIG.maxSlippageBps
          });

        if (
          !execution.success
        ) {
          events.push({
            positionId:
              position.id,

            slotId:
              position.slot_id,

            event:
              "STOP_LOSS_SELL_FAILED",

            execution:
              execution.response
          });

          continue;
        }

        const outAtomic =
          execution.response
            ?.quote
            ?.outAmount;

        const exitUsdc =
          atomicToAmount(
            outAtomic,
            USDC_DECIMALS
          );

        const closed =
          await closePosition({
            id:
              position.id,

            exitPrice:
              currentPrice,

            exitUsdc,

            signature:
              execution.response
                .signature,

            reason:
              "STOP_LOSS"
          });

        events.push({
          positionId:
            position.id,

          slotId:
            position.slot_id,

          event:
            "STOP_LOSS_EXIT",

          pnl:
            closed.realized_pnl,

          pnlPct:
            closed.realized_pnl_pct
        });

        continue;
      }

      // TRAILING EXIT

      if (
        trailingActive
      ) {
        const trailingDistanceBps =
          number(
            position
              .trailing_distance_bps,
            Math.max(
              8,
              targetBps *
                CONFIG
                  .trailingDistancePct
            )
          );

        const dropFromHighBps =
          highestPrice > 0
            ? toBps(
                (
                  highestPrice -
                  currentPrice
                ) /
                highestPrice
              )
            : 0;

        if (
          dropFromHighBps >=
          trailingDistanceBps
        ) {
          const execution =
            await executeTrade({
              req,

              side:
                "SELL",

              slotId:
                position.slot_id,

              amountSol:
                entrySol,

              slippageBps:
                CONFIG
                  .maxSlippageBps
            });

          if (
            !execution.success
          ) {
            events.push({
              positionId:
                position.id,

              slotId:
                position.slot_id,

              event:
                "TRAILING_SELL_FAILED",

              execution:
                execution.response
            });

            continue;
          }

          const exitUsdc =
            atomicToAmount(
              execution
                .response
                ?.quote
                ?.outAmount,

              USDC_DECIMALS
            );

          const closed =
            await closePosition({
              id:
                position.id,

              exitPrice:
                currentPrice,

              exitUsdc,

              signature:
                execution
                  .response
                  .signature,

              reason:
                "TRAILING_PROFIT"
            });

          events.push({
            positionId:
              position.id,

            slotId:
              position.slot_id,

            event:
              "TRAILING_EXIT",

            pnl:
              closed
                .realized_pnl,

            pnlPct:
              closed
                .realized_pnl_pct
          });

          continue;
        }
      }

      // HARD TARGET

      if (
        pnlBps >=
        targetBps * 1.40
      ) {
        const execution =
          await executeTrade({
            req,

            side: "SELL",

            slotId:
              position.slot_id,

            amountSol:
              entrySol,

            slippageBps:
              CONFIG.maxSlippageBps
          });

        if (
          !execution.success
        ) {
          events.push({
            positionId:
              position.id,

            slotId:
              position.slot_id,

            event:
              "TARGET_SELL_FAILED",

            execution:
              execution.response
          });

          continue;
        }

        const exitUsdc =
          atomicToAmount(
            execution
              .response
              ?.quote
              ?.outAmount,

            USDC_DECIMALS
          );

        const closed =
          await closePosition({
            id:
              position.id,

            exitPrice:
              currentPrice,

            exitUsdc,

            signature:
              execution
                .response
                .signature,

            reason:
              "TARGET_PROFIT"
          });

        events.push({
          positionId:
            position.id,

          slotId:
            position.slot_id,

          event:
            "TARGET_EXIT",

          pnl:
            closed.realized_pnl,

          pnlPct:
            closed.realized_pnl_pct
        });

        continue;
      }

      events.push({
        positionId:
          position.id,

        slotId:
          position.slot_id,

        event:
          "KEEP_POSITION_OPEN",

        pnlBps:
          Number(
            pnlBps.toFixed(2)
          ),

        entryPrice,

        currentPrice,

        highestPrice
      });

    } catch (error) {
      events.push({
        positionId:
          position.id,

        slotId:
          position.slot_id,

        event:
          "POSITION_ERROR",

        error:
          error?.message ||
          "Unknown position error"
      });
    }
  }

  return events;
}


// ======================================================
// OPEN NEW SLOT
// ======================================================

async function openNewSlot({
  req,
  walletAddress,
  slotId,
  slotUsd,
  targetBps,
  market,
  recentTrades,
  currentPositions
}) {
  const estimatedSlippageBps =
    Math.max(
      4,
      Math.ceil(
        number(
          market.spreadBps
        ) / 2
      )
    );

  const candidate = {
    amountUsd:
      slotUsd,

    expectedMoveBps:
      targetBps,

    estimatedSlippageBps,

    buyFeeBps: 0,

    sellFeeBps: 0
  };

  const riskState = {
    totalCapitalUsd:
      getTotalCapitalUsd(),

    recentTrades,

    slots:
      currentPositions.map(
        (position) => ({
          id:
            position.slot_id,

          status:
            "OPEN",

          amountUsd:
            number(
              position.entry_usdc
            )
        })
      )
  };

  const risk =
    evaluateRisk({
      state:
        riskState,

      candidate,

      config: {
        maxOpenSlots:
          CONFIG.maxSlots,

        maxSlippageBps:
          CONFIG
            .maxSlippageBps,

        minNetEdgeBps:
          CONFIG
            .minNetEdgeBps
      }
    });

  if (
    !risk.allowed
  ) {
    return {
      opened: false,
      slotId,
      reason:
        risk.reason,
      risk
    };
  }

  const execution =
    await executeTrade({
      req,

      side: "BUY",

      slotId,

      amountUsd:
        slotUsd,

      slippageBps:
        Math.min
