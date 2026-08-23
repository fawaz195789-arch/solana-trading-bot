const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const RPC_URL = "https://api.mainnet-beta.solana.com";
const JUPITER_BASE_URL = "https://api.jup.ag/swap/v2";

const MAX_BUY_USDC = 0.5;
const MAX_SELL_SOL = 0.005;
const SOL_FLOOR = 0.1;
const SOL_REBALANCE_LEVEL = 0.105;

function jupiterHeaders() {
  return process.env.JUPITER_API_KEY
    ? { "x-api-key": process.env.JUPITER_API_KEY }
    : {};
}

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
    throw new Error("Failed to load OKX market candles");
  }

  const closes = [...result.data]
    .reverse()
    .map(candle => Number(candle[4]))
    .filter(Number.isFinite);

  if (closes.length < 30) {
    throw new Error("Not enough valid market candles");
  }

  const currentPrice = closes[closes.length - 1];
  const previousPrice = closes[closes.length - 6];

  if (!currentPrice || !previousPrice) {
    throw new Error("Invalid market prices");
  }

  const sma10 =
    closes.slice(-10).reduce((a, b) => a + b, 0) / 10;

  const sma30 =
    closes.slice(-30).reduce((a, b) => a + b, 0) / 30;

  const momentum =
    ((currentPrice - previousPrice) / previousPrice) * 100;

  const recentCloses = closes.slice(-12);
  const changes = [];

  for (let i = 1; i < recentCloses.length; i++) {
    const previous = recentCloses[i - 1];
    const current = recentCloses[i];

    changes.push(
      Math.abs(((current - previous) / previous) * 100)
    );
  }

  const volatility =
    changes.reduce((a, b) => a + b, 0) / changes.length;

  return {
    currentPrice,
    sma10,
    sma30,
    momentum,
    volatility
  };
}

async function getBalances(walletAddress) {
  const solResponse = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getBalance",
      params: [walletAddress]
    })
  });

  const solResult = await solResponse.json();

  if (!solResponse.ok || !Number.isFinite(solResult.result?.value)) {
    throw new Error("Failed to load SOL balance");
  }

  const tokenResponse = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "getTokenAccountsByOwner",
      params: [
        walletAddress,
        { mint: USDC_MINT },
        { encoding: "jsonParsed" }
      ]
    })
  });

  const tokenResult = await tokenResponse.json();

  if (!token
