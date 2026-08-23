// /api/signal.js
// FAWAZ AI BOT
// Signal Agent v3
//
// مهم:
// هذا الوكيل لا ينفذ أي صفقة.
// وظيفته فقط قراءة Market Agent
// وتحويل بيانات السوق إلى BUY أو WAIT.


// ======================================================
// BASE URL
// ======================================================

function getBaseUrl(req) {
  if (process.env.APP_BASE_URL) {
    return process.env.APP_BASE_URL
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

  if (process.env.VERCEL_URL) {
    return (
      "https://" +
      process.env.VERCEL_URL
    );
  }

  const host =
    req.headers.host;

  if (host) {
    const protocol =
      host.includes("localhost")
        ? "http"
        : "https";

    return `${protocol}://${host}`;
  }

  return "https://fawaz-ai-bot.vercel.app";
}


// ======================================================
// SAFE NUMBER
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


// ======================================================
// LOAD MARKET AGENT
// ======================================================

async function loadMarket(req) {
  const baseUrl =
    getBaseUrl(req);

  const response =
    await fetch(
      `${baseUrl}/api/market-agent`,
      {
        method: "GET",

        headers: {
          Accept:
            "application/json"
        }
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
      raw: text
    };
  }

  if (!response.ok) {
    throw new Error(
      `MARKET_AGENT_HTTP_${response.status}`
    );
  }

  if (
    data?.status !== "ok" ||
    !data?.market
  ) {
    throw new Error(
      "INVALID_MARKET_AGENT_RESPONSE"
    );
  }

  return data;
}


// ======================================================
// SIGNAL LOGIC
// ======================================================

function buildSignal(
  marketData
) {
  const market =
    marketData.market || {};

  const marketSignal =
    marketData.signal || {};

  const price =
    num(market.price);

  const spreadBps =
    num(
      market.spreadBps
    );

  const volatilityBps =
    num(
      market.volatilityBps
    );

  const microRangeBps =
    num(
      market.microRangeBps
    );

  const momentum1mBps =
    num(
      market.momentum1mBps
    );

  const momentum3mBps =
    num(
      market.momentum3mBps
    );

  const imbalance =
    num(
      market.orderBookImbalance
    );

  const scalpingScore =
    num(
      market.scalpingScore
    );

  const direction =
    String(
      market.direction ||
      "FLAT"
    ).toUpperCase();

  const marketMode =
    String(
      market.mode ||
      "CALM"
    ).toUpperCase();


  // ====================================================
  // DEFAULT = WAIT
  // ====================================================

  let action =
    "WAIT";

  let reason =
    "No high-quality micro-scalping setup";

  let confidence =
    Math.round(
      scalpingScore
    );


  // ====================================================
  // BASIC PROTECTIONS
  // ====================================================

  if (price <= 0) {
    return {
      action: "WAIT",
      confidence: 0,
      reason:
        "Invalid market price"
    };
  }


  // Spread واسع جدًا
  if (spreadBps > 20) {
    return {
      action: "WAIT",

      confidence:
        Math.min(
          confidence,
          30
        ),

      reason:
        "Market spread is too wide"
    };
  }


  // السوق هادئ جدًا
  if (
    volatilityBps < 3 &&
    microRangeBps < 10
  ) {
    return {
      action: "WAIT",

      confidence:
        Math.min(
          confidence,
          35
        ),

      reason:
        "Market volatility is too low"
    };
  }


  // ====================================================
  // MOMENTUM ENTRY
  // ====================================================

  const momentumSetup =
    scalpingScore >= 45 &&
    direction === "UP" &&
    momentum1mBps >= 3 &&
    momentum3mBps >= 5 &&
    imbalance > -0.25;


  if (momentumSetup) {
    action =
      "BUY";

    reason =
      "Positive micro momentum with sufficient volatility";

    confidence =
      Math.max(
        70,
        Math.min(
          95,
          Math.round(
            scalpingScore
          )
        )
      );
  }


  // ====================================================
  // DIP / MICRO-REVERSAL ENTRY
  // ====================================================

  const dipSetup =
    scalpingScore >= 50 &&
    momentum1mBps <= -8 &&
    momentum1mBps >= -80 &&
    imbalance >= 0.05;


  if (dipSetup) {
    action =
      "BUY";

    reason =
      "Micro dip with bid-side liquidity support";

    confidence =
      Math.max(
        72,
        Math.min(
          95,
          Math.round(
            scalpingScore
          )
        )
      );
  }


  // ====================================================
  // MARKET AGENT CONFIRMATION
  // ====================================================

  if (
    action === "BUY" &&
    marketSignal.action ===
      "WAIT"
  ) {
    confidence =
      Math.max(
        65,
        confidence - 8
      );
  }


  // ====================================================
  // FINAL CONFIDENCE GUARD
  // ====================================================

  if (
    action === "BUY" &&
    confidence < 70
  ) {
    action =
      "WAIT";

    reason =
      "Setup detected but confidence is below execution threshold";
  }


  return {
    action,

    confidence,

    reason,

    price,

    spreadBps,

    volatilityBps,

    microRangeBps,

    momentum1mBps,

    momentum3mBps,

    orderBookImbalance:
      imbalance,

    scalpingScore,

    direction,

    marketMode
  };
}


// ======================================================
// HANDLER
// ======================================================

export default async function handler(
  req,
  res
) {
  if (req.method !== "GET") {
    return res
      .status(405)
      .json({
        status: "error",
        message:
          "GET only"
      });
  }

  try {
    const marketData =
      await loadMarket(req);

    const analysis =
      buildSignal(
        marketData
      );

    const signal = {
      signalId:
        crypto.randomUUID(),

      pair:
        "SOL-USDC",

      action:
        analysis.action,

      confidence:
        analysis.confidence,

      amount:
        5,

      currency:
        "USDC",

      reason:
        analysis.reason,

      currentPrice:
        analysis.price,

      spreadBps:
        analysis.spreadBps,

      volatilityBps:
        analysis.volatilityBps,

      microRangeBps:
        analysis.microRangeBps,

      momentum1mBps:
        analysis.momentum1mBps,

      momentum3mBps:
        analysis.momentum3mBps,

      orderBookImbalance:
        analysis
          .orderBookImbalance,

      scalpingScore:
        analysis.scalpingScore,

      direction:
        analysis.direction,

      marketMode:
        analysis.marketMode,

      status:
        analysis.action ===
          "BUY"
          ? "candidate"
          : "no_trade",

      createdAt:
        new Date()
          .toISOString()
    };


    return res
      .status(200)
      .json({
        status: "ok",

        engine:
          "FAWAZ_SIGNAL_AGENT_V3",

        signal,

        market:
          marketData.market
      });

  } catch (error) {
    console.error(
      "Signal Agent Error:",
      error
    );

    return res
      .status(500)
      .json({
        status: "error",

        engine:
          "FAWAZ_SIGNAL_AGENT_V3",

        message:
          error?.message ||
          "Signal Agent failed"
      });
  }
}
