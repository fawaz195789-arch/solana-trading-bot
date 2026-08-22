export default function handler(req, res) {
  res.status(200).json({
    OKX_API_KEY: !!process.env.OKX_API_KEY,
    OKX_SECRET_KEY: !!process.env.OKX_SECRET_KEY,
    OKX_PASSPHRASE: !!process.env.OKX_PASSPHRASE
  });
}
      {
        method,
        headers: {
          "OK-ACCESS-KEY": apiKey,
          "OK-ACCESS-SIGN": signature,
          "OK-ACCESS-TIMESTAMP": timestamp,
          "OK-ACCESS-PASSPHRASE": passphrase,
          "Content-Type": "application/json"
        }
      }
    );

    const data = await response.json();

    if (data.code !== "0") {
      return res.status(400).json({
        status: "error",
        okxCode: data.code,
        message: data.msg
      });
    }

    return res.status(200).json({
      status: "ok",
      message: "OKX connected successfully",
      balance: data.data
    });

  } catch (error) {
    return res.status(500).json({
      status: "error",
      message: error.message
    });
  }
}
