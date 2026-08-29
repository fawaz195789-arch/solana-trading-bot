export default function handler(req, res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");

  return res.status(200).send(`
<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
  />

  <title>FAWAZ AI DEX TRADER V3</title>

  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: #f3f5f7;
      color: #111;
      font-family:
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        Arial,
        sans-serif;
    }

    .page {
      width: min(900px, 100%);
      margin: auto;
      padding: 18px;
    }

    .card {
      background: white;
      border-radius: 28px;
      padding: 24px;
      margin-bottom: 18px;
      box-shadow:
        0 8px 28px
        rgba(0,0,0,.045);
    }

    h1 {
      margin: 0 0 10px;
      font-size: 30px;
    }

    h2 {
      margin: 0 0 18px;
      font-size: 24px;
    }

    .muted {
      color: #777;
    }

    .status {
      display: inline-flex;
      gap: 8px;
      align-items: center;
      padding: 10px 16px;
      border-radius: 999px;
      font-weight: 800;
      background: #eef2f4;
    }

    .dot {
      width: 13px;
      height: 13px;
      border-radius: 50%;
      background: #999;
    }

    .green {
      background: #16c56e;
    }

    .red {
      background: #e34850;
    }

    .orange {
      background: #f0a020;
    }

    .grid {
      display: grid;
      grid-template-columns:
        repeat(2, minmax(0,1fr));
      gap: 14px;
    }

    .metric {
      padding: 18px;
      background: #f7f8f9;
      border-radius: 20px;
    }

    .metric .label {
      color: #777;
      font-size: 14px;
      margin-bottom: 7px;
    }

    .metric .value {
      font-size: 23px;
      font-weight: 850;
      word-break: break-word;
    }

    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      border-bottom: 1px solid #eee;
      padding: 14px 0;
    }

    .row:last-child {
      border-bottom: 0;
    }

    .strong {
      font-weight: 850;
    }

    .buy {
      color: #079448;
    }

    .sell {
      color: #d52c36;
    }

    .wait {
      color: #777;
    }

    .chartWrap {
      width: 100%;
      height: 190px;
      border-radius: 20px;
      overflow: hidden;
      background:
        linear-gradient(
          180deg,
          #f8fafb,
          #fff
        );
    }

    svg {
      width: 100%;
      height: 100%;
    }

    .slot {
      background: #f5f7f8;
      padding: 15px;
      border-radius: 16px;
      margin: 8px 0;
    }

    .good {
      color: #088f47;
      font-weight: 850;
    }

    .bad {
      color: #d3313b;
      font-weight: 850;
    }

    .warn {
      color: #b97300;
      font-weight: 850;
    }

    .small {
      font-size: 13px;
    }

    .timestamp {
      text-align: center;
      color: #999;
      padding: 10px;
    }

    @media(max-width:600px) {
      .grid {
        grid-template-columns: 1fr 1fr;
      }

      .metric .value {
        font-size: 19px;
      }

      h1 {
        font-size: 26px;
      }
    }
  </style>
</head>

<body>

<div class="page">

  <div class="card">
    <h1>FAWAZ AI DEX TRADER ⚡</h1>

    <div class="muted" id="wallet">
      جاري تحميل المحفظة...
    </div>

    <br>

    <div class="status">
      <span
        id="mainDot"
        class="dot"
      ></span>

      <span id="mainStatus">
        جاري الاتصال...
      </span>
    </div>
  </div>


  <div class="card">
    <h2>🔐 حالة النظام الحقيقية</h2>

    <div class="row">
      <span>Market Engine</span>
      <span id="marketStatus">
        ...
      </span>
    </div>

    <div class="row">
      <span>Auto Trading</span>
      <span id="autoStatus">
        ...
      </span>
    </div>

    <div class="row">
      <span>Wallet Key</span>
      <span id="keyStatus">
        ...
      </span>
    </div>

    <div class="row">
      <span>Wallet Match</span>
      <span id="walletMatch">
        ...
      </span>
    </div>

    <div class="row">
      <span>Solana RPC</span>
      <span id="rpcStatus">
        ...
      </span>
    </div>

    <div class="row">
      <span>Compounding</span>
      <span id="compoundStatus">
        ...
      </span>
    </div>
  </div>


  <div class="card">
    <h2>💰 رأس المال</h2>

    <div class="grid">

      <div class="metric">
        <div class="label">
          رأس المال
        </div>
        <div
          class="value"
          id="capital"
        >
          -
        </div>
      </div>

      <div class="metric">
        <div class="label">
          المتاح للتداول
        </div>
        <div
          class="value"
          id="available"
        >
          -
        </div>
      </div>

      <div class="metric">
        <div class="label">
          حجم الصفقة الحالي
        </div>
        <div
          class="value"
          id="slotSize"
        >
          -
        </div>
      </div>

      <div class="metric">
        <div class="label">
          الاحتياطي
        </div>
        <div
          class="value"
          id="reserve"
        >
          -
        </div>
      </div>

      <div class="metric">
        <div class="label">
          الربح الجديد المركب
        </div>
        <div
          class="value"
          id="compoundPnl"
        >
          -
        </div>
      </div>

      <div class="metric">
        <div class="label">
          المستخدم الآن
        </div>
        <div
          class="value"
          id="used"
        >
          -
        </div>
      </div>

    </div>
  </div>


  <div class="card">
    <h2>📈 حركة SOL الحقيقية</h2>

    <div class="grid">

      <div class="metric">
        <div class="label">
          السعر الحالي
        </div>

        <div
          class="value"
          id="price"
        >
          -
        </div>
      </div>

      <div class="metric">
        <div class="label">
          آخر تغير مسجل
        </div>

        <div
          class="value"
          id="priceChange"
        >
          -
        </div>
      </div>

    </div>

    <br>

    <div class="chartWrap">
      <svg
        id="priceChart"
        viewBox="0 0 800 190"
        preserveAspectRatio="none"
      ></svg>
    </div>

    <div class="small muted">
      الرسم يتحرك فقط من الأسعار التي تصل فعليًا
      من API البوت، ولا توجد بيانات سعر وهمية.
    </div>
  </div>


  <div class="card">
    <h2>🤖 قرار الوكيل</h2>

    <div class="row">
      <span>القرار</span>

      <span
        class="strong"
        id="decision"
      >
        -
      </span>
    </div>

    <div class="row">
      <span>الثقة</span>

      <span
        class="strong"
        id="confidence"
      >
        -
      </span>
    </div>

    <div class="row">
      <span>السبب</span>

      <span
        class="strong"
        id="reason"
      >
        -
      </span>
    </div>

    <div class="row">
      <span>Risk Mode</span>

      <span
        class="strong"
        id="riskMode"
      >
        -
      </span>
    </div>
  </div>


  <div class="card">
    <h2>📊 قراءة السوق</h2>

    <div class="row">
      <span>Market Mode</span>
      <strong id="marketMode">-</strong>
    </div>

    <div class="row">
      <span>Scalping Score</span>
      <strong id="score">-</strong>
    </div>

    <div class="row">
      <span>Spread</span>
      <strong id="spread">-</strong>
    </div>

    <div class="row">
      <span>Volatility</span>
      <strong id="volatility">-</strong>
    </div>

    <div class="row">
      <span>الاتجاه</span>
      <strong id="direction">-</strong>
    </div>
  </div>


  <div class="card">
    <h2>🎯 المراكز المفتوحة</h2>

    <div id="slots">
      جاري التحميل...
    </div>
  </div>


  <div class="card">
    <h2>📈 نتائج حقيقية</h2>

    <div class="grid">

      <div class="metric">
        <div class="label">
          صفقات آخر 24 ساعة
        </div>

        <div
          class="value"
          id="trades24"
        >
          -
        </div>
      </div>

      <div class="metric">
        <div class="label">
          الرابحة 24 ساعة
        </div>

        <div
          class="value"
          id="wins24"
        >
          -
        </div>
      </div>

      <div class="metric">
        <div class="label">
          الخاسرة 24 ساعة
        </div>

        <div
          class="value"
          id="losses24"
        >
          -
        </div>
      </div>

      <div class="metric">
        <div class="label">
          ربح 24 ساعة
        </div>

        <div
          class="value"
          id="pnl24"
        >
          -
        </div>
      </div>

      <div class="metric">
        <div class="label">
          إجمالي الصفقات
        </div>

        <div
          class="value"
          id="allTrades"
        >
          -
        </div>
      </div>

      <div class="metric">
        <div class="label">
          إجمالي الربح
        </div>

        <div
          class="value"
          id="allPnl"
        >
          -
        </div>
      </div>

      <div class="metric">
        <div class="label">
          نسبة النجاح
        </div>

        <div
          class="value"
          id="winRate"
        >
          -
        </div>
      </div>

      <div class="metric">
        <div class="label">
          المراكز المفتوحة
        </div>

        <div
          class="value"
          id="openCount"
        >
          -
        </div>
      </div>

    </div>
  </div>


  <div class="card">
    <h2>🔗 المحفظة</h2>

    <div class="row">
      <span>اتصال المفتاح</span>
      <strong id="walletReady">-</strong>
    </div>

    <div class="row">
      <span>رصيد SOL للرسوم</span>
      <strong id="solBalance">-</strong>
    </div>

    <div class="row">
      <span>عنوان المحفظة</span>
      <strong
        class="small"
        id="fullWallet"
      >
        -
      </strong>
    </div>
  </div>


  <div class="timestamp">
    آخر تحديث:
    <span id="lastUpdate">-</span>
  </div>

</div>


<script>
  const priceHistory = [];
  const MAX_POINTS = 80;

  function n(value, fallback = 0) {
    const x = Number(value);
    return Number.isFinite(x)
      ? x
      : fallback;
  }

  function usd(value, digits = 4) {
    return "USDC " +
      n(value).toFixed(digits);
  }

  function yesNo(
    element,
    value,
    goodText = "CONNECTED",
    badText = "OFFLINE"
  ) {
    element.textContent =
      value
        ? goodText
        : badText;

    element.className =
      value
        ? "good"
        : "bad";
  }

  function drawPriceChart() {
    const svg =
      document.getElementById(
        "priceChart"
      );

    if (
      priceHistory.length < 2
    ) {
      svg.innerHTML = "";
      return;
    }

    const values =
      priceHistory.map(
        x => x.price
      );

    const min =
      Math.min(...values);

    const max =
      Math.max(...values);

    const range =
      Math.max(
        max - min,
        0.000001
      );

    const width = 800;
    const height = 190;

    const points =
      priceHistory.map(
        (item, index) => {

          const x =
            (
              index /
              Math.max(
                1,
                priceHistory.length - 1
              )
            ) * width;

          const y =
            height -
            (
              (
                item.price - min
              ) /
              range
            ) *
            (height - 25) -
            12;

          return (
            x.toFixed(2) +
            "," +
            y.toFixed(2)
          );
        }
      ).join(" ");

    svg.innerHTML =
      '<polyline ' +
      'points="' + points + '" ' +
      'fill="none" ' +
      'stroke="currentColor" ' +
      'stroke-width="4" ' +
      'stroke-linecap="round" ' +
      'stroke-linejoin="round" />';
  }


  function renderSlots(
    positions = [],
    maxSlots = 4
  ) {
    const root =
      document.getElementById(
        "slots"
      );

    const map = {};

    positions.forEach(
      p => {
        map[
          Number(
            p.slot_id
          )
        ] = p;
      }
    );

    let html = "";

    for (
      let slot = 1;
      slot <= maxSlots;
      slot++
    ) {
      const p =
        map[slot];

      if (!p) {
        html +=
          '<div class="slot">' +
          '<strong>Slot ' +
          slot +
          '</strong>' +
          '<span style="float:left" class="muted">' +
          'فارغ' +
          '</span>' +
          '</div>';

        continue;
      }

      html +=
        '<div class="slot">' +
        '<div><strong>Slot ' +
        slot +
        '</strong></div>' +

        '<div class="small">' +
        'Entry USDC: ' +
        n(
          p.entry_usdc
        ).toFixed(6) +
        '</div>' +

        '<div class="small">' +
        'Entry SOL: ' +
        n(
          p.entry_sol
        ).toFixed(8) +
        '</div>' +

        '<div class="small">' +
        'Entry Price: ' +
        n(
          p.entry_price
        ).toFixed(4) +
        '</div>' +

        '</div>';
    }

    root.innerHTML = html;
  }


  async function loadDashboard() {

    let tradeData = null;
    let walletData = null;

    try {

      const [
        tradeResponse,
        walletResponse
      ] =
        await Promise.all([
          fetch(
            "/api/trade-orchestrator",
            {
              cache: "no-store"
            }
          ),

          fetch(
            "/api/execution-agent?test=wallet",
            {
              cache: "no-store"
            }
          )
        ]);

      tradeData =
        await tradeResponse.json();

      walletData =
        await walletResponse.json();

    } catch (error) {

      document.getElementById(
        "mainDot"
      ).className =
        "dot red";

      document.getElementById(
        "mainStatus"
      ).textContent =
        "API CONNECTION ERROR";

      return;
    }


    const live =
      tradeData?.status === "ok" ||
      tradeData?.status === "waiting";

    document.getElementById(
      "mainDot"
    ).className =
      live
        ? "dot green"
        : "dot red";

    document.getElementById(
      "mainStatus"
    ).textContent =
      live
        ? "LIVE AI MARKET ENGINE"
        : "ENGINE ERROR";


    const address =
      tradeData?.walletAddress ||
      walletData?.walletAddress ||
      "-";

    document.getElementById(
      "wallet"
    ).textContent =
      "محفظة البوت: " +
      address;

    document.getElementById(
      "fullWallet"
    ).textContent =
      address;


    yesNo(
      document.getElementById(
        "marketStatus"
      ),
      tradeData?.liveMarket === true,
      "LIVE",
      "OFFLINE"
    );

    yesNo(
      document.getElementById(
        "autoStatus"
      ),
      tradeData?.realTrading === true &&
      tradeData?.execution ===
        "FULL_AUTO",
      "FULL AUTO",
      "NOT READY"
    );

    yesNo(
      document.getElementById(
        "keyStatus"
      ),
      walletData?.keyLoaded === true &&
      walletData?.keyValid === true,
      "READY",
      "ERROR"
    );

    yesNo(
      document.getElementById(
        "walletMatch"
      ),
      walletData?.walletMatch === true,
      "MATCHED",
      "MISMATCH"
    );

    yesNo(
      document.getElementById(
        "rpcStatus"
      ),
      walletData?.rpcConnected === true,
      "CONNECTED",
      "OFFLINE"
    );

    yesNo(
      document.getElementById(
        "compoundStatus"
      ),
      tradeData?.compounding === true ||
      tradeData?.capital
        ?.compounding === true,
      "ACTIVE",
      "OFF"
    );


    const capital =
      tradeData?.capital || {};

    document.getElementById(
      "capital"
    ).textContent =
      usd(
        capital.total
      );

    document.getElementById(
      "available"
    ).textContent =
      usd(
        capital.availableForTrading
      );

    document.getElementById(
      "slotSize"
    ).textContent =
      usd(
        capital.slotSize
      );

    document.getElementById(
      "reserve"
    ).textContent =
      usd(
        capital.reserve
      );

    document.getElementById(
      "compoundPnl"
    ).textContent =
      usd(
        capital.realizedPnl,
        6
      );

    document.getElementById(
      "used"
    ).textContent =
      usd(
        capital.used
      );


    const signal =
      tradeData?.signal || {};

    const currentPrice =
      n(
        signal.currentPrice,
        0
      );

    if (
      currentPrice > 0
    ) {

      const previous =
        priceHistory.length
          ? priceHistory[
              priceHistory.length - 1
            ].price
          : currentPrice;

      priceHistory.push({
        price:
          currentPrice,

        time:
          Date.now()
      });

      while (
        priceHistory.length >
        MAX_POINTS
      ) {
        priceHistory.shift();
      }

      const delta =
        currentPrice -
        previous;

      const deltaPct =
        previous > 0
          ? (
              delta /
              previous
            ) * 100
          : 0;

      document.getElementById(
        "price"
      ).textContent =
        "$" +
        currentPrice.toFixed(4);

      const changeElement =
        document.getElementById(
          "priceChange"
        );

      changeElement.textContent =
        (
          delta >= 0
            ? "+"
            : ""
        ) +
        deltaPct.toFixed(4) +
        "%";

      changeElement.className =
        "value " +
        (
          delta > 0
            ? "buy"
            : delta < 0
              ? "sell"
              : "wait"
        );

      drawPriceChart();
    }


    const action =
      String(
        signal.action ||
        "WAIT"
      ).toUpperCase();

    const decision =
      document.getElementById(
        "decision"
      );

    decision.textContent =
      action;

    decision.className =
      "strong " +
      (
        action === "BUY"
          ? "buy"
          : action === "SELL"
            ? "sell"
            : "wait"
      );


    document.getElementById(
      "confidence"
    ).textContent =
      n(
        signal.confidence
      ).toFixed(0) +
      "%";

    document.getElementById(
      "reason"
    ).textContent =
      signal.reason ||
      tradeData.reason ||
      "-";

    document.getElementById(
      "riskMode"
    ).textContent =
      tradeData.riskMode ||
      "-";


    document.getElementById(
      "marketMode"
    ).textContent =
      signal.marketMode ||
      "-";

    document.getElementById(
      "score"
    ).textContent =
      n(
        signal.scalpingScore
      ).toFixed(0) +
      " / 100";

    document.getElementById(
      "spread"
    ).textContent =
      n(
        signal.spreadBps
      ).toFixed(2) +
      " bps";

    document.getElementById(
      "volatility"
    ).textContent =
      n(
        signal.volatilityBps
      ).toFixed(2) +
      " bps";

    document.getElementById(
      "direction"
    ).textContent =
      signal.direction ||
      "-";


    const dashboard =
      tradeData?.dashboard || {};

    const positions =
      tradeData?.positions ||
      dashboard?.openPositions ||
      [];

    renderSlots(
      positions,
      n(
        capital.maxSlots,
        4
      )
    );


    const d24 =
      dashboard?.last24Hours ||
      {};

    const all =
      dashboard?.allTime ||
      {};

    document.getElementById(
      "trades24"
    ).textContent =
      n(
        d24.trades
      );

    document.getElementById(
      "wins24"
    ).textContent =
      n(
        d24.wins
      );

    document.getElementById(
      "losses24"
    ).textContent =
      n(
        d24.losses
      );

    document.getElementById(
      "pnl24"
    ).textContent =
      usd(
        d24.pnl,
        6
      );

    document.getElementById(
      "allTrades"
    ).textContent =
      n(
        all.trades
      );

    document.getElementById(
      "allPnl"
    ).textContent =
      usd(
        all.pnl,
        6
      );

    document.getElementById(
      "winRate"
    ).textContent =
      n(
        all.winRate
      ).toFixed(1) +
      "%";

    document.getElementById(
      "openCount"
    ).textContent =
      (
        Array.isArray(
          dashboard.openPositions
        )
          ? dashboard
              .openPositions
              .length
          : n(
              dashboard.openSlots
            )
      ) +
      " / " +
      n(
        capital.maxSlots,
        4
      );


    yesNo(
      document.getElementById(
        "walletReady"
      ),
      walletData
        ?.tradingKeyReady === true,
      "READY",
      "NOT READY"
    );

    document.getElementById(
      "solBalance"
    ).textContent =
      n(
        walletData?.solBalance
      ).toFixed(8) +
      " SOL";


    document.getElementById(
      "lastUpdate"
    ).textContent =
      new Date()
        .toLocaleTimeString(
          "ar-SA"
        );
  }


  loadDashboard();

  setInterval(
    loadDashboard,
    3000
  );
</script>

</body>
</html>
  `);
}
