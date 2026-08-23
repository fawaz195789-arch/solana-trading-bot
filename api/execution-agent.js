import {
  Connection,
  Keypair,
  VersionedTransaction
} from "@solana/web3.js";

import bs58 from "bs58";

const SOL_MINT =
  "So11111111111111111111111111111111111111112";

const USDC_MINT =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;

const RPC_URL =
  process.env.SOLANA_RPC_URL ||
  "https://api.mainnet-beta.solana.com";

const JUPITER_QUOTE_URL =
  "https://api.jup.ag/swap/v1/quote";

const JUPITER_SWAP_URL =
  "https://api.jup.ag/swap/v1/swap";


// =========================
// JUPITER HEADERS
// =========================

function jupiterHeaders() {
  const headers = {
    "Content-Type": "application/json"
  };

  if (process.env.JUPITER_API_KEY) {
    headers["x-api-key"] =
      process.env.JUPITER_API_KEY;
  }

  return headers;
}


// =========================
// PRIVATE KEY
// Supports Base58 or JSON Array
// =========================

function loadBotKeypair() {
  const raw =
    process.env.BOT_SOLANA_PRIVATE_KEY;

  if (!raw) {
    throw new Error(
      "BOT_SOLANA_PRIVATE_KEY is missing"
    );
  }

  const value = raw.trim();

  try {
    // JSON array:
    // [12,34,56,...]

    if (
      value.startsWith("[") &&
      value.endsWith("]")
    ) {
      const parsed =
        JSON.parse(value);

      if (!Array.isArray(parsed)) {
        throw new Error(
          "Private key JSON is not an array"
        );
      }

      const secret =
        Uint8Array.from(parsed);

      return Keypair.fromSecretKey(
        secret
      );
    }

    // Base58

    const secret =
      bs58.decode(value);

    return Keypair.fromSecretKey(
      secret
    );

  } catch (error) {
    throw new Error(
      "Invalid BOT_SOLANA_PRIVATE_KEY format"
    );
  }
}


// =========================
// AMOUNT
// =========================

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
      "Invalid trade amount"
    );
  }

  return Math.floor(
    numeric *
    Math.pow(10, decimals)
  ).toString();
}


// =========================
// MAIN
// =========================

export default async function handler(
  req,
  res
) {
  if (req.method !== "POST") {
    return res.status(405).json({
      status: "error",
      executed: false,
      message: "POST only"
    });
  }

  try {
    const {
      decision,
      confidence,
      riskApproved,
      amount,
      walletAddress
    } = req.body || {};

    const side =
      String(
        decision || ""
      ).toUpperCase();

    // =========================
    // HOLD
    // =========================

    if (
      side === "HOLD" ||
      side === "WAIT"
    ) {
      return res.status(200).json({
        status: "ok",
        executed: false,
        decision: "HOLD",
        message:
          "No trade requested"
      });
    }

    // =========================
    // SIDE
    // =========================

    if (
      side !== "BUY" &&
      side !== "SELL"
    ) {
      return res.status(400).json({
        status: "error",
        executed: false,
        message:
          "Invalid trade decision"
      });
    }

    // =========================
    // CONFIDENCE
    // =========================

    const confidenceNumber =
      Number(confidence);

    if (
      !Number.isFinite(
        confidenceNumber
      ) ||
      confidenceNumber < 70
    ) {
      return res.status(200).json({
        status: "blocked",
        executed: false,
        reason: "LOW_CONFIDENCE",
        confidence:
          confidenceNumber
      });
    }

    // =========================
    // RISK AGENT
    // =========================

    if (riskApproved !== true) {
      return res.status(200).json({
        status: "blocked",
        executed: false,
        reason: "RISK_REJECTED",
        message:
          "Trade rejected by Risk Agent"
      });
    }

    // =========================
    // AMOUNT
    // =========================

    const amountNumber =
      Number(amount);

    if (
      !Number.isFinite(
        amountNumber
      ) ||
      amountNumber <= 0
    ) {
      return res.status(400).json({
        status: "error",
        executed: false,
        message:
          "Invalid amount"
      });
    }

    // =========================
    // WALLET
    // =========================

    if (
      !walletAddress ||
      typeof walletAddress !==
        "string"
    ) {
      return res.status(400).json({
        status: "error",
        executed: false,
        message:
          "walletAddress required"
      });
    }

    // =========================
    // LOAD BOT WALLET
    // =========================

    const keypair =
      loadBotKeypair();

    const botAddress =
      keypair.publicKey.toString();

    // Critical protection:
    // private key must match wallet

    if (
      botAddress !== walletAddress
    ) {
      return res.status(403).json({
        status: "blocked",
        executed: false,
        reason:
          "WALLET_KEY_MISMATCH",
        message:
          "BOT_SOLANA_PRIVATE_KEY does not match walletAddress"
      });
    }

    // =========================
    // MINT DIRECTION
    // =========================

    let inputMint;
    let outputMint;
    let atomicAmount;

    // BUY SOL using USDC

    if (side === "BUY") {
      inputMint =
        USDC_MINT;

      outputMint =
        SOL_MINT;

      atomicAmount =
        toAtomicAmount(
          amountNumber,
          USDC_DECIMALS
        );
    }

    // SELL SOL for USDC

    if (side === "SELL") {
      inputMint =
        SOL_MINT;

      outputMint =
        USDC_MINT;

      atomicAmount =
        toAtomicAmount(
          amountNumber,
          SOL_DECIMALS
        );
    }

    // =========================
    // GET JUPITER QUOTE
    // =========================

    const params =
      new URLSearchParams({
        inputMint,
        outputMint,
        amount:
          atomicAmount,

        // 1%
        slippageBps: "100"
      });

    const quoteResponse =
      await fetch(
        `${JUPITER_QUOTE_URL}?${params.toString()}`,
        {
          method: "GET",
          headers:
            jupiterHeaders()
        }
      );

    const quote =
      await quoteResponse.json();

    if (
      !quoteResponse.ok ||
      !quote?.outAmount
    ) {
      console.error(
        "Jupiter Quote Error:",
        quote
      );

      return res.status(502).json({
        status: "error",
        executed: false,
        message:
          "Failed to get Jupiter quote",
        details: quote
      });
    }

    // =========================
    // BUILD SWAP
    // =========================

    const swapResponse =
      await fetch(
        JUPITER_SWAP_URL,
        {
          method: "POST",

          headers:
            jupiterHeaders(),

          body: JSON.stringify({
            quoteResponse:
              quote,

            userPublicKey:
              botAddress,

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

    const swapData =
      await swapResponse.json();

    if (
      !swapResponse.ok ||
      !swapData?.swapTransaction
    ) {
      console.error(
        "Jupiter Swap Error:",
        swapData
      );

      return res.status(502).json({
        status: "error",
        executed: false,
        message:
          "Failed to build Jupiter swap",
        details:
          swapData
      });
    }

    // =========================
    // DESERIALIZE
    // =========================

    const transactionBuffer =
      Buffer.from(
        swapData.swapTransaction,
        "base64"
      );

    const transaction =
      VersionedTransaction.deserialize(
        transactionBuffer
      );

    // =========================
    // SIGN AUTOMATICALLY
    // =========================

    transaction.sign([
      keypair
    ]);

    // =========================
    // SEND TO SOLANA
    // =========================

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
            skipPreflight: false,
            maxRetries: 3
          }
        );

    // =========================
    // CONFIRM
    // =========================

    if (
      swapData.lastValidBlockHeight
    ) {
      await connection
        .confirmTransaction(
          {
            signature,

            blockhash:
              transaction.message
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

    // =========================
    // SUCCESS
    // =========================

    return res.status(200).json({
      status: "ok",

      executed: true,

      automatic: true,

      decision:
        side,

      confidence:
        confidenceNumber,

      amount:
        amountNumber,

      walletAddress:
        botAddress,

      signature,

      quote: {
        inAmount:
          quote.inAmount,

        outAmount:
          quote.outAmount,

        priceImpactPct:
          quote.priceImpactPct ||
          null,

        slippageBps:
          quote.slippageBps ||
          100
      },

      message:
        "Trade signed and executed automatically"
    });

  } catch (error) {
    console.error(
      "Execution Agent Error:",
      error
    );

    return res.status(500).json({
      status: "error",
      executed: false,

      message:
        error?.message ||
        "Execution Agent failed"
    });
  }
}
