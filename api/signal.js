export default async function handler(req, res) {
  const signal = {
    signalId: crypto.randomUUID(),
    pair: "SOL-USDC",
    action: "BUY",
    amount: 5,
    currency: "USDC",
    confidence: 82,
    status: "waiting_approval",
    createdAt: new Date().toISOString()
  };

  return res.status(200).json({
    status: "ok",
    signal
  });
}
