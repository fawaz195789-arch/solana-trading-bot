export default async function handler(req, res) {
  try {

    // ==========================================
    // BASE URL
    // ==========================================

    const protocol =
      req.headers["x-forwarded-proto"] || "https";

    const host =
      req.headers.host;

    const baseUrl =
      `${protocol}://${host}`;


    // ==========================================
    // 1. CHECK RISK AGENT
    // ==========================================

    const riskResponse =
      await fetch(`${baseUrl}/api/risk-agent`);

    if (!riskResponse.ok) {

      return res.status(500).json({
        status: "error",
        stage: "risk-agent",
        executed: false,
        message: "Risk Agent request failed"
      });

    }

    const risk =
      await riskResponse.json();


    if (risk.status !== "ok") {

      return res.status(500).json({
        status: "error",
        stage: "risk-agent",
        executed: false,
        risk
      });

    }


    // ==========================================
    // 2. WAIT = STOP
    // ==========================================

    if (risk.marketDecision === "WAIT") {

      return res.status(200).json({
        status: "ok",
        mode: "DRY_RUN",
        executed: false,

        decision: "WAIT",

        confidence:
          risk.confidence,

        riskApproved: false,

        reason:
          risk.reason,

        message:
          "Agents decided to wait. No trade."
      });

    }


    // ==========================================
    // 3. RISK BLOCK = STOP
    // ==========================================

    if (risk.riskApproved !== true) {

      return res.status(200).json({
        status: "blocked",
        mode: "DRY_RUN",
        executed: false,

        decision:
          risk.marketDecision,

        confidence:
          risk.confidence,

        riskApproved: false,

        reason:
          risk.reason,

        message:
          "Trade blocked by Risk Agent."
      });

    }


    // ==========================================
    // 4. EXECUTION AGENT
    // ==========================================

    const executionResponse =
      await fetch(
        `${baseUrl}/api/execution-agent`,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({

            decision:
              risk.marketDecision,

            confidence:
              risk.confidence,

            riskApproved:
              risk.riskApproved,

            symbol:
              risk.pair,

            amount:
              risk.amount

          })
        }
      );


    if (!executionResponse.ok) {

      return res.status(500).json({
        status: "error",
        stage: "execution-agent",
        executed: false,
        message:
          "Execution Agent request failed"
      });

    }


    const execution =
      await executionResponse.json();


    // ==========================================
    // 5. FINAL RESULT
    // ==========================================

    return res.status(200).json({

      status: "ok",

      mode: "DRY_RUN",

      executed: false,

      market: {

        pair:
          risk.pair,

        price:
          risk.currentPrice,

        momentum:
          risk.momentum,

        volatility:
          risk.volatility

      },

      agents: {

        decision:
          risk.marketDecision,

        confidence:
          risk.confidence,

        riskDecision:
          risk.riskDecision,

        riskApproved:
          risk.riskApproved,

        reason:
          risk.reason

      },

      execution

    });


  } catch (error) {

    console.error(
      "Trade Orchestrator Error:",
      error
    );

    return res.status(500).json({

      status: "error",

      mode: "DRY_RUN",

      executed: false,

      message:
        error.message ||
        "Trade Orchestrator failed"

    });

  }
}

