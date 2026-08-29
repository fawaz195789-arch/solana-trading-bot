// /api/trade-orchestrator.js
// FAWAZ AI BOT
// FULL AUTO ORCHESTRATOR V5 LIVE
//
// GET  = LIVE ANALYSIS ONLY
// POST = FULL AUTO REAL TRADING CYCLE
//
// Strategy:
// AUTO SLOTS -> 80% CAPITAL TARGET -> DYNAMIC SIZE
// MULTI ENTRY -> NET PROFIT EXIT -> COMPOUND

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

  // Capital management
  reservePct: 0.20,
  maxCapitalUsagePct: 0.80,

  // Dynamic slots
  minSlots: 4,
  maxSlotsCap: 16,
  minSlotUsd: 0.25,

  // Entry sizing relative to target slot budget
  weakSlotMultiplier: 0.80,
  normalSlotMultiplier: 0.95,
  strongSlotMultiplier: 1.05,
  veryStrongSlotMultiplier: 1.15,

  // Multi-entry spacing
  minEntrySpacingBps: 12,
  minAdditionalEntryConfidence: 48,
  dipAddBelowLowestBps: 8,

  // Expected move before BUY
  calmTargetBps: 30,
  normalTargetBps: 40,
  fastTargetBps: 55,

  // 12 bps = 0.12% estimated NET profit
  minNetExitBps: 12,

  // Emergency protection
  stopLossBps: 40,

  // Execution / edge controls
  maxSlippageBps: 30,
  minNetEdgeBps: 10,
  executionBufferBps: 6
};


const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;


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


function roundUsd(
  value
) {

  return Number(
    num(value)
      .toFixed(6)
  );
}


function toBps(
  value
) {

  return value * 10000;
}


function atomicToAmount(
  value,
  decimals
) {

  return (
    num(value) /
    Math.pow(
      10,
      decimals
    )
  );
}


function getDynamicMaxSlots(
  totalCapitalUsd
) {

  const capital =
    Math.max(
      0,
      num(totalCapitalUsd)
    );

  if (capital < 25) {
    return 4;
  }

  if (capital < 50) {
    return 6;
  }

  if (capital < 100) {
    return 8;
  }

  if (capital < 250) {
    return 10;
  }

  if (capital < 500) {
    return 12;
  }

  return CONFIG.maxSlotsCap;
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

function authorize(
  req
) {

  const secret =
    process.env
      .AUTO_TRADER_SECRET;


  if (!secret) {

    return {

      ok: false,

      status: 500,

      reason:
        "AUTO_TRADER_SECRET_MISSING"
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
        "UNAUTHORIZED"
    };
  }


  return {
    ok: true
  };
}


// ======================================================
// BASE URL
// ======================================================

function getBaseUrl(
  req
) {

  if (
    process.env.APP_BASE_URL
  ) {

    return process.env
      .APP_BASE_URL
      .replace(
        /\/$/,
        ""
      );
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
      host.includes(
        "localhost"
      )
        ? "http"
        : "https";


    return (
      `${protocol}://${host}`
    );
  }


  return (
    "https://fawaz-ai-bot.vercel.app"
  );
}


// ======================================================
// FETCH JSON
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

        cache:
          "no-store"
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
      raw:
        text
    };
  }


  if (
    !response.ok
  ) {

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

async function loadSignal(
  req
) {

  const baseUrl =
    getBaseUrl(req);


  const data =
    await fetchJson(
      `${baseUrl}/api/signal`,
      {

        method:
          "GET",

        headers: {

          Accept:
            "application/json"
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


// ======================================================
// LOAD REAL WALLET
// ======================================================

async function loadWalletSnapshot(
  req
) {

  const baseUrl =
    getBaseUrl(req);


  const data =
    await fetchJson(
      `${baseUrl}/api/execution-agent?test=wallet`,
      {

        method:
          "GET",

        headers: {

          Accept:
            "application/json"
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
      num(
        data.solBalance
      ),

    usdcBalance:
      num(
        data.usdcBalance
      ),

    source:
      data.balancesSource ||
      "ON_CHAIN"
  };
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
  slippageBps = 20
}) {

  const baseUrl =
    getBaseUrl(req);


  const secret =
    process.env
      .AUTO_TRADER_SECRET;


  if (!secret) {

    throw new Error(
      "AUTO_TRADER_SECRET_MISSING"
    );
  }


  return await fetchJson(
    `${baseUrl}/api/execution-agent`,
    {

      method:
        "POST",

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
              CONFIG
                .maxSlippageBps
            )
        })
    }
  );
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
    CONFIG
      .calmTargetBps;


  if (
    mode === "NORMAL"
  ) {

    target =
      CONFIG
        .normalTargetBps;
  }


  if (
    mode === "FAST"
  ) {

    target =
      CONFIG
        .fastTargetBps;
  }


  if (
    riskMode === "FAST"
  ) {

    target *=
      1.08;
  }


  if (
    riskMode === "DEFENSIVE"
  ) {

    target *=
      0.85;
  }


  return Math.round(
    clamp(
      target,
      24,
      80
    )
  );
}


// ======================================================
// REAL CAPITAL / AUTO SLOTS
// ======================================================

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
          (
            num(
              position
                .entry_sol
            ) *
            currentPrice
          )
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
            position
              .entry_usdc
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


// ======================================================
// DYNAMIC ENTRY SIZE
// ======================================================

function getDynamicEntrySize({
  availableUsdc,
  confidence,
  openPositions,
  maxSlots,
  targetSlotBudget
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
      num(
        maxSlots,
        1
      ) -
      num(
        openPositions,
        0
      )
    );


  const evenShareOfRemaining =
    available /
    remainingSlots;


  const baseBudget =
    Math.max(
      CONFIG.minSlotUsd,
      Math.min(
        num(
          targetSlotBudget,
          evenShareOfRemaining
        ),
        evenShareOfRemaining
      )
    );


  let multiplier =
    CONFIG
      .weakSlotMultiplier;


  if (
    confidence >= 75
  ) {

    multiplier =
      CONFIG
        .veryStrongSlotMultiplier;
  }

  else if (
    confidence >= 68
  ) {

    multiplier =
      CONFIG
        .strongSlotMultiplier;
  }

  else if (
    confidence >= 58
  ) {

    multiplier =
      CONFIG
        .normalSlotMultiplier;
  }


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


// ======================================================
// COST ESTIMATE
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


  const roundTripCostBps =
    spread +
    (
      slippage *
      2
    ) +
    CONFIG
      .executionBufferBps;


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


// ======================================================
// SELL COST
// ======================================================

function estimateSellCostBps(
  signal
) {

  const spreadBps =
    Math.max(
      0,
      num(
        signal?.spreadBps
      )
    );


  const estimatedSlippageBps =
    clamp(
      Math.ceil(
        spreadBps / 2 +
        2
      ),
      4,
      15
    );


  const estimatedSellCostBps =
    estimatedSlippageBps +
    (
      spreadBps / 2
    ) +
    CONFIG
      .executionBufferBps;


  return {

    spreadBps,

    estimatedSlippageBps,

    estimatedSellCostBps:
      Number(
        estimatedSellCostBps
          .toFixed(2)
      )
  };
}


// ======================================================
// MULTI ENTRY FILTER
// ======================================================

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
    positions.length === 0
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
            position
              .entry_price
          )
      )
      .filter(
        price =>
          price > 0
      );


  if (
    entryPrices.length === 0
  ) {

    return {

      allowed:
        true,

      reason:
        "NO_VALID_EXISTING_ENTRY_PRICE",

      entryNumber:
        positions.length + 1
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
    CONFIG
      .minEntrySpacingBps
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
        CONFIG
          .minEntrySpacingBps,

      entryNumber:
        positions.length + 1
    };
  }


  const confidence =
    num(
      signal.confidence
    );


  if (
    confidence <
    CONFIG
      .minAdditionalEntryConfidence
  ) {

    return {

      allowed:
        false,

      reason:
        "ADDITIONAL_ENTRY_CONFIDENCE_TOO_LOW",

      confidence,

      requiredConfidence:
        CONFIG
          .minAdditionalEntryConfidence,

      nearestDistanceBps:
        Number(
          nearestDistanceBps
            .toFixed(2)
        ),

      entryNumber:
        positions.length + 1
    };
  }


  const setup =
    String(
      signal.setup ||
      ""
    ).toUpperCase();


  const isDipSetup =
    setup.includes(
      "DIP"
    );


  if (
    isDipSetup
  ) {

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
      belowLowestBps <
      CONFIG
        .dipAddBelowLowestBps
    ) {

      return {

        allowed:
          false,

        reason:
          "WAIT_FOR_LOWER_DIP_ENTRY",

        lowestEntryPrice,

        currentPrice,

        belowLowestBps:
          Number(
            belowLowestBps
              .toFixed(2)
          ),

        requiredBelowBps:
          CONFIG
            .dipAddBelowLowestBps,

        nearestDistanceBps:
          Number(
            nearestDistanceBps
              .toFixed(2)
          ),

        entryNumber:
          positions.length + 1
      };
    }
  }


  return {

    allowed:
      true,

    reason:
      "MULTI_ENTRY_PRICE_APPROVED",

    nearestDistanceBps:
      Number(
        nearestDistanceBps
          .toFixed(2)
      ),

    entryNumber:
      positions.length + 1
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

  const candidates =
    [];


  const exitCosts =
    estimateSellCostBps(
      signal
    );


  for (
    const position
    of positions
  ) {

    const entryPrice =
      num(
        position
          .entry_price
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
      exitCosts
        .estimatedSellCostBps;


    const oldHigh =
      Math.max(
        entryPrice,
        num(
          position
            .highest_price,
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


    if (
      grossPnlBps <=
      -CONFIG.stopLossBps
    ) {

      reason =
        "STOP_LOSS";
    }


    else if (
      netPnlBps >=
      CONFIG.minNetExitBps
    ) {

      reason =
        "NET_PROFIT_EXIT";
    }


    if (!reason) {

      continue;
    }


    candidates.push({

      candidateId:
        crypto.randomUUID(),

      side:
        "SELL",

      slotId:
        Number(
          position
            .slot_id
        ),

      positionId:
        Number(
          position.id
        ),

      amountSol:
        num(
          position
            .entry_sol
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
        exitCosts
          .estimatedSellCostBps,

      estimatedSlippageBps:
        exitCosts
          .estimatedSlippageBps,

      netPnlBps:
        Number(
          netPnlBps
            .toFixed(2)
        ),

      minNetExitBps:
        CONFIG
          .minNetExitBps,

      reason,

      createdAt:
        new Date()
          .toISOString()
    });
  }


  return candidates;
}


// ======================================================
// BUY CANDIDATE
// ======================================================

async function buildBuyCandidate({
  walletAddress,
  positions,
  recentTrades,
  signal,
  riskMode,
  capital
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


  const freeSlot =
    await getFreeSlot(
      walletAddress,
      capital.maxSlots
    );


  if (!freeSlot) {

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

      currentPrice:
        num(
          signal.currentPrice
        ),

      openPositions:
        positions.length,

      maxSlots:
        capital.maxSlots,

      createdAt:
        new Date()
          .toISOString()
    };
  }


  const amountUsd =
    getDynamicEntrySize({

      availableUsdc:
        capital
          .availableForTrading,

      confidence:
        num(
          signal.confidence
        ),

      openPositions:
        positions.length,

      maxSlots:
        capital.maxSlots,

      targetSlotBudget:
        capital.targetSlotBudget
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

      multiEntry,

      createdAt:
        new Date()
          .toISOString()
    };
  }


  const targetBps =
    getDynamicTarget(
      signal,
      riskMode
    );


  const costs =
    estimateExecutionCosts(
      signal
    );


  const expectedNetEdgeBps =
    targetBps -
    costs
      .estimatedRoundTripCostBps;


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

      estimatedSlippageBps:
        costs
          .estimatedSlippageBps,

      estimatedRoundTripCostBps:
        costs
          .estimatedRoundTripCostBps,

      expectedNetEdgeBps:
        Number(
          expectedNetEdgeBps
            .toFixed(2)
        ),

      multiEntry,

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
            position
              .slot_id,

          status:
            "OPEN",

          amountUsd:
            num(
              position
                .entry_usdc
            )
        })
      )
  };


  const candidate = {

    amountUsd,

    expectedMoveBps:
      targetBps,

    estimatedSlippageBps:
      costs
        .estimatedSlippageBps,

    buyFeeBps:
      0,

    sellFeeBps:
      0
  };


  const risk =
    evaluateRisk({

      state,

      candidate,

      config: {

        maxOpenSlots:
          capital.maxSlots,

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

      estimatedSlippageBps:
        costs
          .estimatedSlippageBps,

      estimatedRoundTripCostBps:
        costs
          .estimatedRoundTripCostBps,

      expectedNetEdgeBps:
        Number(
          expectedNetEdgeBps
            .toFixed(2)
        ),

      multiEntry,

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
      positions.length + 1,

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

    targetBps,

    estimatedSlippageBps:
      costs
        .estimatedSlippageBps,

    estimatedRoundTripCostBps:
      costs
        .estimatedRoundTripCostBps,

    expectedNetEdgeBps:
      Number(
        expectedNetEdgeBps
          .toFixed(2)
      ),

    netEdgeBps:
      risk?.edge
        ?.netEdgeBps ??
      expectedNetEdgeBps,

    multiEntry,

    maxSlots:
      capital.maxSlots,

    targetSlotBudget:
      capital.targetSlotBudget,

    reason:
      signal.reason ||
      "LIVE_BUY_SIGNAL",

    createdAt:
      new Date()
        .toISOString()
  };
}


// ======================================================
// ANALYZE
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

      loadSignal(
        req
      ),

      loadWalletSnapshot(
        req
      )

    ]);


  if (
    walletSnapshot
      .walletAddress !==
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
      signal?.currentPrice ||
      signal?.price ||
      signalData
        ?.market
        ?.price
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
    signalData
      ?.market
      ?.mode
  ) {

    signal.marketMode =
      signalData
        .market
        .mode;
  }


  if (
    signal.scalpingScore ==
      null &&
    signalData
      ?.market
      ?.scalpingScore !=
      null
  ) {

    signal.scalpingScore =
      signalData
        .market
        .scalpingScore;
  }


  if (
    signal.spreadBps ==
      null &&
    signalData
      ?.market
      ?.spreadBps !=
      null
  ) {

    signal.spreadBps =
      signalData
        .market
        .spreadBps;
  }


  if (
    signal.volatilityBps ==
      null &&
    signalData
      ?.market
      ?.volatilityBps !=
      null
  ) {

    signal.volatilityBps =
      signalData
        .market
        .volatilityBps;
  }


  if (
    !signal.direction &&
    signalData
      ?.market
      ?.direction
  ) {

    signal.direction =
      signalData
        .market
        .direction;
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


  const capital =
    calculateCapital({

      positions,

      walletSnapshot,

      currentPrice
    });


  const buyCandidate =
    await buildBuyCandidate({

      walletAddress,

      positions,

      recentTrades,

      signal,

      riskMode,

      capital
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

    capital,

    buyCandidate,

    sellCandidates,

    dashboard
  };
}


// ======================================================
// REAL BUY
// ======================================================

async function executeApprovedBuy({
  req,
  analysis,
  requestedSlotId
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


  if (existing) {

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
        candidate
          .estimatedSlippageBps
    });


  if (
    execution?.executed !== true
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

      execution
        ?.quote
        ?.outAmount,

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
        "LIVE_AUTO_SLOTS_COMPOUND_V5",

      targetBps:
        candidate.targetBps,

      trailingDistanceBps:
        null
    });


  return {

    executed:
      true,

    side:
      "BUY",

    slotId:
      candidate.slotId,

    entryNumber:
      candidate.entryNumber,

    amountUsd,

    solReceived,

    actualEntryPrice,

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


// ======================================================
// REAL SELL
// ======================================================

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
    analysis
      .sellCandidates
      .find(
        item =>
          Number(
            item.slotId
          ) ===
          slotId
      );


  if (!candidate) {

    throw new Error(
      "NO_APPROVED_SELL_CANDIDATE"
    );
  }


  const position =
    await getOpenPositionBySlot(
      analysis.walletAddress,
      slotId
    );


  if (!position) {

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


  const execution =
    await executeTrade({

      req,

      side:
        "SELL",

      slotId,

      amountSol,

      slippageBps:
        candidate
          .estimatedSlippageBps
    });


  if (
    execution?.executed !== true
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

      execution
        ?.quote
        ?.outAmount,

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

    realizedPnl:
      num(
        closed
          ?.realized_pnl
      ),

    realizedPnlPct:
      num(
        closed
          ?.realized_pnl_pct
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


// ======================================================
// GET
// ======================================================

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
          "FAWAZ_AUTO_TRADER_V5_LIVE",

        strategy:
          "AUTO_SLOTS_80PCT_FAST_COMPOUND",

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
            analysis
              .signal
              .signalId ||
            null,

          action:
            analysis
              .signal
              .action ||
            "WAIT",

          confidence:
            num(
              analysis
                .signal
                .confidence
            ),

          reason:
            analysis
              .signal
              .reason ||
            "-",

          setup:
            analysis
              .signal
              .setup ||
            null,

          currentPrice:
            analysis.currentPrice,

          marketMode:
            analysis
              .signal
              .marketMode ||
            "-",

          scalpingScore:
            num(
              analysis
                .signal
                .scalpingScore
            ),

          spreadBps:
            num(
              analysis
                .signal
                .spreadBps
            ),

          volatilityBps:
            num(
              analysis
                .signal
                .volatilityBps
            ),

          momentum1mBps:
            num(
              analysis
                .signal
                .momentum1mBps
            ),

          momentum3mBps:
            num(
              analysis
                .signal
                .momentum3mBps
            ),

          orderBookImbalance:
            num(
              analysis
                .signal
                .orderBookImbalance
            ),

          direction:
            analysis
              .signal
              .direction ||
            "-"
        },

        riskMode:
          analysis.riskMode,

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


  } catch (error) {

    console.error(
      "LIVE ANALYSIS ERROR:",
      error
    );


    return res
      .status(500)
      .json({

        status:
          "error",

        engine:
          "FAWAZ_AUTO_TRADER_V5_LIVE",

        liveMarket:
          true,

        realTrading:
          true,

        executed:
          false,

        message:
          error?.message ||
          "Live analysis failed",

        timestamp:
          new Date()
            .toISOString()
      });
  }
}


// ======================================================
// POST
// ======================================================

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
          "FAWAZ_AUTO_TRADER_V5_LIVE",

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


    // SELL has priority to recycle capital quickly
    if (
      Array.isArray(
        analysis.sellCandidates
      ) &&
      analysis
        .sellCandidates
        .length > 0
    ) {

      const priority = {

        STOP_LOSS:
          1,

        NET_PROFIT_EXIT:
          2
      };


      analysis
        .sellCandidates
        .sort(
          (
            a,
            b
          ) => {

            return (
              (
                priority[
                  a.reason
                ] ||
                99
              ) -
              (
                priority[
                  b.reason
                ] ||
                99
              )
            );
          }
        );


      const sellCandidate =
        analysis
          .sellCandidates[0];


      result =
        await executeApprovedSell({

          req,

          analysis,

          requestedSlotId:
            sellCandidate.slotId
        });
    }


    else if (
      analysis.buyCandidate &&
      analysis
        .buyCandidate
        .approved === true
    ) {

      result =
        await executeApprovedBuy({

          req,

          analysis,

          requestedSlotId:
            analysis
              .buyCandidate
              .slotId
        });
    }


    else {

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
            "FAWAZ_AUTO_TRADER_V5_LIVE",

          strategy:
            "AUTO_SLOTS_80PCT_FAST_COMPOUND",

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
            analysis
              .buyCandidate
              ?.reason ||
            analysis
              .signal
              ?.reason ||
            "NO_APPROVED_TRADE",

          wallet:
            analysis.walletSnapshot,

          capital:
            analysis.capital,

          signal: {

            action:
              analysis
                .signal
                ?.action ||
              "WAIT",

            confidence:
              num(
                analysis
                  .signal
                  ?.confidence
              ),

            setup:
              analysis
                .signal
                ?.setup ||
              null,

            currentPrice:
              analysis.currentPrice,

            marketMode:
              analysis
                .signal
                ?.marketMode ||
              "-",

            direction:
              analysis
                .signal
                ?.direction ||
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
          result?.executed === true
            ? "ok"
            : "blocked",

        engine:
          "FAWAZ_AUTO_TRADER_V5_LIVE",

        strategy:
          "AUTO_SLOTS_80PCT_FAST_COMPOUND",

        liveMarket:
          true,

        realTrading:
          true,

        execution:
          "FULL_AUTO",

        compounding:
          true,

        executed:
          result?.executed === true,

        capital:
          analysis.capital,

        result,

        dashboard,

        timestamp:
          new Date()
            .toISOString()
      });


  } catch (error) {

    console.error(
      "AUTO TRADING ERROR:",
      error
    );


    return res
      .status(500)
      .json({

        status:
          "error",

        engine:
          "FAWAZ_AUTO_TRADER_V5_LIVE",

        strategy:
          "AUTO_SLOTS_80PCT_FAST_COMPOUND",

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
          "Auto trading failed",

        timestamp:
          new Date()
            .toISOString()
      });
  }
}


// ======================================================
// MAIN
// ======================================================

export default async function handler(
  req,
  res
) {

  if (
    req.method === "GET"
  ) {

    return handleGet(
      req,
      res
    );
  }


  if (
    req.method === "POST"
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
        "FAWAZ_AUTO_TRADER_V5_LIVE",

      message:
        "GET or POST only"
    });
}
