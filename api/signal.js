// /api/signal.js
// FAWAZ AI BOT
// Signal Agent v4
//
// الهدف:
// التقاط micro-swings بشكل أسرع
// مع توحيد قرار Market + Signal
//
// هذا الملف لا ينفذ أي صفقة مالية.


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


// ======================================================
// LOAD MARKET
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
        },

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
// BUILD SIGNAL
// ======================================================

function buildSignal(
  marketData
) {
  const market =
    marketData.market || {};

  const marketSignal =
    marketData.signal || {};


  const price =
    num(
      market.price
    );


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


  const marketScalpingScore =
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
  // INVALID MARKET
  // ====================================================

  if (price <= 0) {
    return {
      action: "WAIT",

      confidence: 0,

      reason:
        "Invalid market price",

      finalScore: 0,

      price,

      spreadBps,

      volatilityBps,

      microRangeBps,

      momentum1mBps,

      momentum3mBps,

      orderBookImbalance:
        imbalance,

      scalpingScore:
        0,

      direction,

      marketMode
    };
  }


  // ====================================================
  // HARD SPREAD FILTER
  // ====================================================

  if (spreadBps > 18) {
    return {
      action: "WAIT",

      confidence: 20,

      reason:
        "Spread too wide for micro-scalping",

      finalScore: 20,

      price,

      spreadBps,

      volatilityBps,

      microRangeBps,

      momentum1mBps,

      momentum3mBps,

      orderBookImbalance:
        imbalance,

      scalpingScore:
        marketScalpingScore,

      direction,

      marketMode
    };
  }


  // ====================================================
  // SCORES
  // ====================================================

  let momentumScore = 0;

  let dipScore = 0;

  let liquidityScore = 0;

  let volatilityScore = 0;

  let spreadScore = 0;

  let trendScore = 0;


  // ====================================================
  // SPREAD SCORE
  //
  // tight spread = أفضل
  // ====================================================

  if (spreadBps <= 3) {
    spreadScore = 20;
  }
  else if (spreadBps <= 6) {
    spreadScore = 16;
  }
  else if (spreadBps <= 10) {
    spreadScore = 10;
  }
  else if (spreadBps <= 14) {
    spreadScore = 5;
  }


  // ====================================================
  // VOLATILITY SCORE
  //
  // نريد حركة كافية
  // لكن ليست فوضوية جدًا
  // ====================================================

  if (
    volatilityBps >= 4 &&
    volatilityBps <= 15
  ) {
    volatilityScore = 20;
  }
  else if (
    volatilityBps >= 2 &&
    volatilityBps < 4
  ) {
    volatilityScore = 12;
  }
  else if (
    volatilityBps > 15 &&
    volatilityBps <= 30
  ) {
    volatilityScore = 13;
  }
  else if (
    volatilityBps > 30
  ) {
    volatilityScore = 5;
  }


  // ====================================================
  // MOMENTUM SCORE
  //
  // ارتداد قصير أو تسارع للأعلى
  // ====================================================

  if (
    momentum1mBps >= 2 &&
    momentum3mBps >= 3
  ) {
    momentumScore += 16;
  }

  if (
    momentum1mBps >= 4 &&
    momentum3mBps >= 6
  ) {
    momentumScore += 8;
  }

  if (
    momentum1mBps >= 7
  ) {
    momentumScore += 5;
  }


  momentumScore =
    clamp(
      momentumScore,
      0,
      25
    );


  // ====================================================
  // DIP SCORE
  //
  // نزول قصير قابل للارتداد
  // وليس انهيار قوي
  // ====================================================

  const mildDip =
    momentum1mBps <= -2 &&
    momentum1mBps >= -18;


  const deeperDip =
    momentum1mBps < -6 &&
    momentum1mBps >= -30;


  if (mildDip) {
    dipScore += 10;
  }


  if (
    deeperDip &&
    momentum3mBps > -35
  ) {
    dipScore += 8;
  }


  // لو بدأ الارتداد بعد نزلة
  if (
    momentum1mBps > -4 &&
    momentum3mBps < 0
  ) {
    dipScore += 6;
  }


  dipScore =
    clamp(
      dipScore,
      0,
      24
    );


  // ====================================================
  // ORDER BOOK / LIQUIDITY
  // ====================================================

  if (imbalance >= 0.20) {
    liquidityScore = 18;
  }
  else if (imbalance >= 0.08) {
    liquidityScore = 14;
  }
  else if (imbalance >= 0) {
    liquidityScore = 8;
  }
  else if (imbalance >= -0.15) {
    liquidityScore = 4;
  }
  else {
    liquidityScore = 0;
  }


  // ====================================================
  // TREND SCORE
  // ====================================================

  if (direction === "UP") {
    trendScore = 12;
  }
  else if (
    direction === "FLAT"
  ) {
    trendScore = 7;
  }
  else if (
    direction === "DOWN" &&
    dipScore >= 14
  ) {
    // نزول لكن قابل للارتداد
    trendScore = 4;
  }


  // ====================================================
  // MARKET AGENT BASE SCORE
  // ====================================================

  const marketScoreComponent =
    clamp(
      marketScalpingScore *
      0.15,
      0,
      15
    );


  // ====================================================
  // FINAL SCORE
  // ====================================================

  let finalScore =
    spreadScore +
    volatilityScore +
    liquidityScore +
    trendScore +
    marketScoreComponent;


  // نختار أقوى setup:
  // momentum أو dip
  finalScore +=
    Math.max(
      momentumScore,
      dipScore
    );


  // ====================================================
  // PENALTIES
  // ====================================================

  if (
    microRangeBps < 6
  ) {
    finalScore -= 10;
  }


  if (
    volatilityBps < 2
  ) {
    finalScore -= 12;
  }


  if (
    imbalance < -0.30
  ) {
    finalScore -= 15;
  }


  if (
    spreadBps > 12
  ) {
    finalScore -= 10;
  }


  if (
    momentum1mBps < -35
  ) {
    finalScore -= 20;
  }


  finalScore =
    Math.round(
      clamp(
        finalScore,
        0,
        100
      )
    );


  // ====================================================
  // DECISION
  // ====================================================

  let action =
    "WAIT";


  let reason =
    "No high-quality micro-swing setup";


  /*
    أسرع من v3:
    سابقًا BUY غالبًا يحتاج 70+
    الآن:
    58+ = candidate
  */

  if (
    finalScore >= 58
  ) {
    action =
      "BUY";


    if (
      dipScore >
      momentumScore
    ) {
      reason =
        "Micro-dip reversal with liquidity support";
    }
    else {
      reason =
        "Positive micro-momentum with favorable spread and volatility";
    }
  }


  // ====================================================
  // EXTRA QUALITY GUARD
  // ====================================================

  if (
    action === "BUY" &&
    spreadBps > 14
  ) {
    action =
      "WAIT";

    reason =
      "Setup detected but spread is too expensive";
  }


  if (
    action === "BUY" &&
    volatilityBps < 2
  ) {
    action =
      "WAIT";

    reason =
      "Setup detected but volatility is insufficient";
  }


  // ====================================================
  // MARKET AGENT ALIGNMENT
  // ====================================================

  const marketAction =
    String(
      marketSignal.action ||
      "WAIT"
    ).toUpperCase();


  let confidence =
    finalScore;


  /*
    Market Agent لا يلغي Signal Agent،
    فقط يرفع أو يخفض الثقة.
  */

  if (
    action === "BUY" &&
    marketAction === "BUY"
  ) {
    confidence += 8;
  }


  if (
    action === "BUY" &&
    marketAction === "WAIT"
  ) {
    confidence -= 5;
  }


  confidence =
    Math.round(
      clamp(
        confidence,
        0,
        95
      )
    );


  // ====================================================
  // FINAL CONFIDENCE FLOOR
  // ====================================================

  if (
    action === "BUY" &&
    confidence < 55
  ) {
    action =
      "WAIT";

    reason =
      "Setup detected but combined confidence is insufficient";
  }


  return {
    action,

    confidence,

    reason,

    finalScore,

    price,

    spreadBps,

    volatilityBps,

    microRangeBps,

    momentum1mBps,

    momentum3mBps,

    orderBookImbalance:
      imbalance,

    scalpingScore:
      finalScore,

    marketScalpingScore,

    momentumScore,

    dipScore,

    liquidityScore,

    volatilityScore,

    spreadScore,

    trendScore,

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

      marketScalpingScore:
        analysis
          .marketScalpingScore,

      finalScore:
        analysis.finalScore,

      scoreBreakdown: {
        momentum:
          analysis.momentumScore,

        dip:
          analysis.dipScore,

        liquidity:
          analysis.liquidityScore,

        volatility:
          analysis.volatilityScore,

        spread:
          analysis.spreadScore,

        trend:
          analysis.trendScore
      },

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
          "FAWAZ_SIGNAL_AGENT_V4",

        signal,

        market:
          marketData.market
      });

  }
  catch (error) {
    console.error(
      "Signal Agent Error:",
      error
    );


    return res
      .status(500)
      .json({
        status: "error",

        engine:
          "FAWAZ_SIGNAL_AGENT_V4",

        message:
          error?.message ||
          "Signal Agent failed"
      });
  }
}
