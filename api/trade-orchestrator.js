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

  if (!tokenResponse.ok || !Array.isArray(tokenResult.result?.value)) {
    throw new Error("Failed to load USDC balance");
  }

  const usdcBalance = tokenResult.result.value.reduce(
    (total, account) => {
      const amount =
        account.account.data.parsed.info.tokenAmount.uiAmount || 0;

      return total + Number(amount);
    },
    0
  );

  return {
    solBalance: solResult.result.value / 1000000000,
    usdcBalance
  };
}

async function loadBotWallet() {
  const privateKey = process.env.BOT_SOLANA_PRIVATE_KEY?.trim();

  if (!privateKey) {
    throw new Error("BOT_SOLANA_PRIVATE_KEY is missing");
  }

  const [web3Module, bs58Module] = await Promise.all([
    import("@solana/web3.js"),
    import("bs58")
  ]);

  const bs58 = bs58Module.default || bs58Module;

  return web3Module.Keypair.fromSecretKey(
    bs58.decode(privateKey)
  );
}

async function getJupiterOrder({
  inputMint,
  outputMint,
  amount,
  walletAddress
}) {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amount),
    taker: walletAddress
  });

  const response = await fetch(
    `${JUPITER_BASE_URL}/order?${params.toString()}`,
    { headers: jupiterHeaders() }
  );

  const order = await response.json();

  if (!response.ok || !order.transaction || !order.requestId) {
    throw new Error(
      order.errorMessage || "Jupiter did not return a valid order"
    );
  }

  return order;
}

async function executeJupiterOrder(order, signer) {
  const { VersionedTransaction } = await import("@solana/web3.js");

  const transaction = VersionedTransaction.deserialize(
    Buffer.from(order.transaction, "base64")
  );

  transaction.sign([signer]);

  const signedTransaction = Buffer.from(
    transaction.serialize()
  ).toString("base64");

  const response = await fetch(
    `${JUPITER_BASE_URL}/execute`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...jupiterHeaders()
      },
      body: JSON.stringify({
        signedTransaction,
        requestId: order.requestId
      })
    }
  );

  const result = await response.json();

  if (!response.ok || result.status !== "Success") {
    throw new Error(
      result.error || "Jupiter execution failed"
    );
  }

  return result;
}

export default async function handler(req, res) {
  const auth = req.headers.authorization || "";

  if (
    !process.env.AUTO_TRADER_SECRET ||
    auth !== `Bearer ${process.env.AUTO_TRADER_SECRET}`
  ) {
    return res.status(401).json({
      status: "error",
      executed: false,
      message: "Unauthorized"
    });
  }

  if (process.env.BOT_ENABLED !== "true") {
    return res.status(200).json({
      status: "disabled",
      executed: false,
      message: "BOT_ENABLED is not true"
    });
  }

  try {
    const market = await getMarketData();

    if (Math.abs(market.momentum) > 3) {
      return res.status(200).json({
        status: "no_trade",
        executed: false,
        reason: "Momentum is too extreme",
        market
      });
    }

    if (market.volatility > 1.5) {
      return res.status(200).json({
        status: "no_trade",
        executed: false,
        reason: "Market volatility is too high",
        market
      });
    }

    let action = "WAIT";

    if (
      market.sma10 > market.sma30 &&
      market.momentum > 0.3
    ) {
      action = "BUY";
    }

    if (
      market.sma10 < market.sma30 &&
      market.momentum < -0.3
    ) {
      action = "SELL";
    }

    if (action === "WAIT") {
      return res.status(200).json({
        status: "no_trade",
        executed: false,
        reason: "No confirmed trend",
        market
      });
    }

    if (process.env.LIVE_TRADING_ENABLED !== "true") {
      return res.status(200).json({
        status: "dry_run",
        executed: false,
        action,
        reason: "LIVE_TRADING_ENABLED is not true",
        market
      });
    }

    const signer = await loadBotWallet();
    const walletAddress = signer.publicKey.toBase58();

    const { solBalance, usdcBalance } = await getBalances(
      walletAddress
    );

    let order;
    let tradeAmount;
    let direction;

    if (action === "BUY") {
      if (
        usdcBalance < MAX_BUY_USDC ||
        solBalance >= SOL_REBALANCE_LEVEL
      ) {
        return res.status(200).json({
          status: "no_trade",
          executed: false,
          action,
          reason: "Buy allocation limit reached",
          solBalance,
          usdcBalance,
          market
        });
      }

      tradeAmount = MAX_BUY_USDC;
      direction = "USDC_TO_SOL";

      order = await getJupiterOrder({
        inputMint: USDC_MINT,
        outputMint: SOL_MINT,
        amount: Math.round(MAX_BUY_USDC * 1000000),
        walletAddress
      });
    }

    if (action === "SELL") {
      const availableToSell = solBalance - SOL_FLOOR;

      if (availableToSell < 0.001) {
        return res.status(200).json({
          status: "no_trade",
          executed: false,
          action,
          reason: "SOL reserve limit reached",
          solBalance,
          usdcBalance,
          market
        });
      }

      tradeAmount = Math.min(MAX_SELL_SOL, availableToSell);
      direction = "SOL_TO_USDC";

      order = await getJupiterOrder({
        inputMint: SOL_MINT,
        outputMint: USDC_MINT,
        amount: Math.floor(tradeAmount * 1000000000),
        walletAddress
      });
    }

    const execution = await executeJupiterOrder(order, signer);

    return res.status(200).json({
      status: "success",
      executed: true,
      action,
      direction,
      tradeAmount,
      signature: execution.signature,
      solBalanceBefore: Number(solBalance.toFixed(6)),
      usdcBalanceBefore: Number(usdcBalance.toFixed(6)),
      market: {
        currentPrice: Number(market.currentPrice.toFixed(6)),
        sma10: Number(market.sma10.toFixed(6)),
        sma30: Number(market.sma30.toFixed(6)),
        momentum: Number(market.momentum.toFixed(3)),
        volatility: Number(market.volatility.toFixed(3))
      }
    });
  } catch (error) {
    return res.status(500).json({
      status: "error",
      executed: false,
      message: error.message || "Auto trader failed"
    });
  }
}
