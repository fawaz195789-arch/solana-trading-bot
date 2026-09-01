// /api/risk-agent.js
// FAWAZ AI TRADER V8 GROWTH PRO
// Risk + dynamic sizing + expectancy + drawdown controls

const DEFAULTS = {
  maxOpenSlots: 12,
  maxCapitalUsage: 0.50,
  maxSlippageBps: 30,
  minNetEdgeBps: 14,

  maxConsecutiveLosses: 4,
  defensiveLossStreak: 2,

  maxDrawdownPct: 6,
  maxDailyLossPct: 4,
  defensiveDrawdownPct: 4,
  cautiousDrawdownPct: 2,

  baseAllocationPct: 0.06,
  strongAllocationPct: 0.10,
  eliteAllocationPct: 0.14,
  maxSingleSlotPct: 0.15,
  minTradeUsd: 1,
  lowCapitalTestThresholdUsd: 5,

  minProfitFactorForGrowth: 1.35,
  minExpectancyBpsForGrowth: 8,
  minimumSampleForGrowth: 12
};

function n(value, fallback = 0) {
  const x = Number(value);

  return Number.isFinite(x)
    ? x
    : fallback;
}

function clamp(value, min, max) {
  return Math.max(
    min,
    Math.min(max, value)
  );
}

function round(value, digits = 6) {
  return Number(
    n(value).toFixed(digits)
  );
}

function getTradeTime(trade) {
  const raw =
    trade?.closed_at ||
    trade?.closedAt ||
    trade?.timestamp ||
    trade?.created_at ||
    0;

  const t =
    new Date(raw).getTime();

  return Number.isFinite(t)
    ? t
    : 0;
}

function getTradePnlBps(trade) {
  const explicit =
    Number(
      trade?.pnlBps
    );

  if (
    Number.isFinite(explicit)
  ) {
    return explicit;
  }

  const pct =
    Number(
      trade?.realized_pnl_pct ??
      trade?.realizedPnlPct
    );

  if (
    Number.isFinite(pct)
  ) {
    return pct * 100;
  }

  const pnl =
    Number(
      trade?.realized_pnl ??
      trade?.realizedPnl
    );

  const entryUsdc =
    Number(
      trade?.entry_usdc ??
      trade?.entryUsdc
    );

  if (
    Number.isFinite(pnl) &&
    Number.isFinite(entryUsdc) &&
    entryUsdc > 0
  ) {
    return (
      pnl /
      entryUsdc
    ) * 10000;
  }

  return 0;
}


// ======================================================
// RECENT TRADE ANALYTICS
// ======================================================

export function analyzeRecentTrades(
  trades = []
) {
  const source =
    Array.isArray(trades)
      ? trades.slice(0, 50)
      : [];

  if (!source.length) {
    return {
      trades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      avgWinBps: 0,
      avgLossBps: 0,
      grossProfitBps: 0,
      grossLossBps: 0,
      profitFactor: null,
      expectancyBps: 0,
      consecutiveLosses: 0
    };
  }

  const orderedNewestFirst =
    [
      ...source
    ].sort(
      (a, b) =>
        getTradeTime(b) -
        getTradeTime(a)
    );

  const values =
    orderedNewestFirst.map(
      getTradePnlBps
    );

  const wins =
    values.filter(
      value =>
        value > 0
    );

  const losses =
    values.filter(
      value =>
        value <= 0
    );

  const grossProfitBps =
    wins.reduce(
      (
        sum,
        value
      ) =>
        sum + value,
      0
    );

  const grossLossBps =
    Math.abs(
      losses.reduce(
        (
          sum,
          value
        ) =>
          sum + value,
        0
      )
    );

  const avgWinBps =
    wins.length > 0
      ? grossProfitBps /
        wins.length
      : 0;

  const avgLossBps =
    losses.length > 0
      ? losses.reduce(
          (
            sum,
            value
          ) =>
            sum + value,
          0
        ) /
        losses.length
      : 0;

  const winRate =
    wins.length /
    values.length;

  const lossRate =
    losses.length /
    values.length;

  const expectancyBps =
    winRate *
    avgWinBps +
    lossRate *
    avgLossBps;

  let consecutiveLosses =
    0;

  for (
    const value
    of values
  ) {
    if (
      value <= 0
    ) {
      consecutiveLosses++;
    } else {
      break;
    }
  }

  let profitFactor =
    null;

  if (
    grossLossBps > 0
  ) {
    profitFactor =
      grossProfitBps /
      grossLossBps;

  } else if (
    grossProfitBps > 0
  ) {
    profitFactor =
      Infinity;
  }

  return {
    trades:
      values.length,

    wins:
      wins.length,

    losses:
      losses.length,

    winRate,

    avgWinBps,

    avgLossBps,

    grossProfitBps,

    grossLossBps,

    profitFactor,

    expectancyBps,

    consecutiveLosses
  };
}


// ======================================================
// NET EDGE
// ======================================================

export function calculateNetEdge({
  expectedMoveBps,
  buyFeeBps = 0,
  sellFeeBps = 0,
  estimatedSlippageBps = 0,
  estimatedRoundTripCostBps = null
}) {
  const explicitRoundTrip =
    Number(
      estimatedRoundTripCostBps
    );

  const totalCostBps =
    Number.isFinite(
      explicitRoundTrip
    )
      ? explicitRoundTrip
      : n(buyFeeBps) +
        n(sellFeeBps) +
        n(
          estimatedSlippageBps
        );

  return {
    expectedMoveBps:
      n(expectedMoveBps),

    totalCostBps,

    netEdgeBps:
      n(expectedMoveBps) -
      totalCostBps
  };
}


// ======================================================
// DYNAMIC RISK MODE
// ======================================================

export function getDynamicRiskMode(
  trades = [],
  riskSnapshot = {}
) {
  const stats =
    analyzeRecentTrades(
      trades
    );

  const drawdownPct =
    Math.max(
      0,
      n(
        riskSnapshot
          ?.drawdownPct
      )
    );

  const dailyLossPct =
    Math.max(
      0,
      n(
        riskSnapshot
          ?.dailyLossPct
      )
    );

  const return24hPct =
    n(
      riskSnapshot
        ?.return24hPct
    );

  if (
    dailyLossPct >=
      DEFAULTS
        .maxDailyLossPct ||

    return24hPct <=
      -DEFAULTS
        .maxDailyLossPct ||

    drawdownPct >=
      DEFAULTS
        .maxDrawdownPct ||

    stats
      .consecutiveLosses >=
      DEFAULTS
        .maxConsecutiveLosses
  ) {
    return "PAUSED";
  }

  if (
    drawdownPct >=
      DEFAULTS
        .defensiveDrawdownPct ||

    stats
      .consecutiveLosses >= 3 ||

    (
      stats.trades >= 10 &&
      stats.profitFactor !==
        null &&
      stats.profitFactor !==
        Infinity &&
      stats.profitFactor <
        0.85
    )
  ) {
    return "DEFENSIVE";
  }

  if (
    drawdownPct >=
      DEFAULTS
        .cautiousDrawdownPct ||

    stats
      .consecutiveLosses >=
      DEFAULTS
        .defensiveLossStreak
  ) {
    return "CAUTIOUS";
  }

  if (
    stats.trades >=
      DEFAULTS
        .minimumSampleForGrowth &&

    stats.profitFactor !==
      null &&

    stats.profitFactor >=
      DEFAULTS
        .minProfitFactorForGrowth &&

    stats.expectancyBps >=
      DEFAULTS
        .minExpectancyBpsForGrowth &&

    stats.consecutiveLosses ===
      0 &&

    drawdownPct <
      DEFAULTS
        .cautiousDrawdownPct
  ) {
    return "GROWTH";
  }

  return "NORMAL";
}


// ======================================================
// DYNAMIC POSITION SIZE
// ======================================================

export function calculateDynamicPositionSize({
  totalCapitalUsd,

  // الاسم المستخدم في V8
  availableCapitalUsd,

  // توافق إضافي
  availableUsd,

  openExposureUsd = 0,

  // الاسم المستخدم في V8
  entryScore,

  // توافق إضافي
  score,

  strategyName = null,

  marketRegime = "NORMAL",

  performance = {},

  equityRisk = {},

  growthPlan = {},

  riskMode = null,

  growthMultiplier = null,

  config = {},

  testMode = false
}) {
  const cfg = {
    ...DEFAULTS,
    ...config
  };

  const capital =
    Math.max(
      0,
      n(totalCapitalUsd)
    );

  const available =
    Math.max(
      0,
      n(
        availableCapitalUsd ??
        availableUsd
      )
    );

  const exposure =
    Math.max(
      0,
      n(openExposureUsd)
    );

  const qualityScore =
    clamp(
      n(
        entryScore ??
        score
      ),
      0,
      100
    );

  if (
    capital <= 0 ||
    available <= 0
  ) {
    return {
      amountUsd: 0,

      reason:
        "NO_AVAILABLE_CAPITAL"
    };
  }

  const lowCapitalMode =
    Boolean(testMode) ||
    capital <=
      cfg
        .lowCapitalTestThresholdUsd;

  if (
    lowCapitalMode
  ) {
    const amountUsd =
      Math.min(
        available,

        Math.max(
          0.01,
          cfg.minTradeUsd
        )
      );

    return {
      amountUsd:
        round(amountUsd),

      reason:
        amountUsd > 0
          ? "LOW_CAPITAL_TEST_SIZE"
          : "NO_AVAILABLE_CAPITAL",

      allocationPct:
        capital > 0
          ? amountUsd /
            capital
          : 0,

      score:
        qualityScore,

      mode:
        "TEST"
    };
  }

  let allocationPct =
    cfg.baseAllocationPct;

  if (
    qualityScore >= 84
  ) {
    allocationPct =
      cfg.eliteAllocationPct;

  } else if (
    qualityScore >= 74
  ) {
    allocationPct =
      cfg
        .strongAllocationPct;
  }

  let performanceMode =
    riskMode ||
    "NORMAL";

  const drawdownPct =
    Math.max(
      0,
      n(
        equityRisk
          ?.drawdownPct
      )
    );

  const dailyLossPct =
    Math.max(
      0,
      n(
        performance
          ?.dailyLossPct
      )
    );

  const consecutiveLosses =
    Math.max(
      0,
      n(
        performance
          ?.consecutiveLosses
      )
    );

  const profitFactor =
    Number(
      performance
        ?.profitFactor
    );

  const expectancyBps =
    n(
      performance
        ?.expectancyBps
    );

  if (
    drawdownPct >=
      cfg.maxDrawdownPct ||

    dailyLossPct >=
      cfg.maxDailyLossPct ||

    consecutiveLosses >=
      cfg.maxConsecutiveLosses
  ) {
    performanceMode =
      "PAUSED";

  } else if (
    drawdownPct >=
      cfg
        .defensiveDrawdownPct ||

    consecutiveLosses >= 3
  ) {
    performanceMode =
      "DEFENSIVE";

  } else if (
    drawdownPct >=
      cfg
        .cautiousDrawdownPct ||

    consecutiveLosses >= 2
  ) {
    performanceMode =
      "CAUTIOUS";

  } else if (
    Number.isFinite(
      profitFactor
    ) &&

    profitFactor >=
      cfg
        .minProfitFactorForGrowth &&

    expectancyBps >=
      cfg
        .minExpectancyBpsForGrowth
  ) {
    performanceMode =
      "GROWTH";
  }

  const modeMultipliers = {
    PAUSED: 0,
    DEFENSIVE: 0.45,
    CAUTIOUS: 0.70,
    NORMAL: 1,
    LEARNING: 0.85,
    GROWTH: 1.08,
    FAST: 1.08
  };

  let riskMultiplier =
    modeMultipliers[
      performanceMode
    ] ?? 1;

  if (
    marketRegime ===
      "HIGH_VOLATILITY"
  ) {
    riskMultiplier *=
      0.80;
  }

  if (
    marketRegime === "DOWN"
  ) {
    riskMultiplier *=
      0.70;
  }

  if (
    marketRegime ===
      "STRONG_DOWN"
  ) {
    riskMultiplier =
      0;
  }

  if (
    strategyName ===
      "CONTROLLED_BREAKOUT"
  ) {
    riskMultiplier *=
      0.90;
  }

  const adaptiveGrowthMultiplier =
    growthMultiplier != null
      ? n(
          growthMultiplier,
          1
        )
      : n(
          growthPlan
            ?.activityMultiplier,
          1
        );

  const boundedGrowth =
    clamp(
      adaptiveGrowthMultiplier,
      0.85,
      1.12
    );

  let amountUsd =
    capital *
    allocationPct *
    riskMultiplier *
    boundedGrowth;

  const maxSingleUsd =
    capital *
    cfg.maxSingleSlotPct;

  const maxPortfolioUsd =
    capital *
    cfg.maxCapitalUsage;

  const portfolioRoomUsd =
    Math.max(
      0,

      maxPortfolioUsd -
      exposure
    );

  amountUsd =
    Math.min(
      amountUsd,
      maxSingleUsd,
      portfolioRoomUsd,
      available
    );

  if (
    amountUsd <
    cfg.minTradeUsd
  ) {
    return {
      amountUsd: 0,

      reason:
        "BELOW_MIN_TRADE_SIZE",

      score:
        qualityScore,

      mode:
        performanceMode,

      allocationPct,

      portfolioRoomUsd:
        round(
          portfolioRoomUsd
        ),

      maxSingleUsd:
        round(
          maxSingleUsd
        )
    };
  }

  return {
    amountUsd:
      round(amountUsd),

    reason:
      "DYNAMIC_SIZE_APPROVED",

    score:
      qualityScore,

    mode:
      performanceMode,

    allocationPct,

    riskMultiplier:
      round(
        riskMultiplier,
        4
      ),

    growthMultiplier:
      round(
        boundedGrowth,
        4
      ),

    maxSingleUsd:
      round(
        maxSingleUsd
      ),

    portfolioRoomUsd:
      round(
        portfolioRoomUsd
      ),

    availableUsd:
      round(
        available
      )
  };
}


// ======================================================
// FINAL RISK APPROVAL
// ======================================================

export function evaluateRisk({
  state,
  candidate,
  config = {}
}) {
  const cfg = {
    ...DEFAULTS,
    ...config
  };

  const stats =
    analyzeRecentTrades(
      state?.recentTrades ||
      []
    );

  const openSlots =
    (
      state?.slots || []
    ).filter(
      slot =>
        slot.status ===
        "OPEN"
    );

  const drawdownPct =
    Math.max(
      0,

      n(
        state?.drawdownPct ??
        state
          ?.riskSnapshot
          ?.drawdownPct
      )
    );

  const dailyLossPct =
    Math.max(
      0,

      n(
        state?.dailyLossPct ??
        state
          ?.riskSnapshot
          ?.dailyLossPct
      )
    );

  if (
    dailyLossPct >=
    cfg.maxDailyLossPct
  ) {
    return {
      allowed: false,

      reason:
        "DAILY_LOSS_LIMIT",

      stats,
      drawdownPct,
      dailyLossPct
    };
  }

  if (
    stats
      .consecutiveLosses >=
    cfg.maxConsecutiveLosses
  ) {
    return {
      allowed: false,

      reason:
        "LOSS_STREAK",

      stats,
      drawdownPct,
      dailyLossPct
    };
  }

  if (
    drawdownPct >=
    cfg.maxDrawdownPct
  ) {
    return {
      allowed: false,

      reason:
        "MAX_DRAWDOWN_REACHED",

      stats,
      drawdownPct,
      dailyLossPct
    };
  }

  if (
    openSlots.length >=
    cfg.maxOpenSlots
  ) {
    return {
      allowed: false,

      reason:
        "NO_FREE_SLOT",

      stats
    };
  }

  if (
    n(
      candidate
        ?.estimatedSlippageBps
    ) >
    cfg.maxSlippageBps
  ) {
    return {
      allowed: false,

      reason:
        "SLIPPAGE_TOO_HIGH",

      stats
    };
  }

  const edge =
    calculateNetEdge(
      candidate || {}
    );

  if (
    edge.netEdgeBps <
    cfg.minNetEdgeBps
  ) {
    return {
      allowed: false,

      reason:
        "EDGE_TOO_SMALL",

      edge,
      stats
    };
  }

  const totalCapital =
    Math.max(
      0,

      n(
        state
          ?.totalCapitalUsd
      )
    );

  if (
    totalCapital <= 0
  ) {
    return {
      allowed: false,

      reason:
        "NO_CAPITAL",

      edge,
      stats
    };
  }

  const currentlyUsed =
    openSlots.reduce(
      (
        sum,
        slot
      ) =>
        sum +
        n(
          slot?.amountUsd
        ),
      0
    );

  const amountUsd =
    Math.max(
      0,
      n(
        candidate
          ?.amountUsd
      )
    );

  if (
    amountUsd <= 0
  ) {
    return {
      allowed: false,

      reason:
        "INVALID_POSITION_SIZE",

      edge,
      stats
    };
  }

  const lowCapitalMode =
    totalCapital <=
    cfg
      .lowCapitalTestThresholdUsd;

  if (
    !lowCapitalMode
  ) {
    const maxAllowedCapital =
      totalCapital *
      cfg.maxCapitalUsage;

    if (
      currentlyUsed +
      amountUsd >
      maxAllowedCapital +
      1e-9
    ) {
      return {
        allowed: false,

        reason:
          "CAPITAL_LIMIT",

        edge,
        stats
      };
    }

    if (
      amountUsd >
      totalCapital *
      cfg
        .maxSingleSlotPct +
      1e-9
    ) {
      return {
        allowed: false,

        reason:
          "SLOT_TOO_LARGE",

        edge,
        stats
      };
    }
  }

  return {
    allowed: true,

    reason:
      "APPROVED",

    edge,
    stats,
    drawdownPct,
    dailyLossPct
  };
}


// ======================================================
// EXPORT DEFAULTS
// ======================================================

export {
  DEFAULTS as RISK_DEFAULTS
};
