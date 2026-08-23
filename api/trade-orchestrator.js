// /api/trade-orchestrator.js
// FAWAZ AI BOT
// PAPER SCALPER V1
// 4 Slots - NO REAL TRADING

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

const CONFIG = {
  maxSlots: 4,
  slotUsd: 5,

  calmTargetBps: 30,
  normalTargetBps: 45,
  fastTargetBps: 70,

  stopLossBps: 45,

  trailingActivationRatio: 0.65,
  trailingDistanceRatio: 0.30,

  minNetEdgeBps: 12,
  estimatedSlippageBps: 6,

  maxEntriesPerCycle: 1
};

function num(value, fallback = 0) {
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

function getBaseUrl(req) {
  if (process.env.APP_BASE_URL) {
    return process.env.APP_BASE_URL
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

  if (process.env.VERCEL_URL) {
    return (
      "https://" +
      process.env.VERCEL_URL
    );
  }

  const host =
    req.headers.host;

  if (host) {
    return `https://${host}`;
  }

  return "https://fawaz-ai-bot.vercel.app";
}

async function fetchJson(url) {
  const response =
    await fetch(url, {
      headers: {
        Accept:
          "application/json"
      }
    });

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

  if (mode === "NORMAL") {
    target =
      CONFIG.normalTargetBps;
  }

  if (mode === "FAST") {
    target =
      CONFIG.fastTargetBps;
  }

  if (riskMode === "FAST") {
    target *= 1.1;
  }

  if (
    riskMode === "DEFENSIVE"
  ) {
    target *= 0.8;
  }

  return Math.round(
    clamp(
      target,
      20,
      100
    )
  );
}

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

    if (entryPrice <= 0) {
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

    // STOP LOSS
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
    }

    // TRAILING EXIT
    if (trailingActive) {
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

    // HARD TARGET
    if (
      pnlBps >=
      targetBps * 1.4
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

    events.push({
      slotId:
        position.slot_id,

      action:
        "HOLD",

      pnlBps:
        Number(
          pnlBps.toFixed(2)
        )
    });
  }

  return events;
}

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
      signal.action
    ).toUpperCase() !==
    "BUY"
  ) {
    return {
      opened: false,
      reason:
        "NO_BUY_SIGNAL"
    };
  }

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

  const riskMode =
    getDynamicRiskMode(
      recentTrades
    );

  const riskState = {
    totalCapitalUsd:
      25,

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

  const candidate = {
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

  if (!risk.allowed) {
    return {
      opened: false,
      reason:
        risk.reason,
      risk
    };
  }

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

    riskMode
  };
}

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
    const walletAddress =
      getWalletAddress();

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

    const riskMode =
      getDynamicRiskMode(
        recentTrades
      );

    const targetBps =
      getDynamicTarget(
        signal,
        riskMode
      );

    const positionEvents =
      await managePositions({
        positions:
          positionsBefore,

        currentPrice
      });

    const positionsAfterExit =
      await getOpenPositions(
        walletAddress
      );

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

    const dashboard =
      await getTradingDashboard(
        walletAddress
      );

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
          "Paper scalper failed"
      });
  }
}
