// /api/market-agent.js
// FAWAZ AI BOT
// Fast Market Scanner v3
// SOL/USDC - Volatility + Spread + Momentum

const SYMBOL = "SOL-USDC";

const OKX_TICKER_URL =
  "https://www.okx.com/api/v5/market/ticker?instId=SOL-USDC";

const OKX_BOOK_URL =
  "https://www.okx.com/api/v5/market/books?instId=SOL-USDC&sz=5";

const OKX_CANDLES_URL =
  "https://www.okx.com/api/v5/market/candles?instId=SOL-USDC&bar=1m&limit=30";

// ======================================================
// SAFE NUMBER
// ======================================================

function num(value, fallback = 0) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}

// ======================================================
// BASIS POINTS
// ======================================================

function toBps(value) {
  return value * 10000;
}

// ======================================================
// FETCH JSON
// ======================================================

async function fetchJson(url) {
  const response = await fetch(url, {
    method: "GET",

    headers: {
      Accept: "application/json"
    }
  });

  const data =
    await response.json();

  if (!response.ok) {
    throw new Error(
      `MARKET_HTTP_${response.status}`
    );
  }

  if (
    data?.code !== "0"
  ) {
    throw new Error(
      data?.msg ||
      "OKX_MARKET_ERROR"
    );
  }

  return data;
}

// ======================================================
// TICKER
// ======================================================

async function getTicker() {
  const result =
    await fetchJson(
      OKX_TICKER_URL
    );

  const ticker =
    result?.data?.[0];

  if (!ticker) {
    throw new Error(
      "TICKER_NOT_AVAILABLE"
    );
  }

  return {
    last:
      num(ticker.last),

    bid:
      num(ticker.bidPx),

    ask:
      num(ticker.askPx),

    bidSize:
      num(ticker.bidSz),

    askSize:
      num(ticker.askSz),

    high24h:
      num(ticker.high24h),

    low24h:
      num(ticker.low24h),

    volume24h:
      num(ticker.vol24h),

    volumeCurrency24h:
      num(ticker.volCcy24h),

    timestamp:
      ticker.ts
  };
}

// ======================================================
// ORDER BOOK
// ======================================================

async function getOrderBook() {
  const result =
    await fetchJson(
      OKX_BOOK_URL
    );

  const book =
    result?.data?.[0];

  if (!book) {
    throw new Error(
      "ORDER_BOOK_NOT_AVAILABLE"
    );
  }

  const bids =
    Array.isArray(book.bids)
      ? book.bids
      : [];

  const asks =
    Array.isArray(book.asks)
      ? book.asks
      : [];

  const bestBid =
    bids.length
      ? num(bids[0][0])
      : 0;

  const bestAsk =
    asks.length
      ? num(asks[0][0])
      : 0;

  let bidLiquidity = 0;
  let askLiquidity = 0;

  for (const bid of bids) {
    const price =
      num(bid[0]);

    const amount =
      num(bid[1]);

    bidLiquidity +=
      price * amount;
  }

  for (const ask of asks) {
    const price =
      num(ask[0]);

    const amount =
      num(ask[1]);

    askLiquidity +=
      price * amount;
  }

  return {
    bestBid,
    bestAsk,
    bidLiquidity,
    askLiquidity
  };
}

// ======================================================
// CANDLES
// ======================================================

async function getCandles() {
  const result =
    await fetchJson(
      OKX_CANDLES_URL
    );

  const raw =
    Array.isArray(
      result?.data
    )
      ? result.data
      : [];

  if (
    raw.length < 6
  ) {
    throw new Error(
      "NOT_ENOUGH_CANDLES"
    );
  }

  // OKX returns newest first
  const candles =
    [...raw].reverse();

  return candles.map(
    (candle) => ({
      timestamp:
        num(candle[0]),

      open:
        num(candle[1]),

      high:
        num(candle[2]),

      low:
        num(candle[3]),

      close:
        num(candle[4]),

      volume:
        num(candle[5])
    })
  );
}

// ======================================================
// MARKET METRICS
// ======================================================

function calculateMetrics({
  ticker,
  book,
  candles
}) {
  const currentPrice =
    ticker.last;

  const bestBid =
    book.bestBid ||
    ticker.bid;

  const bestAsk =
    book.bestAsk ||
    ticker.ask;

  // ----------------------------------------------------
  // SPREAD
  // ----------------------------------------------------

  const midpoint =
    bestBid > 0 &&
    bestAsk > 0
      ? (
          bestBid +
          bestAsk
        ) / 2
      : currentPrice;

  const spread =
    bestAsk > 0 &&
    bestBid > 0
      ? bestAsk -
        bestBid
      : 0;

  const spreadBps =
    midpoint > 0
      ? toBps(
          spread /
          midpoint
        )
      : 0;

  // ----------------------------------------------------
  // MOMENTUM
  // ----------------------------------------------------

  const closes =
    candles.map(
      (c) => c.close
    );

  const latestClose =
    closes[
      closes.length - 1
    ];

  const oneMinuteAgo =
    closes[
      Math.max(
        0,
        closes.length - 2
      )
    ];

  const threeMinutesAgo =
    closes[
      Math.max(
        0,
        closes.length - 4
      )
    ];

  const fiveMinutesAgo =
    closes[
      Math.max(
        0,
        closes.length - 6
      )
    ];

  const momentum1mBps =
    oneMinuteAgo > 0
      ? toBps(
          (
            latestClose -
            oneMinuteAgo
          ) /
          oneMinuteAgo
        )
      : 0;

  const momentum3mBps =
    threeMinutesAgo > 0
      ? toBps(
          (
            latestClose -
            threeMinutesAgo
          ) /
          threeMinutesAgo
        )
      : 0;

  const momentum5mBps =
    fiveMinutesAgo > 0
      ? toBps(
          (
            latestClose -
            fiveMinutesAgo
          ) /
          fiveMinutesAgo
        )
      : 0;

  // ----------------------------------------------------
  // VOLATILITY
  // ----------------------------------------------------

  const recent =
    candles.slice(-10);

  const ranges = recent.map(
    (candle) => {
      if (
        candle.open <= 0
      ) {
        return 0;
      }

      return toBps(
        (
          candle.high -
          candle.low
        ) /
        candle.open
      );
    }
  );

  const volatilityBps =
    ranges.length
      ? ranges.reduce(
          (sum, value) =>
            sum + value,
          0
        ) /
        ranges.length
      : 0;

  // ----------------------------------------------------
  // MICRO RANGE
  // ----------------------------------------------------

  const recentFive =
    candles.slice(-5);

  const highest =
    Math.max(
      ...recentFive.map(
        (c) => c.high
      )
    );

  const lowest =
    Math.min(
      ...recentFive.map(
        (c) => c.low
      )
    );

  const microRangeBps =
    lowest > 0
      ? toBps(
          (
            highest -
            lowest
          ) /
          lowest
        )
      : 0;

  // ----------------------------------------------------
  // ORDER BOOK IMBALANCE
  // ----------------------------------------------------

  const totalLiquidity =
    book.bidLiquidity +
    book.askLiquidity;

  const imbalance =
    totalLiquidity > 0
      ? (
          book.bidLiquidity -
          book.askLiquidity
        ) /
        totalLiquidity
      : 0;

  // ----------------------------------------------------
  // DIRECTION
  // ----------------------------------------------------

  let direction =
    "FLAT";

  if (
    momentum1mBps > 3 &&
    momentum3mBps > 5
  ) {
    direction =
      "UP";
  }

  if (
    momentum1mBps < -3 &&
    momentum3mBps < -5
  ) {
    direction =
      "DOWN";
  }

  // ----------------------------------------------------
  // SCALPING SCORE
  // ----------------------------------------------------

  let score = 0;

  if (
    volatilityBps >= 10
  ) {
    score += 20;
  }

  if (
    volatilityBps >= 20
  ) {
    score += 15;
  }

  if (
    microRangeBps >= 20
  ) {
    score += 20;
  }

  if (
    Math.abs(
      momentum1mBps
    ) >= 4
  ) {
    score += 15;
  }

  if (
    Math.abs(
      momentum3mBps
    ) >= 8
  ) {
    score += 15;
  }

  if (
    Math.abs(
      imbalance
    ) >= 0.10
  ) {
    score += 15;
  }

  score =
    Math.min(
      100,
      score
    );

  // ----------------------------------------------------
  // MARKET MODE
  // ----------------------------------------------------

  let marketMode =
    "CALM";

  if (
    volatilityBps >= 12 ||
    microRangeBps >= 20
  ) {
    marketMode =
      "NORMAL";
  }

  if (
    volatilityBps >= 25 ||
    microRangeBps >= 40
  ) {
    marketMode =
      "FAST";
  }

  return {
    currentPrice,

    bestBid,
    bestAsk,

    spread,

    spreadBps,

    midpoint,

    momentum1mBps,

    momentum3mBps,

    momentum5mBps,

    volatilityBps,

    microRangeBps,

    highestRecentPrice:
      highest,

    lowestRecentPrice:
      lowest,

    bidLiquidity:
      book.bidLiquidity,

    askLiquidity:
      book.askLiquidity,

    orderBookImbalance:
      imbalance,

    direction,

    scalpingScore:
      score,

    marketMode
  };
}

// ======================================================
// SIGNAL
// ======================================================

function createSignal(
  metrics
) {
  let action =
    "WAIT";

  let reason =
    "No profitable micro setup";

  /*
    السوق الصاعد القصير
  */

  if (
    metrics.scalpingScore >= 45 &&
    metrics.direction === "UP" &&
    metrics.orderBookImbalance >
      -0.25
  ) {
    action =
      "BUY";

    reason =
      "Positive micro momentum with sufficient volatility";
  }

  /*
    Dip / ارتداد محتمل

    لا نستخدم SELL هنا لفتح Short.
    SELL مسؤول عنه Orchestrator
    لإغلاق Slots الموجودة.
  */

  if (
    metrics.scalpingScore >= 45 &&
    metrics.momentum1mBps <= -8 &&
    metrics.orderBookImbalance > 0.05
  ) {
    action =
      "BUY";

    reason =
      "Micro dip with bid-side liquidity support";
  }

  return {
    signalId:
      crypto.randomUUID(),

    pair:
      SYMBOL,

    action,

    confidence:
      Math.max(
        0,
        Math.min(
          100,
          Math.round(
            metrics
              .scalpingScore
          )
        )
      ),

    reason,

    createdAt:
      new Date()
        .toISOString()
  };
}

// ======================================================
// HANDLER
// ======================================================

export default async function handler(
  req,
  res
) {
  try {
    /*
      الثلاث طلبات تتم مع بعض
      عشان نقلل زمن الفحص.
    */

    const [
      ticker,
      book,
      candles
    ] =
      await Promise.all([
        getTicker(),
        getOrderBook(),
        getCandles()
      ]);

    const metrics =
      calculateMetrics({
        ticker,
        book,
        candles
      });

    const signal =
      createSignal(
        metrics
      );

    return res
      .status(200)
      .json({
        status: "ok",

        engine:
          "FAWAZ_FAST_MARKET_SCANNER_V3",

        pair:
          SYMBOL,

        market: {
          price:
            metrics.currentPrice,

          bid:
            metrics.bestBid,

          ask:
            metrics.bestAsk,

          spread:
            Number(
              metrics.spread.toFixed(
                6
              )
            ),

          spreadBps:
            Number(
              metrics.spreadBps.toFixed(
                2
              )
            ),

          volatilityBps:
            Number(
              metrics.volatilityBps.toFixed(
                2
              )
            ),

          microRangeBps:
            Number(
              metrics.microRangeBps.toFixed(
                2
              )
            ),

          momentum1mBps:
            Number(
              metrics.momentum1mBps.toFixed(
                2
              )
            ),

          momentum3mBps:
            Number(
              metrics.momentum3mBps.toFixed(
                2
              )
            ),

          momentum5mBps:
            Number(
              metrics.momentum5mBps.toFixed(
                2
              )
            ),

          orderBookImbalance:
            Number(
              metrics.orderBookImbalance.toFixed(
                4
              )
            ),

          bidLiquidity:
            Number(
              metrics.bidLiquidity.toFixed(
                2
              )
            ),

          askLiquidity:
            Number(
              metrics.askLiquidity.toFixed(
                2
              )
            ),

          direction:
            metrics.direction,

          mode:
            metrics.marketMode,

          scalpingScore:
            metrics.scalpingScore
        },

        signal
      });

  } catch (error) {
    console.error(
      "Market Agent Error:",
      error
    );

    return res
      .status(500)
      .json({
        status: "error",

        engine:
          "FAWAZ_FAST_MARKET_SCANNER_V3",

        message:
          error?.message ||
          "Market Agent failed"
      });
  }
}
