require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const LTA_API_KEY = process.env.LTA_API_KEY;
const LTA_ENDPOINT = 'https://datamall2.mytransport.sg/ltaodataservice/CarParkAvailabilityv2';
const ONEMAP_SEARCH = 'https://www.onemap.gov.sg/api/common/elastic/search';

const CACHE_TTL_MS = 55 * 1000;
let cache = { data: null, fetchedAt: 0, stale: false };

if (!LTA_API_KEY) {
  console.warn('[warn] LTA_API_KEY is not set — /api/carparks will return errors until it is configured.');
}

async function fetchAllCarparks() {
  const merged = [];
  let skip = 0;
  const pageSize = 500;

  while (true) {
    const url = `${LTA_ENDPOINT}?$skip=${skip}`;
    const res = await fetch(url, {
      headers: {
        AccountKey: LTA_API_KEY,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      throw new Error(`LTA API responded ${res.status} ${res.statusText}`);
    }

    const json = await res.json();
    const page = Array.isArray(json.value) ? json.value : [];
    merged.push(...page);

    if (page.length < pageSize) break;
    skip += pageSize;

    if (skip > 10000) break;
  }

  return merged;
}

app.get('/api/carparks', async (req, res) => {
  const now = Date.now();
  const ageMs = now - cache.fetchedAt;

  if (cache.data && ageMs < CACHE_TTL_MS) {
    return res.json({
      data: cache.data,
      fetchedAt: new Date(cache.fetchedAt).toISOString(),
      stale: false,
    });
  }

  try {
    const data = await fetchAllCarparks();
    cache = { data, fetchedAt: now, stale: false };
    res.json({
      data,
      fetchedAt: new Date(now).toISOString(),
      stale: false,
    });
  } catch (err) {
    console.error('[lta] fetch failed:', err.message);
    if (cache.data) {
      return res.json({
        data: cache.data,
        fetchedAt: new Date(cache.fetchedAt).toISOString(),
        stale: true,
        error: err.message,
      });
    }
    res.status(502).json({ error: 'Upstream LTA API unavailable', detail: err.message });
  }
});

app.get('/api/geocode', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q || q.length < 2) return res.json({ results: [] });

  try {
    const url = `${ONEMAP_SEARCH}?searchVal=${encodeURIComponent(q)}&returnGeom=Y&getAddrDetails=Y&pageNum=1`;
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`OneMap responded ${r.status}`);
    const json = await r.json();
    const seen = new Set();
    const results = [];
    for (const it of (json.results || [])) {
      const lat = parseFloat(it.LATITUDE);
      const lng = parseFloat(it.LONGITUDE);
      if (!isFinite(lat) || !isFinite(lng)) continue;
      const label = it.SEARCHVAL || it.BUILDING || it.ADDRESS || q;
      const dedupeKey = label.toUpperCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      results.push({
        lat,
        lng,
        label,
        address: it.ADDRESS || label,
        postal: it.POSTAL && it.POSTAL !== 'NIL' ? it.POSTAL : '',
      });
      if (results.length >= 6) break;
    }
    res.json({ results });
  } catch (err) {
    console.error('[onemap] geocode failed:', err.message);
    res.status(502).json({ error: 'Geocoding failed', detail: err.message });
  }
});

app.get('/health', (req, res) => {
  const cacheAge = cache.data ? Math.round((Date.now() - cache.fetchedAt) / 1000) : null;
  res.json({ status: 'ok', cacheAge });
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`ParkWhere SG running on http://localhost:${PORT}`);
});
