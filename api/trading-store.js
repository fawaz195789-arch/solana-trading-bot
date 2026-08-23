import { neon } from "@neondatabase/serverless";

function getDatabaseUrl() {
  const direct =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.NEON_DATABASE_URL ||
    process.env.STORAGE_URL;

  if (direct) {
    return direct;
  }

  // احتياط: ابحث تلقائيًا عن متغير Vercel
  // الذي يحتوي رابط PostgreSQL.
  for (const value of Object.values(process.env)) {
    if (
      typeof value === "string" &&
      (
        value.startsWith("postgres://") ||
        value.startsWith("postgresql://")
      )
    ) {
      return value;
    }
  }

  throw new Error("Postgres database URL not found");
}

function db() {
  return neon(getDatabaseUrl());
}

// ======================================================
// CREATE TABLES AUTOMATICALLY
// ======================================================

export async function ensureTradingTables() {
  const sql = db();

  await sql`
    CREATE TABLE IF NOT EXISTS bot_positions (
      id SERIAL PRIMARY KEY,
      wallet_address TEXT NOT NULL,
      symbol TEXT NOT NULL DEFAULT 'SOL-USDC',
      status TEXT NOT NULL DEFAULT 'OPEN',

      entry_price DOUBLE PRECISION NOT NULL,
      entry_sol DOUBLE PRECISION NOT NULL,
      entry_usdc DOUBLE PRECISION NOT NULL,

      buy_signature TEXT,

      opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      exit_price DOUBLE PRECISION,
      exit_usdc DOUBLE PRECISION,
      sell_signature TEXT,

      realized_pnl DOUBLE PRECISION,
      realized_pnl_pct DOUBLE PRECISION,

      closed_at TIMESTAMPTZ
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_bot_positions_wallet_status
    ON bot_positions(wallet_address, status)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_bot_positions_closed_at
    ON bot_positions(closed_at)
  `;
}

// ======================================================
// GET CURRENT OPEN POSITION
// ======================================================

export async function getOpenPosition(
  walletAddress
) {
  await ensureTradingTables();

  const sql = db();

  const rows = await sql`
    SELECT *
    FROM bot_positions
    WHERE wallet_address = ${walletAddress}
      AND status = 'OPEN'
    ORDER BY opened_at DESC
    LIMIT 1
  `;

  return rows[0] || null;
}

// ======================================================
// OPEN NEW POSITION
// ======================================================

export async function openPosition({
  walletAddress,
  entryPrice,
  entrySol,
  entryUsdc,
  signature
}) {
  await ensureTradingTables();

  const sql = db();

  const existing =
    await getOpenPosition(walletAddress);

  if (existing) {
    throw new Error(
      "An open position already exists"
    );
  }

  const rows = await sql`
    INSERT INTO bot_positions (
      wallet_address,
      symbol,
      status,
      entry_price,
      entry_sol,
      entry_usdc,
      buy_signature,
      opened_at
    )
    VALUES (
      ${walletAddress},
      'SOL-USDC',
      'OPEN',
      ${entryPrice},
      ${entrySol},
      ${entryUsdc},
      ${signature || null},
      NOW()
    )
    RETURNING *
  `;

  return rows[0];
}

// ======================================================
// CLOSE POSITION
// ======================================================

export async function closePosition({
  id,
  exitPrice,
  exitUsdc,
  signature
}) {
  await ensureTradingTables();

  const sql = db();

  const rows = await sql`
    SELECT *
    FROM bot_positions
    WHERE id = ${id}
      AND status = 'OPEN'
    LIMIT 1
  `;

  const position =
    rows[0];

  if (!position) {
    throw new Error(
      "Open position not found"
    );
  }

  const entryUsdc =
    Number(position.entry_usdc);

  const receivedUsdc =
    Number(exitUsdc);

  const pnl =
    receivedUsdc - entryUsdc;

  const pnlPct =
    entryUsdc > 0
      ? (pnl / entryUsdc) * 100
      : 0;

  const updated = await sql`
    UPDATE bot_positions
    SET
      status = 'CLOSED',
      exit_price = ${exitPrice},
      exit_usdc = ${receivedUsdc},
      sell_signature = ${signature || null},
      realized_pnl = ${pnl},
      realized_pnl_pct = ${pnlPct},
      closed_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `;

  return updated[0];
}

// ======================================================
// LAST 24 HOURS STATS
// ======================================================

export async function get24HourStats(
  walletAddress
) {
  await ensureTradingTables();

  const sql = db();

  const rows = await sql`
    SELECT
      COUNT(*)::int AS trades,

      COUNT(*) FILTER (
        WHERE realized_pnl > 0
      )::int AS wins,

      COUNT(*) FILTER (
        WHERE realized_pnl <= 0
      )::int AS losses,

      COALESCE(
        SUM(realized_pnl),
        0
      )::double precision AS pnl

    FROM bot_positions

    WHERE wallet_address = ${walletAddress}
      AND status = 'CLOSED'
      AND closed_at >= NOW() - INTERVAL '24 hours'
  `;

  const stats =
    rows[0];

  const trades =
    Number(stats.trades || 0);

  const wins =
    Number(stats.wins || 0);

  return {
    trades,
    wins,
    losses:
      Number(stats.losses || 0),

    pnl:
      Number(stats.pnl || 0),

    winRate:
      trades > 0
        ? (wins / trades) * 100
        : 0
  };
}

// ======================================================
// ALL-TIME STATS
// ======================================================

export async function getAllTimeStats(
  walletAddress
) {
  await ensureTradingTables();

  const sql = db();

  const rows = await sql`
    SELECT
      COUNT(*)::int AS trades,

      COUNT(*) FILTER (
        WHERE realized_pnl > 0
      )::int AS wins,

      COUNT(*) FILTER (
        WHERE realized_pnl <= 0
      )::int AS losses,

      COALESCE(
        SUM(realized_pnl),
        0
      )::double precision AS pnl

    FROM bot_positions

    WHERE wallet_address = ${walletAddress}
      AND status = 'CLOSED'
  `;

  const stats =
    rows[0];

  const trades =
    Number(stats.trades || 0);

  const wins =
    Number(stats.wins || 0);

  return {
    trades,
    wins,

    losses:
      Number(stats.losses || 0),

    pnl:
      Number(stats.pnl || 0),

    winRate:
      trades > 0
        ? (wins / trades) * 100
        : 0
  };
}

// ======================================================
// DASHBOARD DATA
// ======================================================

export async function getTradingDashboard(
  walletAddress
) {
  const [
    position,
    day,
    total
  ] = await Promise.all([
    getOpenPosition(walletAddress),
    get24HourStats(walletAddress),
    getAllTimeStats(walletAddress)
  ]);

  return {
    openPosition: position,
    last24Hours: day,
    allTime: total
  };
}
