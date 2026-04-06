export default async function handler(req, res) {
  const { path, token } = req.query;

  if (!path || !token) {
    return res.status(400).json({ error: "Missing path or token" });
  }

  // Allow csgo, lol, dota2 endpoints
  const allowed = /^(csgo|lol|dota2)\//;
  if (!allowed.test(path)) {
    return res.status(403).json({ error: "Path not allowed" });
  }

  const url = `https://api.pandascore.co/${path}`;
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await resp.json();

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=30");
    return res.status(resp.status).json(data);
  } catch (e) {
    return res.status(502).json({ error: "Upstream fetch failed", detail: e.message });
  }
}
