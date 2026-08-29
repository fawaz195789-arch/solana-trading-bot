// /api/signal.js
// FAWAZ AI BOT
// Signal Agent v5
//
// AGGRESSIVE MICRO DIP / REBOUND ENGINE
//
// الهدف:
// - التقاط النزلات القصيرة بسرعة
// - الدخول عند بداية الارتداد
// - الاستفادة من دفتر الأوامر
// - تجنب السبريد المكلف
// - إعطاء فرص أكثر من V4
//
// IMPORTANT:
// هذا الملف يحلل فقط.
// لا يوقع ولا يرسل أي صفقة مالية.

import {
  randomUUID
} from "crypto";


// ======================================================
// STRATEGY
// ======================================================

const CONFIG = {

  // أقصى Spread نسمح به
  hardMaxSpreadBps: 12,

  // Spread مفضل للدخول
  preferredSpreadBps: 6,

  // أقل حركة سوق مفيدة
  minVolatilityBps: 0.8,

  // أقل مدى قصير مفيد
  minMicroRangeBps: 3,

  // بداية اعتبار الحركة نزلة
  dipStartBps: -1.5,

  // نزلة قوية نسبيًا
  strongDipBps: -5,

  // لا نحاول اصطياد انهيار قوي
  maxDipBps: -35,

  // دفتر أوامر داعم
  positiveImbalance: 0.03,

  strongPositiveImbalance: 0.15,

  // مستوى BUY أصبح أخف من V4
  normalBuyScore: 48,

  // نزلة واضحة تسمح بدخول أسرع
  dipBuyScore: 43,

  // أقل ثقة نهائية
  minimumBuyConfidence: 43
};


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

async function loadMarket(
  req
) {

  const baseUrl =
    getBaseUrl(req);


  const response =
    await fetch(
      `${baseUrl}/api/market-agent`,
      {
        method:
          "GET",

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
      raw:
        text
    };
  }


  if (
    !response.ok
  ) {

    throw new Error(
      `MARKET_AGENT_HTTP_${response.status}`
    );
  }


  if (
    data?.status !==
      "ok" ||
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
    marketData.market ||
    {};


  const marketSignal =
    marketData.signal ||
    {};


  // ====================================================
  // MARKET INPUTS
  // ====================================================

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
  // BASIC VALIDATION
  // ====================================================

  if (
    price <= 0
  ) {

    return {
      action:
        "WAIT",

      confidence:
        0,

      reason:
        "INVALID_MARKET_PRICE",

      finalScore:
        0,

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

      marketScalpingScore,

      direction,

      marketMode,

      setup:
        "NONE"
    };
  }


  // ====================================================
  // HARD SPREAD BLOCK
  // ====================================================

  if (
    spreadBps >
    CONFIG
      .hardMaxSpreadBps
  ) {

    return {

      action:
        "WAIT",

      confidence:
        10,

      reason:
        "SPREAD_TOO_EXPENSIVE",

      finalScore:
        10,

      price,

      spreadBps,

      volatilityBps,

      microRangeBps,

      momentum1mBps,

      momentum3mBps,

      orderBookImbalance:
        imbalance,

      scalpingScore:
        10,

      marketScalpingScore,

      direction,

      marketMode,

      setup:
        "NONE"
    };
  }


  // ====================================================
  // SETUP DETECTION
  // ====================================================

  const isDip =
    momentum1mBps <=
      CONFIG.dipStartBps &&

    momentum1mBps >=
      CONFIG.maxDipBps;


  const isStrongDip =
    momentum1mBps <=
      CONFIG.strongDipBps &&

    momentum1mBps >=
      CONFIG.maxDipBps;


  /*
    السوق كان نازل خلال 3 دقائق
    لكن الدقيقة الأخيرة بدأت تهدأ.

    هذا مهم جدًا لأنه أقرب إلى
    بداية rebound وليس سقوطًا حرًا.
  */

  const reboundStarting =
    momentum3mBps < 0 &&

    momentum1mBps >
      momentum3mBps;


  const cleanRebound =
    momentum3mBps < -2 &&

    momentum1mBps >= -1;


  const positiveMomentum =
    momentum1mBps > 0 &&
    momentum3mBps >= -2;


  const strongMomentum =
    momentum1mBps >= 3 &&
    momentum3mBps >= 2;


  const bookSupport =
    imbalance >=
      CONFIG
        .positiveImbalance;


  const strongBookSupport =
    imbalance >=
      CONFIG
        .strongPositiveImbalance;


  // ====================================================
  // SCORES
  // ====================================================

  let spreadScore = 0;

  let volatilityScore = 0;

  let dipScore = 0;

  let reboundScore = 0;

  let momentumScore = 0;

  let liquidityScore = 0;

  let rangeScore = 0;

  let trendScore = 0;


  // ====================================================
  // SPREAD
  // ====================================================

  if (
    spreadBps <= 2
  ) {

    spreadScore = 20;

  }
  else if (
    spreadBps <= 4
  ) {

    spreadScore = 18;

  }
  else if (
    spreadBps <=
      CONFIG
        .preferredSpreadBps
  ) {

    spreadScore = 14;

  }
  else if (
    spreadBps <= 9
  ) {

    spreadScore = 8;

  }
  else {

    spreadScore = 3;
  }


  // ====================================================
  // VOLATILITY
  // ====================================================

  if (
    volatilityBps >= 2 &&
    volatilityBps <= 15
  ) {

    volatilityScore =
      15;

  }
  else if (
    volatilityBps >=
      CONFIG
        .minVolatilityBps &&
    volatilityBps < 2
  ) {

    volatilityScore =
      8;

  }
  else if (
    volatilityBps >
      15 &&
    volatilityBps <= 30
  ) {

    volatilityScore =
      10;

  }
  else if (
    volatilityBps >
      30
  ) {

    volatilityScore =
      3;
  }


  // ====================================================
  // MICRO RANGE
  // ====================================================

  if (
    microRangeBps >= 12
  ) {

    rangeScore =
      10;

  }
  else if (
    microRangeBps >= 7
  ) {

    rangeScore =
      8;

  }
  else if (
    microRangeBps >=
      CONFIG
        .minMicroRangeBps
  ) {

    rangeScore =
      5;
  }


  // ====================================================
  // DIP
  // ====================================================

  if (
    isDip
  ) {

    dipScore +=
      12;
  }


  if (
    isStrongDip
  ) {

    dipScore +=
      8;
  }


  if (
    momentum1mBps <= -10 &&
    momentum1mBps >= -25
  ) {

    dipScore +=
      4;
  }


  /*
    لا نريد محاولة اصطياد
    نزول عنيف جدًا.
  */

  if (
    momentum1mBps < -25
  ) {

    dipScore -=
      8;
  }


  dipScore =
    clamp(
      dipScore,
      0,
      24
    );


  // ====================================================
  // REBOUND
  // ====================================================

  if (
    reboundStarting
  ) {

    reboundScore +=
      12;
  }


  if (
    cleanRebound
  ) {

    reboundScore +=
      10;
  }


  if (
    reboundStarting &&
    bookSupport
  ) {

    reboundScore +=
      6;
  }


  reboundScore =
    clamp(
      reboundScore,
      0,
      25
    );


  // ====================================================
  // MOMENTUM
  // ====================================================

  if (
    positiveMomentum
  ) {

    momentumScore +=
      8;
  }


  if (
    strongMomentum
  ) {

    momentumScore +=
      10;
  }


  if (
    momentum1mBps >= 6
  ) {

    momentumScore +=
      4;
  }


  momentumScore =
    clamp(
      momentumScore,
      0,
      20
    );


  // ====================================================
  // ORDER BOOK
  // ====================================================

  if (
    strongBookSupport
  ) {

    liquidityScore =
      18;

  }
  else if (
    bookSupport
  ) {

    liquidityScore =
      14;

  }
  else if (
    imbalance >= -0.05
  ) {

    liquidityScore =
      8;

  }
  else if (
    imbalance >= -0.15
  ) {

    liquidityScore =
      4;

  }
  else {

    liquidityScore =
      0;
  }


  // ====================================================
  // TREND
  // ====================================================

  if (
    direction ===
      "UP"
  ) {

    trendScore =
      10;

  }
  else if (
    direction ===
      "FLAT"
  ) {

    trendScore =
      7;

  }
  else if (
    direction ===
      "DOWN" &&
    (
      reboundStarting ||
      cleanRebound
    )
  ) {

    trendScore =
      5;
  }


  // ====================================================
  // MARKET AGENT COMPONENT
  // ====================================================

  const marketScoreComponent =
    clamp(
      marketScalpingScore *
      0.10,
      0,
      10
    );


  // ====================================================
  // FINAL SCORE
  // ====================================================

  let finalScore =

    spreadScore +

    volatilityScore +

    rangeScore +

    liquidityScore +

    trendScore +

    marketScoreComponent;


  /*
    أهم تغيير في V5:

    لا نختار فقط أعلى قيمة
    بين dip و momentum.

    نعطي وزنًا خاصًا
    للـ dip + rebound.
  */

  if (
    isDip
  ) {

    finalScore +=
      dipScore;

    finalScore +=
      reboundScore;

  }
  else {

    finalScore +=
      momentumScore;
  }


  // ====================================================
  // BONUSES
  // ====================================================

  if (
    isDip &&
    reboundStarting
  ) {

    finalScore +=
      8;
  }


  if (
    isDip &&
    strongBookSupport
  ) {

    finalScore +=
      6;
  }


  if (
    cleanRebound &&
    spreadBps <= 5
  ) {

    finalScore +=
      7;
  }


  if (
    strongMomentum &&
    spreadBps <= 4
  ) {

    finalScore +=
      5;
  }


  // ====================================================
  // PENALTIES
  // ====================================================

  if (
    spreadBps > 8
  ) {

    finalScore -=
      10;
  }


  if (
    volatilityBps <
      CONFIG
        .minVolatilityBps
  ) {

    finalScore -=
      10;
  }


  if (
    microRangeBps <
      CONFIG
        .minMicroRangeBps
  ) {

    finalScore -=
      8;
  }


  if (
    imbalance < -0.25
  ) {

    finalScore -=
      15;
  }


  if (
    momentum1mBps <
      CONFIG.maxDipBps
  ) {

    finalScore -=
      25;
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
  // DETERMINE SETUP
  // ====================================================

  let setup =
    "NONE";


  if (
    isDip &&
    reboundStarting
  ) {

    setup =
      "DIP_REBOUND";

  }
  else if (
    isDip
  ) {

    setup =
      "MICRO_DIP";

  }
  else if (
    strongMomentum
  ) {

    setup =
      "MOMENTUM";

  }
  else if (
    positiveMomentum
  ) {

    setup =
      "MICRO_MOMENTUM";
  }


  // ====================================================
  // BUY DECISION
  // ====================================================

  let action =
    "WAIT";


  let reason =
    "NO_MICRO_ENTRY";


  /*
    DIP entry:
    threshold أخف لأن هدفنا
    اصطياد النزلات الصغيرة.
  */

  const dipEntry =
    isDip &&
    finalScore >=
      CONFIG
        .dipBuyScore;


  /*
    Normal momentum entry
  */

  const normalEntry =
    (
      positiveMomentum ||
      reboundStarting
    ) &&
    finalScore >=
      CONFIG
        .normalBuyScore;


  if (
    dipEntry
  ) {

    action =
      "BUY";

    reason =
      reboundStarting
        ? "MICRO_DIP_REBOUND"
        : "MICRO_DIP_ENTRY";

  }
  else if (
    normalEntry
  ) {

    action =
      "BUY";

    reason =
      strongMomentum
        ? "MICRO_MOMENTUM"
        : "EARLY_REBOUND";
  }


  // ====================================================
  // QUALITY GUARDS
  // ====================================================

  if (
    action === "BUY" &&
    spreadBps >
      CONFIG
        .hardMaxSpreadBps
  ) {

    action =
      "WAIT";

    reason =
      "SPREAD_TOO_HIGH";
  }


  if (
    action === "BUY" &&
    momentum1mBps <
      CONFIG
        .maxDipBps
  ) {

    action =
      "WAIT";

    reason =
      "DIP_TOO_AGGRESSIVE";
  }


  /*
    إذا النزول قوي ودفتر
    الأوامر سلبي جدًا:
    ننتظر بدل catching knife.
  */

  if (
    action === "BUY" &&
    isStrongDip &&
    imbalance < -0.20 &&
    !reboundStarting
  ) {

    action =
      "WAIT";

    reason =
      "SELL_PRESSURE_TOO_STRONG";
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


  if (
    action === "BUY" &&
    marketAction === "BUY"
  ) {

    confidence +=
      5;
  }


  /*
    في V4 كان WAIT من Market
    يخفض الثقة بقوة.

    في V5 لا نخلي Market Agent
    يمنع micro dip إذا Signal
    اكتشفها بنفسه.
  */

  if (
    action === "BUY" &&
    marketAction === "WAIT"
  ) {

    confidence -=
      2;
  }


  if (
    action === "BUY" &&
    reboundStarting
  ) {

    confidence +=
      3;
  }


  if (
    action === "BUY" &&
    strongBookSupport
  ) {

    confidence +=
      3;
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
  // CONFIDENCE FLOOR
  // ====================================================

  if (
    action === "BUY" &&
    confidence <
      CONFIG
        .minimumBuyConfidence
  ) {

    action =
      "WAIT";

    reason =
      "CONFIDENCE_BELOW_AGGRESSIVE_THRESHOLD";
  }


  // ====================================================
  // RETURN
  // ====================================================

  return {

    action,

    confidence,

    reason,

    setup,

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

    reboundScore,

    liquidityScore,

    volatilityScore,

    spreadScore,

    rangeScore,

    trendScore,

    direction,

    marketMode,

    flags: {

      isDip,

      isStrongDip,

      reboundStarting,

      cleanRebound,

      positiveMomentum,

      strongMomentum,

      bookSupport,

      strongBookSupport
    }
  };
}


// ======================================================
// HANDLER
// ======================================================

export default async function handler(
  req,
  res
) {

  if (
    req.method !==
      "GET"
  ) {

    return res
      .status(405)
      .json({

        status:
          "error",

        message:
          "GET only"
      });
  }


  try {

    const marketData =
      await loadMarket(
        req
      );


    const analysis =
      buildSignal(
        marketData
      );


    const signal = {

      signalId:
        randomUUID(),

      pair:
        "SOL-USDC",

      action:
        analysis.action,

      confidence:
        analysis.confidence,

      reason:
        analysis.reason,

      setup:
        analysis.setup,

      currentPrice:
        analysis.price,

      spreadBps:
        analysis.spreadBps,

      volatilityBps:
        analysis
          .volatilityBps,

      microRangeBps:
        analysis
          .microRangeBps,

      momentum1mBps:
        analysis
          .momentum1mBps,

      momentum3mBps:
        analysis
          .momentum3mBps,

      orderBookImbalance:
        analysis
          .orderBookImbalance,

      scalpingScore:
        analysis
          .scalpingScore,

      marketScalpingScore:
        analysis
          .marketScalpingScore,

      finalScore:
        analysis
          .finalScore,

      scoreBreakdown: {

        momentum:
          analysis
            .momentumScore,

        dip:
          analysis
            .dipScore,

        rebound:
          analysis
            .reboundScore,

        liquidity:
          analysis
            .liquidityScore,

        volatility:
          analysis
            .volatilityScore,

        spread:
          analysis
            .spreadScore,

        range:
          analysis
            .rangeScore,

        trend:
          analysis
            .trendScore
      },

      flags:
        analysis.flags,

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

        status:
          "ok",

        engine:
          "FAWAZ_SIGNAL_AGENT_V5",

        strategy:
          "AGGRESSIVE_MICRO_DIP_REBOUND",

        signal,

        market:
          marketData.market,

        config: {

          hardMaxSpreadBps:
            CONFIG
              .hardMaxSpreadBps,

          dipBuyScore:
            CONFIG
              .dipBuyScore,

          normalBuyScore:
            CONFIG
              .normalBuyScore,

          minimumBuyConfidence:
            CONFIG
              .minimumBuyConfidence
        }
      });


  } catch (error) {

    console.error(
      "Signal Agent Error:",
      error
    );


    return res
      .status(500)
      .json({

        status:
          "error",

        engine:
          "FAWAZ_SIGNAL_AGENT_V5",

        message:
          error?.message ||
          "Signal Agent failed",

        timestamp:
          new Date()
            .toISOString()
      });
  }
}
