// /api/trade-orchestrator.js
// FAWAZ AI BOT
// Parallel Micro Scalper Orchestrator v5

import {
  evaluateRisk,
  getDynamicRiskMode
} from "./risk-agent.js";

import {
  getOpenPositions,
  getFreeSlot,
  openPosition,
  closePosition,
  updateHighestPrice,
  activateTrailing,
  getRecentClosedTrades,
  getTradingDashboard
} from "./trading-store.js";


// ======================================================
// CONFIG
// ======================================================

const CONFIG = {
  maxSlots: 4,

  defaultSlotUsd: 5,

  // نستخدم 80% ونترك 20% احتياطي
  reservePct: 0.20,

  // Dynamic TP
  calmTargetBps: 30,
  normalTargetBps: 45,
  fastTargetBps: 70,

  // Stop Loss
  stopLossBps: 45,

  // Trailing
  trailingActivationRatio: 0.65,
  trailingDistanceRatio: 0.30,

  // Execution protection
  maxSlippageBps: 30,

  minNetEdgeBps: 12,

  // لا نفتح الأربع Slots دفعة واحدة
  // إلا إذا كانت الإشارة قوية جدًا
  maxEntriesPerCycle: 2
};


const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;


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


function toBps(value) {
  return value * 10000;
}


function atomicToAmount(
  value,
  decimals
) {
  return (
    num(value) /
    Math.pow(
      10,
      decimals
    )
  );
}


// ======================================================
// AUTH
// ======================================================

function authorize(req) {
  const secret =
    process.env.AUTO_TRADER_SECRET;

  if (!secret) {
    return {
      ok: false,
      status: 500,
      reason:
        "AUTO_TRADER_SECRET_MISSING"
    };
  }

  const header =
    req.headers.authorization ||
    req.headers.Authorization ||
    "";

  if (
    header !==
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
      `HTTP_${response.status}:${JSON.stringify(
        data
      )}`
    );
  }

  return data;
}


// ======================================================
// LOAD SIGNAL AGENT
// ======================================================

async function loadSignal(req) {
  const baseUrl =
    getBaseUrl(req);

  const data =
    await fetchJson(
      `${
