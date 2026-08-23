// /api/trade-orchestrator.js
// FAWAZ AI BOT
// SAFE DRY RUN ORCHESTRATOR v1
//
// هذه النسخة لا ترسل أي صفقة إلى Jupiter.
// لا BUY حقيقي ولا SELL حقيقي.
// وظيفتها اختبار:
// Market -> Signal -> Risk -> Slots -> Neon

import {
  evaluateRisk,
  getDynamicRiskMode
} from "./risk-agent.js";

import {
  getOpenPositions,
  getFreeSlot,
  getRecentClosedTrades,
  getTradingDashboard
} from "./trading-store.js";


// ======================================================
// CONFIG
// ======================================================

const CONFIG = {
  maxSlots: 4,

  slotUsd: 5,

  calmTargetBps: 30,
  normalTargetBps: 45,
  fastTargetBps: 70,

  stopLossBps: 45,

  maxSlippageBps: 30,

  minNetEdgeBps: 12
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
// AUTH
// POST يحتاج السر
// GET آمن لأنه Dry Run فقط
// ======================================================

function authorize(req) {
  if (
    req.method === "GET"
  ) {
    return {
      ok: true
    };
  }

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

  const header =
    req.headers.authorization ||
    req.headers.Authorization ||
    "";

  if (
    header !==
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

  return data;
}


// ======================================================
// TARGET
// ======================================================

function getDynamicTarget(
  signal,
  riskMode
) {
  const marketMode =
    String(
      signal.marketMode ||
      "CALM"
    ).toUpperCase();

  let target =
    CONFIG.calmTargetBps;

  if (
    marketMode === "NORMAL"
  ) {
    target =
      CONFIG.normalTargetBps;
  }

  if (
    marketMode === "FAST"
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
    riskMode === "DEFENSIVE"
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
// PREVIEW EXISTING POSITIONS
// لا نبيع فعليًا
// ======================================================

function previewPositions(
  positions,
  currentPrice
) {
  return positions.map(
    (position) => {
      const entryPrice =
        num(
          position.entry_price
        );

      if (
        entryPrice <= 0
      ) {
        return {
          slotId:
            position.slot_id,

          action:
            "ERROR",

          reason:
            "INVALID_ENTRY_PRICE"
        };
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

      let wouldAction =
        "HOLD";

      let reason =
        "KEEP_OPEN";


      if (
        pnlBps <=
        -CONFIG.stopLossBps
      ) {
        wouldAction =
          "SELL";

        reason =
          "STOP_LOSS";
      }
      else if (
        pnlBps >=
        targetBps
      ) {
        wouldAction =
          "SELL";

        reason =
          "PROFIT_TARGET";
      }


      return {
        slotId:
          position.slot_id,

        positionId:
          position.id,

        entryPrice,

        currentPrice,

        pnlBps:
          Number(
            pnlBps.toFixed(2)
          ),

        targetBps,

        wouldAction,

        reason
      };
    }
  );
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

        engine:
          "FAWAZ_DRY_RUN_V1",

        message:
          "GET or POST only"
      });
  }


  const auth =
    authorize(req);

  if (!auth.ok) {
    return res
      .status(auth.status)
      .json({
        status: "error",

        engine:
          "FAWAZ_DRY_RUN_V1",

        message:
          auth.reason
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

    const signalData =
      await loadSignal(req);

    const signal =
      signalData.signal;


    const action =
      String(
        signal.action ||
        "WAIT"
      ).toUpperCase();


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


    // ==================================================
    // RISK MODE
    // ==================================================

    const riskMode =
      getDynamicRiskMode(
        recentTrades
      );


    // ==================================================
    // TARGET
    // ==================================================

    const targetBps =
      getDynamicTarget(
        signal,
        riskMode
      );


    // ==================================================
    // EXISTING POSITIONS PREVIEW
    // ==================================================

    const positionPreview =
      previewPositions(
        positions,
        currentPrice
      );


    // ==================================================
    // FREE SLOT
    // ==================================================

    const freeSlot =
      await getFreeSlot(
        walletAddress,
        CONFIG.maxSlots
      );


    // ==================================================
    // DEFAULT ENTRY RESULT
    // ==================================================

    let entryPreview = {
      requested:
        false,

      allowed:
        false,

      wouldExecute:
        false,

      reason:
        "NO_BUY_SIGNAL"
    };


    // ==================================================
    // BUY CANDIDATE
    // ==================================================

    if (
      action === "BUY"
    ) {

      const estimatedSlippageBps =
        Math.max(
          4,

          Math.ceil(
            num(
              signal.spreadBps
            ) / 2
          )
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

        estimatedSlippageBps,

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

            maxSlippageBps:
              CONFIG.maxSlippageBps,

            minNetEdgeBps:
              CONFIG.minNetEdgeBps
          }
        });


      entryPreview = {
        requested:
          true,

        allowed:
          risk.allowed === true,

        wouldExecute:
          risk.allowed === true &&
          freeSlot !== null,

        slotId:
          freeSlot,

        amountUsd:
          CONFIG.slotUsd,

        targetBps,

        estimatedSlippageBps,

        risk
      };


      if (
        freeSlot === null
      ) {
        entryPreview.allowed =
          false;

        entryPreview.wouldExecute =
          false;

        entryPreview.reason =
          "NO_FREE_SLOT";
      }
      else if (
        risk.allowed
      ) {
        entryPreview.reason =
          "DRY_RUN_BUY_APPROVED";
      }
      else {
        entryPreview.reason =
          risk.reason;
      }
    }


    // ==================================================
    // DASHBOARD
    // ==================================================

    const dashboard =
      await getTradingDashboard(
        walletAddress
      );


    // ==================================================
    // RESPONSE
    // ==================================================

    return res
      .status(200)
      .json({
        status: "ok",

        engine:
          "FAWAZ_DRY_RUN_V1",

        dryRun: true,

        realTrading:
          false,

        message:
          "SAFE MODE - no Jupiter transaction can be executed",

        walletAddress,

        signal: {
          action,

          confidence:
            num(
              signal.confidence
            ),

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

        slots: {
          max:
            CONFIG.maxSlots,

          open:
            positions.length,

          freeSlot
        },

        positionPreview,

        entryPreview,

        dashboard,

        timestamp:
          new Date()
            .toISOString()
      });

  } catch (error) {

    console.error(
      "Dry Run Orchestrator Error:",
      error
    );


    return res
      .status(500)
      .json({
        status: "error",

        engine:
          "FAWAZ_DRY_RUN_V1",

        dryRun: true,

        realTrading:
          false,

        message:
          error?.message ||
          "Dry run failed",

        timestamp:
          new Date()
            .toISOString()
      });
  }
}
