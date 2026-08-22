let tradingEnabled = false;

export default function handler(req, res) {

  // قراءة حالة التداول
  if (req.method === "GET") {

    return res.status(200).json({
      status: "ok",
      enabled: tradingEnabled
    });

  }

  // تشغيل أو إيقاف التداول
  if (req.method === "POST") {

    const { enabled } = req.body || {};

    if (typeof enabled !== "boolean") {

      return res.status(400).json({
        status: "error",
        message: "enabled must be boolean"
      });

    }

    tradingEnabled = enabled;

    return res.status(200).json({
      status: "ok",
      enabled: tradingEnabled
    });

  }

  return res.status(405).json({
    status: "error",
    message: "Method not allowed"
  });

}
