// /api/execution-agent.js
// FAWAZ AI BOT
// STABLE EXECUTION AGENT
//
// GET  = Wallet connection test
// POST = Real Jupiter Swap Execution

import {
  Connection,
  Keypair,
  VersionedTransaction
} from "@solana/web3.js";

import bs58 from "bs58";


// ======================================================
// TOKEN MINTS
// ======================================================

const SOL_MINT =
  "So11111111111111111111111111111111111111112";

const USDC_MINT =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;


// ======================================================
// RPC
// ======================================================

const RPC_URL =
  process.env.SOLANA_RPC_URL ||
  "https://api.mainnet-beta.solana.com";


// ======================================================
// JUPITER
// ======================================================

const JUPITER_QUOTE_URL =
  "https://api.jup.ag/swap/v1/quote";

const JUPITER_SWAP_URL =
  "https://api.jup.ag/swap/v1/swap";


// ======================================================
// SAFETY
// ======================================================

const ABSOLUTE_MAX_SLIPPAGE_BPS = 30;
const MAX_PRICE_IMPACT_PCT = 0.003;


// ======================================================
// JUPITER HEADERS
// ======================================================

function jupiterHeaders() {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json"
  };

  if (process.env.JUPITER_API_KEY) {
    headers["x-api-key"] =
      process.env.JUPITER_API_KEY;
  }

  return headers;
}


// ======================================================
// AUTH
// ======================================================

function authorize(req) {
  const expected =
    process.env.AUTO_TRADER_SECRET;

  if (!expected) {
    return {
      ok: false,
      status: 500,
      reason:
        "AUTO_TRADER_SECRET_MISSING"
    };
  }

  const auth =
    req.headers.authorization ||
    req.headers.Authorization ||
    "";

  if (
    auth !==
    `Bearer ${expected}`
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
// PRIVATE KEY
// ======================================================

function loadBotKeypair() {
  const raw =
    process.env.BOT_SOLANA_PRIVATE_KEY;

  if (!raw) {
    throw new Error(
      "BOT_SOLANA_PRIVATE_KEY_MISSING"
    );
  }

  const value =
    raw.trim();

  try {

    if (
      value.startsWith("[") &&
      value.endsWith("]")
    ) {
      const parsed =
        JSON.parse(value);

      const secret =
        Uint8Array.from(parsed);

      return Keypair.fromSecretKey(
        secret
      );
    }

    const secret =
      bs58.decode(value);

    return Keypair.fromSecretKey(
      secret
    );

  } catch {
    throw new Error(
      "INVALID_BOT_SOLANA_PRIVATE_KEY_FORMAT"
    );
  }
}


// ======================================================
// CONFIGURED WALLET
// ======================================================

function getConfiguredWalletAddress() {
  const wallet =
    process.env.BOT_PUBLIC_WALLET ||
    process.env.BOT_WALLET_ADDRESS ||
    process.env.SOLANA_WALLET_ADDRESS ||
    process.env.WALLET_ADDRESS ||
    null;

  return wallet
    ? wallet.trim()
    : null;
}


// ======================================================
// VERIFY WALLET
// ======================================================

function verifyWalletMatchesKeypair(
  keypair
) {
  const botAddress =
    keypair.publicKey.toString();

  const configuredWallet =
    getConfiguredWalletAddress();

  if (
    configuredWallet &&
    configuredWallet !== botAddress
  ) {
    throw new Error(
      "BOT_WALLET_ADDRESS_DOES_NOT_MATCH_PRIVATE_KEY"
    );
  }

  return botAddress;
}


// ======================================================
// SAFE WALLET TEST
// ======================================================

async function handleWalletTest(
  req,
  res
) {
  try {

    const keypair =
      loadBotKeypair();

    const derivedAddress =
      keypair.publicKey.toString();

    const configuredWallet =
      getConfiguredWalletAddress();

    const walletMatch =
      !configuredWallet ||
      configuredWallet ===
        derivedAddress;

    if (!walletMatch) {
      return res
        .status(500)
        .json({
          status: "error",
          test: "WALLET_CONNECTION",
          executed: false,
          keyLoaded: true,
          keyValid: true,
          walletMatch: false,
          configuredWallet,
          derivedWallet:
            derivedAddress,
          tradingKeyReady: false,
          message:
            "Private key does not match configured wallet"
        });
    }

    const connection =
      new Connection(
        RPC_URL,
        "confirmed"
      );

    const balanceLamports =
      await connection.getBalance(
        keypair.publicKey
      );

    const solBalance =
      balanceLamports /
      1_000_000_000;

    return res
      .status(200)
      .json({
        status: "ok",
        test: "WALLET_CONNECTION",
        executed: false,
        keyLoaded: true,
        keyValid: true,
        walletMatch: true,
        rpcConnected: true,
        walletAddress:
          derivedAddress,
        solBalance,
        tradingKeyReady: true,
        message:
          "Bot wallet key is loaded and ready. No trade was executed."
      });

  } catch (error) {

    console.error(
      "Wallet Test Error:",
      error
    );

    return res
      .status(500)
      .json({
        status: "error",
        test: "WALLET_CONNECTION",
        executed: false,
        keyLoaded: false,
        walletMatch: false,
        tradingKeyReady: false,
        message:
          error?.message ||
          "Wallet connection test failed"
      });
  }
}


// ======================================================
// HELPERS
// ======================================================

function safeNumber(
  value,
  fallback = 0
) {
  const n =
    Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}


function toAtomicAmount(
  amount,
  decimals
) {
  const numeric =
    Number(amount);

  if (
    !Number.isFinite(numeric) ||
    numeric <= 0
  ) {
    throw new Error(
      "INVALID_TRADE_AMOUNT"
    );
  }

  return Math.floor(
    numeric *
    Math.pow(
      10,
      decimals
    )
  ).toString();
}


// ======================================================
// PARSE REQUEST
// ======================================================

function parseTradeRequest(
  body = {}
) {
  const side =
    String(
      body.side ||
      body.decision ||
      ""
    ).toUpperCase();

  const slotId =
    body.slotId ??
    null;

  const amountUsd =
    safeNumber(
      body.amountUsd,
      side === "BUY"
        ? safeNumber(
            body.amount,
            0
          )
        : 0
    );

  const amountSol =
    safeNumber(
      body.amountSol ??
      body.quantity,
      side === "SELL"
        ? safeNumber(
            body.amount,
            0
          )
        : 0
    );

  let slippageBps =
    safeNumber(
      body.slippageBps,
      20
    );

  slippageBps =
    Math.max(
      1,
      Math.min(
        ABSOLUTE_MAX_SLIPPAGE_BPS,
        Math.floor(
          slippageBps
        )
      )
    );

  return {
    side,
    slotId,
    amountUsd,
    amountSol,
    slippageBps
  };
}


// ======================================================
// JUPITER QUOTE
// ======================================================

async function getJupiterQuote({
  inputMint,
  outputMint,
  atomicAmount,
  slippageBps
}) {
  const params =
    new URLSearchParams({
      inputMint,
      outputMint,
      amount:
        atomicAmount,
      slippageBps:
        String(
          slippageBps
        )
    });

  const response =
    await fetch(
      `${JUPITER_QUOTE_URL}?${params.toString()}`,
      {
        method: "GET",
        headers:
          jupiterHeaders()
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

  if (
    !response.ok ||
    !data?.outAmount
  ) {
    throw new Error(
      `JUPITER_QUOTE_FAILED:${response.status}:${JSON.stringify(data)}`
    );
  }

  return data;
}


// ======================================================
// BUILD SWAP
// ======================================================

async function buildSwap({
  quote,
  walletAddress
}) {
  const response =
    await fetch(
      JUPITER_SWAP_URL,
      {
        method: "POST",

        headers:
          jupiterHeaders(),

        body:
          JSON.stringify({
            quoteResponse:
              quote,

            userPublicKey:
              walletAddress,

            wrapAndUnwrapSol:
              true,

            dynamicComputeUnitLimit:
              true,

            prioritizationFeeLamports: {
              priorityLevelWithMaxLamports: {
                maxLamports:
                  1000000,
                priorityLevel:
                  "medium"
              }
            }
          })
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

  if (
    !response.ok ||
    !data?.swapTransaction
  ) {
    throw new Error(
      `JUPITER_SWAP_BUILD_FAILED:${response.status}:${JSON.stringify(data)}`
    );
  }

  return data;
}


// ======================================================
// MAIN HANDLER
// ======================================================

export default async function handler(
  req,
  res
) {

  // GET = wallet test
  if (
    req.method === "GET"
  ) {
    if (
      req.query?.test ===
      "wallet"
    ) {
      return handleWalletTest(
        req,
        res
      );
    }

    return res
      .status(200)
      .json({
        status: "ok",
        engine:
          "FAWAZ_EXECUTION_AGENT_V4",
        executed: false,
        message:
          "Use ?test=wallet for wallet connection test"
      });
  }


  // POST only for real trading
  if (
    req.method !== "POST"
  ) {
    return res
      .status(405)
      .json({
        status: "error",
        executed: false,
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
        executed: false,
        reason:
          auth.reason
      });
  }


  try {

    const trade =
      parseTradeRequest(
        req.body || {}
      );

    const {
      side,
      slotId,
      amountUsd,
      amountSol,
      slippageBps
    } = trade;


    if (
      side === "WAIT" ||
      side === "HOLD"
    ) {
      return res
        .status(200)
        .json({
          status: "ok",
          executed: false,
          decision: "HOLD",
          slotId,
          message:
            "No trade requested"
        });
    }


    if (
      side !== "BUY" &&
      side !== "SELL"
    ) {
      return res
        .status(400)
        .json({
          status: "error",
          executed: false,
          slotId,
          message:
            "Invalid trade side"
        });
    }


    const keypair =
      loadBotKeypair();

    const botAddress =
      verifyWalletMatchesKeypair(
        keypair
      );


    let inputMint;
    let outputMint;
    let atomicAmount;
    let humanAmount;


    if (
      side === "BUY"
    ) {
      if (
        !Number.isFinite(
          amountUsd
        ) ||
        amountUsd <= 0
      ) {
        return res
          .status(400)
          .json({
            status: "error",
            executed: false,
            slotId,
            message:
              "BUY requires valid amountUsd"
          });
      }

      inputMint =
        USDC_MINT;

      outputMint =
        SOL_MINT;

      humanAmount =
        amountUsd;

      atomicAmount =
        toAtomicAmount(
          amountUsd,
          USDC_DECIMALS
        );
    }


    if (
      side === "SELL"
    ) {
      if (
        !Number.isFinite(
          amountSol
        ) ||
        amountSol <= 0
      ) {
        return res
          .status(400)
          .json({
            status: "blocked",
            executed: false,
            slotId,
            reason:
              "SELL_AMOUNT_SOL_REQUIRED",
            message:
              "SELL requires amountSol/quantity"
          });
      }

      inputMint =
        SOL_MINT;

      outputMint =
        USDC_MINT;

      humanAmount =
        amountSol;

      atomicAmount =
        toAtomicAmount(
          amountSol,
          SOL_DECIMALS
        );
    }


    const quote =
      await getJupiterQuote({
        inputMint,
        outputMint,
        atomicAmount,
        slippageBps
      });


    const priceImpactPct =
      safeNumber(
        quote.priceImpactPct,
        0
      );


    if (
      Math.abs(
        priceImpactPct
      ) >
      MAX_PRICE_IMPACT_PCT
    ) {
      return res
        .status(200)
        .json({
          status: "blocked",
          executed: false,
          slotId,
          reason:
            "PRICE_IMPACT_TOO_HIGH",
          priceImpactPct,
          maxPriceImpactPct:
            MAX_PRICE_IMPACT_PCT,
          slippageBps
        });
    }


    const swapData =
      await buildSwap({
        quote,
        walletAddress:
          botAddress
      });


    const transactionBuffer =
      Buffer.from(
        swapData.swapTransaction,
        "base64"
      );

    const transaction =
      VersionedTransaction
        .deserialize(
          transactionBuffer
        );


    transaction.sign([
      keypair
    ]);


    const connection =
      new Connection(
        RPC_URL,
        "confirmed"
      );


    const signature =
      await connection
        .sendRawTransaction(
          transaction.serialize(),
          {
            skipPreflight:
              false,
            maxRetries:
              3
          }
        );


    if (
      swapData.lastValidBlockHeight
    ) {
      await connection
        .confirmTransaction(
          {
            signature,

            blockhash:
              transaction
                .message
                .recentBlockhash,

            lastValidBlockHeight:
              swapData
                .lastValidBlockHeight
          },
          "confirmed"
        );

    } else {

      await connection
        .confirmTransaction(
          signature,
          "confirmed"
        );
    }


    return res
      .status(200)
      .json({
        status: "ok",
        executed: true,
        automatic: true,
        engine:
          "FAWAZ_EXECUTION_AGENT_V4",
        slotId,
        side,
        amount:
          humanAmount,
        amountType:
          side === "BUY"
            ? "USDC"
            : "SOL",
        walletAddress:
          botAddress,
        signature,

        quote: {
          inputMint,
          outputMint,
          inAmount:
            quote.inAmount,
          outAmount:
            quote.outAmount,
          otherAmountThreshold:
            quote.otherAmountThreshold ||
            null,
          priceImpactPct:
            quote.priceImpactPct ||
            null,
          slippageBps
        },

        timestamp:
          new Date()
            .toISOString(),

        message:
          "Trade signed and executed automatically"
      });


  } catch (error) {

    console.error(
      "Execution Agent Error:",
      error
    );

    return res
      .status(500)
      .json({
        status: "error",
        executed: false,
        engine:
          "FAWAZ_EXECUTION_AGENT_V4",
        message:
          error?.message ||
          "Execution Agent failed",
        timestamp:
          new Date()
            .toISOString()
      });
  }
}
