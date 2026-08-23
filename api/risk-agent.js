// /api/risk-agent.js
// FAWAZ AI BOT - Risk Agent v2

const DEFAULTS = {
  maxOpenSlots: 4,
  maxCapitalUsage: 0.80,      // نستخدم 80% كحد أقصى
  maxSlippageBps: 30,         // 0.30%
  maxConsecutiveLosses: 3,
  cooldownAfterLossMs: 60_000,
  emergencyCooldownMs: 5 * 60_000,
  minNetEdgeBps: 12,          // لازم يبقى هامش صافي بعد التكاليف
  maxSingleSlotPct: 0.25,
};

export function analyzeRecentTrades(trades = []) {
  const recent = trades.slice(-20);

  if (!recent.length) {
    return {
      trades: 0,
      wins: 0,
      losses: 0,
      winRate: 1,
      avgWinBps: 0,
      avgLossBps: 0,
      consecutiveLosses: 0,
    };
  }

  const wins = recent.filter((t) => Number(t.pnlBps) > 0);
  const losses = recent.filter((t) => Number(t.pnlBps) <= 0);

  let consecutiveLosses = 0;

  for (let i = recent.length - 1; i >= 0; i--) {
    if (Number(recent[i].pnlBps) <= 0) {
      consecutiveLosses++;
    } else {
      break;
    }
  }

  const avgWinBps =
    wins.length > 0
      ? wins.reduce((sum, t) => sum + Number(t.pnlBps || 0), 0) /
        wins.length
      : 0;

  const avgLossBps =
    losses.length > 0
      ? losses.reduce((sum, t) => sum + Number(t.pnlBps || 0), 0) /
        losses.length
      : 0;

  return {
    trades: recent.length,
    wins: wins.length,
    losses: losses.length,
    winRate: wins.length / recent.length,
    avgWinBps,
    avgLossBps,
    consecutiveLosses,
  };
}

export function calculateNetEdge({
  expectedMoveBps,
  buyFeeBps = 0,
  sellFeeBps = 0,
  estimatedSlippageBps = 0,
}) {
  const totalCostBps =
    Number(buyFeeBps) +
    Number(sellFeeBps) +
    Number(estimatedSlippageBps);

  return {
    expectedMoveBps,
    totalCostBps,
    netEdgeBps: Number(expectedMoveBps) - totalCostBps,
  };
}

export function evaluateRisk({
  state,
  candidate,
  config = {},
}) {
  const cfg = {
    ...DEFAULTS,
    ...config,
  };

  const now = Date.now();

  const stats = analyzeRecentTrades(state?.recentTrades || []);

  const openSlots = (state?.slots || []).filter(
    (slot) => slot.status === "OPEN"
  );

  // إيقاف طارئ فقط، وليس منع البحث عن الفرص
  if (
    state?.cooldownUntil &&
    now < Number(state.cooldownUntil)
  ) {
    return {
      allowed: false,
      reason: "COOLDOWN",
      retryAfterMs: Number(state.cooldownUntil) - now,
      stats,
    };
  }

  if (stats.consecutiveLosses >= cfg.maxConsecutiveLosses) {
    return {
      allowed: false,
      reason: "LOSS_STREAK",
      cooldownMs: cfg.emergencyCooldownMs,
      stats,
    };
  }

  if (openSlots.length >= cfg.maxOpenSlots) {
    return {
      allowed: false,
      reason: "NO_FREE_SLOT",
      stats,
    };
  }

  if (
    Number(candidate.estimatedSlippageBps) >
    cfg.maxSlippageBps
  ) {
    return {
      allowed: false,
      reason: "SLIPPAGE_TOO_HIGH",
      stats,
    };
  }

  const edge = calculateNetEdge(candidate);

  if (edge.netEdgeBps < cfg.minNetEdgeBps) {
    return {
      allowed: false,
      reason: "EDGE_TOO_SMALL",
      edge,
      stats,
    };
  }

  const totalCapital = Number(state?.totalCapitalUsd || 0);

  const currentlyUsed = openSlots.reduce(
    (sum, slot) => sum + Number(slot.amountUsd || 0),
    0
  );

  const maxAllowedCapital =
    totalCapital * cfg.maxCapitalUsage;

  if (
    currentlyUsed + Number(candidate.amountUsd) >
    maxAllowedCapital
  ) {
    return {
      allowed: false,
      reason: "CAPITAL_LIMIT",
      stats,
    };
  }

  if (
    Number(candidate.amountUsd) >
    totalCapital * cfg.maxSingleSlotPct
  ) {
    return {
      allowed: false,
      reason: "SLOT_TOO_LARGE",
      stats,
    };
  }

  return {
    allowed: true,
    reason: "APPROVED",
    edge,
    stats,
  };
}

export function getDynamicRiskMode(trades = []) {
  const stats = analyzeRecentTrades(trades);

  if (stats.consecutiveLosses >= 3) {
    return "PAUSED";
  }

  if (
    stats.trades >= 8 &&
    stats.winRate < 0.40
  ) {
    return "DEFENSIVE";
  }

  if (
    stats.trades >= 8 &&
    stats.winRate >= 0.65
  ) {
    return "FAST";
  }

  return "NORMAL";
}
