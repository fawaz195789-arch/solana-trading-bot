// ======================================================
// WALLET CONNECTION + REAL BALANCES TEST
// NO TRADE / NO TRANSACTION
// ======================================================

async function handleWalletTest(
  req,
  res
) {
  try {

    // ===============================================
    // LOAD PRIVATE KEY
    // ===============================================

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

          status:
            "error",

          test:
            "WALLET_CONNECTION",

          executed:
            false,

          keyLoaded:
            true,

          keyValid:
            true,

          walletMatch:
            false,

          configuredWallet,

          derivedWallet:
            derivedAddress,

          message:
            "Private key does not match configured wallet"
        });
    }


    // ===============================================
    // CONNECT TO SOLANA
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
      Math.pow(
        10,
        SOL_DECIMALS
      );


    // ===============================================
    // REAL USDC BALANCE
    // ===============================================

    const usdcMint =
      new PublicKey(
        USDC_MINT
      );


    const tokenAccounts =
      await connection
        .getParsedTokenAccountsByOwner(
          keypair.publicKey,
          {
            mint:
              usdcMint
          }
        );


    let usdcBalance =
      0;


    for (
      const account
      of tokenAccounts.value
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


      const atomic =
        Number(
          tokenAmount.amount
        );


      if (
        Number.isFinite(
          atomic
        )
      ) {

        usdcBalance +=
          atomic /
          Math.pow(
            10,
            USDC_DECIMALS
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

        balances: {

          sol:
            Number(
              solBalance
                .toFixed(9)
            ),

          usdc:
            Number(
              usdcBalance
                .toFixed(6)
            )
        },

        solBalance:
          Number(
            solBalance
              .toFixed(9)
          ),

        usdcBalance:
          Number(
            usdcBalance
              .toFixed(6)
          ),

        timestamp:
          new Date()
            .toISOString(),

        message:
          "Real on-chain SOL and USDC balances loaded successfully. No trade was executed."
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

        keyLoaded:
          false,

        walletMatch:
          false,

        rpcConnected:
          false,

        tradingKeyReady:
          false,

        message:
          error?.message ||
          "Wallet connection test failed",

        timestamp:
          new Date()
            .toISOString()
      });
  }
}
