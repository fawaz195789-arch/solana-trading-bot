export default function handler(req, res) {
  res.status(200).json({
    OKX_API_KEY: !!process.env.OKX_API_KEY,
    OKX_SECRET_KEY: !!process.env.OKX_SECRET_KEY,
    OKX_PASSPHRASE: !!process.env.OKX_PASSPHRASE
  });
}
