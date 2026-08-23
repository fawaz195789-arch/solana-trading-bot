// /api/trade-orchestrator.js
// FAWAZ AI BOT
// Parallel Micro Scalper v2

import {
  evaluateRisk,
  getDynamicRiskMode,
} from "./risk-agent.js";

const SOL_MINT =
  "So11111111111111111111111111111111111111112";

const USDC_MINT =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// ======================================================
// CONFIG
// ======================================================

const CONFIG = {
  maxSlots: 4,

  // نخلي 20% من رأس المال احتياطي
  reservePct: 0.20,

  // أهداف الربح المتغيرة بالنقاط
  calmTargetBps: 30,    // 0.30%
  normalTargetBps: 45,  // 0.45%
  fastTargetBps: 70,    // 0.70%

  // Trailing Profit
  trailingActivationPct: 0.65,
  trailingDistancePct: 0.30,

  // وقف الخسارة
  stopLossBps: 45, // 0.45%

  // أقصى انزلاق
  maxSlippageBps: 30, // 0.30%

  // الحد الأدنى للربح المتوقع بعد التكاليف
  minNetEdgeBps: 12,

  // تأخير بسيط قبل إعادة استخدام نفس Slot
  slotReentryDelayMs: 20_000,
};

// ======================================================
// STATE
// ======================================================

const globalState =
  globalThis.__FAWAZ_SCALPER_STATE__ || {
    totalCapitalUsd: 0,

    slots: Array.from(
      { length: CONFIG.maxSlots },
      (_, index) => ({
        id: index + 1,
        status: "READY",

        entryPrice: null,
        highestPrice: null,

        amountUsd: 0,
        quantity: 0,

        targetBps: 0,

        trailingActive: false,
        trailingDistanceBps: 0,

        openedAt: null,
        closedAt: null,

        lastUsedAt: 0,
      })
    ),

    recentTrades: [],

    prices: [],

    cooldownUntil: 0,

    stats: {
      scanned: 0,
      entries: 0,
      exits: 0,
      skipped: 0,
    },
  };

globalThis.__FAWAZ_SCALPER_STATE__ = globalState;

// ======================================================
// HELPERS
// ======================================================

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function percentageToBps(value) {
  return value * 10000;
}

// ======================================================
// AUTH
// ======================================================

function getAuthorization(req) {
  const expected = process.env.AUTO_TRADER_SECRET;

  if (!expected) {
    return {
      ok: false,
      reason: "AUTO_TRADER_SECRET_MISSING",
    };
  }

  const header =
    req.headers.authorization ||
    req.headers.Authorization;

  if (header !== `Bearer ${expected}`) {
    return {
      ok: false,
      reason: "UNAUTHORIZED",
    };
  }

  return {
    ok: true,
  };
}

// ======================================================
// MARKET PRICE
// ======================================================

async function getMarketPrice(req) {
  /*
    الخيار الأول:
    إذا عندك API خاص بالسعر نحطه في:

    MARKET_PRICE_ENDPOINT
  */

  if (process.env.MARKET_PRICE_ENDPOINT) {
    const response = await fetch(
      process.env.MARKET_PRICE_ENDPOINT,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      }
    );

    if (!response.ok) {
      throw new Error(
        `MARKET_PRICE_HTTP_${response.status}`
      );
    }

    const data = await response.json();

    const price =
      Number(data.price) ||
      Number(data.solPrice) ||
      Number(data.data?.price);

    if (!price || price <= 0) {
      throw new Error("INVALID_MARKET_PRICE");
    }

    return price;
  }

  /*
    للاختبار فقط:

    /api/trade-orchestrator?price=200
  */

  const queryPrice = Number(req.query?.price);

  if (queryPrice > 0) {
    return queryPrice;
  }

  throw new Error(
    "MARKET_PRICE_ENDPOINT_NOT_CONFIGURED"
  );
}

// ======================================================
// PRICE MEMORY
// ======================================================

function pushPrice(price) {
  globalState.prices.push({
    price,
    time: Date.now(),
  });

  if (globalState.prices.length > 60) {
    globalState.prices =
      globalState.prices.slice(-60);
  }
}

// ======================================================
// MARKET METRICS
// ======================================================

function calculateMarketMetrics() {
  const prices =
    globalState.prices.map((item) => item.price);

  if (prices.length < 2) {
    return {
      momentumBps: 0,
      volatilityBps: 0,
      shortMoveBps: 0,
      direction: "FLAT",
    };
  }

  const current =
    prices[prices.length - 1];

  const previous =
    prices[prices.length - 2];

  const lookback =
    prices[Math.max(0, prices.length - 6)];

  const shortMoveBps =
    percentageToBps(
      (current - previous) / previous
    );

  const momentumBps =
    percentageToBps(
      (current - lookback) / lookback
    );

  const returns = [];

  for (let i = 1; i < prices.length; i++) {
    const move =
      percentageToBps(
        (prices[i] - prices[i - 1]) /
          prices[i - 1]
      );

    returns.push(Math.abs(move));
  }

  const volatilityBps =
    returns.length > 0
      ? returns.reduce(
          (sum, move) => sum + move,
          0
        ) / returns.length
      : 0;

  let direction = "FLAT";

  if (momentumBps > 5) {
    direction = "UP";
  }

  if (momentumBps < -5) {
    direction = "DOWN";
  }

  return {
    momentumBps,
    volatilityBps,
    shortMoveBps,
    direction,
  };
}

// ======================================================
// DYNAMIC TARGET
// ======================================================

function getDynamicTarget(metrics, mode) {
  let target = CONFIG.calmTargetBps;

  if (metrics.volatilityBps >= 25) {
    target = CONFIG.normalTargetBps;
  }

  if (metrics.volatilityBps >= 50) {
    target = CONFIG.fastTargetBps;
  }

  if (mode === "FAST") {
    target *= 1.10;
  }

  if (mode === "DEFENSIVE") {
    target *= 0.80;
  }

  return Math.round(
    clamp(target, 20, 100)
  );
}

// ======================================================
// SLOTS
// ======================================================

function getReadySlot() {
  const now = Date.now();

  return globalState.slots.find(
    (slot) =>
      slot.status === "READY" &&
      now - Number(slot.lastUsedAt || 0) >=
        CONFIG.slotReentryDelayMs
  );
}

function getOpenSlots() {
  return globalState.slots.filter(
    (slot) => slot.status === "OPEN"
  );
}

function calculateSlotAmount() {
  const usableCapital =
    globalState.totalCapitalUsd *
    (1 - CONFIG.reservePct);

  return usableCapital / CONFIG.maxSlots;
}

// ======================================================
// ENTRY DETECTOR
// ======================================================

function detectEntryOpportunity({
  price,
  metrics,
  mode,
}) {
  /*
    طريقتين للدخول:

    1) Momentum Scalping
    السعر بدأ يتحرك للأعلى

    2) Dip Layer
    هبوط صغير نحاول نصيد ارتداده
  */

  const momentumEntry =
    metrics.shortMoveBps >= 4 &&
    metrics.momentumBps >= 3;

  const dipEntry =
    metrics.shortMoveBps <= -8 &&
    Math.abs(metrics.shortMoveBps) <= 80;

  const volatilityOk =
    metrics.volatilityBps >= 3;

  if (!volatilityOk) {
    return {
      enter: false,
      reason: "VOLATILITY_TOO_LOW",
    };
  }

  if (!momentumEntry && !dipEntry) {
    return {
      enter: false,
      reason: "NO_MICRO_SETUP",
    };
  }

  return {
    enter: true,

    type:
      dipEntry
        ? "DIP_LAYER"
        : "MOMENTUM_SCALP",

    estimatedMoveBps:
      getDynamicTarget(metrics, mode),

    price,
  };
}

// ======================================================
// EXECUTION
// ======================================================

async function executeTrade({
  side,
  amountUsd,
  slotId,
  maxSlippageBps,
}) {
  /*
    هذا يرسل أمر التنفيذ إلى ملف التداول الموجود عندك.

    ضع الرابط في Vercel باسم:

    TRADE_EXECUTION_ENDPOINT

    مثال:

    https://fawaz-ai-bot.vercel.app/api/execute-trade
  */

  const endpoint =
    process.env.TRADE_EXECUTION_ENDPOINT;

  if (!endpoint) {
    return {
      success: false,
      simulated: true,
      reason:
        "TRADE_EXECUTION_ENDPOINT_NOT_SET",
    };
  }

  const secret =
    process.env.AUTO_TRADER_SECRET;

  const response = await fetch(endpoint, {
    method: "POST",

    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    },

    body: JSON.stringify({
      side,
      slotId,
      amountUsd,

      inputMint:
        side === "BUY"
          ? USDC_MINT
          : SOL_MINT,

      outputMint:
        side === "BUY"
          ? SOL_MINT
          : USDC_MINT,

      slippageBps:
        maxSlippageBps,
    }),
  });

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = {
      raw: text,
    };
  }

  if (!response.ok) {
    return {
      success: false,
      status: response.status,
      data,
    };
  }

  return {
    success: true,
    data,
  };
}

// ======================================================
// OPEN SLOT
// ======================================================

async function openSlot({
  slot,
  price,
  amountUsd,
  targetBps,
}) {
  const execution =
    await executeTrade({
      side: "BUY",

      amountUsd,

      slotId: slot.id,

      maxSlippageBps:
        CONFIG.maxSlippageBps,
    });

  if (!execution.success) {
    return {
      opened: false,
      execution,
    };
  }

  const quantity =
    amountUsd / price;

  slot.status = "OPEN";

  slot.entryPrice = price;

  slot.highestPrice = price;

  slot.amountUsd = amountUsd;

  slot.quantity = quantity;

  slot.targetBps = targetBps;

  slot.trailingActive = false;

  slot.trailingDistanceBps =
    Math.max(
      8,
      Math.round(
        targetBps *
          CONFIG.trailingDistancePct
      )
    );

  slot.openedAt = Date.now();

  slot.lastUsedAt = Date.now();

  globalState.stats.entries++;

  return {
    opened: true,
    slot,
    execution,
  };
}

// ======================================================
// CLOSE SLOT
// ======================================================

async function closeSlot(
  slot,
  currentPrice,
  reason
) {
  const execution =
    await executeTrade({
      side: "SELL",

      amountUsd: slot.amountUsd,

      slotId: slot.id,

      maxSlippageBps:
        CONFIG.maxSlippageBps,
    });

  if (!execution.success) {
    return {
      closed: false,
      execution,
    };
  }

  const pnlBps =
    percentageToBps(
      (currentPrice -
        slot.entryPrice) /
        slot.entryPrice
    );

  const trade = {
    slotId: slot.id,

    entryPrice:
      slot.entryPrice,

    exitPrice:
      currentPrice,

    pnlBps,

    reason,

    openedAt:
      slot.openedAt,

    closedAt:
      Date.now(),
  };

  globalState.recentTrades.push(trade);

  if (
    globalState.recentTrades.length > 50
  ) {
    globalState.recentTrades =
      globalState.recentTrades.slice(-50);
  }

  slot.status = "READY";

  slot.entryPrice = null;

  slot.highestPrice = null;

  slot.amountUsd = 0;

  slot.quantity = 0;

  slot.targetBps = 0;

  slot.trailingActive = false;

  slot.trailingDistanceBps = 0;

  slot.openedAt = null;

  slot.closedAt = Date.now();

  slot.lastUsedAt = Date.now();

  globalState.stats.exits++;

  return {
    closed: true,
    pnlBps,
    trade,
    execution,
  };
}

// ======================================================
// MANAGE ALL OPEN SLOTS
// ======================================================

async function manageOpenSlots(price) {
  const events = [];

  const slots =
    getOpenSlots();

  /*
    كل Slot يتم تقييمه بشكل مستقل.
    ما ننتظر صفقة تخلص عشان ندير الثانية.
  */

  for (const slot of slots) {
    if (
      !slot.entryPrice ||
      slot.entryPrice <= 0
    ) {
      continue;
    }

    if (
      !slot.highestPrice ||
      price > slot.highestPrice
    ) {
      slot.highestPrice = price;
    }

    const pnlBps =
      percentageToBps(
        (price -
          slot.entryPrice) /
          slot.entryPrice
      );

    const activationBps =
      slot.targetBps *
      CONFIG.trailingActivationPct;

    // تفعيل Trailing
    if (
      !slot.trailingActive &&
      pnlBps >= activationBps
    ) {
      slot.trailingActive = true;

      events.push({
        slotId: slot.id,
        event:
          "TRAILING_ACTIVATED",
        pnlBps,
      });
    }

    // STOP LOSS
    if (
      pnlBps <=
      -CONFIG.stopLossBps
    ) {
      const close =
        await closeSlot(
          slot,
          price,
          "STOP_LOSS"
        );

      events.push({
        slotId: slot.id,
        event: "STOP_LOSS",
        ...close,
      });

      continue;
    }

    // TRAILING PROFIT
    if (slot.trailingActive) {
      const dropFromHighBps =
        percentageToBps(
          (slot.highestPrice -
            price) /
            slot.highestPrice
        );

      if (
        dropFromHighBps >=
        slot.trailingDistanceBps
      ) {
        const close =
          await closeSlot(
            slot,
            price,
            "TRAILING_PROFIT"
          );

        events.push({
          slotId: slot.id,
          event:
            "TRAILING_EXIT",
          ...close,
        });

        continue;
      }
    }

    // خروج إجباري إذا امتدت الحركة كثيرًا
    if (
      pnlBps >=
      slot.targetBps * 1.35
    ) {
      const close =
        await closeSlot(
          slot,
          price,
          "TARGET_EXIT"
        );

      events.push({
        slotId: slot.id,
        event:
          "TARGET_EXIT",
        ...close,
      });
    }
  }

  return events;
}

// ======================================================
// SEARCH FOR NEW POSITION
// ======================================================

async function searchForEntry({
  price,
  metrics,
  mode,
}) {
  const slot =
    getReadySlot();

  if (!slot) {
    return {
      skipped: true,
      reason:
        "ALL_SLOTS_BUSY",
    };
  }

  const opportunity =
    detectEntryOpportunity({
      price,
      metrics,
      mode,
    });

  if (!opportunity.enter) {
    globalState.stats.skipped++;

    return {
      skipped: true,
      reason:
        opportunity.reason,
    };
  }

  const amountUsd =
    calculateSlotAmount();

  const candidate = {
    amountUsd,

    expectedMoveBps:
      opportunity.estimatedMoveBps,

    /*
      مؤقتًا تقدير للانزلاق.
      الأفضل لاحقًا نجيبه من Quote الحقيقي.
    */
    estimatedSlippageBps: 8,

    buyFeeBps: 0,

    sellFeeBps: 0,
  };

  const risk =
    evaluateRisk({
      state:
        globalState,

      candidate,

      config: {
        maxOpenSlots:
          CONFIG.maxSlots,

        maxSlippageBps:
          CONFIG.maxSlippageBps,

        minNetEdgeBps:
          CONFIG.minNetEdgeBps,
      },
    });

  if (!risk.allowed) {
    globalState.stats.skipped++;

    if (
      risk.reason ===
      "LOSS_STREAK"
    ) {
      globalState.cooldownUntil =
        Date.now() +
        Number(
          risk.cooldownMs ||
            300000
        );
    }

    return {
      skipped: true,
      opportunity,
      risk,
    };
  }

  const opened =
    await openSlot({
      slot,
      price,
      amountUsd,

      targetBps:
        opportunity.estimatedMoveBps,
    });

  return {
    opportunity,
    risk,
    opened,
  };
}

// ======================================================
// MAIN HANDLER
// ======================================================

export default async function handler(
  req,
  res
) {
  try {
    // ---------------------------------------------
    // AUTH
    // ---------------------------------------------

    const auth =
      getAuthorization(req);

    if (!auth.ok) {
      return res
        .status(
          auth.reason ===
            "UNAUTHORIZED"
            ? 401
            : 500
        )
        .json({
          ok: false,
          error: auth.reason,
        });
    }

    globalState.stats.scanned++;

    // ---------------------------------------------
    // CAPITAL
    // ---------------------------------------------

    const configuredCapital =
      Number(
        process.env
          .SCALPER_CAPITAL_USD
      );

    if (
      configuredCapital > 0
    ) {
      globalState.totalCapitalUsd =
        configuredCapital;
    }

    if (
      globalState.totalCapitalUsd <= 0
    ) {
      return res
        .status(400)
        .json({
          ok: false,

          error:
            "SCALPER_CAPITAL_USD_NOT_SET",

          message:
            "ضع SCALPER_CAPITAL_USD في Environment Variables.",
        });
    }

    // ---------------------------------------------
    // PRICE
    // ---------------------------------------------

    const price =
      await getMarketPrice(req);

    pushPrice(price);

    // ---------------------------------------------
    // ANALYSIS
    // ---------------------------------------------

    const metrics =
      calculateMarketMetrics();

    const mode =
      getDynamicRiskMode(
        globalState.recentTrades
      );

    // ---------------------------------------------
    // MANAGE EXISTING TRADES
    // ---------------------------------------------

    const positionEvents =
      await manageOpenSlots(price);

    // ---------------------------------------------
    // SEARCH FOR NEW TRADE
    // ---------------------------------------------

    let entryEvent = null;

    if (mode === "PAUSED") {
      entryEvent = {
        skipped: true,
        reason:
          "PERFORMANCE_PAUSED",
      };
    } else if (
      globalState.cooldownUntil &&
      Date.now() <
        globalState.cooldownUntil
    ) {
      entryEvent = {
        skipped: true,
        reason: "COOLDOWN",
        cooldownUntil:
          globalState.cooldownUntil,
      };
    } else {
      /*
        مهم جدًا:
        بعد إدارة الصفقات المفتوحة
        نبحث فورًا عن فرصة جديدة.

        لو فيه Slot فاضي يدخل،
        حتى لو Slots ثانية ما زالت مفتوحة.
      */

      entryEvent =
        await searchForEntry({
          price,
          metrics,
          mode,
        });
    }

    // ---------------------------------------------
    // RESPONSE
    // ---------------------------------------------

    const openSlots =
      getOpenSlots();

    const readySlots =
      globalState.slots.filter(
        (slot) =>
          slot.status === "READY"
      );

    return res
      .status(200)
      .json({
        ok: true,

        engine:
          "FAWAZ_PARALLEL_MICRO_SCALPER_V2",

        mode,

        market: {
          symbol:
            "SOL/USDC",

          price,

          momentumBps:
            Number(
              metrics.momentumBps.toFixed(
                2
              )
            ),

          volatilityBps:
            Number(
              metrics.volatilityBps.toFixed(
                2
              )
            ),

          shortMoveBps:
            Number(
              metrics.shortMoveBps.toFixed(
                2
              )
            ),

          direction:
            metrics.direction,
        },

        capital: {
          totalUsd:
            globalState.totalCapitalUsd,

          reservePct:
            CONFIG.reservePct,

          slotAmountUsd:
            calculateSlotAmount(),
        },

        slotsSummary: {
          total:
            CONFIG.maxSlots,

          open:
            openSlots.length,

          ready:
            readySlots.length,
        },

        slots:
          globalState.slots,

        positionEvents,

        entryEvent,

        recentTrades:
          globalState.recentTrades.slice(
            -10
          ),

        stats:
          globalState.stats,

        timestamp:
          new Date().toISOString(),
      });
  } catch (error) {
    console.error(
      "TRADE_ORCHESTRATOR_ERROR",
      error
    );

    return res
      .status(500)
      .json({
        ok: false,

        engine:
          "FAWAZ_PARALLEL_MICRO_SCALPER_V2",

        error:
          error?.message ||
          "UNKNOWN_ERROR",

        timestamp:
          new Date().toISOString(),
      });
  }
}
