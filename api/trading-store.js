// /api/trading-store.js
// FAWAZ AI TRADER V8 GROWTH PRO
// Database + position memory + equity + performance + locking

import crypto from "crypto";
import { neon } from "@neondatabase/serverless";

let tablesReadyPromise = null;


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


function round(
  value,
  digits = 6
) {
  return Number(
    num(value).toFixed(digits)
  );
}


function getTradeTime(
  trade
) {
  const raw =
    trade?.closed_at ||
    trade?.closedAt ||
    trade?.timestamp ||
    trade?.created_at ||
    trade?.opened_at ||
    0;

  const value =
    new Date(raw).getTime();

  return Number.isFinite(value)
    ? value
    : 0;
}


// ======================================================
// DATABASE
// ======================================================

function getDatabaseUrl() {
  const direct =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.NEON_DATABASE_URL ||
    process.env.STORAGE_URL;

  if (direct) {
    return direct;
  }

  for (
    const value
    of Object.values(
      process.env
    )
  ) {
    if (
      typeof value === "string" &&
      (
        value.startsWith(
          "postgres://"
        ) ||
        value.startsWith(
          "postgresql://"
        )
      )
    ) {
      return value;
    }
  }

  throw new Error(
    "Postgres database URL not found"
  );
}


function db() {
  return neon(
    getDatabaseUrl()
  );
}


// ======================================================
// CREATE / UPGRADE TABLES
// ======================================================

async function initTradingTables() {
  const sql = db();


  // ====================================================
  // POSITIONS
  // ====================================================

  await sql`
    CREATE TABLE IF NOT EXISTS bot_positions (
      id SERIAL PRIMARY KEY,

      wallet_address TEXT NOT NULL,

      symbol TEXT NOT NULL
        DEFAULT 'SOL-USDC',

      status TEXT NOT NULL
        DEFAULT 'OPEN',

      slot_id INTEGER NOT NULL
        DEFAULT 1,

      strategy TEXT NOT NULL
        DEFAULT 'LEGACY',

      setup TEXT,

      entry_signal_id TEXT,

      entry_price DOUBLE PRECISION
        NOT NULL,

      entry_sol DOUBLE PRECISION
        NOT NULL,

      entry_usdc DOUBLE PRECISION
        NOT NULL,

      buy_signature TEXT,

      opened_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW(),

      entry_score DOUBLE PRECISION,

      prediction_score
        DOUBLE PRECISION,

      market_regime_at_entry
        TEXT,

      entry_confidence
        DOUBLE PRECISION,

      estimated_entry_cost_bps
        DOUBLE PRECISION,

      highest_price
        DOUBLE PRECISION,

      target_bps
        DOUBLE PRECISION,

      trailing_active BOOLEAN
        NOT NULL DEFAULT FALSE,

      trailing_distance_bps
        DOUBLE PRECISION,

      trailing_activated_at
        TIMESTAMPTZ,

      profit_lock_price
        DOUBLE PRECISION,

      max_favorable_excursion_bps
        DOUBLE PRECISION
        NOT NULL DEFAULT 0,

      max_adverse_excursion_bps
        DOUBLE PRECISION
        NOT NULL DEFAULT 0,

      last_mark_price
        DOUBLE PRECISION,

      exit_price
        DOUBLE PRECISION,

      exit_usdc
        DOUBLE PRECISION,

      sell_signature TEXT,

      close_reason TEXT,

      realized_pnl
        DOUBLE PRECISION,

      realized_pnl_pct
        DOUBLE PRECISION,

      closed_at TIMESTAMPTZ
    )
  `;


  // ====================================================
  // SAFE MIGRATIONS
  // ====================================================

  await sql`
    ALTER TABLE bot_positions
    ADD COLUMN IF NOT EXISTS
      slot_id INTEGER
  `;

  await sql`
    ALTER TABLE bot_positions
    ADD COLUMN IF NOT EXISTS
      strategy TEXT
  `;

  await sql`
    ALTER TABLE bot_positions
    ADD COLUMN IF NOT EXISTS
      setup TEXT
  `;

  await sql`
    ALTER TABLE bot_positions
    ADD COLUMN IF NOT EXISTS
      entry_signal_id TEXT
  `;

  await sql`
    ALTER TABLE bot_positions
    ADD COLUMN IF NOT EXISTS
      entry_score DOUBLE PRECISION
  `;

  await sql`
    ALTER TABLE bot_positions
    ADD COLUMN IF NOT EXISTS
      prediction_score
      DOUBLE PRECISION
  `;

  await sql`
    ALTER TABLE bot_positions
    ADD COLUMN IF NOT EXISTS
      market_regime_at_entry TEXT
  `;

  await sql`
    ALTER TABLE bot_positions
    ADD COLUMN IF NOT EXISTS
      entry_confidence
      DOUBLE PRECISION
  `;

  await sql`
    ALTER TABLE bot_positions
    ADD COLUMN IF NOT EXISTS
      estimated_entry_cost_bps
      DOUBLE PRECISION
  `;

  await sql`
    ALTER TABLE bot_positions
    ADD COLUMN IF NOT EXISTS
      highest_price
      DOUBLE PRECISION
  `;

  await sql`
    ALTER TABLE bot_positions
    ADD COLUMN IF NOT EXISTS
      target_bps
      DOUBLE PRECISION
  `;

  await sql`
    ALTER TABLE bot_positions
    ADD COLUMN IF NOT EXISTS
      trailing_active BOOLEAN
  `;

  await sql`
    ALTER TABLE bot_positions
    ADD COLUMN IF NOT EXISTS
      trailing_distance_bps
      DOUBLE PRECISION
  `;

  await sql`
    ALTER TABLE bot_positions
    ADD COLUMN IF NOT EXISTS
      trailing_activated_at
      TIMESTAMPTZ
  `;

  await sql`
    ALTER TABLE bot_positions
    ADD COLUMN IF NOT EXISTS
      profit_lock_price
      DOUBLE PRECISION
  `;

  await sql`
    ALTER TABLE bot_positions
    ADD COLUMN IF NOT EXISTS
      max_favorable_excursion_bps
      DOUBLE PRECISION
      DEFAULT 0
  `;

  await sql`
    ALTER TABLE bot_positions
    ADD COLUMN IF NOT EXISTS
      max_adverse_excursion_bps
      DOUBLE PRECISION
      DEFAULT 0
  `;

  await sql`
    ALTER TABLE bot_positions
    ADD COLUMN IF NOT EXISTS
      last_mark_price
      DOUBLE PRECISION
  `;

  await sql`
    ALTER TABLE bot_positions
    ADD COLUMN IF NOT EXISTS
      close_reason TEXT
  `;


  // ====================================================
  // NORMALIZE LEGACY ROWS
  // ====================================================

  await sql`
    UPDATE bot_positions
    SET slot_id = 1
    WHERE slot_id IS NULL
  `;

  await sql`
    UPDATE bot_positions
    SET strategy = 'LEGACY'
    WHERE strategy IS NULL
  `;

  await sql`
    UPDATE bot_positions
    SET trailing_active = FALSE
    WHERE trailing_active IS NULL
  `;

  await sql`
    UPDATE bot_positions
    SET
      max_favorable_excursion_bps = 0
    WHERE
      max_favorable_excursion_bps
      IS NULL
  `;

  await sql`
    UPDATE bot_positions
    SET
      max_adverse_excursion_bps = 0
    WHERE
      max_adverse_excursion_bps
      IS NULL
  `;


  // ====================================================
  // SLOT CLAIMS
  // Temporary lock used only while BUY is executing.
  // Open positions themselves are checked separately.
  // ====================================================

  await sql`
    CREATE TABLE IF NOT EXISTS bot_slot_claims (
      wallet_address TEXT NOT NULL,

      slot_id INTEGER NOT NULL,

      claim_token TEXT,

      claimed_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW(),

      PRIMARY KEY (
        wallet_address,
        slot_id
      )
    )
  `;

  await sql`
    ALTER TABLE bot_slot_claims
    ADD COLUMN IF NOT EXISTS
      claim_token TEXT
  `;


  // ====================================================
  // CYCLE LOCK
  // ====================================================

  await sql`
    CREATE TABLE IF NOT EXISTS bot_cycle_locks (
      wallet_address TEXT PRIMARY KEY,

      token TEXT NOT NULL,

      lock_until TIMESTAMPTZ
        NOT NULL
    )
  `;


  // ====================================================
  // EQUITY HISTORY
  // ====================================================

  await sql`
    CREATE TABLE IF NOT EXISTS bot_equity_snapshots (
      wallet_address TEXT NOT NULL,

      bucket_minute TIMESTAMPTZ
        NOT NULL,

      equity_usd DOUBLE PRECISION
        NOT NULL,

      usdc_balance DOUBLE PRECISION,

      sol_balance DOUBLE PRECISION,

      sol_price DOUBLE PRECISION,

      created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW(),

      PRIMARY KEY (
        wallet_address,
        bucket_minute
      )
    )
  `;

  await sql`
    ALTER TABLE bot_equity_snapshots
    ADD COLUMN IF NOT EXISTS
      usdc_balance DOUBLE PRECISION
  `;

  await sql`
    ALTER TABLE bot_equity_snapshots
    ADD COLUMN IF NOT EXISTS
      sol_balance DOUBLE PRECISION
  `;

  await sql`
    ALTER TABLE bot_equity_snapshots
    ADD COLUMN IF NOT EXISTS
      sol_price DOUBLE PRECISION
  `;


  // ====================================================
  // INDEXES
  // ====================================================

  await sql`
    CREATE INDEX IF NOT EXISTS
      idx_bot_positions_wallet_status
    ON bot_positions(
      wallet_address,
      status
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS
      idx_bot_positions_wallet_slot
    ON bot_positions(
      wallet_address,
      slot_id,
      status
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS
      idx_bot_positions_closed_at
    ON bot_positions(
      closed_at
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS
      idx_bot_positions_entry_signal
    ON bot_positions(
      wallet_address,
      entry_signal_id
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS
      idx_bot_equity_wallet_time
    ON bot_equity_snapshots(
      wallet_address,
      bucket_minute
    )
  `;
}


export async function ensureTradingTables() {
  if (!tablesReadyPromise) {
    tablesReadyPromise =
      initTradingTables()
        .catch(
          error => {
            tablesReadyPromise =
              null;

            throw error;
          }
        );
  }

  return tablesReadyPromise;
}


// ======================================================
// CLEAN EXPIRED CLAIMS
// ======================================================

async function cleanExpiredSlotClaims(
  walletAddress
) {
  await ensureTradingTables();

  const sql = db();

  await sql`
    DELETE FROM bot_slot_claims

    WHERE wallet_address =
      ${walletAddress}

      AND claimed_at <
        NOW() -
        INTERVAL '5 minutes'
  `;
}


// ======================================================
// CYCLE LOCK
// ======================================================

export async function acquireCycleLock(
  walletOrObject,
  ttlSecondsArg = 45
) {
  await ensureTradingTables();

  const sql = db();

  const walletAddress =
    typeof walletOrObject ===
      "object"
      ? walletOrObject
          ?.walletAddress
      : walletOrObject;

  const ttlSeconds =
    typeof walletOrObject ===
      "object"
      ? num(
          walletOrObject
            ?.ttlSeconds,
          ttlSecondsArg
        )
      : num(
          ttlSecondsArg,
          45
        );

  if (!walletAddress) {
    throw new Error(
      "CYCLE_LOCK_WALLET_MISSING"
    );
  }

  const token =
    crypto.randomUUID();

  const ttl =
    Math.max(
      10,
      Math.min(
        120,
        Math.floor(
          ttlSeconds
        )
      )
    );

  const rows =
    await sql`
      INSERT INTO bot_cycle_locks (
        wallet_address,
        token,
        lock_until
      )

      VALUES (
        ${walletAddress},
        ${token},
        NOW() +
          (
            ${ttl} *
            INTERVAL '1 second'
          )
      )

      ON CONFLICT (
        wallet_address
      )

      DO UPDATE SET
        token =
          EXCLUDED.token,

        lock_until =
          EXCLUDED.lock_until

      WHERE
        bot_cycle_locks
          .lock_until <
        NOW()

      RETURNING *
    `;

  return (
    rows[0] ||
    null
  );
}


export async function releaseCycleLock(
  walletOrObject,
  tokenArg = null
) {
  await ensureTradingTables();

  const sql = db();

  const walletAddress =
    typeof walletOrObject ===
      "object"
      ? walletOrObject
          ?.walletAddress
      : walletOrObject;

  const token =
    typeof walletOrObject ===
      "object"
      ? walletOrObject
          ?.token
      : tokenArg;

  if (
    !walletAddress ||
    !token
  ) {
    return;
  }

  await sql`
    DELETE FROM bot_cycle_locks

    WHERE wallet_address =
      ${walletAddress}

      AND token =
      ${token}
  `;
}


// ======================================================
// SLOT CLAIM
// ======================================================

export async function claimSlot(
  walletOrObject,
  slotArg = null
) {
  await ensureTradingTables();

  const sql = db();

  const walletAddress =
    typeof walletOrObject ===
      "object"
      ? walletOrObject
          ?.walletAddress
      : walletOrObject;

  const slotId =
    Number(
      typeof walletOrObject ===
        "object"
        ? walletOrObject
            ?.slotId
        : slotArg
    );

  const requestedToken =
    typeof walletOrObject ===
      "object"
      ? walletOrObject
          ?.claimToken
      : null;

  const claimToken =
    requestedToken ||
    crypto.randomUUID();

  if (
    !walletAddress ||
    !Number.isInteger(slotId) ||
    slotId < 1
  ) {
    return {
      acquired: false,
      reason:
        "INVALID_SLOT_CLAIM"
    };
  }

  await cleanExpiredSlotClaims(
    walletAddress
  );

  // Never claim a slot that already has
  // a real open position.
  const openRows =
    await sql`
      SELECT id

      FROM bot_positions

      WHERE wallet_address =
        ${walletAddress}

        AND slot_id =
        ${slotId}

        AND status =
        'OPEN'

        AND (
          strategy IS NULL
          OR strategy NOT LIKE
          'PAPER%'
        )

        AND (
          buy_signature IS NULL
          OR buy_signature <>
          'PAPER_BUY'
        )

      LIMIT 1
    `;

  if (openRows[0]) {
    return {
      acquired: false,
      reason:
        "SLOT_ALREADY_OPEN"
    };
  }

  const rows =
    await sql`
      INSERT INTO bot_slot_claims (
        wallet_address,
        slot_id,
        claim_token,
        claimed_at
      )

      VALUES (
        ${walletAddress},
        ${slotId},
        ${claimToken},
        NOW()
      )

      ON CONFLICT DO NOTHING

      RETURNING *
    `;

  if (!rows[0]) {
    return {
      acquired: false,
      reason:
        "SLOT_ALREADY_CLAIMED"
    };
  }

  return {
    acquired: true,

    walletAddress,

    slotId,

    token:
      rows[0].claim_token ||
      claimToken
  };
}


export async function releaseSlot(
  walletOrObject,
  slotArg = null
) {
  await ensureTradingTables();

  const sql = db();

  const walletAddress =
    typeof walletOrObject ===
      "object"
      ? walletOrObject
          ?.walletAddress
      : walletOrObject;

  const slotId =
    Number(
      typeof walletOrObject ===
        "object"
        ? walletOrObject
            ?.slotId
        : slotArg
    );

  if (
    !walletAddress ||
    !Number.isInteger(slotId)
  ) {
    return;
  }

  await sql`
    DELETE FROM bot_slot_claims

    WHERE wallet_address =
      ${walletAddress}

      AND slot_id =
      ${slotId}
  `;
}


// ======================================================
// GET OPEN POSITIONS
// ======================================================

export async function getOpenPositions(
  walletAddress
) {
  await ensureTradingTables();

  const sql = db();

  const rows =
    await sql`
      SELECT *

      FROM bot_positions

      WHERE wallet_address =
        ${walletAddress}

        AND status =
        'OPEN'

        AND (
          strategy IS NULL
          OR strategy NOT LIKE
          'PAPER%'
        )

        AND (
          buy_signature IS NULL
          OR buy_signature <>
          'PAPER_BUY'
        )

      ORDER BY
        slot_id ASC,
        opened_at ASC
    `;

  return rows || [];
}


// ======================================================
// FIRST OPEN POSITION
// ======================================================

export async function getOpenPosition(
  walletAddress
) {
  const positions =
    await getOpenPositions(
      walletAddress
    );

  return (
    positions[0] ||
    null
  );
}


// ======================================================
// POSITION BY SLOT
// ======================================================

export async function getOpenPositionBySlot(
  walletAddress,
  slotId
) {
  await ensureTradingTables();

  const sql = db();

  const rows =
    await sql`
      SELECT *

      FROM bot_positions

      WHERE wallet_address =
        ${walletAddress}

        AND status =
        'OPEN'

        AND slot_id =
        ${Number(slotId)}

        AND (
          strategy IS NULL
          OR strategy NOT LIKE
          'PAPER%'
        )

        AND (
          buy_signature IS NULL
          OR buy_signature <>
          'PAPER_BUY'
        )

      ORDER BY
        opened_at DESC

      LIMIT 1
    `;

  return (
    rows[0] ||
    null
  );
}


// ======================================================
// FREE SLOT
// Checks BOTH real open positions + temporary claims.
// ======================================================

export async function getFreeSlot(
  walletAddress,
  maxSlots = 12
) {
  await ensureTradingTables();

  const sql = db();

  await cleanExpiredSlotClaims(
    walletAddress
  );

  const openRows =
    await sql`
      SELECT slot_id

      FROM bot_positions

      WHERE wallet_address =
        ${walletAddress}

        AND status =
        'OPEN'

        AND (
          strategy IS NULL
          OR strategy NOT LIKE
          'PAPER%'
        )

        AND (
          buy_signature IS NULL
          OR buy_signature <>
          'PAPER_BUY'
        )
    `;

  const claimRows =
    await sql`
      SELECT slot_id

      FROM bot_slot_claims

      WHERE wallet_address =
        ${walletAddress}
    `;

  const used =
    new Set();

  for (
    const row
    of openRows
  ) {
    used.add(
      Number(row.slot_id)
    );
  }

  for (
    const row
    of claimRows
  ) {
    used.add(
      Number(row.slot_id)
    );
  }

  const safeMax =
    Math.max(
      1,
      Math.floor(
        num(maxSlots, 12)
      )
    );

  for (
    let slot = 1;
    slot <= safeMax;
    slot++
  ) {
    if (!used.has(slot)) {
      return slot;
    }
  }

  return null;
}


// ======================================================
// SIGNAL DEDUPLICATION
// Supports:
// hasUsedEntrySignal(wallet, signal)
// OR
// hasUsedEntrySignal({walletAddress, signalId})
// ======================================================

export async function hasUsedEntrySignal(
  walletOrObject,
  signalArg = null
) {
  const walletAddress =
    typeof walletOrObject ===
      "object"
      ? walletOrObject
          ?.walletAddress
      : walletOrObject;

  const signalId =
    typeof walletOrObject ===
      "object"
      ? walletOrObject
          ?.signalId
      : signalArg;

  if (
    !walletAddress ||
    !signalId
  ) {
    return false;
  }

  await ensureTradingTables();

  const sql = db();

  const rows =
    await sql`
      SELECT id

      FROM bot_positions

      WHERE wallet_address =
        ${walletAddress}

        AND entry_signal_id =
        ${String(signalId)}

        AND opened_at >=
        NOW() -
        INTERVAL '15 minutes'

        AND (
          strategy IS NULL
          OR strategy NOT LIKE
          'PAPER%'
        )

        AND (
          buy_signature IS NULL
          OR buy_signature <>
          'PAPER_BUY'
        )

      LIMIT 1
    `;

  return Boolean(
    rows[0]
  );
}


// ======================================================
// OPEN POSITION
// Requires a temporary slot claim.
// ======================================================

export async function openPosition({
  walletAddress,
  slotId,

  entryPrice,
  entrySol,
  entryUsdc,

  signature,

  strategy =
    "FAWAZ_V8_GROWTH",

  setup = null,

  signalId = null,

  entryScore = null,

  predictionScore = null,

  marketRegime = null,

  entryConfidence = null,

  estimatedEntryCostBps = null,

  targetBps = null,

  trailingDistanceBps = null
}) {
  await ensureTradingTables();

  const sql = db();

  const numericSlot =
    Number(slotId);

  if (
    !Number.isInteger(
      numericSlot
    ) ||
    numericSlot < 1
  ) {
    throw new Error(
      "INVALID_SLOT_ID"
    );
  }

  if (
    num(entryPrice) <= 0 ||
    num(entrySol) <= 0 ||
    num(entryUsdc) <= 0
  ) {
    throw new Error(
      "INVALID_POSITION_ENTRY_DATA"
    );
  }


  // Slot must have been claimed first.
  const claimRows =
    await sql`
      SELECT 1

      FROM bot_slot_claims

      WHERE wallet_address =
        ${walletAddress}

        AND slot_id =
        ${numericSlot}

      LIMIT 1
    `;

  if (!claimRows[0]) {
    throw new Error(
      "SLOT_NOT_CLAIMED"
    );
  }


  // Extra protection against an already-open slot.
  const existing =
    await sql`
      SELECT id

      FROM bot_positions

      WHERE wallet_address =
        ${walletAddress}

        AND slot_id =
        ${numericSlot}

        AND status =
        'OPEN'

      LIMIT 1
    `;

  if (existing[0]) {
    throw new Error(
      "SLOT_ALREADY_OPEN"
    );
  }


  const rows =
    await sql`
      INSERT INTO bot_positions (
        wallet_address,
        symbol,
        status,

        slot_id,
        strategy,
        setup,
        entry_signal_id,

        entry_price,
        entry_sol,
        entry_usdc,

        highest_price,

        target_bps,

        trailing_active,

        trailing_distance_bps,

        buy_signature,

        opened_at,

        entry_score,

        prediction_score,

        market_regime_at_entry,

        entry_confidence,

        estimated_entry_cost_bps,

        max_favorable_excursion_bps,

        max_adverse_excursion_bps,

        last_mark_price
      )

      VALUES (
        ${walletAddress},

        'SOL-USDC',

        'OPEN',

        ${numericSlot},

        ${strategy},

        ${setup},

        ${signalId},

        ${Number(entryPrice)},

        ${Number(entrySol)},

        ${Number(entryUsdc)},

        ${Number(entryPrice)},

        ${
          targetBps !== null
            ? Number(targetBps)
            : null
        },

        FALSE,

        ${
          trailingDistanceBps !==
          null
            ? Number(
                trailingDistanceBps
              )
            : null
        },

        ${signature || null},

        NOW(),

        ${
          entryScore !== null
            ? Number(entryScore)
            : null
        },

        ${
          predictionScore !== null
            ? Number(
                predictionScore
              )
            : null
        },

        ${marketRegime},

        ${
          entryConfidence !== null
            ? Number(
                entryConfidence
              )
            : null
        },

        ${
          estimatedEntryCostBps !==
          null
            ? Number(
                estimatedEntryCostBps
              )
            : null
        },

        0,

        0,

        ${Number(entryPrice)}
      )

      RETURNING *
    `;

  return rows[0];
}


// ======================================================
// POSITION TELEMETRY
// Accepts either:
// {id,currentPrice}
// or extended values from earlier V8 code.
// ======================================================

export async function updatePositionTelemetry({
  id,

  currentPrice = null,

  highestPrice = null,

  maxFavorableExcursionBps =
    null,

  maxAdverseExcursionBps =
    null
}) {
  await ensureTradingTables();

  const sql = db();

  const rows =
    await sql`
      SELECT *

      FROM bot_positions

      WHERE id =
        ${Number(id)}

        AND status =
        'OPEN'

      LIMIT 1
    `;

  const position =
    rows[0];

  if (!position) {
    return null;
  }

  const entryPrice =
    num(
      position.entry_price
    );

  const price =
    num(
      currentPrice ??
      highestPrice ??
      position.last_mark_price ??
      entryPrice,
      entryPrice
    );

  const calculatedPnlBps =
    entryPrice > 0
      ? (
          (
            price -
            entryPrice
          ) /
          entryPrice
        ) * 10000
      : 0;

  const nextHigh =
    Math.max(
      entryPrice,

      num(
        position.highest_price,
        entryPrice
      ),

      num(
        highestPrice,
        price
      ),

      price
    );

  const nextMfe =
    Math.max(
      0,

      num(
        position
          .max_favorable_excursion_bps,
        0
      ),

      calculatedPnlBps,

      num(
        maxFavorableExcursionBps,
        calculatedPnlBps
      )
    );

  const nextMae =
    Math.min(
      0,

      num(
        position
          .max_adverse_excursion_bps,
        0
      ),

      calculatedPnlBps,

      num(
        maxAdverseExcursionBps,
        calculatedPnlBps
      )
    );

  const updated =
    await sql`
      UPDATE bot_positions

      SET
        highest_price =
          ${nextHigh},

        last_mark_price =
          ${price},

        max_favorable_excursion_bps =
          ${nextMfe},

        max_adverse_excursion_bps =
          ${nextMae}

      WHERE id =
        ${Number(id)}

        AND status =
        'OPEN'

      RETURNING *
    `;

  return (
    updated[0] ||
    null
  );
}


// ======================================================
// LEGACY HIGH UPDATE
// ======================================================

export async function updateHighestPrice({
  id,
  highestPrice
}) {
  return updatePositionTelemetry({
    id,

    currentPrice:
      highestPrice,

    highestPrice
  });
}


// ======================================================
// ACTIVATE TRAILING
// ======================================================

export async function activateTrailing({
  id,

  highestPrice = null,

  trailingDistanceBps = null,

  profitLockPrice = null
}) {
  await ensureTradingTables();

  const sql = db();

  const rows =
    await sql`
      UPDATE bot_positions

      SET
        trailing_active =
          TRUE,

        trailing_activated_at =
          COALESCE(
            trailing_activated_at,
            NOW()
          ),

        highest_price =
          CASE

            WHEN ${
              highestPrice
            }::double precision
              IS NULL

            THEN highest_price

            ELSE GREATEST(
              COALESCE(
                highest_price,
                entry_price
              ),

              ${
                highestPrice
              }::double precision
            )

          END,

        trailing_distance_bps =
          COALESCE(
            ${
              trailingDistanceBps
            }::double precision,

            trailing_distance_bps
          ),

        profit_lock_price =
          COALESCE(
            ${
              profitLockPrice
            }::double precision,

            profit_lock_price
          )

      WHERE id =
        ${Number(id)}

        AND status =
        'OPEN'

      RETURNING *
    `;

  return (
    rows[0] ||
    null
  );
}


// ======================================================
// CLOSE POSITION
// ======================================================

export async function closePosition({
  id,
  exitPrice,
  exitUsdc,
  signature,
  reason = "EXIT"
}) {
  await ensureTradingTables();

  const sql = db();

  const receivedUsdc =
    Number(exitUsdc);

  if (
    !Number.isFinite(
      receivedUsdc
    ) ||
    receivedUsdc < 0
  ) {
    throw new Error(
      "INVALID_EXIT_USDC"
    );
  }

  const rows =
    await sql`
      UPDATE bot_positions

      SET
        status =
          'CLOSED',

        exit_price =
          ${Number(exitPrice)},

        exit_usdc =
          ${receivedUsdc},

        sell_signature =
          ${signature || null},

        close_reason =
          ${reason},

        realized_pnl =
          ${receivedUsdc} -
          entry_usdc,

        realized_pnl_pct =
          CASE

            WHEN entry_usdc > 0

            THEN (
              (
                ${receivedUsdc} -
                entry_usdc
              ) /
              entry_usdc
            ) * 100

            ELSE 0

          END,

        closed_at =
          NOW()

      WHERE id =
        ${Number(id)}

        AND status =
        'OPEN'

      RETURNING *
    `;

  const updated =
    rows[0] ||
    null;

  if (!updated) {
    throw new Error(
      "LIVE_OPEN_POSITION_NOT_FOUND_OR_ALREADY_CLOSED"
    );
  }

  // Clear any old temporary claim.
  await releaseSlot(
    updated.wallet_address,
    updated.slot_id
  );

  return updated;
}


// ======================================================
// RECENT CLOSED TRADES
// ======================================================

export async function getRecentClosedTrades(
  walletAddress,
  limit = 50
) {
  await ensureTradingTables();

  const sql = db();

  const safeLimit =
    Math.max(
      1,
      Math.min(
        200,
        Number(limit) || 50
      )
    );

  const rows =
    await sql`
      SELECT *

      FROM bot_positions

      WHERE wallet_address =
        ${walletAddress}

        AND status =
        'CLOSED'

        AND (
          strategy IS NULL
          OR strategy NOT LIKE
          'PAPER%'
        )

        AND (
          buy_signature IS NULL
          OR buy_signature <>
          'PAPER_BUY'
        )

      ORDER BY
        closed_at DESC

      LIMIT ${safeLimit}
    `;

  return rows.map(
    trade => ({
      ...trade,

      pnlBps:
        Number(
          trade.realized_pnl_pct ||
          0
        ) * 100
    })
  );
}


// ======================================================
// SUMMARIZE TRADES
// ======================================================

function summarizeTrades(
  trades = []
) {
  const ordered =
    [
      ...trades
    ].sort(
      (
        a,
        b
      ) =>
        getTradeTime(b) -
        getTradeTime(a)
    );

  const values =
    ordered.map(
      trade =>
        num(
          trade.pnlBps ??
          (
            num(
              trade
                .realized_pnl_pct
            ) * 100
          )
        )
    );

  const wins =
    values.filter(
      value =>
        value > 0
    );

  const losses =
    values.filter(
      value =>
        value <= 0
    );

  const grossProfitBps =
    wins.reduce(
      (
        sum,
        value
      ) =>
        sum +
        value,
      0
    );

  const grossLossBps =
    Math.abs(
      losses.reduce(
        (
          sum,
          value
        ) =>
          sum +
          value,
        0
      )
    );

  const avgWinBps =
    wins.length
      ? grossProfitBps /
        wins.length
      : 0;

  const avgLossBps =
    losses.length
      ? losses.reduce(
          (
            sum,
            value
          ) =>
            sum +
            value,
          0
        ) /
        losses.length
      : 0;

  const winRate =
    values.length
      ? wins.length /
        values.length
      : 0;

  const expectancyBps =
    values.length
      ? values.reduce(
          (
            sum,
            value
          ) =>
            sum +
            value,
          0
        ) /
        values.length
      : 0;

  let consecutiveLosses =
    0;

  for (
    const value
    of values
  ) {
    if (
      value <= 0
    ) {
      consecutiveLosses++;
    } else {
      break;
    }
  }


  // ====================================================
  // PER-SETUP LEARNING
  // ====================================================

  const setupMap =
    new Map();

  for (
    const trade
    of ordered
  ) {
    const key =
      trade.setup ||
      trade.strategy ||
      "UNKNOWN";

    if (
      !setupMap.has(key)
    ) {
      setupMap.set(
        key,
        []
      );
    }

    setupMap
      .get(key)
      .push(
        num(
          trade.pnlBps ??
          (
            num(
              trade
                .realized_pnl_pct
            ) * 100
          )
        )
      );
  }


  const setupStats =
    [
      ...setupMap.entries()
    ]
      .map(
        ([
          setup,
          setupValues
        ]) => {
          const setupWins =
            setupValues.filter(
              value =>
                value > 0
            );

          const setupLosses =
            setupValues.filter(
              value =>
                value <= 0
            );

          const setupGrossProfit =
            setupWins.reduce(
              (
                sum,
                value
              ) =>
                sum +
                value,
              0
            );

          const setupGrossLoss =
            Math.abs(
              setupLosses.reduce(
                (
                  sum,
                  value
                ) =>
                  sum +
                  value,
                0
              )
            );

          return {
            setup,

            trades:
              setupValues.length,

            winRate:
              setupValues.length
                ? (
                    setupWins.length /
                    setupValues.length
                  ) * 100
                : 0,

            expectancyBps:
              setupValues.length
                ? setupValues.reduce(
                    (
                      sum,
                      value
                    ) =>
                      sum +
                      value,
                    0
                  ) /
                  setupValues.length
                : 0,

            profitFactor:
              setupGrossLoss > 0
                ? setupGrossProfit /
                  setupGrossLoss
                : setupGrossProfit > 0
                  ? 999
                  : null
          };
        }
      )
      .sort(
        (
          a,
          b
        ) =>
          b.expectancyBps -
          a.expectancyBps
      );


  const profitFactor =
    grossLossBps > 0
      ? grossProfitBps /
        grossLossBps
      : grossProfitBps > 0
        ? 999
        : null;


  return {
    trades:
      values.length,

    wins:
      wins.length,

    losses:
      losses.length,

    winRate:
      winRate * 100,

    avgWinBps,

    avgLossBps,

    grossProfitBps,

    grossLossBps,

    expectancyBps,

    profitFactor,

    consecutiveLosses,

    bestSetup:
      setupStats[0] ||
      null,

    worstSetup:
      setupStats.length
        ? setupStats[
            setupStats.length -
            1
          ]
        : null,

    setupStats
  };
}


// ======================================================
// EQUITY SNAPSHOT
//
// Supports:
// recordEquitySnapshot({
//   walletAddress,
//   equityUsd,
//   usdcBalance,
//   solBalance,
//   solPrice
// })
//
// and old:
// recordEquitySnapshot(wallet, equity)
// ======================================================

export async function recordEquitySnapshot(
  walletOrObject,
  equityArg = null
) {
  await ensureTradingTables();

  const sql = db();

  const isObject =
    typeof walletOrObject ===
    "object";

  const walletAddress =
    isObject
      ? walletOrObject
          ?.walletAddress
      : walletOrObject;

  const equityUsd =
    Math.max(
      0,

      num(
        isObject
          ? walletOrObject
              ?.equityUsd
          : equityArg
      )
    );

  const usdcBalance =
    isObject
      ? num(
          walletOrObject
            ?.usdcBalance,
          null
        )
      : null;

  const solBalance =
    isObject
      ? num(
          walletOrObject
            ?.solBalance,
          null
        )
      : null;

  const solPrice =
    isObject
      ? num(
          walletOrObject
            ?.solPrice,
          null
        )
      : null;

  if (!walletAddress) {
    throw new Error(
      "EQUITY_WALLET_MISSING"
    );
  }

  await sql`
    INSERT INTO bot_equity_snapshots (
      wallet_address,

      bucket_minute,

      equity_usd,

      usdc_balance,

      sol_balance,

      sol_price
    )

    VALUES (
      ${walletAddress},

      date_trunc(
        'minute',
        NOW()
      ),

      ${equityUsd},

      ${usdcBalance},

      ${solBalance},

      ${solPrice}
    )

    ON CONFLICT (
      wallet_address,
      bucket_minute
    )

    DO UPDATE SET
      equity_usd =
        EXCLUDED.equity_usd,

      usdc_balance =
        EXCLUDED.usdc_balance,

      sol_balance =
        EXCLUDED.sol_balance,

      sol_price =
        EXCLUDED.sol_price
  `;
}


// ======================================================
// EQUITY RISK
// ======================================================

export async function getEquityRiskSnapshot(
  walletAddress
) {
  await ensureTradingTables();

  const sql = db();

  const rows =
    await sql`
      SELECT

        (
          SELECT equity_usd

          FROM bot_equity_snapshots

          WHERE wallet_address =
            ${walletAddress}

          ORDER BY
            bucket_minute DESC

          LIMIT 1
        ) AS current_equity,

        (
          SELECT MAX(
            equity_usd
          )

          FROM bot_equity_snapshots

          WHERE wallet_address =
            ${walletAddress}

            AND bucket_minute >=
            NOW() -
            INTERVAL '30 days'
        ) AS peak_30d,

        (
          SELECT equity_usd

          FROM bot_equity_snapshots

          WHERE wallet_address =
            ${walletAddress}

            AND bucket_minute >=
            NOW() -
            INTERVAL '30 days'

          ORDER BY
            bucket_minute ASC

          LIMIT 1
        ) AS start_30d,

        (
          SELECT bucket_minute

          FROM bot_equity_snapshots

          WHERE wallet_address =
            ${walletAddress}

            AND bucket_minute >=
            NOW() -
            INTERVAL '30 days'

          ORDER BY
            bucket_minute ASC

          LIMIT 1
        ) AS start_30d_at,

        (
          SELECT equity_usd

          FROM bot_equity_snapshots

          WHERE wallet_address =
            ${walletAddress}

            AND bucket_minute <=
            NOW() -
            INTERVAL '24 hours'

          ORDER BY
            bucket_minute DESC

          LIMIT 1
        ) AS start_24h
    `;

  const row =
    rows[0] ||
    {};

  const current =
    num(
      row.current_equity,
      0
    );

  const peak =
    num(
      row.peak_30d,
      current
    );

  const start30d =
    num(
      row.start_30d,
      current
    );

  const start24h =
    num(
      row.start_24h,
      current
    );

  const drawdownPct =
    peak > 0
      ? (
          (
            peak -
            current
          ) /
          peak
        ) * 100
      : 0;

  const return30dPct =
    start30d > 0
      ? (
          (
            current -
            start30d
          ) /
          start30d
        ) * 100
      : 0;

  const return24hPct =
    start24h > 0
      ? (
          (
            current -
            start24h
          ) /
          start24h
        ) * 100
      : 0;

  return {
    currentEquity:
      current,

    peak30d:
      peak,

    drawdownPct:
      Math.max(
        0,
        drawdownPct
      ),

    start30d,

    start30dAt:
      row.start_30d_at ||
      null,

    return30dPct,

    start24h,

    return24hPct,

    dailyLossPct:
      return24hPct < 0
        ? Math.abs(
            return24hPct
          )
        : 0
  };
}


// ======================================================
// PERFORMANCE STATS
// ======================================================

export async function getPerformanceStats(
  walletAddress,
  limit = 100
) {
  const [
    trades,
    equityRisk
  ] =
    await Promise.all([
      getRecentClosedTrades(
        walletAddress,
        limit
      ),

      getEquityRiskSnapshot(
        walletAddress
      )
    ]);

  const summary =
    summarizeTrades(
      trades
    );

  return {
    ...summary,

    dailyLossPct:
      num(
        equityRisk
          ?.dailyLossPct
      ),

    drawdownPct:
      num(
        equityRisk
          ?.drawdownPct
      ),

    return24hPct:
      num(
        equityRisk
          ?.return24hPct
      ),

    return30dPct:
      num(
        equityRisk
          ?.return30dPct
      )
  };
}


// ======================================================
// LAST 24 HOURS
// ======================================================

export async function get24HourStats(
  walletAddress
) {
  await ensureTradingTables();

  const sql = db();

  const rows =
    await sql`
      SELECT *

      FROM bot_positions

      WHERE wallet_address =
        ${walletAddress}

        AND status =
        'CLOSED'

        AND closed_at >=
        NOW() -
        INTERVAL '24 hours'

        AND (
          strategy IS NULL
          OR strategy NOT LIKE
          'PAPER%'
        )

        AND (
          buy_signature IS NULL
          OR buy_signature <>
          'PAPER_BUY'
        )

      ORDER BY
        closed_at DESC
    `;

  const trades =
    rows.map(
      trade => ({
        ...trade,

        pnlBps:
          num(
            trade
              .realized_pnl_pct
          ) * 100
      })
    );

  const summary =
    summarizeTrades(
      trades
    );

  const pnl =
    rows.reduce(
      (
        sum,
        trade
      ) =>
        sum +
        num(
          trade.realized_pnl
        ),
      0
    );

  return {
    ...summary,

    pnl:
      round(
        pnl,
        6
      )
  };
}


// ======================================================
// ALL TIME
// ======================================================

export async function getAllTimeStats(
  walletAddress
) {
  await ensureTradingTables();

  const sql = db();

  const rows =
    await sql`
      SELECT *

      FROM bot_positions

      WHERE wallet_address =
        ${walletAddress}

        AND status =
        'CLOSED'

        AND (
          strategy IS NULL
          OR strategy NOT LIKE
          'PAPER%'
        )

        AND (
          buy_signature IS NULL
          OR buy_signature <>
          'PAPER_BUY'
        )

      ORDER BY
        closed_at DESC
    `;

  const trades =
    rows.map(
      trade => ({
        ...trade,

        pnlBps:
          num(
            trade
              .realized_pnl_pct
          ) * 100
      })
    );

  const summary =
    summarizeTrades(
      trades
    );

  const pnl =
    rows.reduce(
      (
        sum,
        trade
      ) =>
        sum +
        num(
          trade.realized_pnl
        ),
      0
    );

  return {
    ...summary,

    pnl:
      round(
        pnl,
        6
      )
  };
}


// ======================================================
// DASHBOARD
// ======================================================

export async function getTradingDashboard(
  walletAddress
) {
  const [
    positions,
    day,
    total,
    performance,
    equityRisk
  ] =
    await Promise.all([
      getOpenPositions(
        walletAddress
      ),

      get24HourStats(
        walletAddress
      ),

      getAllTimeStats(
        walletAddress
      ),

      getPerformanceStats(
        walletAddress,
        100
      ),

      getEquityRiskSnapshot(
        walletAddress
      )
    ]);

  return {
    openPosition:
      positions[0] ||
      null,

    openPositions:
      positions,

    openSlots:
      positions.length,

    last24Hours:
      day,

    allTime:
      total,

    performance,

    equityRisk
  };
}


// ======================================================
// RECONCILIATION
// ======================================================

export async function markPositionForReconciliation({
  id,

  reason =
    "ON_CHAIN_BALANCE_MISMATCH"
}) {
  await ensureTradingTables();

  const sql = db();

  const numericId =
    Number(id);

  if (
    !Number.isInteger(
      numericId
    ) ||
    numericId <= 0
  ) {
    throw new Error(
      "INVALID_POSITION_ID_FOR_RECONCILIATION"
    );
  }

  const rows =
    await sql`
      UPDATE bot_positions

      SET
        status =
          'RECONCILE',

        close_reason =
          ${reason}

      WHERE id =
        ${numericId}

        AND status =
        'OPEN'

      RETURNING *
    `;

  const updated =
    rows[0] ||
    null;

  if (updated) {
    await releaseSlot(
      updated.wallet_address,
      updated.slot_id
    );
  }

  return updated;
}
