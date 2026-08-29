// ======================================================
// WALLET CONNECTION + REAL ON-CHAIN BALANCES
// NO TRADE / NO TRANSACTION
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
      configuredWallet === derivedAddress;


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
          derivedWallet: derivedAddress,
          message:
            "Private key does not match configured wallet"
        });
    }


    // ===============================================
    // SOLANA RPC CONNECTION
    // ===============================================

    const connection =
      new Connection(
        RPC_URL,
        "confirmed"
      );


    // ===============================================
    // REAL SOL BALANCE
    // ===============================================

    const balanceLamports =
      await connection.getBalance(
        keypair.publicKey
      );

    const solBalance =
      balanceLamports /
      1_000_000_000;


    // ===============================================
    // REAL USDC BALANCE VIA RAW SOLANA RPC
    // ===============================================

    const tokenResponse =
      await fetch(
        RPC_URL,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,

              method:
                "getTokenAccountsByOwner",

              params: [
                derivedAddress,

                {
                  mint:
                    USDC_MINT
                },

                {
                  encoding:
                    "jsonParsed",

                  commitment:
                    "confirmed"
                }
              ]
            })
        }
      );


    const tokenData =
      await tokenResponse.json();


    if (
      tokenData?.error
    ) {
      throw new Error(
        "USDC_BALANCE_RPC_FAILED:" +
        JSON.stringify(
          tokenData.error
        )
      );
    }


    const accounts =
      Array.isArray(
        tokenData?.result?.value
      )
        ? tokenData.result.value
        : [];


    let usdcBalance = 0;


    for (
      const account
      of accounts
    ) {

      const tokenAmount =
        account
          ?.account
          ?.data
          ?.parsed
          ?.info
          ?.tokenAmount;


      if (!tokenAmount) {
        continue;
      }


      const amount =
        Number(
          tokenAmount.amount
        );

      const decimals =
        Number(
          tokenAmount.decimals
        );


      if (
        Number.isFinite(amount) &&
        Number.isFinite(decimals)
      ) {

        usdcBalance +=
          amount /
          Math.pow(
            10,
            decimals
          );
      }
    }


    // ===============================================
    // SUCCESS
    // ===============================================

    return res
      .status(200)
      .json({

        status:
          "ok",

        test:
          "WALLET_CONNECTION",

        source:
          "SOLANA_MAINNET",

        balancesSource:
          "ON_CHAIN",

        executed:
          false,

        keyLoaded:
          true,

        keyValid:
          true,

        walletMatch:
          true,

        rpcConnected:
          true,

        tradingKeyReady:
          true,

        walletAddress:
          derivedAddress,

        solBalance:
          Number(
            solBalance.toFixed(9)
          ),

        usdcBalance:
          Number(
            usdcBalance.toFixed(6)
          ),

        balances: {
          sol:
            Number(
              solBalance.toFixed(9)
            ),

          usdc:
            Number(
              usdcBalance.toFixed(6)
            )
        },

        timestamp:
          new Date()
            .toISOString(),

        message:
          "Real SOL and USDC balances loaded directly from Solana. No trade was executed."
      });


  } catch (error) {

    console.error(
      "Wallet Test Error:",
      error
    );

    return res
      .status(500)
      .json({

        status:
          "error",

        test:
          "WALLET_CONNECTION",

        executed:
          false,

        tradingKeyReady:
          false,

        message:
          error?.message ||
          "Wallet balance test failed",

        timestamp:
          new Date()
            .toISOString()
      });
  }
}
