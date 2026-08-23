// /api/trade-orchestrator.js
// FAWAZ AI BOT
// PAPER SCALPER V1
// 4 Slots - 5 USDC Capital Simulation
// NO REAL TRADING

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
// CONFIG
// ======================================================

const CONFIG = {
  maxSlots: 4,

  // كل صفقة = 1 USDC
  slotUsd: 1,

  // Dynamic targets
  calmTargetBps: 30,
  normalTargetBps: 45,
  fastTargetBps: 70,

  // Stop Loss
  stopLossBps: 45,

  // Trailing Profit
  trailingActivationRatio: 0.65,
  trailingDistanceRatio: 0.30,

  // Risk
  minNetEdgeBps: 12,

  // محاكاة تكلفة الانزلاق
  estimatedSlippageBps: 6,

  maxEntriesPerCycle: 1
};


// ======================================================
// HELPERS
// ======================================================

function num(
  value,
  fallback = 0
) {
  const n =
    Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}


function clamp(
  value,
  min,
  max
) {
  return Math.max(
    min,
    Math.min(
      max,
      value
    )
  );
}


function toBps(value) {
  return value * 10000;
}


// ======================================================
// WALLET
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

  if (host) {
    const protocol =
      host.includes("localhost")
        ? "http"
        : "https";

    return `${protocol}://${host}`;
  }

  return (
    "https://fawaz-ai-bot.vercel.app"
  );
}


// ======================================================
// FETCH JSON
// ======================================================

async function fetchJson(url) {
  const response =
    await fetch(
      url,
      {
        method: "GET",

        headers: {
          Accept:
            "application/json"
        }
      }
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
// LOAD SIGNAL
// ======================================================

async function loadSignal(req) {
  const baseUrl =
    getBaseUrl(req);

  const data =
    await fetchJson(
      `${baseUrl}/api/signal`
    );

  if (
    data?.status !== "ok" ||
    !data?.signal
  ) {
    throw new Error(
      "INVALID_SIGNAL_RESPONSE"
    );
  }

  return data.signal;
}


// ======================================================
// DYNAMIC TARGET
// ======================================================

function getDynamicTarget(
  signal,
  riskMode
) {
  const mode =
    String(
      signal.marketMode ||
      "CALM"
    ).toUpperCase();

  let target =
    CONFIG.calmTargetBps;

  if (
    mode === "NORMAL"
  ) {
    target =
      CONFIG.normalTargetBps;
  }

  if (
    mode === "FAST"
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
    riskMode ===
    "DEFENSIVE"
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
// MANAGE OPEN POSITIONS
// ======================================================

async function managePositions({
  positions,
  currentPrice
}) {
  const events = [];


  for (
    const position
    of positions
  ) {

    const entryPrice =
      num(
        position.entry_price
      );


    if (
      entryPrice <= 0
    ) {
      events.push({
        slotId:
          position.slot_id,

        action:
          "ERROR",

        reason:
          "INVALID_ENTRY_PRICE"
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
      num(
        position.highest_price,
        entryPrice
      );


    // ==================================================
    // UPDATE HIGH
    // ==================================================

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
      num(
        position.target_bps,
        CONFIG.normalTargetBps
      );


    // ==================================================
    // STOP LOSS
    // ==================================================

    if (
      pnlBps <=
      -CONFIG.stopLossBps
    ) {

      const exitUsdc =
        num(
          position.entry_usdc
        ) *
        (
          1 +
          pnlBps /
          10000
        );


      const closed =
        await closePosition({
          id:
            position.id,

          exitPrice:
            currentPrice,

          exitUsdc,

          signature:
            "PAPER_SELL",

          reason:
            "PAPER_STOP_LOSS"
        });


      events.push({
        slotId:
          position.slot_id,

        action:
          "SELL",

        reason:
          "STOP_LOSS",

        pnlPct:
          closed
            .realized_pnl_pct
      });


      continue;
    }


    // ==================================================
    // TRAILING ACTIVATION
    // ==================================================

    const activationBps =
      targetBps *
      CONFIG
        .trailingActivationRatio;


    let trailingActive =
      position
        .trailing_active === true;


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
        slotId:
          position.slot_id,

        action:
          "TRAILING_ON",

        reason:
          "PROFIT_PROTECTION",

        pnlBps:
          Number(
            pnlBps.toFixed(2)
          )
      });
    }


    // ==================================================
    // TRAILING EXIT
    // ==================================================

    if (
      trailingActive
    ) {

      const distanceBps =
        num(
          position
            .trailing_distance_bps,

          Math.max(
            8,

            targetBps *
            CONFIG
              .trailingDistanceRatio
          )
        );


      const dropBps =
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
        dropBps >=
        distanceBps
      ) {

        const pnlPct =
          (
            currentPrice -
            entryPrice
          ) /
          entryPrice;


        const exitUsdc =
          num(
            position.entry_usdc
          ) *
          (
            1 +
            pnlPct
          );


        const closed =
          await closePosition({
            id:
              position.id,

            exitPrice:
              currentPrice,

            exitUsdc,

            signature:
              "PAPER_SELL",

            reason:
              "PAPER_TRAILING"
          });


        events.push({
          slotId:
            position.slot_id,

          action:
            "SELL",

          reason:
            "TRAILING_PROFIT",

          pnlPct:
            closed
              .realized_pnl_pct
        });


        continue;
      }
    }


    // ==================================================
    // HARD TARGET
    // ==================================================

    if (
      pnlBps >=
      targetBps * 1.40
    ) {

      const pnlPct =
        (
          currentPrice -
          entryPrice
        ) /
        entryPrice;


      const exitUsdc =
        num(
          position.entry_usdc
        ) *
        (
          1 +
          pnlPct
        );


      const closed =
        await closePosition({
          id:
            position.id,

          exitPrice:
            currentPrice,

          exitUsdc,

          signature:
            "PAPER_SELL",

          reason:
            "PAPER_TARGET"
        });


      events.push({
        slotId:
          position.slot_id,

        action:
          "SELL",

        reason:
          "TARGET_PROFIT",

        pnlPct:
          closed
            .realized_pnl_pct
      });


      continue;
    }


    // ==================================================
    // KEEP OPEN
    // ==================================================

    events.push({
      slotId:
        position.slot_id,

      action:
        "HOLD",

      reason:
        "KEEP_OPEN",

      pnlBps:
        Number(
          pnlBps.toFixed(2)
        )
    });
  }


  return events;
}


// ======================================================
// TRY PAPER ENTRY
// ======================================================

async function tryPaperEntry({
  walletAddress,
  signal,
  positions,
  recentTrades,
  targetBps,
  currentPrice
}) {

  if (
    String(
      signal.action ||
      "WAIT"
    ).toUpperCase() !==
    "BUY"
  ) {
    return {
      opened: false,

      reason:
        "NO_BUY_SIGNAL"
    };
  }


  // ====================================================
  // FIND FREE SLOT
  // ====================================================

  const slotId =
    await getFreeSlot(
      walletAddress,
      CONFIG.maxSlots
    );


  if (!slotId) {
    return {
      opened: false,

      reason:
        "NO_FREE_SLOT"
    };
  }


  // ====================================================
  // RISK STATE
  // ====================================================

  const riskState = {

    // رأس المال الكلي = 5 USDC
    totalCapitalUsd: 5,

    recentTrades,

    slots:
      positions.map(
        (position) => ({
          id:
            position.slot_id,

          status:
            "OPEN",

          amountUsd:
            num(
              position.entry_usdc
            )
        })
      )
  };


  // ====================================================
  // CANDIDATE
  // ====================================================

  const candidate = {

    // كل Slot = 1 USDC
    amountUsd:
      CONFIG.slotUsd,

    expectedMoveBps:
      targetBps,

    estimatedSlippageBps:
      CONFIG
        .estimatedSlippageBps,

    buyFeeBps: 0,

    sellFeeBps: 0
  };


  // ====================================================
  // RISK AGENT
  // ====================================================

  const risk =
    evaluateRisk({
      state:
        riskState,

      candidate,

      config: {
        maxOpenSlots:
          CONFIG.maxSlots,

        minNetEdgeBps:
          CONFIG.minNetEdgeBps
      }
    });


  if (
    !risk.allowed
  ) {
    return {
      opened: false,

      reason:
        risk.reason,

      risk
    };
  }


  // ====================================================
  // PAPER BUY
  // ====================================================

  const entryUsdc =
    CONFIG.slotUsd;


  const entrySol =
    entryUsdc /
    currentPrice;


  const trailingDistanceBps =
    Math.max(
      8,

      Math.round(
        targetBps *
        CONFIG
          .trailingDistanceRatio
      )
    );


  const position =
    await openPosition({
      walletAddress,

      slotId,

      entryPrice:
        currentPrice,

      entrySol,

      entryUsdc,

      signature:
        "PAPER_BUY",

      strategy:
        "PAPER_MICRO_SCALP",

      targetBps,

      trailingDistanceBps
    });


  return {
    opened: true,

    paper: true,

    slotId,

    positionId:
      position.id,

    entryPrice:
      currentPrice,

    entryUsdc,

    entrySol,

    targetBps,

    remainingCapital:
      5 -
      (
        positions.reduce(
          (
            total,
            item
          ) =>
            total +
            num(
              item.entry_usdc
            ),
          0
        ) +
        entryUsdc
      )
  };
}


// ======================================================
// MAIN
// ======================================================

export default async function handler(
  req,
  res
) {

  if (
    req.method !== "GET" &&
    req.method !== "POST"
  ) {
    return res
      .status(405)
      .json({
        status: "error",

        message:
          "GET or POST only"
      });
  }


  try {

    // ==================================================
    // WALLET
    // ==================================================

    const walletAddress =
      getWalletAddress();


    // ==================================================
    // SIGNAL
    // ==================================================

    const signal =
      await loadSignal(req);


    const currentPrice =
      num(
        signal.currentPrice
      );


    if (
      currentPrice <= 0
    ) {
      throw new Error(
        "INVALID_CURRENT_PRICE"
      );
    }


    // ==================================================
    // DATABASE
    // ==================================================

    const [
      positionsBefore,
      recentTrades
    ] =
      await Promise.all([

        getOpenPositions(
          walletAddress
        ),

        getRecentClosedTrades(
          walletAddress,
          20
        )

      ]);


    // ==================================================
    // RISK MODE
    // ==================================================

    const riskMode =
      getDynamicRiskMode(
        recentTrades
      );


    // ==================================================
    // DYNAMIC TARGET
    // ==================================================

    const targetBps =
      getDynamicTarget(
        signal,
        riskMode
      );


    // ==================================================
    // MANAGE EXISTING SLOTS
    // ==================================================

    const positionEvents =
      await managePositions({
        positions:
          positionsBefore,

        currentPrice
      });


    // ==================================================
    // RELOAD AFTER EXITS
    // ==================================================

    const positionsAfterExit =
      await getOpenPositions(
        walletAddress
      );


    // ==================================================
    // TRY NEW ENTRY
    // ==================================================

    const entryResult =
      await tryPaperEntry({
        walletAddress,

        signal,

        positions:
          positionsAfterExit,

        recentTrades,

        targetBps,

        currentPrice
      });


    // ==================================================
    // DASHBOARD
    // ==================================================

    const dashboard =
      await getTradingDashboard(
        walletAddress
      );


    // ==================================================
    // CAPITAL STATS
    // ==================================================

    const openPositions =
      Array.isArray(
        dashboard.openPositions
      )
        ? dashboard.openPositions
        : [];


    const usedCapital =
      openPositions.reduce(
        (
          total,
          position
        ) =>
          total +
          num(
            position.entry_usdc
          ),
        0
      );


    const totalCapital =
      5;


    const freeCapital =
      Math.max(
        0,
        totalCapital -
        usedCapital
      );


    const realizedPnl =
      num(
        dashboard
          ?.allTime
          ?.pnl
      );


    const returnPct =
      (
        realizedPnl /
        totalCapital
      ) *
      100;


    // ==================================================
    // RESPONSE
    // ==================================================

    return res
      .status(200)
      .json({
        status: "ok",

        engine:
          "FAWAZ_PAPER_SCALPER_V1",

        paperTrading:
          true,

        realTrading:
          false,

        walletAddress,

        capital: {
          total:
            totalCapital,

          slotSize:
            CONFIG.slotUsd,

          maxSlots:
            CONFIG.maxSlots,

          used:
            usedCapital,

          free:
            freeCapital,

          realizedPnl,

          returnPct:
            Number(
              returnPct.toFixed(
                4
              )
            )
        },

        signal: {
          action:
            signal.action,

          confidence:
            signal.confidence,

          reason:
            signal.reason,

          currentPrice,

          marketMode:
            signal.marketMode,

          scalpingScore:
            signal.scalpingScore
        },

        riskMode,

        targetBps,

        positionEvents,

        entryResult,

        dashboard,

        timestamp:
          new Date()
            .toISOString()
      });


  } catch (error) {

    console.error(
      "Paper Scalper Error:",
      error
    );


    return res
      .status(500)
      .json({
        status: "error",

        engine:
          "FAWAZ_PAPER_SCALPER_V1",

        paperTrading:
          true,

        realTrading:
          false,

        message:
          error?.message ||
          "Paper scalper failed",

        timestamp:
          new Date()
            .toISOString()
      });
  }
}
