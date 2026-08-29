// /api/trade-orchestrator.js
// FAWAZ AI BOT
// FULL AUTO ORCHESTRATOR V3
//
// GET  = LIVE ANALYSIS ONLY
// POST = FULL AUTO REAL TRADING CYCLE
//
// Strategy:
// MICRO DIP -> BUY -> TRAILING PROFIT -> SELL
//
// Capital:
// Uses REAL on-chain USDC balance.
// Keeps 20% reserve.
// Up to 4 tracked positions.
// Profits are automatically available for future sizing.

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
  updateHighestPrice,
  activateTrailing
} from "./trading-store.js";


// ======================================================
// CONFIG
// ======================================================

const CONFIG = {

  maxSlots: 4,

  // Keep 20% of tracked NAV as reserve
  reservePct: 0.20,

  // Don't create microscopic slots
  minSlotUsd: 0.25,

  // Soft profit target / trailing activation
  calmTargetBps: 30,
  normalTargetBps: 40,
  fastTargetBps: 55,

  // Emergency loss protection
  stopLossBps: 35,

  // Minimum profit still accepted by trailing exit
  minExitProfitBps: 12,

  // Trailing distance
  calmTrailingBps: 8,
  normalTrailingBps: 10,
  fastTrailingBps: 13,

  // If price keeps running and never retraces
  hardProfitExtraBps: 25,

  maxSlippageBps: 30,

  // Expected net edge before BUY
  minNetEdgeBps: 10,

  // Safety allowance for route/network friction
  executionBufferBps: 4
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
    process.env.AUTO_TRADER_SECRET;


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
// LOAD REAL WALLET BALANCES
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
    data?.status !==
      "ok" ||
    data?.tradingKeyReady !==
      true
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
      24,
      80
    )
  );
}


// ======================================================
// TRAILING DISTANCE
// ======================================================

function getTrailingDistance(
  signal
) {

  const mode =
    String(
      signal.marketMode ||
      "CALM"
    ).toUpperCase();


  if (
    mode === "FAST"
  ) {

    return CONFIG
      .fastTrailingBps;
  }


  if (
    mode === "NORMAL"
  ) {

    return CONFIG
      .normalTrailingBps;
  }


  return CONFIG
    .calmTrailingBps;
}


// ======================================================
// REAL COMPOUND CAPITAL
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


  /*
    Only tracked bot positions are counted here.

    Random/manual SOL in the wallet is NOT
    automatically sold by the bot.
  */

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


  const reserve =
    trackedNav *
    CONFIG.reservePct;


  const targetTradableCapital =
    Math.max(
      0,
      trackedNav -
      reserve
    );


  let dynamicSlotUsd =
    targetTradableCapital /
    CONFIG.maxSlots;


  if (
    dynamicSlotUsd > 0
  ) {

    dynamicSlotUsd =
      Math.max(
        CONFIG.minSlotUsd,
        dynamicSlotUsd
      );
  }


  /*
    Reserve must remain as USDC.

    This prevents the bot from slowly
    consuming the entire wallet.
  */

  const availableForTrading =
    Math.max(
      0,
      realUsdc -
      reserve
    );


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

    slotSize:
      roundUsd(
        dynamicSlotUsd
      ),

    maxSlots:
      CONFIG.maxSlots,

    reservePct:
      CONFIG.reservePct,

    reserve:
      roundUsd(
        reserve
      ),

    availableForTrading:
      roundUsd(
        availableForTrading
      ),

    openPositions:
      positions.length,

    compounding:
      true
  };
}


// ======================================================
// ESTIMATED EXECUTION COST
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


  /*
    Conservative round-trip estimate:

    spread
    + BUY slippage
    + SELL slippage
    + small execution/network buffer
  */

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
// SELL CANDIDATES
// ======================================================

async function buildSellCandidates({
  positions,
  currentPrice
}) {

  const candidates = [];


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
      toBps(
        (
          currentPrice -
          entryPrice
        ) /
        entryPrice
      );


    const targetBps =
      Math.max(
        1,
        num(
          position.target_bps,
          CONFIG
            .normalTargetBps
        )
      );


    const trailingDistanceBps =
      Math.max(
        5,
        num(
          position
            .trailing_distance_bps,
          CONFIG
            .normalTrailingBps
        )
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


    // ------------------------------------------
    // SAVE NEW HIGH
    // ------------------------------------------

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


    let trailingActive =
      position.trailing_active ===
      true;


    // ------------------------------------------
    // ACTIVATE TRAILING
    // ------------------------------------------

    if (
      !trailingActive &&
      pnlBps >= targetBps
    ) {

      const activated =
        await activateTrailing({

          id:
            position.id,

          highestPrice
        });


      if (activated) {

        trailingActive =
          true;
      }
    }


    // ------------------------------------------
    // TRAILING STOP PRICE
    // ------------------------------------------

    const trailingStopPrice =
      highestPrice *
      (
        1 -
        (
          trailingDistanceBps /
          10000
        )
      );


    const hardProfitBps =
      targetBps +
      CONFIG
        .hardProfitExtraBps;


    let reason =
      null;


    // ------------------------------------------
    // STOP LOSS
    // ------------------------------------------

    if (
      pnlBps <=
      -CONFIG
        .stopLossBps
    ) {

      reason =
        "STOP_LOSS";
    }


    // ------------------------------------------
    // TRAILING PROFIT
    // ------------------------------------------

    else if (
      trailingActive &&
      currentPrice <=
        trailingStopPrice &&
      pnlBps >=
        CONFIG
          .minExitProfitBps
    ) {

      reason =
        "TRAILING_PROFIT";
    }


    // ------------------------------------------
    // HARD PROFIT EXIT
    //
    // Ensures very fast moves don't remain
    // open forever waiting for retracement.
    // ------------------------------------------

    else if (
      pnlBps >=
      hardProfitBps
    ) {

      reason =
        "HARD_PROFIT";
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

      pnlBps:
        Number(
          pnlBps
            .toFixed(2)
        ),

      targetBps,

      trailingActive,

      trailingDistanceBps,

      trailingStopPrice:
        Number(
          trailingStopPrice
            .toFixed(8)
        ),

      hardProfitBps,

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


  const freeSlot =
    await getFreeSlot(
      walletAddress,
      CONFIG.maxSlots
    );


  if (!freeSlot) {

    return null;
  }


  /*
    Never spend beyond REAL available USDC.
  */

  const slotUsd =
    roundUsd(
      Math.min(
        capital.slotSize,
        capital
          .availableForTrading
      )
    );


  if (
    slotUsd <
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

      amountUsd:
        slotUsd,

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


  const trailingDistanceBps =
    getTrailingDistance(
      signal
    );


  const costs =
    estimateExecutionCosts(
      signal
    );


  const expectedNetEdgeBps =
    targetBps -
    costs
      .estimatedRoundTripCostBps;


  // ------------------------------------------
  // OUR OWN NET EDGE GUARD
  // ------------------------------------------

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

      amountUsd:
        slotUsd,

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


  const candidate = {

    amountUsd:
      slotUsd,

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

      amountUsd:
        slotUsd,

      targetBps,

      trailingDistanceBps,

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

    amountUsd:
      slotUsd,

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

    trailingDistanceBps,

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

    reason:
      signal.reason ||
      "LIVE_BUY_SIGNAL",

    createdAt:
      new Date()
        .toISOString()
  };
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
      signalData.market.mode;
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

      currentPrice
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
// EXECUTE BUY
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


  /*
    Recheck slot immediately before
    spending real money.
  */

  const existing =
    await getOpenPositionBySlot(

      analysis
        .walletAddress,

      candidate
        .slotId
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


  /*
    Do not allow stale analysis to spend
    beyond current on-chain USDC snapshot.
  */

  if (
    amountUsd >
    analysis
      .walletSnapshot
      .usdcBalance
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
        analysis
          .walletAddress,

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
        "LIVE_MICRO_DIP_COMPOUND_V3",

      targetBps:
        candidate.targetBps,

      trailingDistanceBps:
        candidate
          .trailingDistanceBps
    });


  return {

    executed:
      true,

    side:
      "BUY",

    slotId:
      candidate.slotId,

    amountUsd,

    solReceived,

    actualEntryPrice,

    targetBps:
      candidate.targetBps,

    trailingDistanceBps:
      candidate
        .trailingDistanceBps,

    signature:
      execution.signature,

    compounding:
      true,

    position:
      saved
  };
}


// ======================================================
// EXECUTE SELL
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
          ) === slotId
      );


  if (!candidate) {

    throw new Error(
      "NO_APPROVED_SELL_CANDIDATE"
    );
  }


  const position =
    await getOpenPositionBySlot(

      analysis
        .walletAddress,

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
        CONFIG.maxSlippageBps
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
      : analysis
          .currentPrice;


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
// ANALYSIS ONLY
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
          "FAWAZ_AUTO_TRADER_V3",

        strategy:
          "MICRO_DIP_TRAILING_COMPOUND",

        liveMarket:
          true,

        realTrading:
          true,

        execution:
          "FULL_AUTO",

        compounding:
          true,

        walletAddress:
          analysis
            .walletAddress,

        wallet: {

          source:
            analysis
              .walletSnapshot
              .source,

          solBalance:
            analysis
              .walletSnapshot
              .solBalance,

          usdcBalance:
            analysis
              .walletSnapshot
              .usdcBalance
        },

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
            analysis
              .currentPrice,

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
          "FAWAZ_AUTO_TRADER_V3",

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
// FULL AUTO REAL TRADING
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
          "FAWAZ_AUTO_TRADER_V3",

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


    // ==================================================
    // SELL ALWAYS HAS PRIORITY
    // ==================================================

    if (
      Array.isArray(
        analysis.sellCandidates
      ) &&
      analysis
        .sellCandidates
        .length > 0
    ) {

      /*
        If several exits trigger together,
        process the most urgent one first.

        Stop loss has priority,
        then trailing,
        then hard profit.
      */

      const priority = {

        STOP_LOSS:
          1,

        TRAILING_PROFIT:
          2,

        HARD_PROFIT:
          3
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
            sellCandidate
              .slotId
        });
    }


    // ==================================================
    // OTHERWISE BUY
    // ==================================================

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


    // ==================================================
    // NOTHING TO EXECUTE
    // ==================================================

    else {

      const dashboard =
        await getTradingDashboard(
          analysis
            .walletAddress
        );


      return res
        .status(200)
        .json({

          status:
            "waiting",

          engine:
            "FAWAZ_AUTO_TRADER_V3",

          strategy:
            "MICRO_DIP_TRAILING_COMPOUND",

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
            analysis
              .walletSnapshot,

          capital:
            analysis
              .capital,

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
              analysis
                .currentPrice,

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
            analysis
              .buyCandidate,

          sellCandidates:
            analysis
              .sellCandidates,

          dashboard,

          timestamp:
            new Date()
              .toISOString()
        });
    }


    // ==================================================
    // AFTER EXECUTION
    // ==================================================

    const dashboard =
      await getTradingDashboard(
        analysis
          .walletAddress
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
          "FAWAZ_AUTO_TRADER_V3",

        strategy:
          "MICRO_DIP_TRAILING_COMPOUND",

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
          "FAWAZ_AUTO_TRADER_V3",

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
// MAIN HANDLER
// ======================================================

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
        "FAWAZ_AUTO_TRADER_V3",

      message:
        "GET or POST only"
    });
}
