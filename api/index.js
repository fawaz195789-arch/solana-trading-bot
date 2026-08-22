export default function handler(req, res) {
  res.status(200).json({
    status: "ok",
    message: "Solana Trading Bot is running"
  });
}
