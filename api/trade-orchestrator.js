const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const RPC_URL = "https://api.mainnet-beta.solana.com";

const BUY_USDC_AMOUNT = 0.5;
const SELL_SOL_AMOUNT = 0.005;

const SOL_FLOOR = 0.1;
const MIN_USDC_TO_BUY = 0.55;

async function getMarketData() {
  const response = await fetch(
    "https://www.okx.com/api/v5/market/candles?instId=SOL-USDC&bar=5m&limit=100"
  );

  const result = await response.json();

  if (
    !response.ok ||
    result.code !== "0" ||
    !Array.isArray(result.data) ||
    result.data.length < 30
  ) {
    throw new Error("Failed to load market candles");
  }

  const closes = [...result.data]
    .reverse()
    .map((candle) => Number(candle[4]))
    .filter(Number.isFinite);

  if (closes.length < 30) {
    throw new Error("Not enough valid candles");
  }

  const currentPrice = closes[closes.length - 1];

  const sma10 =
    closes.slice(-10).reduce((a, b) => a + b, 0) / 10;

  const sma30 =
    closes.slice(-30).reduce((a, b) => a + b, 0) / 30;

  const fiveCandlesAgo =
    closes[closes.length - 6];

  const momentum =
    ((currentPrice - fiveCandlesAgo) /
      fiveCandlesAgo) *
    100;

  return {
    currentPrice,
    sma10,
    sma30,
    momentum
  };
}

async function getSolBalance(walletAddress) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getBalance",
      params: [walletAddress]
    })
  });

  const result = await response.json();

  const lamports =
    result?.result?.value;

  if (!Number.isFinite(lamports)) {
    throw new Error("Failed to load SOL balance");
  }

  return lamports / 1e9;
}

async function getUsdcBalance(walletAddress) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "getTokenAccountsByOwner",
      params: [
        walletAddress,
        {
          mint: USDC_MINT
        },
        {
          encoding: "jsonParsed"
        }
      ]
    })
  });

  const result = await response.json();

  const accounts =
    result?.result?.value || [];

  let total = 0;

  for (const account of accounts) {
    const amount =
      account?.account?.data?.parsed?.info?.tokenAmount
        ?.uiAmount;

    if (Number.isFinite(amount)) {
      total += amount;
    }
  }

  return total;
}

function makeDecision(market, balances) {
  const {
    currentPrice,
    sma10,
    sma30,
    momentum
  } = market;

  const {
    solBalance,
    usdcBalance
  } = balances;

  // =========================
  // BUY SIGNAL
  // =========================

  const bullishTrend =
    sma10 > sma30;

  const positiveMomentum =
    momentum > 0.15;

  if (
    bullishTrend &&
    positiveMomentum &&
    usdcBalance >= MIN_USDC_TO_BUY
  ) {
    return {
      decision: "BUY",
      confidence: 75,
      amount: BUY_USDC_AMOUNT,
      reason:
        "Short-term trend and momentum are bullish."
    };
  }

  // =========================
  // SELL SIGNAL
  // =========================

  const bearishTrend =
    sma10 < sma30;

  const negativeMomentum =
    momentum < -0.15;

  const can
