// /api/trade-orchestrator.js
// FAWAZ AI BOT
// LIVE CANDIDATE ORCHESTRATOR v1
//
// GET  = تحليل فقط - لا ينفذ أموال
// POST = تنفيذ BUY/SELL حقيقي بعد موافقة مصرح بها
//
// Capital = 5 USDC
// 4 Slots x 1 USDC
// 1 USDC reserve

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
  getTradingDashboard
} from "./trading-store.js";


// ======================================================
// CONFIG
// ======================================================

const CONFIG = {
  totalCapitalUsd: 5,
  maxSlots: 4,
  slotUsd: 1,
  reserveUsd: 1,

  calmTargetBps: 30,
  normalTargetBps: 45,
  fastTargetBps: 70,

  stopLossBps: 45,

  maxSlippageBps: 30,
  minNetEdgeBps: 12
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


function toBps(value) {
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
      "BOT wallet address is missing"
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
      host.includes(
        "localhost"
      )
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
// LOAD SIGNAL
// IMPORTANT:
// نرجع الرد كامل حتى نقرأ signal + market
// ======================================================

async function loadSignal(req) {
  const baseUrl =
    getBaseUrl(req);

  const data =
    await fetchJson(
      `${baseUrl}/api/signal`,
      {
        method: "GET",

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

  // مهم:
  // لا نرجع data.signal فقط
  return data;
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
    process.env.AUTO_TRADER_SECRET;

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


// ======================================================
// TARGET
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
// CAPITAL
// ======================================================

function calculateCapital(
  positions
) {
  const used =
    positions.reduce(
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

  const free =
    Math.max(
      0,
      CONFIG.totalCapitalUsd -
      used
    );

  return {
    total:
      CONFIG.totalCapitalUsd,

    slotSize:
      CONFIG.slotUsd,

    reserve:
      CONFIG.reserveUsd,

    used,

    free,

    availableForTrading:
      Math.max(
        0,
        free -
        CONFIG.reserveUsd
      )
  };
}


// ======================================================
// SELL CANDIDATES
// ======================================================

function buildSellCandidates({
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
      num(
        position.target_bps,
        CONFIG.normalTargetBps
      );

    let reason = null;

    if (
      pnlBps <=
      -CONFIG.stopLossBps
    ) {
      reason =
        "STOP_LOSS";
    }

    if (
      pnlBps >=
      targetBps
    ) {
      reason =
        "PROFIT_TARGET";
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

      pnlBps:
        Number(
          pnlBps.toFixed(2)
        ),

      targetBps,

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
  riskMode
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

  const capital =
    calculateCapital(
      positions
    );

  if (
    capital
      .availableForTrading <
    CONFIG.slotUsd
  ) {
    return null;
  }

  const targetBps =
    getDynamicTarget(
      signal,
      riskMode
    );

  const estimatedSlippageBps =
    Math.max(
      4,

      Math.ceil(
        num(
          signal.spreadBps
        ) / 2
      )
    );

  const state = {
    totalCapitalUsd:
      CONFIG.totalCapitalUsd,

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

    estimatedSlippageBps,

    buyFeeBps: 0,
    sellFeeBps: 0
  };

  const risk =
    evaluateRisk({
      state,

      candidate,

      config: {
        maxOpenSlots:
          CONFIG.maxSlots,

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

      amountUsd:
        CONFIG.slotUsd,

      targetBps,

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
      CONFIG.slotUsd,

    currentPrice:
      num(
        signal.currentPrice
      ),

    confidence:
      num(
        signal.confidence
      ),

    targetBps,

    estimatedSlippageBps,

    netEdgeBps:
      risk?.edge
        ?.netEdgeBps ??
      null,

    reason:
      signal.reason,

    createdAt:
      new Date()
        .toISOString()
  };
}


// ======================================================
// ANALYZE SYSTEM
// FIXED CURRENT PRICE
// ======================================================

async function analyzeSystem(req) {
  const walletAddress =
    getWalletAddress();

  // الآن هذا هو الرد الكامل من /api/signal
  const signalData =
    await loadSignal(req);

  const signal =
    signalData?.signal ||
    {};

  // الإصلاح:
  // ندعم السعر داخل signal أو market
  const currentPrice =
    num(
      signal?.currentPrice ||
      signal?.price ||
      signalData?.market?.price
    );

  if (
    currentPrice <= 0
  ) {
    throw new Error(
      "INVALID_CURRENT_PRICE"
    );
  }

  // نخلي السعر متوفر دائمًا داخل signal
  signal.currentPrice =
    currentPrice;

  const [
    positions,
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

  const capital =
    calculateCapital(
      positions
    );

  const buyCandidate =
    await buildBuyCandidate({
      walletAddress,
      positions,
      recentTrades,
      signal,
      riskMode
    });

  const sellCandidates =
    buildSellCandidates({
      positions,
      currentPrice
    });

  const dashboard =
    await getTradingDashboard(
      walletAddress
    );

  return {
    walletAddress,
    signalData,
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

  const execution =
    await executeTrade({
      req,

      side:
        "BUY",

      slotId:
        candidate.slotId,

      amountUsd:
        CONFIG.slotUsd,

      slippageBps:
        candidate
          .estimatedSlippageBps
    });

  if (
    execution?.executed !==
    true
  ) {
    return {
      executed: false,

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
    CONFIG.slotUsd /
    solReceived;

  const targetBps =
    candidate.targetBps;

  const trailingDistanceBps =
    Math.max(
      8,

      Math.round(
        targetBps *
        0.30
      )
    );

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
        CONFIG.slotUsd,

      signature:
        execution.signature,

      strategy:
        "LIVE_MICRO_SCALP",

      targetBps,

      trailingDistanceBps
    });

  return {
    executed: true,

    side:
      "BUY",

    slotId:
      candidate.slotId,

    amountUsd:
      CONFIG.slotUsd,

    solReceived,

    actualEntryPrice,

    signature:
      execution.signature,

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
        (item) =>
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
        CONFIG.maxSlippageBps
    });

  if (
    execution?.executed !==
    true
  ) {
    return {
      executed: false,

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

  const closed =
    await closePosition({
      id:
        position.id,

      exitPrice:
        analysis.currentPrice,

      exitUsdc:
        usdcReceived,

      signature:
        execution.signature,

      reason:
        candidate.reason
    });

  return {
    executed: true,

    side:
      "SELL",

    slotId,

    amountSol,

    usdcReceived,

    reason:
      candidate.reason,

    signature:
      execution.signature,

    pnl:
      closed.realized_pnl,

    pnlPct:
      closed.realized_pnl_pct,

    position:
      closed
  };
}


// ======================================================
// MAIN HANDLER
// ======================================================

export default async function handler(
  req,
  res
) {

  // ====================================================
  // GET = ANALYSIS ONLY
  // لا ينفذ أي صفقة
  // ====================================================

  if (req.method === "GET") {
    try {

      const analysis =
        await analyzeSystem(req);

      return res
        .status(200)
        .json({
          status: "ok",

          engine:
            "FAWAZ_LIVE_CANDIDATE_V1",

          liveMarket: true,

          realTrading: true,

          execution:
            "APPROVAL_REQUIRED",

          walletAddress:
            analysis.walletAddress,

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

            direction:
              analysis.signal.direction ||
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
            new Date().toISOString()
        });

    } catch (error) {

      console.error(
        "Live Analysis Error:",
        error
      );

      return res
        .status(500)
        .json({
          status: "error",

          engine:
            "FAWAZ_LIVE_CANDIDATE_V1",

          message:
            error?.message ||
            "Live analysis failed",

          timestamp:
            new Date().toISOString()
        });
    }
  }


  // ====================================================
  // POST = REAL EXECUTION AFTER APPROVAL
  // ====================================================

  if (req.method === "POST") {

    const auth =
      authorize(req);

    if (!auth.ok) {
      return res
        .status(auth.status)
        .json({
          status: "error",

          executed: false,

          engine:
            "FAWAZ_LIVE_CANDIDATE_V1",

          message:
            auth.reason
        });
    }


    try {

      const {
        side,
        slotId
      } =
        req.body || {};


      const requestedSide =
        String(
          side || ""
        ).toUpperCase();


      const numericSlotId =
        Number(slotId);


      if (
        requestedSide !== "BUY" &&
        requestedSide !== "SELL"
      ) {
        return res
          .status(400)
          .json({
            status: "error",

            executed: false,

            message:
              "side must be BUY or SELL"
          });
      }


      if (
        !Number.isInteger(
          numericSlotId
        ) ||
        numericSlotId < 1 ||
        numericSlotId >
          CONFIG.maxSlots
      ) {
        return res
          .status(400)
          .json({
            status: "error",

            executed: false,

            message:
              "Invalid slotId"
          });
      }


      // نعيد التحليل قبل التنفيذ
      const analysis =
        await analyzeSystem(req);


      let result;


      if (
        requestedSide === "BUY"
      ) {
        result =
          await executeApprovedBuy({
            req,

            analysis,

            requestedSlotId:
              numericSlotId
          });
      }


      if (
        requestedSide === "SELL"
      ) {
        result =
          await executeApprovedSell({
            req,

            analysis,

            requestedSlotId:
              numericSlotId
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
            "FAWAZ_LIVE_CANDIDATE_V1",

          realTrading: true,

          executed:
            result?.executed === true,

          result,

          dashboard,

          timestamp:
            new Date().toISOString()
        });

    } catch (error) {

      console.error(
        "Live Execution Error:",
        error
      );

      return res
        .status(500)
        .json({
          status: "error",

          engine:
            "FAWAZ_LIVE_CANDIDATE_V1",

          realTrading: true,

          executed: false,

          message:
            error?.message ||
            "Live execution failed",

          timestamp:
            new Date().toISOString()
        });
    }
  }


    return res
    .status(405)
    .json({
      status: "error",

      engine:
        "FAWAZ_LIVE_CANDIDATE_V1",

      message:
        "GET or POST only"
    });
}
