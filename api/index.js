import crypto from "crypto";

export default async function handler(req, res) {
  try {
    const apiKey = process.env.OKX_API_KEY;
    const secretKey = process.env.OKX_SECRET_KEY;
    const passphrase = process.env.OKX_PASSPHRASE;

    if (!apiKey || !secretKey || !passphrase) {
      return res.status(500).json({
        status: "error",
        message: "Missing OKX environment variables"
      });
    }

    const timestamp = new Date().toISOString();
    const method = "GET";
    const requestPath = "/api/v5/account/balance";
    const body = "";

    const prehash = timestamp + method + requestPath + body;

    const signature = crypto
      .createHmac("sha256", secretKey)
      .update(prehash)
      .digest("base64");

    const response = await fetch(
      "https://www.okx.com" + requestPath,
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
