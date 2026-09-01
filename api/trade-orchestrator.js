تمام. هذا الكود الأول كاملًا trade-orchestrator.js. انسخ الموجود داخل المربع بالكامل واستبدل الملف القديم.

// /api/trade-orchestrator.js
// FAWAZ AI TRADER V8 GROWTH PRO
// Adaptive multi-strategy spot engine for SOL/USDC
import crypto from "crypto";
import {
  evaluateRisk,
  getDynamicRiskMode,
  calculateDynamicPositionSize,
  analyzeRecentTrades,
} from "./risk-agent.js";
import {
  getOpenPositions,
  getFreeSlot,
  getOpenPositionBySlot,
  openPosition,
  closePosition,
  getRecentClosedTrades,
  getTradingDashboard,
  updatePositionTelemetry,
  activateTrailing,
  recordEquitySnapshot,
  getEquityRiskSnapshot,
  getPerformanceStats,
  hasUsedEntrySignal,
  acquireCycleLock,
  releaseCycleLock,
  claimSlot,
  releaseSlot,
} from "./trading-store.js";
const CONFIG = {
  // Portfolio
  maxOpenSlots: 12,
  maxCapitalUsagePct: 0.50,
  maxSingleSlotPct: 0.15,
  baseAllocationPct: 0.06,
  strongAllocationPct: 0.10,
  eliteAllocationPct: 0.14,
  minTradeUsd: 1,
  lowCapitalTestThresholdUsd: 5,
  // Entry activity
  minEntrySpacingBps: 8,
  minimumEntryScore: 64,
  strongEntryScore: 74,
  eliteEntryScore: 84,
  maxSpreadBps: 15,
  maxVolatilityBps: 120,
  minEntryCooldownSeconds: 45,
  // Edge / execution
  maxSlippageBps: 30,
  minNetEdgeBps: 14,
  executionBufferBps: 6,
  // Targets
  targetMinBps: 36,
  targetMaxBps: 140,
  trailingMinBps: 14,
  trailingMaxBps: 36,
  minLockedProfitBps: 12,
  extendedProfitMultiple: 2.35,
  // Protection
  emergencyLossBps: 100,
  absoluteEmergencyLossBps: 180,
  emergencyMomentum1mBps: -18,
  emergencyMomentum3mBps: -30,
  // Growth plan
  monthlyGrowthTargetPct: Number(
    process.env.MONTHLY_GROWTH_TARGET_PCT || 0.50
  ),
  maxGrowthActivityMultiplier: 1.12,
  // Cycle
  maxSellsPerCycle: 8,
  cycleLockSeconds: 50,
};
const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;
// ======================================================
// HELPERS
// ======================================================
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
function round(value, digits = 2) {
  return Number(
    num(value).toFixed(digits)
  );
}
function atomicToAmount(
  value,
  decimals
) {
  return (
    num(value) /
    Math.pow(10, decimals)
  );
}
function pctBps(
  current,
  entry
) {
  if (!(entry > 0)) {
    return 0;
  }
  return (
    (
      current -
      entry
    ) /
    entry
  ) * 10000;
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
      "BOT_WALLET_ADDRESS_MISSING"
    );
  }
  return wallet.trim();
}
// ======================================================
// AUTH
// ======================================================
function authorize(req) {
  const secret =
    process.env.AUTO_TRADER_SECRET;
  if (!secret) {
    return {
      ok: false,
      status: 500,
      reason:
        "AUTO_TRADER_SECRET_MISSING",
    };
  }
  const auth =
    req.headers.authorization ||
    req.headers.Authorization ||
    "";
  if (
    auth !==
    `Bearer ${secret}`
  ) {
    return {
      ok: false,
      status: 401,
      reason:
        "UNAUTHORIZED",
    };
  }
  return {
    ok: true,
  };
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
      `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    );
  }
  if (
    process.env.VERCEL_URL
  ) {
    return (
      `https://${process.env.VERCEL_URL}`
    );
  }
  const host =
    req.headers.host;
  if (host) {
    return (
      `${host.includes("localhost")
        ? "http"
        : "https"}://${host}`
    );
  }
  return (
    "https://fawaz-ai-bot.vercel.app"
  );
}
// ======================================================
// FETCH
// ======================================================
async function fetchJson(
  url,
  options = {}
) {
  const response =
    await fetch(
      url,
      {
        ...options,
        cache: "no-store",
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
      raw: text,
    };
  }
  if (!response.ok) {
    throw new Error(
      `HTTP_${response.status}:${JSON.stringify(data)}`
    );
  }
  return data;
}
// ======================================================
// SIGNAL
// ======================================================
async function loadSignal(req) {
  const data =
    await fetchJson(
      `${getBaseUrl(req)}/api/signal`,
      {
        method: "GET",
        headers: {
          Accept:
            "application/json",
        },
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
// ======================================================
// WALLET SNAPSHOT
// ======================================================
async function loadWalletSnapshot(
  req
) {
  const data =
    await fetchJson(
      `${getBaseUrl(req)}/api/execution-agent?test=wallet`,
      {
        method: "GET",
        headers: {
          Accept:
            "application/json",
        },
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
      "ON_CHAIN",
  };
}
// ======================================================
// EXECUTION
// ======================================================
async function executeTrade({
  req,
  side,
  slotId,
  amountUsd = 0,
  amountSol = 0,
  slippageBps = 20,
}) {
  const secret =
    process.env
      .AUTO_TRADER_SECRET;
  if (!secret) {
    throw new Error(
      "AUTO_TRADER_SECRET_MISSING"
    );
  }
  return fetchJson(
    `${getBaseUrl(req)}/api/execution-agent`,
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/json",
        Authorization:
          `Bearer ${secret}`,
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
            ),
        }),
    }
  );
}
// ======================================================
// NORMALIZE MARKET DATA
// ======================================================
function mergeMarketFields(
  signalData
) {
  const signal = {
    ...(signalData?.signal || {}),
  };
  const market =
    signalData?.market ||
    {};
  const fields = [
    "marketMode",
    "scalpingScore",
    "spreadBps",
    "volatilityBps",
    "momentum1mBps",
    "momentum3mBps",
    "momentum5mBps",
    "orderBookImbalance",
    "direction",
  ];
  for (
    const field
    of fields
  ) {
    if (
      signal[field] == null &&
      market[field] != null
    ) {
      signal[field] =
        market[field];
    }
  }
  signal.currentPrice =
    num(
      signal.currentPrice ||
      signal.price ||
      market.price
    );
  return signal;
}
// ======================================================
// MARKET REGIME
// ======================================================
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
  const m5 =
    num(
      signal.momentum5mBps
    );
  const vol =
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
      direction.includes(
        "DOWN"
      ) &&
      m3 <= -22
    )
  ) {
    return {
      regime:
        "STRONG_DOWN",
      scorePenalty:
        30,
      targetMultiplier:
        0.8,
    };
  }
  if (
    m1 < -4 &&
    m3 < -8
  ) {
    return {
      regime:
        "DOWN",
      scorePenalty:
        12,
      targetMultiplier:
        0.9,
    };
  }
  if (
    vol >= 85
  ) {
    return {
      regime:
        "HIGH_VOLATILITY",
      scorePenalty:
        8,
      targetMultiplier:
        1.25,
    };
  }
  if (
    (
      m1 >= 4 &&
      m3 >= 2
    ) ||
    direction.includes(
      "UP"
    ) ||
    direction.includes(
      "BULL"
    )
  ) {
    return {
      regime:
        "UP",
      scorePenalty:
        0,
      targetMultiplier:
        1.15,
    };
  }
  if (
    Math.abs(m1) <= 8 &&
    Math.abs(m3) <= 15 &&
    Math.abs(m5) <= 25
  ) {
    return {
      regime:
        "RANGE",
      scorePenalty:
        0,
      targetMultiplier:
        0.95,
    };
  }
  return {
    regime:
      "NORMAL",
    scorePenalty:
      2,
    targetMultiplier:
      1,
  };
}
// ======================================================
// EXECUTION COST
// ======================================================
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
        spread / 2 +
        2
      ),
      4,
      15
    );
  return {
    estimatedSlippageBps:
      slippage,
    estimatedRoundTripCostBps:
      round(
        spread +
        slippage * 2 +
        CONFIG.executionBufferBps
      ),
    estimatedSellCostBps:
      round(
        spread / 2 +
        slippage +
        CONFIG.executionBufferBps
      ),
  };
}
// ======================================================
// ADAPTIVE STRATEGY ENGINE
// ======================================================
function buildStrategyScores(
  signal,
  regime,
  learning,
  growthPlan
) {
  const confidence =
    clamp(
      num(
        signal.confidence
      ),
      0,
      100
    );
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
  const vol =
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
  const setupText =
    String(
      signal.setup ||
      ""
    ).toUpperCase();
  const improvement =
    m1 - m3;
  const baseQuality =
    confidence * 0.35 +
    clamp(
      imbalance * 18,
      -12,
      18
    ) +
    (
      spread <= 4
        ? 8
        : spread <= 8
          ? 4
          : -8
    );
  const candidates = [];
  const add = (
    name,
    rawScore,
    expectedSwingBps,
    evidence
  ) => {
    let score =
      rawScore -
      num(
        regime.scorePenalty
      );
    if (
      learning?.mode ===
      "DEFENSIVE"
    ) {
      score -= 5;
    }
    if (
      learning?.mode ===
      "CAUTIOUS"
    ) {
      score -= 2;
    }
    score +=
      clamp(
        (
          num(
            growthPlan
              ?.activityMultiplier,
            1
          ) -
          1
        ) * 20,
        -3,
        2.5
      );
    candidates.push({
      name,
      score:
        round(
          clamp(
            score,
            0,
            100
          )
        ),
      expectedSwingBps:
        round(
          clamp(
            expectedSwingBps,
            CONFIG.targetMinBps,
            CONFIG.targetMaxBps *
              1.25
          )
        ),
      evidence,
    });
  };
  // DIP RECOVERY
  if (
    m3 <= -3 &&
    improvement >= 4 &&
    m1 >= -1 &&
    regime.regime !==
      "STRONG_DOWN"
  ) {
    add(
      "DIP_RECOVERY",
      baseQuality +
      28 +
      clamp(
        improvement * 1.4,
        0,
        22
      ) +
      (
        m1 >= 0
          ? 8
          : 0
      ),
      42 +
      vol * 0.65 +
      Math.max(
        0,
        improvement
      ) * 1.2,
      [
        "PRIOR_DIP",
        "MOMENTUM_IMPROVING",
        m1 >= 0
          ? "MICRO_REVERSAL"
          : "EARLY_RECOVERY",
      ]
    );
  }
  // RANGE
  if (
    regime.regime ===
      "RANGE" &&
    m3 <= 2 &&
    m1 > m3 &&
    spread <= 8 &&
    vol <= 65
  ) {
    add(
      "RANGE_MEAN_REVERSION",
      baseQuality +
      20 +
      clamp(
        improvement * 1.2,
        0,
        18
      ) +
      (
        m3 < 0
          ? 8
          : 0
      ),
      36 +
      vol * 0.55 +
      Math.max(
        0,
        improvement
      ),
      [
        "RANGE",
        "MEAN_REVERSION",
        "LOW_EXECUTION_FRICTION",
      ]
    );
  }
  // TREND PULLBACK
  const upContext =
    direction.includes(
      "UP"
    ) ||
    direction.includes(
      "BULL"
    ) ||
    m5 >= 3;
  if (
    upContext &&
    m3 <= 5 &&
    improvement >= 2 &&
    m1 <= 16 &&
    spread <= 10 &&
    regime.regime !==
      "STRONG_DOWN"
  ) {
    add(
      "TREND_PULLBACK",
      baseQuality +
      18 +
      clamp(
        m5 * 0.5,
        0,
        12
      ) +
      clamp(
        improvement,
        0,
        12
      ),
      48 +
      vol * 0.70 +
      Math.max(
        0,
        m5
      ) * 0.5,
      [
        "UPTREND_CONTEXT",
        "PULLBACK_RECOVERY",
        "ANTI_CHASE_CAP",
      ]
    );
  }
  // CONTROLLED BREAKOUT
  if (
    m1 >= 4 &&
    m1 <= 20 &&
    m3 >= 1 &&
    m3 <= 15 &&
    imbalance >= 0.10 &&
    spread <= 7 &&
    regime.regime !==
      "HIGH_VOLATILITY"
  ) {
    add(
      "CONTROLLED_BREAKOUT",
      baseQuality +
      17 +
      clamp(
        m1 * 0.8,
        0,
        14
      ) +
      clamp(
        imbalance * 20,
        0,
        12
      ),
      52 +
      vol * 0.80 +
      m1 * 0.7,
      [
        "POSITIVE_MOMENTUM",
        "BUY_PRESSURE",
        "CONTROLLED_BREAKOUT",
      ]
    );
  }
  // SIGNAL ASSISTED
  if (
    String(
      signal.action ||
      ""
    ).toUpperCase() ===
      "BUY" &&
    regime.regime !==
      "STRONG_DOWN"
  ) {
    add(
      "SIGNAL_ASSISTED",
      baseQuality +
      18 +
      (
        setupText.includes(
          "DIP"
        )
          ? 7
          : 0
      ),
            40 +
      vol * 0.60,
      [
        "UPSTREAM_BUY_SIGNAL",
        "INTERNAL_RISK_STILL_REQUIRED"
      ]
    );
  }

  candidates.sort(
    (a, b) =>
      b.score -
      a.score
  );

  return candidates;
}


// ======================================================
// LEARNING PROFILE
// ======================================================

function buildLearningProfile(
  recentTrades
) {
  const stats =
    analyzeRecentTrades(
      recentTrades
    );

  let mode =
    "NORMAL";

  if (
    stats.trades < 8
  ) {
    mode =
      "LEARNING";

  } else if (
    stats.consecutiveLosses >= 3 ||
    (
      stats.profitFactor !== null &&
      stats.profitFactor < 0.9
    )
  ) {
    mode =
      "DEFENSIVE";

  } else if (
    stats.consecutiveLosses >= 2
  ) {
    mode =
      "CAUTIOUS";

  } else if (
    stats.profitFactor !== null &&
    stats.profitFactor >= 1.5 &&
    stats.expectancyBps >= 8
  ) {
    mode =
      "GROWTH";
  }

  return {
    engine:
      "ADAPTIVE_LEARNING_V2",

    mode,

    sampleSize:
      stats.trades,

    winRatePct:
      round(
        stats.winRate *
        100
      ),

    profitFactor:
      stats.profitFactor ===
      Infinity
        ? 999
        : stats.profitFactor ===
          null
          ? null
          : round(
              stats.profitFactor
            ),

    expectancyBps:
      round(
        stats.expectancyBps
      ),

    consecutiveLosses:
      stats.consecutiveLosses
  };
}


// ======================================================
// GROWTH PLAN
// ======================================================

function buildGrowthPlan(
  equityRisk,
  performance
) {
  const current =
    num(
      equityRisk
        ?.currentEquity
    );

  const start =
    num(
      equityRisk
        ?.start30d,
      current
    );

  const targetPct =
    Math.max(
      0,
      CONFIG
        .monthlyGrowthTargetPct
    );

  const targetEquity =
    start > 0
      ? start *
        (
          1 +
          targetPct
        )
      : current;

  const startAt =
    equityRisk
      ?.start30dAt
      ? new Date(
          equityRisk
            .start30dAt
        ).getTime()
      : Date.now();

  const elapsedDays =
    clamp(
      (
        Date.now() -
        startAt
      ) /
      86_400_000,
      0,
      30
    );

  const expectedNow =
    start > 0
      ? start *
        Math.pow(
          1 +
          targetPct,
          elapsedDays /
          30
        )
      : current;

  const paceGapPct =
    expectedNow > 0
      ? (
          (
            current -
            expectedNow
          ) /
          expectedNow
        ) * 100
      : 0;

  let activityMultiplier =
    1;

  const pf =
    num(
      performance
        ?.profitFactor,
      0
    );

  const expectancy =
    num(
      performance
        ?.expectancyBps,
      0
    );

  const drawdown =
    num(
      equityRisk
        ?.drawdownPct,
      0
    );

  if (
    paceGapPct < -3 &&
    pf >= 1.15 &&
    expectancy > 0 &&
    drawdown < 3
  ) {
    activityMultiplier =
      1.06;
  }

  if (
    paceGapPct < -7 &&
    pf >= 1.35 &&
    expectancy >= 6 &&
    drawdown < 2
  ) {
    activityMultiplier =
      CONFIG
        .maxGrowthActivityMultiplier;
  }

  if (
    paceGapPct > 5
  ) {
    activityMultiplier =
      0.94;
  }

  if (
    drawdown >= 3
  ) {
    activityMultiplier =
      Math.min(
        activityMultiplier,
        0.90
      );
  }

  return {
    monthlyTargetPct:
      round(
        targetPct *
        100
      ),

    startEquity:
      round(
        start,
        4
      ),

    currentEquity:
      round(
        current,
        4
      ),

    targetEquity:
      round(
        targetEquity,
        4
      ),

    expectedEquityNow:
      round(
        expectedNow,
        4
      ),

    paceGapPct:
      round(
        paceGapPct
      ),

    activityMultiplier:
      round(
        activityMultiplier,
        3
      ),

    note:
      "Target changes activity modestly; it never overrides drawdown or position-size caps."
  };
}


// ======================================================
// CAPITAL
// ======================================================

function calculateCapital({
  positions,
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
        sum,
        p
      ) =>
        sum +
        num(
          p.entry_sol
        ) *
        currentPrice,
      0
    );

  const total =
    Math.max(
      0,
      realUsdc +
      trackedSolValue
    );

  const used =
    positions.reduce(
      (
        sum,
        p
      ) =>
        sum +
        num(
          p.entry_usdc
        ),
      0
    );

  const maxExposure =
    total *
    CONFIG
      .maxCapitalUsagePct;

  const availableForTrading =
    Math.max(
      0,
      Math.min(
        realUsdc,
        maxExposure -
        used
      )
    );

  return {
    source:
      "REAL_ON_CHAIN_USDC_PLUS_TRACKED_SOL",

    realUsdcBalance:
      round(
        realUsdc,
        6
      ),

    trackedSolValue:
      round(
        trackedSolValue,
        6
      ),

    total:
      round(
        total,
        6
      ),

    usedInPositions:
      round(
        used,
        6
      ),

    maxExposureUsd:
      round(
        maxExposure,
        6
      ),

    exposurePct:
      total > 0
        ? round(
            (
              used /
              total
            ) * 100
          )
        : 0,

    availableForTrading:
      round(
        availableForTrading,
        6
      ),

    maxOpenSlots:
      CONFIG.maxOpenSlots,

    openPositions:
      positions.length,

    remainingSlots:
      Math.max(
        0,
        CONFIG.maxOpenSlots -
        positions.length
      ),

    testMode:
      total > 0 &&
      total <=
      CONFIG
        .lowCapitalTestThresholdUsd
  };
}


// ======================================================
// ENTRY SPACING
// ======================================================

function evaluateEntrySpacing(
  positions,
  currentPrice
) {
  if (
    !positions.length
  ) {
    return {
      allowed:
        true,

      reason:
        "FIRST_ENTRY"
    };
  }

  const prices =
    positions
      .map(
        p =>
          num(
            p.entry_price
          )
      )
      .filter(
        x =>
          x > 0
      );

  if (
    !prices.length
  ) {
    return {
      allowed:
        true,

      reason:
        "NO_VALID_ENTRY_PRICES"
    };
  }

  const nearest =
    Math.min(
      ...prices.map(
        p =>
          Math.abs(
            (
              (
                currentPrice -
                p
              ) /
              p
            ) *
            10000
          )
      )
    );

  if (
    nearest <
    CONFIG
      .minEntrySpacingBps
  ) {
    return {
      allowed:
        false,

      reason:
        "ENTRY_TOO_CLOSE",

      nearestDistanceBps:
        round(
          nearest
        ),

      requiredBps:
        CONFIG
          .minEntrySpacingBps
    };
  }

  const newest =
    [
      ...positions
    ].sort(
      (
        a,
        b
      ) =>
        new Date(
          b.opened_at
        ).getTime() -
        new Date(
          a.opened_at
        ).getTime()
    )[0];

  const ageSec =
    (
      Date.now() -
      new Date(
        newest.opened_at
      ).getTime()
    ) /
    1000;

  if (
    Number.isFinite(
      ageSec
    ) &&
    ageSec <
    CONFIG
      .minEntryCooldownSeconds
  ) {
    return {
      allowed:
        false,

      reason:
        "ENTRY_COOLDOWN",

      retryAfterSeconds:
        Math.ceil(
          CONFIG
            .minEntryCooldownSeconds -
          ageSec
        )
    };
  }

  return {
    allowed:
      true,

    reason:
      "ENTRY_SPACING_OK",

    nearestDistanceBps:
      round(
        nearest
      )
  };
}


// ======================================================
// TARGET + TRAILING
// ======================================================

function getTargetAndTrailing(
  strategy,
  signal,
  regime
) {
  const vol =
    Math.abs(
      num(
        signal.volatilityBps
      )
    );

  const strategyBase = {
    DIP_RECOVERY:
      48,

    RANGE_MEAN_REVERSION:
      40,

    TREND_PULLBACK:
      55,

    CONTROLLED_BREAKOUT:
      62,

    SIGNAL_ASSISTED:
      45
  }[
    strategy.name
  ] || 45;

  const targetBps =
    clamp(
      (
        strategyBase +
        vol * 0.55 +
        Math.max(
          0,
          strategy
            .expectedSwingBps -
          strategyBase
        ) * 0.35
      ) *
      num(
        regime
          .targetMultiplier,
        1
      ),

      CONFIG.targetMinBps,

      CONFIG.targetMaxBps
    );

  const trailingDistanceBps =
    clamp(
      targetBps *
      0.28,

      CONFIG.trailingMinBps,

      CONFIG.trailingMaxBps
    );

  return {
    targetBps:
      Math.round(
        targetBps
      ),

    trailingDistanceBps:
      Math.round(
        trailingDistanceBps
      )
  };
}


// ======================================================
// BUY CANDIDATE
// ======================================================

async function buildBuyCandidate({
  walletAddress,
  positions,
  recentTrades,
  signal,
  capital,
  learning,
  regime,
  growthPlan,
  equityRisk,
  performance
}) {
  if (
    capital.remainingSlots <= 0
  ) {
    return {
      approved: false,
      reason: "MAX_OPEN_SLOTS_REACHED"
    };
  }

  if (
    capital.availableForTrading <= 0
  ) {
    return {
      approved: false,
      reason: "NO_AVAILABLE_TRADING_CAPITAL"
    };
  }

  if (
    num(equityRisk?.drawdownPct) >= 6
  ) {
    return {
      approved: false,
      reason: "DRAWDOWN_CIRCUIT_BREAKER"
    };
  }

  if (
    num(performance?.dailyLossPct) >= 4
  ) {
    return {
      approved: false,
      reason: "DAILY_LOSS_LIMIT"
    };
  }

  const strategies =
    buildStrategyScores(
      signal,
      regime,
      learning,
      growthPlan
    );

  const strategy =
    strategies[0] || null;

  if (!strategy) {
    return {
      approved: false,
      reason: "NO_VALID_STRATEGY",
      strategies
    };
  }

  if (
    strategy.score <
    CONFIG.minimumEntryScore
  ) {
    return {
      approved: false,
      reason: "ENTRY_SCORE_TOO_LOW",
      strategy,
      strategies
    };
  }

  if (
    num(signal.spreadBps) >
    CONFIG.maxSpreadBps
  ) {
    return {
      approved: false,
      reason: "SPREAD_TOO_HIGH",
      strategy
    };
  }

  if (
    Math.abs(
      num(signal.volatilityBps)
    ) >
    CONFIG.maxVolatilityBps
  ) {
    return {
      approved: false,
      reason: "VOLATILITY_TOO_HIGH",
      strategy
    };
  }

  if (
    regime.regime === "STRONG_DOWN"
  ) {
    return {
      approved: false,
      reason: "STRONG_DOWN_PROTECTION",
      strategy
    };
  }

  const spacing =
    evaluateEntrySpacing(
      positions,
      signal.currentPrice
    );

  if (!spacing.allowed) {
    return {
      approved: false,
      reason: spacing.reason,
      spacing,
      strategy
    };
  }

  if (
    signal.signalId &&
    await hasUsedEntrySignal({
      walletAddress,
      signalId:
        String(signal.signalId)
    })
  ) {
    return {
      approved: false,
      reason: "SIGNAL_ALREADY_USED",
      strategy
    };
  }

  const costs =
    estimateExecutionCosts(signal);

  const {
    targetBps,
    trailingDistanceBps
  } =
    getTargetAndTrailing(
      strategy,
      signal,
      regime
    );

  const expectedNetEdgeBps =
    targetBps -
    costs.estimatedRoundTripCostBps;

  if (
    expectedNetEdgeBps <
    CONFIG.minNetEdgeBps
  ) {
    return {
      approved: false,
      reason: "NET_EDGE_TOO_LOW",
      strategy,
      expectedNetEdgeBps:
        round(expectedNetEdgeBps)
    };
  }

  const size =
    calculateDynamicPositionSize({
      totalCapitalUsd:
        capital.total,

      availableCapitalUsd:
        capital.availableForTrading,

      openExposureUsd:
        capital.usedInPositions,

      entryScore:
        strategy.score,

      strategyName:
        strategy.name,

      marketRegime:
        regime.regime,

      performance,
      equityRisk,
      growthPlan,

      config: {
        baseAllocationPct:
          CONFIG.baseAllocationPct,

        strongAllocationPct:
          CONFIG.strongAllocationPct,

        eliteAllocationPct:
          CONFIG.eliteAllocationPct,

        maxSingleSlotPct:
          CONFIG.maxSingleSlotPct,

        maxCapitalUsagePct:
          CONFIG.maxCapitalUsagePct,

        minTradeUsd:
          CONFIG.minTradeUsd,

        lowCapitalTestThresholdUsd:
          CONFIG.lowCapitalTestThresholdUsd
      }
    });

  if (
    !size ||
    num(size.amountUsd) <= 0
  ) {
    return {
      approved: false,
      reason:
        size?.reason ||
        "POSITION_SIZE_ZERO",
      size,
      strategy
    };
  }

  const freeSlot =
    await getFreeSlot(
      walletAddress,
      CONFIG.maxOpenSlots
    );

  if (
    freeSlot == null
  ) {
    return {
      approved: false,
      reason: "NO_FREE_SLOT"
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
            num(position.entry_usdc)
        })
      ),

    drawdownPct:
      num(equityRisk?.drawdownPct),

    dailyLossPct:
      num(performance?.dailyLossPct)
  };

  const risk =
    evaluateRisk({
      state,

      candidate: {
        amountUsd:
          size.amountUsd,

        expectedMoveBps:
          targetBps,

        buyFeeBps: 0,
        sellFeeBps: 0,

        estimatedSlippageBps:
          costs.estimatedSlippageBps
      },

      config: {
        maxOpenSlots:
          CONFIG.maxOpenSlots,

        maxCapitalUsage:
          CONFIG.maxCapitalUsagePct,

        maxSlippageBps:
          CONFIG.maxSlippageBps,

        minNetEdgeBps:
          CONFIG.minNetEdgeBps,

        maxSingleSlotPct:
          CONFIG.maxSingleSlotPct
      }
    });

  if (
    !risk.allowed
  ) {
    return {
      approved: false,
      reason: risk.reason,
      risk,
      strategy,
      size
    };
  }

  return {
    approved: true,

    candidateId:
      crypto.randomUUID(),

    side: "BUY",

    slotId:
      freeSlot,

    signalId:
      signal.signalId || null,

    strategy:
      strategy.name,

    entryScore:
      strategy.score,

    expectedSwingBps:
      strategy.expectedSwingBps,

    evidence:
      strategy.evidence,

    amountUsd:
      round(
        size.amountUsd,
        6
      ),

    positionSizing:
      size,

    targetBps,

    trailingDistanceBps,

    estimatedSlippageBps:
      costs.estimatedSlippageBps,

    estimatedRoundTripCostBps:
      costs.estimatedRoundTripCostBps,

    expectedNetEdgeBps:
      round(expectedNetEdgeBps),

    regime:
      regime.regime,

    confidence:
      num(signal.confidence),

    createdAt:
      new Date().toISOString()
  };
}


// ======================================================
// SELL CANDIDATES
// ======================================================

async function buildSellCandidates({
  positions,
  currentPrice,
  signal
}) {
  const candidates = [];

  const costs =
    estimateExecutionCosts(signal);

  const m1 =
    num(signal.momentum1mBps);

  const m3 =
    num(signal.momentum3mBps);

  const direction =
    String(
      signal.direction || ""
    ).toUpperCase();

  for (
    const position
    of positions
  ) {
    const entryPrice =
      num(position.entry_price);

    if (
      entryPrice <= 0
    ) {
      continue;
    }

    const grossPnlBps =
      pctBps(
        currentPrice,
        entryPrice
      );

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

    const highestPnlBps =
      pctBps(
        highestPrice,
        entryPrice
      );

    const previousMfe =
      num(
        position
          .max_favorable_excursion_bps,
        0
      );

    const previousMae =
      num(
        position
          .max_adverse_excursion_bps,
        0
      );

    const mfeBps =
      Math.max(
        previousMfe,
        highestPnlBps
      );

    const maeBps =
      Math.min(
        previousMae,
        grossPnlBps
      );

    await updatePositionTelemetry({
      id:
        position.id,

      highestPrice,

      maxFavorableExcursionBps:
        mfeBps,

      maxAdverseExcursionBps:
        maeBps
    });

    const targetBps =
      Math.max(
        CONFIG.targetMinBps,

        num(
          position.target_bps,
          CONFIG.targetMinBps
        )
      );

    const trailingDistanceBps =
      clamp(
        num(
          position
            .trailing_distance_bps,
          targetBps * 0.28
        ),

        CONFIG.trailingMinBps,

        CONFIG.trailingMaxBps
      );

    let trailingActive =
      position.trailing_active === true;

    if (
      !trailingActive &&
      grossPnlBps >= targetBps
    ) {
      await activateTrailing({
        id:
          position.id,

        highestPrice
      });

      trailingActive = true;
    }

    let reason = null;

    let protectionMode =
      "HOLD";

    if (
      trailingActive
    ) {
      const retracementBps =
        pctBps(
          currentPrice,
          highestPrice
        );

      const lockedNetProfitBps =
        grossPnlBps -
        costs.estimatedSellCostBps;

      if (
        retracementBps <=
          -trailingDistanceBps &&
        lockedNetProfitBps >=
          CONFIG.minLockedProfitBps
      ) {
        reason =
          "TRAILING_PROFIT_EXIT";

        protectionMode =
          "PROFIT_LOCK";
      }

      const extendedTarget =
        targetBps *
        CONFIG.extendedProfitMultiple;

      if (
        !reason &&
        grossPnlBps >=
          extendedTarget
      ) {
        reason =
          "EXTENDED_PROFIT_EXIT";

        protectionMode =
          "EXTENDED_TAKE_PROFIT";
      }
    }

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
      !reason &&
      emergencyLoss &&
      momentumBreakdown &&
      directionBreakdown
    ) {
      reason =
        "CONFIRMED_EMERGENCY_EXIT";

      protectionMode =
        "EMERGENCY";
    }

    if (!reason) {
      continue;
    }

    candidates.push({
      candidateId:
        crypto.randomUUID(),

      side: "SELL",

      slotId:
        Number(position.slot_id),

      positionId:
        Number(position.id),

      amountSol:
        num(position.entry_sol),

      entryPrice,

      currentPrice,

      highestPrice,

      grossPnlBps:
        round(grossPnlBps),

      highestPnlBps:
        round(highestPnlBps),

      estimatedSellCostBps:
        costs.estimatedSellCostBps,

      estimatedSlippageBps:
        costs.estimatedSlippageBps,

      trailingActive,

      trailingDistanceBps:
        round(
          trailingDistanceBps
        ),

      targetBps:
        round(targetBps),

      protectionMode,

      reason,

      createdAt:
        new Date().toISOString()
    });
  }

  const priority = {
    ABSOLUTE_EMERGENCY_EXIT: 1,
    CONFIRMED_EMERGENCY_EXIT: 2,
    TRAILING_PROFIT_EXIT: 3,
    EXTENDED_PROFIT_EXIT: 4
  };

  candidates.sort(
    (a, b) => {
      const pa =
        priority[a.reason] || 99;

      const pb =
        priority[b.reason] || 99;

      if (pa !== pb) {
        return pa - pb;
      }

      return (
        b.grossPnlBps -
        a.grossPnlBps
      );
    }
  );

  return candidates;
}


// ======================================================
// ANALYZE SYSTEM
// ======================================================

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
    String(
      walletSnapshot.walletAddress
    ) !==
    String(walletAddress)
  ) {
    throw new Error(
      "WALLET_SNAPSHOT_ADDRESS_MISMATCH"
    );
  }

  const signal =
    mergeMarketFields(
      signalData
    );

  const currentPrice =
    num(signal.currentPrice);

  if (
    currentPrice <= 0
  ) {
    throw new Error(
      "INVALID_CURRENT_PRICE"
    );
  }

  signal.currentPrice =
    currentPrice;

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
        100
      ),

      getTradingDashboard(
        walletAddress
      )
    ]);

  const capital =
    calculateCapital({
      positions,
      walletSnapshot,
      currentPrice
    });

  await recordEquitySnapshot({
    walletAddress,

    equityUsd:
      capital.total,

    usdcBalance:
      walletSnapshot.usdcBalance,

    solBalance:
      walletSnapshot.solBalance,

    solPrice:
      currentPrice
  });

  const [
    equityRisk,
    performance
  ] =
    await Promise.all([
      getEquityRiskSnapshot(
        walletAddress
      ),

      getPerformanceStats(
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

  const regime =
    detectMarketRegime(
      signal
    );

  const growthPlan =
    buildGrowthPlan(
      equityRisk,
      performance
    );

  const strategies =
    buildStrategyScores(
      signal,
      regime,
      learning,
      growthPlan
    );

  const buyCandidate =
    await buildBuyCandidate({
      walletAddress,
      positions,
      recentTrades,
      signal,
      capital,
      learning,
      regime,
      growthPlan,
      equityRisk,
      performance
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
    dashboard,
    capital,
    riskMode,
    learning,
    regime,
    growthPlan,
    equityRisk,
    performance,
    strategies,
    buyCandidate,
    sellCandidates
  };
}


// ======================================================
// EXECUTE BUY
// ======================================================

async function executeApprovedBuy({
  req,
  analysis
}) {
  const candidate =
    analysis.buyCandidate;

  if (
    !candidate ||
    candidate.approved !== true
  ) {
    throw new Error(
      "NO_APPROVED_BUY_CANDIDATE"
    );
  }

  const slotId =
    Number(candidate.slotId);

  const claimToken =
    crypto.randomUUID();

  let slotClaimed = false;

  try {
    const claim =
      await claimSlot({
        walletAddress:
          analysis.walletAddress,

        slotId,

        claimToken,

        ttlSeconds:
          CONFIG.cycleLockSeconds
      });

    if (
      !claim?.acquired
    ) {
      return {
        executed: false,
        side: "BUY",
        slotId,
        reason:
          "SLOT_CLAIM_FAILED"
      };
    }

    slotClaimed = true;

    const existing =
      await getOpenPositionBySlot(
        analysis.walletAddress,
        slotId
      );

    if (existing) {
      return {
        executed: false,
        side: "BUY",
        slotId,
        reason:
          "SLOT_ALREADY_OPEN"
      };
    }

    const freshWallet =
      await loadWalletSnapshot(
        req
      );

    const amountUsd =
      Math.min(
        num(candidate.amountUsd),
        num(
          freshWallet.usdcBalance
        )
      );

    if (
      amountUsd <
      CONFIG.minTradeUsd &&
      !analysis.capital.testMode
    ) {
      return {
        executed: false,
        side: "BUY",
        slotId,
        reason:
          "INSUFFICIENT_REAL_USDC"
      };
    }

    if (
      amountUsd <= 0
    ) {
      return {
        executed: false,
        side: "BUY",
        slotId,
        reason:
          "ZERO_BUY_AMOUNT"
      };
    }

    const execution =
      await executeTrade({
        req,

        side: "BUY",

        slotId,

        amountUsd,

        slippageBps:
          candidate
            .estimatedSlippageBps
      });

    if (
      execution?.executed !== true
    ) {
      return {
        executed: false,
        side: "BUY",
        slotId,

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

        slotId,

        entryPrice:
          actualEntryPrice,

        entrySol:
          solReceived,

        entryUsdc:
          amountUsd,

        signature:
          execution.signature,

        strategy:
          `V8_${candidate.strategy}`,

        targetBps:
          candidate.target
