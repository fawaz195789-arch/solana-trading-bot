import { neon } from "@neondatabase/serverless";


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

export async function ensureTradingTables() {
  const sql = db();

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
        DEFAULT 'MICRO_SCALP',

      entry_price DOUBLE PRECISION
        NOT NULL,

      entry_sol DOUBLE PRECISION
        NOT NULL,

      entry_usdc DOUBLE PRECISION
        NOT NULL,

      buy_signature TEXT,

      opened_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW(),

      highest_price DOUBLE PRECISION,

      target_bps DOUBLE PRECISION,

      trailing_active BOOLEAN
        NOT NULL DEFAULT FALSE,

      trailing_distance_bps
        DOUBLE PRECISION,

      exit_price DOUBLE PRECISION,

      exit_usdc DOUBLE PRECISION,

      sell_signature TEXT,

      close_reason TEXT,

      realized_pnl DOUBLE PRECISION,

      realized_pnl_pct
        DOUBLE PRECISION,

      closed_at TIMESTAMPTZ
    )
  `;


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
      highest_price DOUBLE PRECISION
  `;

  await sql`
    ALTER TABLE bot_positions
    ADD COLUMN IF NOT EXISTS
      target_bps DOUBLE PRECISION
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
      close_reason TEXT
  `;


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
}


// ======================================================
// GET LIVE OPEN POSITIONS
//
// IMPORTANT:
// PAPER positions are ignored completely.
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

        AND status = 'OPEN'

        AND (
          strategy IS NULL
          OR strategy NOT LIKE 'PAPER%'
        )

        AND (
          buy_signature IS NULL
          OR buy_signature <> 'PAPER_BUY'
        )

      ORDER BY
        slot_id ASC,
        opened_at ASC
    `;

  return rows || [];
}


// ======================================================
// GET FIRST LIVE OPEN POSITION
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
// GET LIVE POSITION BY SLOT
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

        AND status = 'OPEN'

        AND slot_id =
          ${Number(slotId)}

        AND (
          strategy IS NULL
          OR strategy NOT LIKE 'PAPER%'
        )

        AND (
          buy_signature IS NULL
          OR buy_signature <> 'PAPER_BUY'
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
// FIND FREE LIVE SLOT
// ======================================================

export async function getFreeSlot(
  walletAddress,
  maxSlots = 4
) {
  const openPositions =
    await getOpenPositions(
      walletAddress
    );

  const usedSlots =
    new Set(
      openPositions.map(
        position =>
          Number(
            position.slot_id
          )
      )
    );

  for (
    let slot = 1;
    slot <= maxSlots;
    slot++
  ) {
    if (
      !usedSlots.has(
        slot
      )
    ) {
      return slot;
    }
  }

  return null;
}


// ======================================================
// OPEN LIVE POSITION
// ======================================================

export async function openPosition({
  walletAddress,
  slotId,
  entryPrice,
  entrySol,
  entryUsdc,
  signature,
  strategy = "LIVE_MICRO_SCALP",
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
      "Invalid slotId"
    );
  }


  const existing =
    await getOpenPositionBySlot(
      walletAddress,
      numericSlot
    );


  if (existing) {
    throw new Error(
      `Slot ${numericSlot} already has a LIVE open position`
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

        entry_price,
        entry_sol,
        entry_usdc,

        highest_price,
        target_bps,

        trailing_active,
        trailing_distance_bps,

        buy_signature,
        opened_at
      )

      VALUES (
        ${walletAddress},

        'SOL-USDC',

        'OPEN',

        ${numericSlot},

        ${strategy},

        ${Number(entryPrice)},

        ${Number(entrySol)},

        ${Number(entryUsdc)},

        ${Number(entryPrice)},

        ${
          targetBps !== null
            ? Number(
                targetBps
              )
            : null
        },

        FALSE,

        ${
          trailingDistanceBps !== null
            ? Number(
                trailingDistanceBps
              )
            : null
        },

        ${signature || null},

        NOW()
      )

      RETURNING *
    `;

  return rows[0];
}


// ======================================================
// UPDATE LIVE POSITION HIGH
// ======================================================

export async function updateHighestPrice({
  id,
  highestPrice
}) {
  await ensureTradingTables();

  const sql = db();

  const rows =
    await sql`
      UPDATE bot_positions

      SET highest_price =
        GREATEST(
          COALESCE(
            highest_price,
            entry_price
          ),
          ${Number(
            highestPrice
          )}
        )

      WHERE id =
        ${Number(id)}

        AND status =
          'OPEN'

        AND (
          strategy IS NULL
          OR strategy NOT LIKE 'PAPER%'
        )

        AND (
          buy_signature IS NULL
          OR buy_signature <> 'PAPER_BUY'
        )

      RETURNING *
    `;

  return (
    rows[0] ||
    null
  );
}


// ======================================================
// ACTIVATE LIVE TRAILING
// ======================================================

export async function activateTrailing({
  id,
  highestPrice = null
}) {
  await ensureTradingTables();

  const sql = db();

  const rows =
    await sql`
      UPDATE bot_positions

      SET
        trailing_active = TRUE,

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

          END

      WHERE id =
        ${Number(id)}

        AND status =
          'OPEN'

        AND (
          strategy IS NULL
          OR strategy NOT LIKE 'PAPER%'
        )

        AND (
          buy_signature IS NULL
          OR buy_signature <> 'PAPER_BUY'
        )

      RETURNING *
    `;

  return (
    rows[0] ||
    null
  );
}


// ======================================================
// CLOSE LIVE POSITION
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


  const rows =
    await sql`
      SELECT *
      FROM bot_positions

      WHERE id =
        ${Number(id)}

        AND status =
          'OPEN'

        AND (
          strategy IS NULL
          OR strategy NOT LIKE 'PAPER%'
        )

        AND (
          buy_signature IS NULL
          OR buy_signature <> 'PAPER_BUY'
        )

      LIMIT 1
    `;


  const position =
    rows[0];


  if (!position) {
    throw new Error(
      "LIVE open position not found"
    );
  }


  const entryUsdc =
    Number(
      position.entry_usdc
    );


  const receivedUsdc =
    Number(
      exitUsdc
    );


  if (
    !Number.isFinite(
      receivedUsdc
    ) ||
    receivedUsdc < 0
  ) {
    throw new Error(
      "Invalid exitUsdc"
    );
  }


  const pnl =
    receivedUsdc -
    entryUsdc;


  const pnlPct =
    entryUsdc > 0
      ? (
          pnl /
          entryUsdc
        ) * 100
      : 0;


  const updated =
    await sql`
      UPDATE bot_positions

      SET
        status =
          'CLOSED',

        exit_price =
          ${Number(
            exitPrice
          )},

        exit_usdc =
          ${receivedUsdc},

        sell_signature =
          ${signature || null},

        close_reason =
          ${reason},

        realized_pnl =
          ${pnl},

        realized_pnl_pct =
          ${pnlPct},

        closed_at =
          NOW()

      WHERE id =
        ${Number(id)}

      RETURNING *
    `;


  return updated[0];
}


// ======================================================
// RECENT LIVE CLOSED TRADES
// ======================================================

export async function getRecentClosedTrades(
  walletAddress,
  limit = 20
) {
  await ensureTradingTables();

  const sql = db();


  const safeLimit =
    Math.max(
      1,
      Math.min(
        100,
        Number(limit) ||
        20
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
          OR strategy NOT LIKE 'PAPER%'
        )

        AND (
          buy_signature IS NULL
          OR buy_signature <> 'PAPER_BUY'
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
          trade
            .realized_pnl_pct ||
          0
        ) * 100
    })
  );
}


// ======================================================
// LIVE LAST 24 HOURS
// ======================================================

export async function get24HourStats(
  walletAddress
) {
  await ensureTradingTables();

  const sql = db();


  const rows =
    await sql`
      SELECT

        COUNT(*)::int
          AS trades,

        COUNT(*) FILTER (
          WHERE realized_pnl > 0
        )::int
          AS wins,

        COUNT(*) FILTER (
          WHERE realized_pnl <= 0
        )::int
          AS losses,

        COALESCE(
          SUM(
            realized_pnl
          ),
          0
        )::double precision
          AS pnl

      FROM bot_positions

      WHERE wallet_address =
        ${walletAddress}

        AND status =
          'CLOSED'

        AND (
          strategy IS NULL
          OR strategy NOT LIKE 'PAPER%'
        )

        AND (
          buy_signature IS NULL
          OR buy_signature <> 'PAPER_BUY'
        )

        AND closed_at >=
          NOW() -
          INTERVAL '24 hours'
    `;


  const stats =
    rows[0];


  const trades =
    Number(
      stats.trades ||
      0
    );


  const wins =
    Number(
      stats.wins ||
      0
    );


  return {
    trades,

    wins,

    losses:
      Number(
        stats.losses ||
        0
      ),

    pnl:
      Number(
        stats.pnl ||
        0
      ),

    winRate:
      trades > 0
        ? (
            wins /
            trades
          ) * 100
        : 0
  };
}


// ======================================================
// LIVE ALL TIME STATS
// ======================================================

export async function getAllTimeStats(
  walletAddress
) {
  await ensureTradingTables();

  const sql = db();


  const rows =
    await sql`
      SELECT

        COUNT(*)::int
          AS trades,

        COUNT(*) FILTER (
          WHERE realized_pnl > 0
        )::int
          AS wins,

        COUNT(*) FILTER (
          WHERE realized_pnl <= 0
        )::int
          AS losses,

        COALESCE(
          SUM(
            realized_pnl
          ),
          0
        )::double precision
          AS pnl

      FROM bot_positions

      WHERE wallet_address =
        ${walletAddress}

        AND status =
          'CLOSED'

        AND (
          strategy IS NULL
          OR strategy NOT LIKE 'PAPER%'
        )

        AND (
          buy_signature IS NULL
          OR buy_signature <> 'PAPER_BUY'
        )
    `;


  const stats =
    rows[0];


  const trades =
    Number(
      stats.trades ||
      0
    );


  const wins =
    Number(
      stats.wins ||
      0
    );


  return {
    trades,

    wins,

    losses:
      Number(
        stats.losses ||
        0
      ),

    pnl:
      Number(
        stats.pnl ||
        0
      ),

    winRate:
      trades > 0
        ? (
            wins /
            trades
          ) * 100
        : 0
  };
}


// ======================================================
// LIVE DASHBOARD
// ======================================================

export async function getTradingDashboard(
  walletAddress
) {
  const [
    positions,
    day,
    total
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
      total
  };
}
