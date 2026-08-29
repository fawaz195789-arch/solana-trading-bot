// /api/trade-orchestrator.js
// FAWAZ AI BOT
// FULL AUTO ORCHESTRATOR V6
// WHALE INTELLIGENCE V1 + STRICT BUY-THE-DIP V1 + PREDICTIVE VOLATILITY V1

import crypto from "crypto";

import {
  evaluateRisk,
  getDynamicRiskMode
} from "./risk-agent.js";

import {
  getOpenPositions,
  getFreeSlot,
  getOpenPositionBySlot,
  openPosition,
  closePosition,
  getRecentClosedTrades,
  getTradingDashboard,
  updateHighestPrice
} from "./trading-store.js";

const CONFIG = {
  reservePct: 0.20,
  maxCapitalUsagePct: 0.80,
  minSlots: 4,
  maxSlotsCap: 16,
  minSlotUsd: 0.25,

  weakSlotMultiplier: 0.65,
  normalSlotMultiplier: 0.90,
  strongSlotMultiplier: 1.00,
  veryStrongSlotMultiplier: 1.08,

  minEntrySpacingBps: 14,
  minAdditionalEntryConfidence: 52,
  strictLowerAdditionalEntries: true,
  strictAddBelowLowestBps: 10,

  calmTargetBps: 30,
  normalTargetBps: 42,
  fastTargetBps: 58,

  minNetExitBps: 12,
  profitSafetyBufferBps: 2,

  softLossGuardBps: 35,
  emergencyLossBps: 90,
  absoluteEmergencyLossBps: 175,
  emergencyMomentum1mBps: -18,
  emergencyMomentum3mBps: -30,
  maxProtectedPositionsPct: 0.35,

  minimumEntryScore: 56,
  strongEntryScore: 72,
  eliteEntryScore: 84,
  minimumLearningConfidence: 50,

  requireDipBeforeBuy: true,
  minPriorDipMomentumBps: -3,
  minDipRecoveryBps: 4,
  chaseMomentumThresholdBps: 3,

  minimumPredictionScore: 58,
  strongPredictionScore: 72,
  predictionWeightMomentum: 0.35,
  predictionWeightReversal: 0.30,
  predictionWeightOrderBook: 0.20,
  predictionWeightVolatility: 0.15,
  predictiveTargetMinBps: 24,
  predictiveTargetMaxBps: 85,

  maxSlippageBps: 30,
  minNetEdgeBps: 10,
  executionBufferBps: 6
};

const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundUsd(value) {
  return Number(num(value).toFixed(6));
}

function toBps(value) {
  return value * 10000;
}

function atomicToAmount(value, decimals) {
  return num(value) / Math.pow(10, decimals);
}

function getDynamicMaxSlots(totalCapitalUsd) {
  const capital = Math.max(0, num(totalCapitalUsd));

  if (capital < 25) return 4;
  if (capital < 50) return 6;
  if (capital < 100) return 8;
  if (capital < 250) return 10;
  if (capital < 500) return 12;

  return CONFIG.maxSlotsCap;
}

function getWalletAddress() {
  const wallet =
    process.env.BOT_PUBLIC_WALLET ||
    process.env.BOT_WALLET_ADDRESS ||
    process.env.SOLANA_WALLET_ADDRESS ||
    process.env.WALLET_ADDRESS;

  if (!wallet) {
    throw new Error("BOT_WALLET_ADDRESS_MISSING");
  }

  return wallet.trim();
}

function authorize(req) {
  const secret = process.env.AUTO_TRADER_SECRET;

  if (!secret) {
    return {
      ok: false,
      status: 500,
      reason: "AUTO_TRADER_SECRET_MISSING"
    };
  }

  const auth =
    req.headers.authorization ||
    req.headers.Authorization ||
    "";

  if (auth !== `Bearer ${secret}`) {
    return {
      ok: false,
      status: 401,
      reason: "UNAUTHORIZED"
    };
  }

  return { ok: true };
}

function getBaseUrl(req) {
  if (process.env.APP_BASE_URL) {
    return process.env.APP_BASE_URL.replace(/\/$/, "");
  }

  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }

  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }

  const host = req.headers.host;

  if (host) {
    const protocol =
      host.includes("localhost")
        ? "http"
        : "https";

    return `${protocol}://${host}`;
  }

  return "https://fawaz-ai-bot.vercel.app";
}

async function fetchJson(url, options = {}) {
  const response =
    await fetch(url, {
      ...options,
      cache: "no-store"
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
      `HTTP_${response.status}:${JSON.stringify(data)}`
    );
  }

  return data;
}

async function loadSignal(req) {
  const baseUrl =
    getBaseUrl(req);

  const data =
    await fetchJson(
      `${baseUrl}/api/signal`,
      {
        method: "GET",
        headers: {
          Accept: "application/json"
        }
      }
    );

  if (
    data?.status !== "ok" ||
    !data?.signal
  ) {
    throw new Error(
      "INVALID_SIGNAL_RESPONSE"
    );
  }

  return data;
}

async function loadWalletSnapshot(req) {
  const baseUrl =
    getBaseUrl(req);

  const data =
    await fetchJson(
      `${baseUrl}/api/execution-agent?test=wallet`,
      {
        method: "GET",
        headers: {
          Accept: "application/json"
        }
      }
    );

  if (
    data?.status !== "ok" ||
    data?.tradingKeyReady !== true
  ) {
    throw new Error(
      "REAL_WALLET_NOT_READY"
    );
  }

  return {
    walletAddress:
      data.walletAddress,

    solBalance:
      num(data.solBalance),

    usdcBalance:
      num(data.usdcBalance),

    source:
      data.balancesSource ||
      "ON_CHAIN"
  };
}

async function executeTrade({
  req,
  side,
  slotId,
  amountUsd = 0,
  amountSol = 0,
  slippageBps = 20
}) {
  const baseUrl =
    getBaseUrl(req);

  const secret =
    process.env.AUTO_TRADER_SECRET;

  if (!secret) {
    throw new Error(
      "AUTO_TRADER_SECRET_MISSING"
    );
  }

  return await fetchJson(
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
        JSON.stringify({
          side,
          slotId,
          amountUsd,
          amountSol,

          slippageBps:
            clamp(
              Math.floor(
                num(
                  slippageBps,
                  20
                )
              ),
              1,
              CONFIG.maxSlippageBps
            )
        })
    }
  );
}

function getTradePnlBps(trade) {
  const realizedPnl =
    num(
      trade?.realized_pnl,
      NaN
    );

  const entryUsdc =
    num(
      trade?.entry_usdc,
      NaN
    );

  if (
    Number.isFinite(realizedPnl) &&
    Number.isFinite(entryUsdc) &&
    entryUsdc > 0
  ) {
    return (
      realizedPnl /
      entryUsdc
    ) * 10000;
  }

  const pct =
    num(
      trade?.realized_pnl_pct,
      NaN
    );

  if (
    Number.isFinite(pct)
  ) {
    return pct * 100;
  }

  return 0;
}

function buildLearningProfile(
  recentTrades = []
) {
  const trades =
    Array.isArray(recentTrades)
      ? recentTrades.slice(0, 20)
      : [];

  if (
    trades.length === 0
  ) {
    return {
      engine:
        "ADAPTIVE_LEARNING_V1",

      sampleSize: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      consecutiveLosses: 0,
      averagePnlBps: 0,
      minConfidence: 58,
      entryScoreAdjustment: 0,
      sizeMultiplier: 0.90,
      mode:
        "LEARNING"
    };
  }

  let wins = 0;
  let losses = 0;
  let totalPnlBps = 0;

  const values =
    trades.map(
      trade => {
        const pnl =
          getTradePnlBps(
            trade
          );

        totalPnlBps +=
          pnl;

        if (pnl > 0) {
          wins++;
        } else if (pnl < 0) {
          losses++;
        }

        return pnl;
      }
    );

  let consecutiveLosses =
    0;

  for (
    const pnl
    of values
  ) {
    if (pnl < 0) {
      consecutiveLosses++;
    } else {
      break;
    }
  }

  const winRate =
    wins /
    trades.length;

  const averagePnlBps =
    totalPnlBps /
    trades.length;

  let minConfidence =
    56;

  let entryScoreAdjustment =
    0;

  let sizeMultiplier =
    1.00;

  let mode =
    "NORMAL";

  if (
    trades.length >= 5 &&
    winRate >= 0.82 &&
    consecutiveLosses === 0 &&
    averagePnlBps > 0
  ) {
    minConfidence =
      52;

    entryScoreAdjustment =
      -3;

    sizeMultiplier =
      1.05;

    mode =
      "CONFIDENT";
  }

  if (
    winRate < 0.70
  ) {
    minConfidence =
      60;

    entryScoreAdjustment =
      5;

    sizeMultiplier =
      0.85;

    mode =
      "CAUTIOUS";
  }

  if (
    consecutiveLosses >= 2
  ) {
    minConfidence =
      65;

    entryScoreAdjustment =
      9;

    sizeMultiplier =
      0.70;

    mode =
      "DEFENSIVE";
  }

  if (
    consecutiveLosses >= 3
  ) {
    minConfidence =
      70;

    entryScoreAdjustment =
      14;

    sizeMultiplier =
      0.55;

    mode =
      "RECOVERY";
  }

  return {
    engine:
      "ADAPTIVE_LEARNING_V1",

    sampleSize:
      trades.length,

    wins,

    losses,

    winRate:
      Number(
        (
          winRate *
          100
        ).toFixed(2)
      ),

    consecutiveLosses,

    averagePnlBps:
      Number(
        averagePnlBps
          .toFixed(2)
      ),

    minConfidence:
      clamp(
        minConfidence,
        CONFIG.minimumLearningConfidence,
        75
      ),

    entryScoreAdjustment,

    sizeMultiplier:
      clamp(
        sizeMultiplier,
        0.50,
        1.08
      ),

    mode
  };
}

function detectMarketRegime(
  signal
) {
  const m1 =
    num(
      signal.momentum1mBps
    );

  const m3 =
    num(
      signal.momentum3mBps
    );

  const volatility =
    Math.abs(
      num(
        signal.volatilityBps
      )
    );

  const direction =
    String(
      signal.direction ||
      ""
    ).toUpperCase();

  if (
    (
      m1 <= -18 &&
      m3 <= -25
    ) ||
    (
      direction.includes("DOWN") &&
      m3 <= -20
    )
  ) {
    return {
      regime:
        "STRONG_DOWN",

      riskMultiplier:
        0.55,

      entryPenalty:
        20
    };
  }

  if (
    m1 < 0 &&
    m3 < 0
  ) {
    return {
      regime:
        "DOWN",

      riskMultiplier:
        0.75,

      entryPenalty:
        10
    };
  }

  if (
    m1 >= 8 &&
    m3 >= 5
  ) {
    return {
      regime:
        "UP",

      riskMultiplier:
        1.00,

      entryPenalty:
        0
    };
  }

  if (
    volatility >= 70
  ) {
    return {
      regime:
        "HIGH_VOLATILITY",

      riskMultiplier:
        0.75,

      entryPenalty:
        8
    };
  }

  if (
    Math.abs(m1) <= 8 &&
    Math.abs(m3) <= 15
  ) {
    return {
      regime:
        "RANGE",

      riskMultiplier:
        1.00,

      entryPenalty:
        0
    };
  }

  return {
    regime:
      "NORMAL",

    riskMultiplier:
      0.95,

    entryPenalty:
      2
  };
}

function estimateExecutionCosts(
  signal
) {
  const spread =
    Math.max(
      0,
      num(
        signal.spreadBps
      )
    );

  const slippage =
    clamp(
      Math.ceil(
        spread /
        2 +
        2
      ),
      4,
      15
    );

  const roundTripCostBps =
    spread +
    slippage * 2 +
    CONFIG.executionBufferBps;

  return {
    estimatedSlippageBps:
      slippage,

    estimatedRoundTripCostBps:
      Number(
        roundTripCostBps
          .toFixed(2)
      )
  };
}

function buildPredictiveVolatility(
  signal,
  marketRegime,
  learning
) {
  const hasM1 =
    signal.momentum1mBps != null;

  const hasM3 =
    signal.momentum3mBps != null;

  const hasM5 =
    signal.momentum5mBps != null;

  const m1 =
    num(
      signal.momentum1mBps
    );

  const m3 =
    num(
      signal.momentum3mBps
    );

  const m5 =
    num(
      signal.momentum5mBps
    );

  const volatility =
    Math.abs(
      num(
        signal.volatilityBps
      )
    );

  const imbalance =
    clamp(
      num(
        signal.orderBookImbalance
      ),
      -1,
      1
    );

  const spread =
    Math.max(
      0,
      num(
        signal.spreadBps
      )
    );

  const confidence =
    clamp(
      num(
        signal.confidence
      ),
      0,
      100
    );

  const momentumImprovement =
    hasM1 &&
    hasM3
      ? m1 - m3
      : 0;

  const priorDip =
    hasM3 &&
    m3 <=
      CONFIG.minPriorDipMomentumBps;

  const recovery =
    hasM1 &&
    hasM3 &&
    priorDip &&
    m1 >= 0 &&
    momentumImprovement >=
      CONFIG.minDipRecoveryBps;

  let momentumModel =
    50;

  if (
    hasM1 &&
    hasM3
  ) {
    momentumModel +=
      clamp(
        momentumImprovement *
        1.7,
        -35,
        35
      );

    if (
      recovery
    ) {
      momentumModel +=
        15;
    }

    if (
      m1 >= 0 &&
      m3 < 0
    ) {
      momentumModel +=
        12;
    }

    if (
      m1 >
        CONFIG
          .chaseMomentumThresholdBps &&
      m3 >
        CONFIG
          .chaseMomentumThresholdBps
    ) {
      momentumModel -=
        25;
    }
  } else {
    momentumModel =
      20;
  }

  momentumModel =
    clamp(
      momentumModel,
      0,
      100
    );

  let reversalModel =
    25;

  if (
    priorDip
  ) {
    reversalModel +=
      25;
  }

  if (
    recovery
  ) {
    reversalModel +=
      35;
  }

  if (
    m1 >= 0 &&
    m3 < 0
  ) {
    reversalModel +=
      15;
  }

  if (
    marketRegime.regime ===
    "STRONG_DOWN"
  ) {
    reversalModel -=
      40;
  }

  reversalModel =
    clamp(
      reversalModel,
      0,
      100
    );

  let orderBookModel =
    50 +
    imbalance *
    40;

  if (
    spread <= 4
  ) {
    orderBookModel +=
      8;
  }

  if (
    spread >= 15
  ) {
    orderBookModel -=
      18;
  }

  orderBookModel =
    clamp(
      orderBookModel,
      0,
      100
    );

  let volatilityModel =
    45;

  if (
    volatility >= 8 &&
    volatility <= 60
  ) {
    volatilityModel +=
      30;

  } else if (
    volatility > 60 &&
    volatility <= 90
  ) {
    volatilityModel +=
      10;

  } else if (
    volatility > 90
  ) {
    volatilityModel -=
      20;
  }

  if (
    marketRegime.regime ===
    "RANGE"
  ) {
    volatilityModel +=
      10;
  }

  if (
    marketRegime.regime ===
    "STRONG_DOWN"
  ) {
    volatilityModel -=
      15;
  }

  volatilityModel =
    clamp(
      volatilityModel,
      0,
      100
    );

  const consensusScore =
    clamp(
      momentumModel *
        CONFIG
          .predictionWeightMomentum +

      reversalModel *
        CONFIG
          .predictionWeightReversal +

      orderBookModel *
        CONFIG
          .predictionWeightOrderBook +

      volatilityModel *
        CONFIG
          .predictionWeightVolatility,

      0,
      100
    );

  let upsideScore =
    consensusScore;

  if (
    marketRegime.regime ===
    "STRONG_DOWN"
  ) {
    upsideScore -=
      15;
  }

  if (
    priorDip &&
    recovery
  ) {
    upsideScore +=
      10;
  }

  upsideScore =
    clamp(
      upsideScore,
      0,
      100
    );

  const expectedSwingBps =
    clamp(
      Math.max(
        CONFIG.predictiveTargetMinBps,

        volatility *
          0.70 +

        Math.max(
          0,
          momentumImprovement
        ) *
          0.80
      ),
      CONFIG.predictiveTargetMinBps,
      CONFIG.predictiveTargetMaxBps
    );

  const costs =
    estimateExecutionCosts(
      signal
    );

  const expectedNetEdgeBps =
    expectedSwingBps -
    costs.estimatedRoundTripCostBps;

  let requiredScore =
    CONFIG.minimumPredictionScore +
    num(
      learning.entryScoreAdjustment
    ) * 0.5;

  requiredScore =
    clamp(
      requiredScore,
      54,
      76
    );

  const chasingUptrend =
    hasM1 &&
    hasM3 &&
    m1 >
      CONFIG
        .chaseMomentumThresholdBps &&
    m3 >
      CONFIG
        .chaseMomentumThresholdBps;

  const enoughMomentumData =
    hasM1 &&
    hasM3;

  const allowed =
    enoughMomentumData &&
    priorDip &&
    recovery &&
    consensusScore >=
      requiredScore &&
    expectedNetEdgeBps >=
      CONFIG.minNetEdgeBps &&
    !chasingUptrend &&
    marketRegime.regime !==
      "STRONG_DOWN";

  let reason =
    "PREDICTIVE_SCORE_TOO_LOW";

  if (
    !enoughMomentumData
  ) {
    reason =
      "INSUFFICIENT_MOMENTUM_DATA";

  } else if (
    chasingUptrend
  ) {
    reason =
      "PREDICTIVE_REJECT_CHASING_UPTREND";

  } else if (
    marketRegime.regime ===
    "STRONG_DOWN"
  ) {
    reason =
      "PREDICTIVE_REJECT_STRONG_DOWN";

  } else if (
    !priorDip
  ) {
    reason =
      "WAIT_FOR_REAL_DIP";

  } else if (
    !recovery
  ) {
    reason =
      "WAIT_FOR_CONFIRMED_REVERSAL";

  } else if (
    expectedNetEdgeBps <
    CONFIG.minNetEdgeBps
  ) {
    reason =
      "PREDICTIVE_EDGE_TOO_LOW";

  } else if (
    allowed
  ) {
    reason =
      "PREDICTIVE_CONSENSUS_APPROVED";
  }

  return {
    engine:
      "PREDICTIVE_VOLATILITY_V1",

    allowed,

    consensusScore:
      Number(
        consensusScore
          .toFixed(2)
      ),

    requiredScore:
      Number(
        requiredScore
          .toFixed(2)
      ),

    upsideScore:
      Number(
        upsideScore
          .toFixed(2)
      ),

    probabilityUpPct:
      Number(
        upsideScore
          .toFixed(2)
      ),

    expectedSwingBps:
      Number(
        expectedSwingBps
          .toFixed(2)
      ),

    expectedNetEdgeBps:
      Number(
        expectedNetEdgeBps
          .toFixed(2)
      ),

    momentumModel:
      Number(
        momentumModel
          .toFixed(2)
      ),

    reversalModel:
      Number(
        reversalModel
          .toFixed(2)
      ),

    orderBookModel:
      Number(
        orderBookModel
          .toFixed(2)
      ),

    volatilityModel:
      Number(
        volatilityModel
          .toFixed(2)
      ),

    momentum1mBps:
      m1,

    momentum3mBps:
      m3,

    momentum5mBps:
      hasM5
        ? m5
        : null,

    momentumImprovementBps:
      Number(
        momentumImprovement
          .toFixed(2)
      ),

    enoughMomentumData,

    priorDip,

    recovery,

    chasingUptrend,

    marketRegime:
      marketRegime.regime,

    reason
  };
}

function evaluateWhaleEntry({
  signal,
  learning,
  marketRegime,
  predictive
}) {
  const confidence =
    num(
      signal.confidence
    );

  const setup =
    String(
      signal.setup ||
      ""
    ).toUpperCase();

  const direction =
    String(
      signal.direction ||
      ""
    ).toUpperCase();

  const hasM1 =
    signal.momentum1mBps != null;

  const hasM3 =
    signal.momentum3mBps != null;

  const m1 =
    num(
      signal.momentum1mBps
    );

  const m3 =
    num(
      signal.momentum3mBps
    );

  const imbalance =
    num(
      signal.orderBookImbalance
    );

  const spread =
    Math.max(
      0,
      num(
        signal.spreadBps
      )
    );

  const volatility =
    Math.abs(
      num(
        signal.volatilityBps
      )
    );

  const minimumConfidence =
    Math.max(
      CONFIG.minimumLearningConfidence,
      num(
        learning.minConfidence,
        58
      )
    );

  if (
    !hasM1 ||
    !hasM3
  ) {
    return {
      engine:
        "WHALE_INTELLIGENCE_V1",

      allowed:
        false,

      score:
        0,

      grade:
        "WAIT_DATA",

      reason:
        "INSUFFICIENT_MOMENTUM_DATA",

      confidence,

      minimumConfidence,

      marketRegime:
        marketRegime.regime,

      predictive,

      evidence: [
        "STRICT_BUY_THE_DIP_REQUIRES_MOMENTUM_DATA"
      ]
    };
  }

  if (
    confidence <
    minimumConfidence
  ) {
    return {
      engine:
        "WHALE_INTELLIGENCE_V1",

      allowed:
        false,

      score:
        0,

      grade:
        "REJECTED",

      reason:
        "LEARNING_CONFIDENCE_TOO_LOW",

      confidence,

      minimumConfidence,

      marketRegime:
        marketRegime.regime,

      predictive,

      evidence: []
    };
  }

  if (
    !predictive ||
    predictive.allowed !== true
  ) {
    return {
      engine:
        "WHALE_INTELLIGENCE_V1",

      allowed:
        false,

      score:
        0,

      grade:
        "WAIT_PREDICTION",

      reason:
        predictive?.reason ||
        "PREDICTIVE_NOT_READY",

      confidence,

      minimumConfidence,

      marketRegime:
        marketRegime.regime,

      predictive,

      evidence: [
        "PREDICTIVE_VOLATILITY_GATE"
      ]
    };
  }

  const priorDip =
    m3 <=
    CONFIG.minPriorDipMomentumBps;

  const momentumImprovement =
    m1 -
    m3;

  const momentumRecovery =
    m1 >= 0 &&
    momentumImprovement >=
      CONFIG.minDipRecoveryBps;

  const chasingUptrend =
    m1 >
      CONFIG.chaseMomentumThresholdBps &&
    m3 >
      CONFIG.chaseMomentumThresholdBps;

  if (
    CONFIG.requireDipBeforeBuy &&
    (
      !priorDip ||
      !momentumRecovery ||
      chasingUptrend
    )
  ) {
    return {
      engine:
        "WHALE_INTELLIGENCE_V1",

      allowed:
        false,

      score:
        0,

      grade:
        "WAIT_DIP",

      reason:
        chasingUptrend
          ? "DO_NOT_CHASE_RISING_PRICE"
          : !priorDip
            ? "WAIT_FOR_REAL_DIP"
            : "WAIT_FOR_CONFIRMED_REVERSAL",

      confidence,

      minimumConfidence,

      marketRegime:
        marketRegime.regime,

      momentum1mBps:
        m1,

      momentum3mBps:
        m3,

      momentumImprovementBps:
        Number(
          momentumImprovement
            .toFixed(2)
        ),

      predictive,

      evidence: [
        "STRICT_BUY_THE_DIP_V1"
      ]
    };
  }

  let score =
    0;

  const evidence =
    [];

  score +=
    clamp(
      confidence *
      0.35,
      0,
      35
    );

  if (
    setup.includes("DIP") ||
    setup.includes("PULLBACK") ||
    setup.includes("REVERS")
  ) {
    score +=
      15;

    evidence.push(
      "DIP_OR_REVERSAL_SETUP"
    );
  }

  if (
    priorDip &&
    momentumRecovery
  ) {
    score +=
      22;

    evidence.push(
      "CONFIRMED_DIP_RECOVERY"
    );
  }

  if (
    m1 >= 0 &&
    m3 < 0
  ) {
    score +=
      14;

    evidence.push(
      "MICRO_REVERSAL_CONFIRMED"
    );
  }

  if (
    imbalance > 0
  ) {
    score +=
      clamp(
        imbalance *
        10,
        0,
        10
      );

    evidence.push(
      "BUY_PRESSURE"
    );
  }

  if (
    momentumRecovery &&
    (
      direction.includes("UP") ||
      direction.includes("BULL")
    )
  ) {
    score +=
      6;

    evidence.push(
      "RECOVERY_DIRECTION_UP"
    );
  }

  if (
    spread <= 4
  ) {
    score +=
      7;

    evidence.push(
      "LOW_SPREAD"
    );

  } else if (
    spread <= 8
  ) {
    score +=
      4;

    evidence.push(
      "ACCEPTABLE_SPREAD"
    );

  } else if (
    spread >= 15
  ) {
    score -=
      8;

    evidence.push(
      "HIGH_SPREAD_PENALTY"
    );
  }

  if (
    volatility >= 8 &&
    volatility <= 60
  ) {
    score +=
      5;

    evidence.push(
      "HEALTHY_VOLATILITY"
    );
  }

  score -=
    num(
      marketRegime.entryPenalty
    );

  const requiredScore =
    clamp(
      CONFIG.minimumEntryScore +
      num(
        learning.entryScoreAdjustment
      ),
      50,
      78
    );

  score =
    clamp(
      score,
      0,
      100
    );

  let grade =
    "WEAK";

  if (
    score >=
    CONFIG.eliteEntryScore
  ) {
    grade =
      "ELITE";

  } else if (
    score >=
    CONFIG.strongEntryScore
  ) {
    grade =
      "STRONG";

  } else if (
    score >=
    requiredScore
  ) {
    grade =
      "APPROVED";
  }

  const allowed =
    score >=
    requiredScore;

  return {
    engine:
      "WHALE_INTELLIGENCE_V1",

    allowed,

    score:
      Number(
        score
          .toFixed(2)
      ),

    requiredScore,

    grade,

    reason:
      allowed
        ? "WHALE_DIP_REVERSAL_APPROVED"
        : "WHALE_ENTRY_REJECTED",

    confidence,

    minimumConfidence,

    marketRegime:
      marketRegime.regime,

    momentum1mBps:
      m1,

    momentum3mBps:
      m3,

    momentumImprovementBps:
      Number(
        momentumImprovement
          .toFixed(2)
      ),

    priorDip,

    momentumRecovery,

    chasingUptrend,

    spreadBps:
      spread,

    volatilityBps:
      volatility,

    orderBookImbalance:
      imbalance,

    predictive,

    evidence
  };
}

function getDynamicTarget(
  signal,
  riskMode,
  predictive = null
) {
  const mode =
    String(
      signal.marketMode ||
      "CALM"
    ).toUpperCase();

  let target =
    CONFIG.calmTargetBps;

  if (
    mode ===
    "NORMAL"
  ) {
    target =
      CONFIG.normalTargetBps;
  }

  if (
    mode ===
    "FAST"
  ) {
    target =
      CONFIG.fastTargetBps;
  }

  if (
    predictive &&
    predictive.expectedSwingBps >
      0
  ) {
    target =
      target *
      0.45 +
      predictive.expectedSwingBps *
      0.55;
  }

  if (
    riskMode ===
    "FAST"
  ) {
    target *=
      1.08;
  }

  if (
    riskMode ===
    "DEFENSIVE"
  ) {
    target *=
      0.85;
  }

  return Math.round(
    clamp(
      target,
      CONFIG.predictiveTargetMinBps,
      CONFIG.predictiveTargetMaxBps
    )
  );
}

function calculateCapital({
  positions = [],
  walletSnapshot,
  currentPrice
}) {
  const realUsdc =
    Math.max(
      0,
      num(
        walletSnapshot
          ?.usdcBalance
      )
    );

  const trackedSolValue =
    positions.reduce(
      (
        total,
        position
      ) => {
        return (
          total +
          num(
            position.entry_sol
          ) *
          currentPrice
        );
      },
      0
    );

  const trackedNav =
    Math.max(
      0,
      realUsdc +
      trackedSolValue
    );

  const maxSlots =
    getDynamicMaxSlots(
      trackedNav
    );

  const tradableTarget =
    trackedNav *
    CONFIG.maxCapitalUsagePct;

  const reserve =
    trackedNav *
    CONFIG.reservePct;

  const usedInPositions =
    positions.reduce(
      (
        total,
        position
      ) => {
        return (
          total +
          num(
            position.entry_usdc
          )
        );
      },
      0
    );

  const remainingTradableBudget =
    Math.max(
      0,
      tradableTarget -
      usedInPositions
    );

  const cashAboveReserve =
    Math.max(
      0,
      realUsdc -
      reserve
    );

  const availableForTrading =
    Math.max(
      0,
      Math.min(
        cashAboveReserve,
        remainingTradableBudget
      )
    );

  const targetSlotBudget =
    maxSlots > 0
      ? tradableTarget /
        maxSlots
      : 0;

  const exposurePct =
    trackedNav > 0
      ? usedInPositions /
        trackedNav
      : 0;

  return {
    source:
      "REAL_ON_CHAIN_BALANCE",

    realUsdcBalance:
      roundUsd(
        realUsdc
      ),

    trackedSolValue:
      roundUsd(
        trackedSolValue
      ),

    total:
      roundUsd(
        trackedNav
      ),

    reservePct:
      CONFIG.reservePct,

    maxCapitalUsagePct:
      CONFIG.maxCapitalUsagePct,

    reserve:
      roundUsd(
        reserve
      ),

    tradableTarget:
      roundUsd(
        tradableTarget
      ),

    usedInPositions:
      roundUsd(
        usedInPositions
      ),

    exposurePct:
      Number(
        (
          exposurePct *
          100
        ).toFixed(2)
      ),

    remainingTradableBudget:
      roundUsd(
        remainingTradableBudget
      ),

    availableForTrading:
      roundUsd(
        availableForTrading
      ),

    targetSlotBudget:
      roundUsd(
        targetSlotBudget
      ),

    maxSlots,

    openPositions:
      positions.length,

    compounding:
      true
  };
}

function analyzeOpenRisk({
  positions = [],
  currentPrice,
  maxSlots
}) {
  let underwaterCount =
    0;

  let protectedCount =
    0;

  let worstPnlBps =
    0;

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
      continue;
    }

    const pnlBps =
      (
        (
          currentPrice -
          entryPrice
        ) /
        entryPrice
      ) *
      10000;

    if (
      pnlBps < 0
    ) {
      underwaterCount++;
    }

    if (
      pnlBps <=
      -CONFIG.softLossGuardBps
    ) {
      protectedCount++;
    }

    worstPnlBps =
      Math.min(
        worstPnlBps,
        pnlBps
      );
  }

  const maxProtectedPositions =
    Math.max(
      1,
      Math.floor(
        maxSlots *
        CONFIG.maxProtectedPositionsPct
      )
    );

  return {
    underwaterCount,

    protectedCount,

    maxProtectedPositions,

    worstPnlBps:
      Number(
        worstPnlBps
          .toFixed(2)
      ),

    allowNewEntry:
      protectedCount <
      maxProtectedPositions
  };
}

function getDynamicEntrySize({
  availableUsdc,
  confidence,
  whaleScore,
  openPositions,
  maxSlots,
  targetSlotBudget,
  learningMultiplier,
  marketRiskMultiplier
}) {
  const available =
    Math.max(
      0,
      num(
        availableUsdc
      )
    );

  if (
    available <
    CONFIG.minSlotUsd
  ) {
    return 0;
  }

  const remainingSlots =
    Math.max(
      1,
      maxSlots -
      openPositions
    );

  const evenShare =
    available /
    remainingSlots;

  const baseBudget =
    Math.min(
      targetSlotBudget,
      evenShare
    );

  let multiplier =
    CONFIG.weakSlotMultiplier;

  if (
    whaleScore >=
    CONFIG.eliteEntryScore
  ) {
    multiplier =
      CONFIG.veryStrongSlotMultiplier;

  } else if (
    whaleScore >=
    CONFIG.strongEntryScore
  ) {
    multiplier =
      CONFIG.strongSlotMultiplier;

  } else if (
    confidence >= 58
  ) {
    multiplier =
      CONFIG.normalSlotMultiplier;
  }

  multiplier *=
    clamp(
      learningMultiplier,
      0.50,
      1.08
    );

  multiplier *=
    clamp(
      marketRiskMultiplier,
      0.50,
      1.00
    );

  const amount =
    Math.min(
      available,
      baseBudget *
      multiplier
    );

  if (
    amount <
    CONFIG.minSlotUsd
  ) {
    return 0;
  }

  return roundUsd(
    amount
  );
}

function estimateSellCostBps(
  signal
) {
  const spread =
    Math.max(
      0,
      num(
        signal?.spreadBps
      )
    );

  const slippage =
    clamp(
      Math.ceil(
        spread /
        2 +
        2
      ),
      4,
      15
    );

  const estimatedSellCostBps =
    slippage +
    spread /
    2 +
    CONFIG.executionBufferBps;

  return {
    spreadBps:
      spread,

    estimatedSlippageBps:
      slippage,

    estimatedSellCostBps:
      Number(
        estimatedSellCostBps
          .toFixed(2)
      )
  };
}

function evaluateMultiEntry({
  positions = [],
  signal
}) {
  const currentPrice =
    num(
      signal.currentPrice
    );

  if (
    currentPrice <= 0
  ) {
    return {
      allowed:
        false,

      reason:
        "INVALID_MULTI_ENTRY_PRICE"
    };
  }

  if (
    positions.length ===
    0
  ) {
    return {
      allowed:
        true,

      reason:
        "FIRST_ENTRY",

      entryNumber:
        1,

      nearestDistanceBps:
        null
    };
  }

  const entryPrices =
    positions
      .map(
        position =>
          num(
            position.entry_price
          )
      )
      .filter(
        value =>
          value > 0
      );

  if (
    entryPrices.length ===
    0
  ) {
    return {
      allowed:
        true,

      reason:
        "NO_VALID_EXISTING_ENTRY_PRICE",

      entryNumber:
        positions.length +
        1
    };
  }

  const distances =
    entryPrices.map(
      entryPrice =>
        Math.abs(
          (
            currentPrice -
            entryPrice
          ) /
          entryPrice
        ) *
        10000
    );

  const nearestDistanceBps =
    Math.min(
      ...distances
    );

  if (
    nearestDistanceBps <
    CONFIG.minEntrySpacingBps
  ) {
    return {
      allowed:
        false,

      reason:
        "ENTRY_TOO_CLOSE_TO_EXISTING_POSITION",

      nearestDistanceBps:
        Number(
          nearestDistanceBps
            .toFixed(2)
        ),

      requiredDistanceBps:
        CONFIG.minEntrySpacingBps,

      entryNumber:
        positions.length +
        1
    };
  }

  const confidence =
    num(
      signal.confidence
    );

  if (
    confidence <
    CONFIG.minAdditionalEntryConfidence
  ) {
    return {
      allowed:
        false,

      reason:
        "ADDITIONAL_ENTRY_CONFIDENCE_TOO_LOW",

      confidence,

      requiredConfidence:
        CONFIG.minAdditionalEntryConfidence,

      entryNumber:
        positions.length +
        1
    };
  }

  const lowestEntryPrice =
    Math.min(
      ...entryPrices
    );

  const belowLowestBps =
    (
      (
        lowestEntryPrice -
        currentPrice
      ) /
      lowestEntryPrice
    ) *
    10000;

  if (
    CONFIG.strictLowerAdditionalEntries &&
    belowLowestBps <
    CONFIG.strictAddBelowLowestBps
  ) {
    return {
      allowed:
        false,

      reason:
        currentPrice >=
        lowestEntryPrice
          ? "NEVER_ADD_ABOVE_LOWEST_ENTRY"
          : "WAIT_FOR_DEEPER_DIP",

      lowestEntryPrice,

      currentPrice,

      belowLowestBps:
        Number(
          belowLowestBps
            .toFixed(2)
        ),

      requiredBelowBps:
        CONFIG.strictAddBelowLowestBps,

      entryNumber:
        positions.length +
        1
    };
  }

  return {
    allowed:
      true,

    reason:
      "STRICT_LOWER_MULTI_ENTRY_APPROVED",

    lowestEntryPrice,

    currentPrice,

    belowLowestBps:
      Number(
        belowLowestBps
          .toFixed(2)
      ),

    nearestDistanceBps:
      Number(
        nearestDistanceBps
          .toFixed(2)
      ),

    entryNumber:
      positions.length +
      1
  };
}

async function buildSellCandidates({
  positions,
  currentPrice,
  signal
}) {
  const candidates =
    [];

  const exitCosts =
    estimateSellCostBps(
      signal
    );

  const m1 =
    num(
      signal.momentum1mBps
    );

  const m3 =
    num(
      signal.momentum3mBps
    );

  const direction =
    String(
      signal.direction ||
      ""
    ).toUpperCase();

  const requiredNetProfitBps =
    CONFIG.minNetExitBps +
    CONFIG.profitSafetyBufferBps;

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
      continue;
    }

    const grossPnlBps =
      toBps(
        (
          currentPrice -
          entryPrice
        ) /
        entryPrice
      );

    const netPnlBps =
      grossPnlBps -
      exitCosts.estimatedSellCostBps;

    const oldHigh =
      Math.max(
        entryPrice,
        num(
          position.highest_price,
          entryPrice
        )
      );

    const highestPrice =
      Math.max(
        oldHigh,
        currentPrice
      );

    if (
      highestPrice >
      oldHigh
    ) {
      await updateHighestPrice({
        id:
          position.id,

        highestPrice
      });
    }

    let reason =
      null;

    let protectionMode =
      "HOLD";

    if (
      netPnlBps >=
      requiredNetProfitBps
    ) {
      reason =
        "PROFIT_GUARD_NET_EXIT";

      protectionMode =
        "TAKE_PROFIT";
    } else {
      const absoluteEmergency =
        grossPnlBps <=
        -CONFIG.absoluteEmergencyLossBps;

      const emergencyLoss =
        grossPnlBps <=
        -CONFIG.emergencyLossBps;

      const momentumBreakdown =
        m1 <=
        CONFIG.emergencyMomentum1mBps &&
        m3 <=
        CONFIG.emergencyMomentum3mBps;

      const directionBreakdown =
        direction.includes("DOWN") ||
        direction.includes("BEAR");

      if (
        absoluteEmergency
      ) {
        reason =
          "ABSOLUTE_EMERGENCY_EXIT";

        protectionMode =
          "EMERGENCY";

      } else if (
        emergencyLoss &&
        momentumBreakdown &&
        directionBreakdown
      ) {
        reason =
          "CONFIRMED_EMERGENCY_EXIT";

        protectionMode =
          "EMERGENCY";
      }
    }

    if (
      !reason
    ) {
      continue;
    }

    candidates.push({
      candidateId:
        crypto.randomUUID(),

      side:
        "SELL",

      slotId:
        Number(
          position.slot_id
        ),

      positionId:
        Number(
          position.id
        ),

      amountSol:
        num(
          position.entry_sol
        ),

      entryPrice,

      currentPrice,

      highestPrice,

      grossPnlBps:
        Number(
          grossPnlBps
            .toFixed(2)
        ),

      estimatedSellCostBps:
        exitCosts.estimatedSellCostBps,

      estimatedSlippageBps:
        exitCosts.estimatedSlippageBps,

      netPnlBps:
        Number(
          netPnlBps
            .toFixed(2)
        ),

      requiredNetProfitBps,

      protectionMode,

      reason,

      createdAt:
        new Date()
          .toISOString()
    });
  }

  return candidates;
}

async function buildBuyCandidate({
  walletAddress,
  positions,
  recentTrades,
  signal,
  riskMode,
  capital,
  learning,
  whale,
  predictive,
  marketRegime,
  openRisk
}) {
  if (
    String(
      signal.action ||
      "WAIT"
    ).toUpperCase() !==
    "BUY"
  ) {
    return null;
  }

  if (
    positions.length >=
    capital.maxSlots
  ) {
    return null;
  }

  if (
    openRisk.allowNewEntry !==
    true
  ) {
    return {
      candidateId:
        crypto.randomUUID(),

      side:
        "BUY",

      approved:
        false,

      reason:
        "LOSS_GUARD_BLOCKING_NEW_ENTRY",

      whale,

      learning,

      openRisk,

      createdAt:
        new Date()
          .toISOString()
    };
  }

  if (
    whale.allowed !==
    true
  ) {
    return {
      candidateId:
        crypto.randomUUID(),

      side:
        "BUY",

      approved:
        false,

      reason:
        whale.reason,

      whale,

      predictive,

      learning,

      marketRegime,

      createdAt:
        new Date()
          .toISOString()
    };
  }

  const freeSlot =
    await getFreeSlot(
      walletAddress,
      capital.maxSlots
    );

  if (
    !freeSlot
  ) {
    return null;
  }

  const multiEntry =
    evaluateMultiEntry({
      positions,
      signal
    });

  if (
    !multiEntry.allowed
  ) {
    return {
      candidateId:
        crypto.randomUUID(),

      side:
        "BUY",

      slotId:
        freeSlot,

      approved:
        false,

      reason:
        multiEntry.reason,

      multiEntry,

      whale,

      predictive,

      learning,

      marketRegime,

      createdAt:
        new Date()
          .toISOString()
    };
  }

  const amountUsd =
    getDynamicEntrySize({
      availableUsdc:
        capital.availableForTrading,

      confidence:
        num(
          signal.confidence
        ),

      whaleScore:
        whale.score,

      openPositions:
        positions.length,

      maxSlots:
        capital.maxSlots,

      targetSlotBudget:
        capital.targetSlotBudget,

      learningMultiplier:
        learning.sizeMultiplier,

      marketRiskMultiplier:
        marketRegime.riskMultiplier
    });

  if (
    amountUsd <
    CONFIG.minSlotUsd
  ) {
    return {
      candidateId:
        crypto.randomUUID(),

      side:
        "BUY",

      slotId:
        freeSlot,

      approved:
        false,

      reason:
        "INSUFFICIENT_REAL_USDC",

      amountUsd,

      whale,

      predictive,

      learning,

      createdAt:
        new Date()
          .toISOString()
    };
  }

  const targetBps =
    getDynamicTarget(
      signal,
      riskMode,
      predictive
    );

  const costs =
    estimateExecutionCosts(
      signal
    );

  const expectedNetEdgeBps =
    targetBps -
    costs.estimatedRoundTripCostBps;

  if (
    expectedNetEdgeBps <
    CONFIG.minNetEdgeBps
  ) {
    return {
      candidateId:
        crypto.randomUUID(),

      side:
        "BUY",

      slotId:
        freeSlot,

      approved:
        false,

      reason:
        "EXPECTED_NET_EDGE_TOO_LOW",

      amountUsd,

      targetBps,

      expectedNetEdgeBps:
        Number(
          expectedNetEdgeBps
            .toFixed(2)
        ),

      estimatedSlippageBps:
        costs.estimatedSlippageBps,

      estimatedRoundTripCostBps:
        costs.estimatedRoundTripCostBps,

      whale,

      predictive,

      learning,

      createdAt:
        new Date()
          .toISOString()
    };
  }

  const state = {
    totalCapitalUsd:
      capital.total,

    recentTrades,

    slots:
      positions.map(
        position => ({
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

  const riskCandidate = {
    amountUsd,

    expectedMoveBps:
      targetBps,

    estimatedSlippageBps:
      costs.estimatedSlippageBps,

    buyFeeBps: 0,

    sellFeeBps: 0
  };

  const risk =
    evaluateRisk({
      state,

      candidate:
        riskCandidate,

      config: {
        maxOpenSlots:
          capital.maxSlots,

        maxSlippageBps:
          CONFIG.maxSlippageBps,

        minNetEdgeBps:
          CONFIG.minNetEdgeBps
      }
    });

  if (
    !risk.allowed
  ) {
    return {
      candidateId:
        crypto.randomUUID(),

      side:
        "BUY",

      slotId:
        freeSlot,

      approved:
        false,

      reason:
        risk.reason,

      amountUsd,

      targetBps,

      whale,

      predictive,

      learning,

      marketRegime,

      risk,

      createdAt:
        new Date()
          .toISOString()
    };
  }

  return {
    candidateId:
      crypto.randomUUID(),

    signalId:
      signal.signalId ||
      null,

    side:
      "BUY",

    slotId:
      freeSlot,

    approved:
      true,

    entryNumber:
      positions.length +
      1,

    amountUsd,

    currentPrice:
      num(
        signal.currentPrice
      ),

    confidence:
      num(
        signal.confidence
      ),

    setup:
      signal.setup ||
      null,

    whaleScore:
      whale.score,

    whaleGrade:
      whale.grade,

    targetBps,

    estimatedSlippageBps:
      costs.estimatedSlippageBps,

    estimatedRoundTripCostBps:
      costs.estimatedRoundTripCostBps,

    expectedNetEdgeBps:
      Number(
        expectedNetEdgeBps
          .toFixed(2)
      ),

    netEdgeBps:
      risk?.edge
        ?.netEdgeBps ??
      expectedNetEdgeBps,

    predictive,

    whale,

    learning,

    marketRegime,

    openRisk,

    multiEntry,

    maxSlots:
      capital.maxSlots,

    targetSlotBudget:
      capital.targetSlotBudget,

    reason:
      "WHALE_DIP_ENTRY_APPROVED",

    createdAt:
      new Date()
        .toISOString()
  };
}

async function analyzeSystem(
  req
) {
  const walletAddress =
    getWalletAddress();

  const [
    signalData,
    walletSnapshot
  ] =
    await Promise.all([
      loadSignal(req),
      loadWalletSnapshot(req)
    ]);

  if (
    walletSnapshot.walletAddress !==
    walletAddress
  ) {
    throw new Error(
      "WALLET_SNAPSHOT_ADDRESS_MISMATCH"
    );
  }

  const signal =
    signalData?.signal ||
    {};

  const currentPrice =
    num(
      signal.currentPrice ||
      signal.price ||
      signalData?.market?.price
    );

  if (
    currentPrice <= 0
  ) {
    throw new Error(
      "INVALID_CURRENT_PRICE"
    );
  }

  signal.currentPrice =
    currentPrice;

  if (
    !signal.marketMode &&
    signalData?.market?.mode
  ) {
    signal.marketMode =
      signalData.market.mode;
  }

  if (
    signal.scalpingScore == null &&
    signalData?.market?.scalpingScore != null
  ) {
    signal.scalpingScore =
      signalData.market.scalpingScore;
  }

  if (
    signal.spreadBps == null &&
    signalData?.market?.spreadBps != null
  ) {
    signal.spreadBps =
      signalData.market.spreadBps;
  }

  if (
    signal.volatilityBps == null &&
    signalData?.market?.volatilityBps != null
  ) {
    signal.volatilityBps =
      signalData.market.volatilityBps;
  }

  if (
    signal.momentum1mBps == null &&
    signalData?.market?.momentum1mBps != null
  ) {
    signal.momentum1mBps =
      signalData.market.momentum1mBps;
  }

  if (
    signal.momentum3mBps == null &&
    signalData?.market?.momentum3mBps != null
  ) {
    signal.momentum3mBps =
      signalData.market.momentum3mBps;
  }

  if (
    signal.momentum5mBps == null &&
    signalData?.market?.momentum5mBps != null
  ) {
    signal.momentum5mBps =
      signalData.market.momentum5mBps;
  }

  if (
    signal.orderBookImbalance == null &&
    signalData?.market?.orderBookImbalance != null
  ) {
    signal.orderBookImbalance =
      signalData.market.orderBookImbalance;
  }

  if (
    !signal.direction &&
    signalData?.market?.direction
  ) {
    signal.direction =
      signalData.market.direction;
  }

  const [
    positions,
    recentTrades,
    dashboard
  ] =
    await Promise.all([
      getOpenPositions(
        walletAddress
      ),

      getRecentClosedTrades(
        walletAddress,
        20
      ),

      getTradingDashboard(
        walletAddress
      )
    ]);

  const riskMode =
    getDynamicRiskMode(
      recentTrades
    );

  const learning =
    buildLearningProfile(
      recentTrades
    );

  const marketRegime =
    detectMarketRegime(
      signal
    );

  const capital =
    calculateCapital({
      positions,
      walletSnapshot,
      currentPrice
    });

  const openRisk =
    analyzeOpenRisk({
      positions,
      currentPrice,
      maxSlots:
        capital.maxSlots
    });

  const predictive =
    buildPredictiveVolatility(
      signal,
      marketRegime,
      learning
    );

  const whale =
    evaluateWhaleEntry({
      signal,
      learning,
      marketRegime,
      predictive
    });

  const buyCandidate =
    await buildBuyCandidate({
      walletAddress,
      positions,
      recentTrades,
      signal,
      riskMode,
      capital,
      learning,
      whale,
      predictive,
      marketRegime,
      openRisk
    });

  const sellCandidates =
    await buildSellCandidates({
      positions,
      currentPrice,
      signal
    });

  return {
    walletAddress,
    walletSnapshot,
    signal,
    currentPrice,
    positions,
    recentTrades,
    riskMode,
    learning,
    whale,
    predictive,
    marketRegime,
    openRisk,
    capital,
    buyCandidate,
    sellCandidates,
    dashboard
  };
}

async function executeApprovedBuy({
  req,
  analysis,
  requestedSlotId
}) {
  const candidate =
    analysis.buyCandidate;

  if (
    !candidate ||
    candidate.approved !==
    true
  ) {
    throw new Error(
      "NO_APPROVED_BUY_CANDIDATE"
    );
  }

  if (
    Number(
      requestedSlotId
    ) !==
    Number(
      candidate.slotId
    )
  ) {
    throw new Error(
      "BUY_SLOT_CHANGED"
    );
  }

  const existing =
    await getOpenPositionBySlot(
      analysis.walletAddress,
      candidate.slotId
    );

  if (
    existing
  ) {
    throw new Error(
      "SLOT_ALREADY_OPEN"
    );
  }

  const amountUsd =
    roundUsd(
      candidate.amountUsd
    );

  if (
    amountUsd <
    CONFIG.minSlotUsd
  ) {
    throw new Error(
      "INVALID_REAL_BUY_AMOUNT"
    );
  }

  const freshWallet =
    await loadWalletSnapshot(
      req
    );

  if (
    amountUsd >
    freshWallet.usdcBalance
  ) {
    throw new Error(
      "BUY_EXCEEDS_REAL_USDC_BALANCE"
    );
  }

  const execution =
    await executeTrade({
      req,

      side:
        "BUY",

      slotId:
        candidate.slotId,

      amountUsd,

      slippageBps:
        candidate.estimatedSlippageBps
    });

  if (
    execution?.executed !==
    true
  ) {
    return {
      executed:
        false,

      side:
        "BUY",

      slotId:
        candidate.slotId,

      reason:
        execution?.reason ||
        "BUY_NOT_EXECUTED",

      execution
    };
  }

  const solReceived =
    atomicToAmount(
      execution?.quote?.outAmount,
      SOL_DECIMALS
    );

  if (
    solReceived <= 0
  ) {
    throw new Error(
      "INVALID_SOL_RECEIVED"
    );
  }

  const actualEntryPrice =
    amountUsd /
    solReceived;

  const saved =
    await openPosition({
      walletAddress:
        analysis.walletAddress,

      slotId:
        candidate.slotId,

      entryPrice:
        actualEntryPrice,

      entrySol:
        solReceived,

      entryUsdc:
        amountUsd,

      signature:
        execution.signature,

      strategy:
        "WHALE_PREDICTIVE_INTELLIGENCE_V1",

      targetBps:
        candidate.targetBps,

      trailingDistanceBps:
        null
    });

  return {
    executed:
      true,

    engine:
      "WHALE_INTELLIGENCE_V1",

    side:
      "BUY",

    slotId:
      candidate.slotId,

    entryNumber:
      candidate.entryNumber,

    amountUsd,

    solReceived,

    actualEntryPrice,

    whaleScore:
      candidate.whaleScore,

    whaleGrade:
      candidate.whaleGrade,

    predictionScore:
      analysis.predictive
        ?.consensusScore ??
      null,

    probabilityUpPct:
      analysis.predictive
        ?.probabilityUpPct ??
      null,

    learningMode:
      analysis.learning.mode,

    marketRegime:
      analysis.marketRegime.regime,

    maxSlots:
      analysis.capital.maxSlots,

    signature:
      execution.signature,

    compounding:
      true,

    position:
      saved
  };
}

async function executeApprovedSell({
  req,
  analysis,
  requestedSlotId
}) {
  const slotId =
    Number(
      requestedSlotId
    );

  const candidate =
    analysis.sellCandidates.find(
      item =>
        Number(
          item.slotId
        ) ===
        slotId
    );

  if (
    !candidate
  ) {
    throw new Error(
      "NO_APPROVED_SELL_CANDIDATE"
    );
  }

  const position =
    await getOpenPositionBySlot(
      analysis.walletAddress,
      slotId
    );

  if (
    !position
  ) {
    throw new Error(
      "OPEN_POSITION_NOT_FOUND"
    );
  }

  const amountSol =
    num(
      position.entry_sol
    );

  if (
    amountSol <= 0
  ) {
    throw new Error(
      "INVALID_POSITION_SOL_AMOUNT"
    );
  }

  const emergency =
    candidate.reason ===
      "CONFIRMED_EMERGENCY_EXIT" ||
    candidate.reason ===
      "ABSOLUTE_EMERGENCY_EXIT";

  if (
    !emergency &&
    candidate.netPnlBps <
    candidate.requiredNetProfitBps
  ) {
    throw new Error(
      "PROFIT_GUARD_BLOCKED_LOSS_SELL"
    );
  }

  const execution =
    await executeTrade({
      req,

      side:
        "SELL",

      slotId,

      amountSol,

      slippageBps:
        candidate.estimatedSlippageBps
    });

  if (
    execution?.executed !==
    true
  ) {
    return {
      executed:
        false,

      side:
        "SELL",

      slotId,

      reason:
        execution?.reason ||
        "SELL_NOT_EXECUTED",

      execution
    };
  }

  const usdcReceived =
    atomicToAmount(
      execution?.quote?.outAmount,
      USDC_DECIMALS
    );

  if (
    usdcReceived <= 0
  ) {
    throw new Error(
      "INVALID_USDC_RECEIVED"
    );
  }

  const actualExitPrice =
    amountSol > 0
      ? usdcReceived /
        amountSol
      : analysis.currentPrice;

  const closed =
    await closePosition({
      id:
        position.id,

      exitPrice:
        actualExitPrice,

      exitUsdc:
        usdcReceived,

      signature:
        execution.signature,

      reason:
        candidate.reason
    });

  return {
    executed:
      true,

    engine:
      "PROFIT_GUARD_V1",

    side:
      "SELL",

    slotId,

    amountSol,

    usdcReceived,

    actualExitPrice,

    grossPnlBps:
      candidate.grossPnlBps,

    estimatedNetPnlBps:
      candidate.netPnlBps,

    requiredNetProfitBps:
      candidate.requiredNetProfitBps,

    protectionMode:
      candidate.protectionMode,

    realizedPnl:
      num(
        closed?.realized_pnl
      ),

    realizedPnlPct:
      num(
        closed?.realized_pnl_pct
      ),

    reason:
      candidate.reason,

    signature:
      execution.signature,

    compounding:
      true,

    position:
      closed
  };
}

async function handleGet(
  req,
  res
) {
  try {
    const analysis =
      await analyzeSystem(
        req
      );

    return res
      .status(200)
      .json({
        status:
          "ok",

        engine:
          "FAWAZ_WHALE_PREDICTIVE_V1",

        strategy:
          "PREDICTIVE_DIP_VOLATILITY_NET_PROFIT",

        modules: {
          whaleIntelligence:
            "V1",

          strictBuyTheDip:
            "V1",

          predictiveVolatility:
            "V1",

          adaptiveLearning:
            "V1",

          marketRegime:
            "V1",

          profitGuard:
            "V1",

          lossReduction:
            "V1"
        },

        liveMarket:
          true,

        realTrading:
          true,

        execution:
          "FULL_AUTO",

        compounding:
          true,

        walletAddress:
          analysis.walletAddress,

        wallet:
          analysis.walletSnapshot,

        capital:
          analysis.capital,

        signal: {
          signalId:
            analysis.signal.signalId ||
            null,

          action:
            analysis.signal.action ||
            "WAIT",

          confidence:
            num(
              analysis.signal.confidence
            ),

          reason:
            analysis.signal.reason ||
            "-",

          setup:
            analysis.signal.setup ||
            null,

          currentPrice:
            analysis.currentPrice,

          marketMode:
            analysis.signal.marketMode ||
            "-",

          scalpingScore:
            num(
              analysis.signal.scalpingScore
            ),

          spreadBps:
            num(
              analysis.signal.spreadBps
            ),

          volatilityBps:
            num(
              analysis.signal.volatilityBps
            ),

          momentum1mBps:
            num(
              analysis.signal.momentum1mBps
            ),

          momentum3mBps:
            num(
              analysis.signal.momentum3mBps
            ),

          momentum5mBps:
            analysis.signal.momentum5mBps ==
            null
              ? null
              : num(
                  analysis.signal.momentum5mBps
                ),

          orderBookImbalance:
            num(
              analysis.signal.orderBookImbalance
            ),

          direction:
            analysis.signal.direction ||
            "-"
        },

        riskMode:
          analysis.riskMode,

        learning:
          analysis.learning,

        whale:
          analysis.whale,

        predictive:
          analysis.predictive,

        marketRegime:
          analysis.marketRegime,

        openRisk:
          analysis.openRisk,

        buyCandidate:
          analysis.buyCandidate,

        sellCandidates:
          analysis.sellCandidates,

        dashboard:
          analysis.dashboard,

        timestamp:
          new Date()
            .toISOString()
      });

  } catch (
    error
  ) {
    console.error(
      "WHALE ANALYSIS ERROR:",
      error
    );

    return res
      .status(500)
      .json({
        status:
          "error",

        engine:
          "FAWAZ_WHALE_PREDICTIVE_V1",

        liveMarket:
          true,

        realTrading:
          true,

        executed:
          false,

        message:
          error?.message ||
          "Whale analysis failed",

        timestamp:
          new Date()
            .toISOString()
      });
  }
}

async function handlePost(
  req,
  res
) {
  const auth =
    authorize(
      req
    );

  if (
    !auth.ok
  ) {
    return res
      .status(
        auth.status
      )
      .json({
        status:
          "error",

        executed:
          false,

        engine:
          "FAWAZ_WHALE_PREDICTIVE_V1",

        message:
          auth.reason
      });
  }

  try {
    const analysis =
      await analyzeSystem(
        req
      );

    let result =
      null;

    if (
      Array.isArray(
        analysis.sellCandidates
      ) &&
      analysis.sellCandidates.length >
      0
    ) {
      const priority = {
        ABSOLUTE_EMERGENCY_EXIT:
          1,

        CONFIRMED_EMERGENCY_EXIT:
          2,

        PROFIT_GUARD_NET_EXIT:
          3
      };

      analysis.sellCandidates.sort(
        (
          a,
          b
        ) =>
          (
            priority[a.reason] ||
            99
          ) -
          (
            priority[b.reason] ||
            99
          )
      );

      const sellCandidate =
        analysis.sellCandidates[0];

      result =
        await executeApprovedSell({
          req,
          analysis,
          requestedSlotId:
            sellCandidate.slotId
        });

    } else if (
      analysis.buyCandidate
        ?.approved === true
    ) {
      result =
        await executeApprovedBuy({
          req,
          analysis,
          requestedSlotId:
            analysis.buyCandidate.slotId
        });

    } else {
      const dashboard =
        await getTradingDashboard(
          analysis.walletAddress
        );

      return res
        .status(200)
        .json({
          status:
            "waiting",

          engine:
            "FAWAZ_WHALE_PREDICTIVE_V1",

          strategy:
            "PREDICTIVE_DIP_VOLATILITY_NET_PROFIT",

          liveMarket:
            true,

          realTrading:
            true,

          execution:
            "FULL_AUTO",

          compounding:
            true,

          executed:
            false,

          reason:
            analysis.buyCandidate?.reason ||
            analysis.signal?.reason ||
            "NO_APPROVED_TRADE",

          wallet:
            analysis.walletSnapshot,

          capital:
            analysis.capital,

          learning:
            analysis.learning,

          whale:
            analysis.whale,

          predictive:
            analysis.predictive,

          marketRegime:
            analysis.marketRegime,

          openRisk:
            analysis.openRisk,

          signal: {
            action:
              analysis.signal?.action ||
              "WAIT",

            confidence:
              num(
                analysis.signal?.confidence
              ),

            setup:
              analysis.signal?.setup ||
              null,

            currentPrice:
              analysis.currentPrice,

            marketMode:
              analysis.signal?.marketMode ||
              "-",

            direction:
              analysis.signal?.direction ||
              "-"
          },

          buyCandidate:
            analysis.buyCandidate,

          sellCandidates:
            analysis.sellCandidates,

          dashboard,

          timestamp:
            new Date()
              .toISOString()
        });
    }

    const dashboard =
      await getTradingDashboard(
        analysis.walletAddress
      );

    return res
      .status(200)
      .json({
        status:
          result?.executed ===
          true
            ? "ok"
            : "blocked",

        engine:
          "FAWAZ_WHALE_PREDICTIVE_V1",

        strategy:
          "PREDICTIVE_DIP_VOLATILITY_NET_PROFIT",

        liveMarket:
          true,

        realTrading:
          true,

        execution:
          "FULL_AUTO",

        compounding:
          true,

        executed:
          result?.executed ===
          true,

        capital:
          analysis.capital,

        learning:
          analysis.learning,

        whale:
          analysis.whale,

        predictive:
          analysis.predictive,

        marketRegime:
          analysis.marketRegime,

        openRisk:
          analysis.openRisk,

        result,

        dashboard,

        timestamp:
          new Date()
            .toISOString()
      });

  } catch (
    error
  ) {
    console.error(
      "WHALE AUTO TRADING ERROR:",
      error
    );

    return res
      .status(500)
      .json({
        status:
          "error",

        engine:
          "FAWAZ_WHALE_PREDICTIVE_V1",

        strategy:
          "PREDICTIVE_DIP_VOLATILITY_NET_PROFIT",

        liveMarket:
          true,

        realTrading:
          true,

        execution:
          "FULL_AUTO",

        compounding:
          true,

        executed:
          false,

        message:
          error?.message ||
          "Whale auto trading failed",

        timestamp:
          new Date()
            .toISOString()
      });
  }
}

export default async function handler(
  req,
  res
) {
  if (
    req.method ===
    "GET"
  ) {
    return handleGet(
      req,
      res
    );
  }

  if (
    req.method ===
    "POST"
  ) {
    return handlePost(
      req,
      res
    );
  }

  return res
    .status(405)
    .json({
      status:
        "error",

      engine:
        "FAWAZ_WHALE_PREDICTIVE_V1",

      message:
        "GET or POST only"
    });
}
