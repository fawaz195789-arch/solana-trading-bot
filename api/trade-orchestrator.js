أكيد. امسح محتوى api/trade-orchestrator.js بالكامل وحط هذا من أول سطر لآخر سطر.

هذه نسخة v5 كاملة ومتوافقة مع الملفات التي راجعناها: signal.js الجديد + risk-agent.js + trading-store.js + execution-agent.js.

// /api/trade-orchestrator.js
// FAWAZ AI BOT
// Parallel Micro Scalper Orchestrator v5
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
// ======================================================
// CONFIG
// ======================================================
const CONFIG = {
  maxSlots: 4,
  defaultSlotUsd: 5,
  reservePct: 0.20,
  calmTargetBps: 30,
  normalTargetBps: 45,
  fastTargetBps: 70,
  stopLossBps: 45,
  trailingActivationRatio: 0.65,
  trailingDistanceRatio: 0.30,
  maxSlippageBps: 30,
  minNetEdgeBps: 12,
  maxEntriesPerCycle: 2
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
// SIGNAL AGENT
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
  const result =
    await fetchJson(
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
                CONFIG
                  .maxSlippageBps
              )
          })
      }
    );
  return {
    success:
      result?.executed === true,
    result
  };
}
// ======================================================
// CAPITAL
// ======================================================
function getSlotUsd() {
  const configured =
    num(
      process.env
        .SCALPER_SLOT_USD
    );
  if (
    configured > 0
  ) {
    return configured;
  }
  const capital =
    num(
      process.env
        .SCALPER_CAPITAL_USD
    );
  if (
    capital > 0
  ) {
    return (
      capital *
      (
        1 -
        CONFIG.reservePct
      )
    ) /
    CONFIG.maxSlots;
  }
  return CONFIG.defaultSlotUsd;
}
function getTotalCapitalUsd() {
  const configured =
    num(
      process.env
        .SCALPER_CAPITAL_USD
    );
  if (
    configured > 0
  ) {
    return configured;
  }
  return (
    getSlotUsd() *
    CONFIG.maxSlots
  ) /
  (
    1 -
    CONFIG.reservePct
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
// SELL ONE POSITION
// ======================================================
async function sellPosition({
  req,
  position,
  currentPrice,
  reason
}) {
  const solAmount =
    num(
      position.entry_sol
    );
  if (
    solAmount <= 0
  ) {
    return {
      success: false,
      reason:
        "INVALID_SOL_AMOUNT"
    };
  }
  const execution =
    await executeTrade({
      req,
      side: "SELL",
      slotId:
        position.slot_id,
      amountSol:
        solAmount,
      slippageBps:
        CONFIG.maxSlippageBps
    });
  if (
    !execution.success
  ) {
    return {
      success: false,
      reason:
        "SELL_EXECUTION_FAILED",
      execution:
        execution.result
    };
  }
  const receivedUsdc =
    atomicToAmount(
      execution.result
        ?.quote
        ?.outAmount,
      USDC_DECIMALS
    );
  if (
    receivedUsdc <= 0
  ) {
    return {
      success: false,
      reason:
        "INVALID_USDC_RECEIVED"
    };
  }
  const closed =
    await closePosition({
      id:
        position.id,
      exitPrice:
        currentPrice,
      exitUsdc:
        receivedUsdc,
      signature:
        execution.result
          .signature,
      reason
    });
  return {
    success: true,
    reason,
    receivedUsdc,
    pnl:
      closed.realized_pnl,
    pnlPct:
      closed.realized_pnl_pct,
    signature:
      execution.result
        .signature
  };
}
// ======================================================
// MANAGE ALL OPEN POSITIONS
// ======================================================
async function managePositions({
  req,
  positions,
  currentPrice
}) {
  const events = [];
  for (
    const position
    of positions
  ) {
    try {
      const entryPrice =
        num(
          position.entry_price
        );
      if (
        entryPrice <= 0
      ) {
        events.push({
          slotId:
            position.slot_id,
          event:
            "INVALID_ENTRY_PRICE"
        });
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
      // ==================================================
      // NEW HIGH
      // ==================================================
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
      // ==================================================
      // STOP LOSS
      // ==================================================
      if (
        pnlBps <=
        -CONFIG.stopLossBps
      ) {
        const result =
          await sellPosition({
            req,
            position,
            currentPrice,
            reason:
              "STOP_LOSS"
          });
        events.push({
          slotId:
            position.slot_id,
          event:
            result.success
              ? "STOP_LOSS_EXIT"
              : "STOP_LOSS_FAILED",
          pnlBps:
            Number(
              pnlBps.toFixed(2)
            ),
          ...result
        });
        continue;
      }
      // ==================================================
      // TRAILING ACTIVATION
      // ==================================================
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
        events.push({
          slotId:
            position.slot_id,
          event:
            "TRAILING_ACTIVATED",
          pnlBps:
            Number(
              pnlBps.toFixed(2)
            )
        });
      }
      // ==================================================
      // TRAILING EXIT
      // ==================================================
      if (
        trailingActive
      ) {
        const distance =
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
          distance
        ) {
          const result =
            await sellPosition({
              req,
              position,
              currentPrice,
              reason:
                "TRAILING_PROFIT"
            });
          events.push({
            slotId:
              position.slot_id,
            event:
              result.success
                ? "TRAILING_EXIT"
                : "TRAILING_EXIT_FAILED",
            pnlBps:
              Number(
                pnlBps.toFixed(2)
              ),
            ...result
          });
          continue;
        }
      }
      // ==================================================
      // HARD PROFIT EXIT
      // ==================================================
      if (
        pnlBps >=
        targetBps * 1.40
      ) {
        const result =
          await sellPosition({
            req,
            position,
            currentPrice,
            reason:
              "TARGET_PROFIT"
          });
        events.push({
          slotId:
            position.slot_id,
          event:
            result.success
              ? "TARGET_EXIT"
              : "TARGET_EXIT_FAILED",
          pnlBps:
            Number(
              pnlBps.toFixed(2)
            ),
          ...result
        });
        continue;
      }
      // ==================================================
      // KEEP OPEN
      // ==================================================
      events.push({
        slotId:
          position.slot_id,
        event:
          "KEEP_OPEN",
        pnlBps:
          Number(
            pnlBps.toFixed(2)
          ),
        entryPrice,
        currentPrice,
        highestPrice
      });
    } catch (error) {
      events.push({
        slotId:
          position.slot_id,
        event:
          "POSITION_ERROR",
        error:
          error?.message ||
          "Unknown position error"
      });
    }
  }
  return events;
}
// ======================================================
// OPEN ONE SLOT
// ======================================================
async function openNewSlot({
  req,
  walletAddress,
  slotId,
  signal,
  positions,
  recentTrades,
  targetBps
}) {
  const slotUsd =
    getSlotUsd();
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
      getTotalCapitalUsd(),
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
      slotUsd,
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
  if (
    !risk.allowed
  ) {
    return {
      opened: false,
      slotId,
      reason:
        risk.reason,
      risk
    };
  }
  // ====================================================
  // REAL BUY
  // ====================================================
  const execution =
    await executeTrade({
      req,
      side: "BUY",
      slotId,
      amountUsd:
        slotUsd,
      slippageBps:
        Math.min(
          CONFIG.maxSlippageBps,
          Math.max(
            8,
            estimatedSlippageBps
          )
        )
    });
  if (
    !execution.success
  ) {
    return {
      opened: false,
      slotId,
      reason:
        "BUY_EXECUTION_FAILED",
      execution:
        execution.result
    };
  }
  // ====================================================
  // ACTUAL SOL RECEIVED
  // ====================================================
  const solReceived =
    atomicToAmount(
      execution.result
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
    slotUsd /
    solReceived;
  const trailingDistanceBps =
    Math.max(
      8,
      Math.round(
        targetBps *
        CONFIG
          .trailingDistanceRatio
      )
    );
  // ====================================================
  // SAVE POSITION TO NEON
  // ====================================================
  const saved =
    await openPosition({
      walletAddress,
      slotId,
      entryPrice:
        actualEntryPrice,
      entrySol:
        solReceived,
      entryUsdc:
        slotUsd,
      signature:
        execution.result
          .signature,
      strategy:
        "PARALLEL_MICRO_SCALP",
      targetBps,
      trailingDistanceBps
    });
  return {
    opened: true,
    slotId,
    positionId:
      saved.id,
    entryUsdc:
      slotUsd,
    entrySol:
      solReceived,
    entryPrice:
      actualEntryPrice,
    targetBps,
    signature:
      execution.result
        .signature
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
  // POST ONLY
  // ====================================================
  if (
    req.method !== "POST"
  ) {
    return res
      .status(405)
      .json({
        status: "error",
        engine:
          "FAWAZ_PARALLEL_SCALPER_V5",
        message:
          "POST only"
      });
  }
  // ====================================================
  // AUTH
  // ====================================================
  const auth =
    authorize(req);
  if (
    !auth.ok
  ) {
    return res
      .status(auth.status)
      .json({
        status: "error",
        engine:
          "FAWAZ_PARALLEL_SCALPER_V5",
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
    // =================================================
