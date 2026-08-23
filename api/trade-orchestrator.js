// /api/trade-orchestrator.js
// FAWAZ AI BOT
// Stable Orchestrator - Recovery Version

import {
  getOpenPosition,
  openPosition,
  closePosition,
  getTradingDashboard
} from "./trading-store.js";


// ======================================================
// CONFIG
// ======================================================

const BUY_AMOUNT_USDC = 5;

// مؤقتًا نرجع لاستراتيجية مستقرة
// وبعد ما يشتغل البوت نطورها بدون كسر النظام
const TAKE_PROFIT_PCT = 0.80;
const STOP_LOSS_PCT = -0.60;

const USDC_DECIMALS = 6;
const SOL_DECIMALS = 9;


// ======================================================
// HELPERS
// ======================================================

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n)
    ? n
    : fallback;
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

function checkAuthorization(req) {
  const secret =
    process.env.AUTO_TRADER_SECRET;

  // إذا السر غير موجود، نوقف
  if (!secret) {
    return {
      ok: false,
      status: 500,
      reason:
        "AUTO_TRADER_SECRET_MISSING"
    };
  }

  const authorization =
    req.headers.authorization ||
    req.headers.Authorization ||
    "";

  if (
    authorization !==
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

  if (!host) {
    return (
      "https://fawaz-ai-bot.vercel.app"
    );
  }

  return `https://${host}`;
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

  let data = null;

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
      `HTTP_${response.status}: ${JSON.stringify(
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

  // يدعم الشكل القديم:
  // { status:"ok", signal:{...} }

  if (data?.signal) {
    return data.signal;
  }

  // احتياط إذا API يرجع البيانات مباشرة
  return data;
}


// ======================================================
// EXECUTE TRADE
// ======================================================

async function executeTrade({
  req,
  decision,
  confidence,
  amount,
  walletAddress
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
          decision,

          confidence,

          riskApproved: true,

          amount,

          walletAddress
        })
    }
  );
}


// ======================================================
// MAIN HANDLER
// ======================================================

export default async function handler(
  req,
  res
) {
  if (
    req.method !== "POST" &&
    req.method !== "GET"
  ) {
    return res
      .status(405)
      .json({
        status: "error",
        message:
          "GET or POST only"
      });
  }

  try {

    // ================================================
    // AUTH
    // ================================================

    // GET يسمح للواجهة بالقراءة
    // POST يحتاج السر

    if (req.method === "POST") {
      const auth =
        checkAuthorization(req);

      if (!auth.ok) {
        return res
          .status(auth.status)
          .json({
            status: "error",
            message:
              auth.reason
          });
      }
    }


    // ================================================
    // WALLET
    // ================================================

    const walletAddress =
      getWalletAddress();


    // ================================================
    // SIGNAL
    // ================================================

    const signal =
      await loadSignal(req);

    const action =
      String(
        signal?.action ||
        signal?.decision ||
        "WAIT"
      ).toUpperCase();

    const confidence =
      num(
        signal?.confidence,
        50
      );

    const currentPrice =
      num(
        signal?.currentPrice ||
        signal?.price
      );


    // ================================================
    // CURRENT POSITION
    // ================================================

    const position =
      await getOpenPosition(
        walletAddress
      );


    // ================================================
    // MANAGE EXISTING POSITION
    // ================================================

    if (position) {

      const entryPrice =
        num(
          position.entry_price
        );

      const entrySol =
        num(
          position.entry_sol
        );

      const pnlPct =
        entryPrice > 0
          ? (
              (
                currentPrice -
                entryPrice
              ) /
              entryPrice
            ) * 100
          : 0;


      // ==============================================
      // TAKE PROFIT
      // ==============================================

      if (
        pnlPct >=
        TAKE_PROFIT_PCT
      ) {
        const execution =
          await executeTrade({
            req,

            decision:
              "SELL",

            confidence:
              Math.max(
                confidence,
                80
              ),

            amount:
              entrySol,

            walletAddress
          });


        if (
          execution?.executed ===
          true
        ) {
          const receivedUsdc =
            atomicToAmount(
              execution
                ?.quote
                ?.outAmount,

              USDC_DECIMALS
            );

          const closed =
            await closePosition({
              id:
                position.id,

              exitPrice:
                currentPrice,

              exitUsdc:
                receivedUsdc,

              signature:
                execution.signature
            });


          return res
            .status(200)
            .json({
              status: "ok",

              engine:
                "FAWAZ_STABLE_RECOVERY",

              action:
                "SELL",

              reason:
                "TAKE_PROFIT",

              pnlPct,

              execution,

              closedPosition:
                closed
            });
        }
      }


      // ==============================================
      // STOP LOSS
      // ==============================================

      if (
        pnlPct <=
        STOP_LOSS_PCT
      ) {
        const execution =
          await executeTrade({
            req,

            decision:
              "SELL",

            confidence:
              90,

            amount:
              entrySol,

            walletAddress
          });


        if (
          execution?.executed ===
          true
        ) {
          const receivedUsdc =
            atomicToAmount(
              execution
                ?.quote
                ?.outAmount,

              USDC_DECIMALS
            );

          const closed =
            await closePosition({
              id:
                position.id,

              exitPrice:
                currentPrice,

              exitUsdc:
                receivedUsdc,

              signature:
                execution.signature
            });


          return res
            .status(200)
            .json({
              status: "ok",

              engine:
                "FAWAZ_STABLE_RECOVERY",

              action:
                "SELL",

              reason:
                "STOP_LOSS",

              pnlPct,

              execution,

              closedPosition:
                closed
            });
        }
      }


      // ==============================================
      // KEEP OPEN
      // ==============================================

      const dashboard =
        await getTradingDashboard(
          walletAddress
        );


      return res
        .status(200)
        .json({
          status: "ok",

          engine:
            "FAWAZ_STABLE_RECOVERY",

          action:
            "HOLD",

          reason:
            "KEEP_POSITION_OPEN",

          walletAddress,

          signal,

          market: {
            currentPrice
          },

          position: {
            ...position,

            pnlPct:
              Number(
                pnlPct.toFixed(4)
              )
          },

          dashboard
        });
    }


    // ================================================
    // NO POSITION
    // ================================================

    if (
      action !== "BUY"
    ) {
      const dashboard =
        await getTradingDashboard(
          walletAddress
        );


      return res
        .status(200)
        .json({
          status: "ok",

          engine:
            "FAWAZ_STABLE_RECOVERY",

          action:
            "HOLD",

          reason:
            "WAIT_FOR_BUY_SIGNAL",

          signal,

          walletAddress,

          dashboard
        });
    }


    // ================================================
    // CONFIDENCE FILTER
    // ================================================

    if (
      confidence < 70
    ) {
      return res
        .status(200)
        .json({
          status: "ok",

          engine:
            "FAWAZ_STABLE_RECOVERY",

          action:
            "HOLD",

          reason:
            "LOW_CONFIDENCE",

          confidence
        });
    }


    // ================================================
    // BUY
    // ================================================

    const execution =
      await executeTrade({
        req,

        decision:
          "BUY",

        confidence,

        amount:
          BUY_AMOUNT_USDC,

        walletAddress
      });


    if (
      execution?.executed !==
      true
    ) {
      return res
        .status(200)
        .json({
          status: "blocked",

          engine:
            "FAWAZ_STABLE_RECOVERY",

          reason:
            "BUY_NOT_EXECUTED",

          execution
        });
    }


    // Jupiter outAmount = SOL received

    const receivedSol =
      atomicToAmount(
        execution
          ?.quote
          ?.outAmount,

        SOL_DECIMALS
      );


    if (
      receivedSol <= 0
    ) {
      throw new Error(
        "Invalid SOL amount received from execution agent"
      );
    }


    // ================================================
    // SAVE POSITION
    // ================================================

    const opened =
      await openPosition({
        walletAddress,

        entryPrice:
          currentPrice,

        entrySol:
          receivedSol,

        entryUsdc:
          BUY_AMOUNT_USDC,

        signature:
          execution.signature
      });


    const dashboard =
      await getTradingDashboard(
        walletAddress
      );


    return res
      .status(200)
      .json({
        status: "ok",

        engine:
          "FAWAZ_STABLE_RECOVERY",

        action:
          "BUY",

        reason:
          "BUY_SIGNAL_APPROVED",

        confidence,

        currentPrice,

        execution,

        openedPosition:
          opened,

        dashboard
      });

  } catch (error) {

    console.error(
      "Trade Orchestrator Error:",
      error
    );


    return res
      .status(500)
      .json({
        status: "error",

        engine:
          "FAWAZ_STABLE_RECOVERY",

        message:
          error?.message ||
          "Trade orchestrator failed",

        timestamp:
          new Date()
            .toISOString()
      });
  }
}
