export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      status: "error",
      message: "POST only"
    });
  }

  const { action, signalId } = req.body || {};

  if (!signalId) {
    return res.status(400).json({
      status: "error",
      message: "Missing signalId"
    });
  }

  if (!["approve", "reject"].includes(action)) {
    return res.status(400).json({
      status: "error",
      message: "Invalid action"
    });
  }

  return res.status(200).json({
    status: "ok",
    signalId,
    action,
    message:
      action === "approve"
        ? "Signal approved"
        : "Signal rejected"
  });
}
