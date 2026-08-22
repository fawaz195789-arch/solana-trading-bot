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

    const message = timestamp + method + requestPath;

    const signature = crypto
      .createHmac("sha256", secretKey)
      .update(message)
      .digest("base64");

    const response = await fetch(
      "https://www.okx.com" + requestPath,
      {
        method: "GET",
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

    return res.status(200).json({
      status: data.code === "0" ? "ok" : "error",
      okxCode: data.code,
      message:
        data.code === "0"
          ? "OKX connected successfully"
          : data.msg
    });

  } catch (error) {
    return res.status(500).json({
      status: "error",
      message: error.message
    });
  }
}
