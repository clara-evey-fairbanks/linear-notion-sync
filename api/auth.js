// POST /api/auth
// Body: { password: "..." }
// Checks against DASHBOARD_PASSWORD env var.
// Returns a signed token the client stores in sessionStorage.

import crypto from 'crypto';

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (req.method !== 'POST') return res.status(405).end();

  const { password } = req.body ?? {};
  const correct = process.env.DASHBOARD_PASSWORD;
  const secret  = process.env.LINEAR_API_KEY ?? 'fallback-secret';

  if (!correct) {
    // No password set — open access (dev mode)
    const token = sign('open', secret);
    return res.json({ ok: true, token });
  }

  if (!password || password !== correct) {
    return res.status(401).json({ ok: false, error: 'Incorrect password' });
  }

  // Return a token the client can use to verify it authenticated correctly
  const token = sign(correct, secret);
  res.json({ ok: true, token });
}
