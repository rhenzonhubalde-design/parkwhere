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

const INCIDENTS_ENDPOINT = 'https://datamall2.mytransport.sg/ltaodataservice/TrafficIncidents';
let incidentsCache = { data: null, fetchedAt: 0 };

app.get('/api/incidents', async (req, res) => {
  const now = Date.now();
  if (incidentsCache.data && now - incidentsCache.fetchedAt < CACHE_TTL_MS) {
    return res.json({
      data: incidentsCache.data,
      fetchedAt: new Date(incidentsCache.fetchedAt).toISOString(),
      stale: false,
    });
  }

  try {
    const r = await fetch(INCIDENTS_ENDPOINT, {
      headers: { AccountKey: LTA_API_KEY, Accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`LTA API responded ${r.status} ${r.statusText}`);
    const json = await r.json();
    const data = Array.isArray(json.value) ? json.value : [];
    incidentsCache = { data, fetchedAt: now };
    res.json({ data, fetchedAt: new Date(now).toISOString(), stale: false });
  } catch (err) {
    console.error('[lta] incidents fetch failed:', err.message);
    if (incidentsCache.data) {
      return res.json({
        data: incidentsCache.data,
        fetchedAt: new Date(incidentsCache.fetchedAt).toISOString(),
        stale: true,
        error: err.message,
      });
    }
    res.status(502).json({ error: 'Upstream LTA API unavailable', detail: err.message });
  }
});

// ---------- EV charging (EVCBatch: all stations + live availability) ----------
const EVCBATCH_ENDPOINT = 'https://datamall2.mytransport.sg/ltaodataservice/EVCBatch';
const EV_TTL_MS = 4.5 * 60 * 1000; // LTA refreshes every 5 min; signed link valid 5 min
let evCache = { data: null, fetchedAt: 0 };

function summariseEVStations(raw) {
  // The batch file nests the array under a few possible shapes.
  const arr =
    (raw && raw.value && raw.value.evLocationsData) ||
    (raw && raw.evLocationsData) ||
    (Array.isArray(raw && raw.value) ? raw.value : null) ||
    [];

  const out = [];
  for (const loc of arr) {
    const lat = parseFloat(loc.latitude);
    const lng = parseFloat(loc.longtitude ?? loc.longitude); // LTA spells it "longtitude"
    if (!isFinite(lat) || !isFinite(lng)) continue;

    const operators = new Set();
    const plugs = new Set();
    let available = 0, occupied = 0, offline = 0, total = 0;
    let maxKw = 0;
    let price = '', priceType = '';

    for (const cp of loc.chargingPoints || []) {
      if (cp.operator) operators.add(cp.operator);
      for (const pt of cp.plugTypes || []) {
        if (pt.plugType) plugs.add(pt.plugType);
        // Batch file: kW is in `powerRating` (numeric), `current` is AC/DC.
        // Postal-code endpoint: kW is in `chargingSpeed`, `powerRating` is AC/DC.
        const kw = parseFloat(pt.powerRating) || parseFloat(pt.chargingSpeed);
        if (isFinite(kw) && kw > maxKw) maxKw = kw;
        if (!price && pt.price) { price = pt.price; priceType = pt.priceType || ''; }
        for (const ev of pt.evIds || []) {
          total++;
          if (ev.status === '1') available++;
          else if (ev.status === '0') occupied++;
          else offline++;
        }
      }
    }
    if (total === 0) continue;

    out.push({
      name: loc.name || loc.address || 'EV Charging',
      address: loc.address || '',
      lat, lng,
      operators: [...operators],
      plugs: [...plugs],
      maxKw,
      available, occupied, offline, total,
      price, priceType,
    });
  }
  return out;
}

async function fetchEVStations() {
  const r1 = await fetch(EVCBATCH_ENDPOINT, {
    headers: { AccountKey: LTA_API_KEY, Accept: 'application/json' },
  });
  if (!r1.ok) throw new Error(`EVCBatch responded ${r1.status} ${r1.statusText}`);
  const j1 = await r1.json();
  const link = j1 && j1.value && j1.value[0] && j1.value[0].Link;
  if (!link) throw new Error('EVCBatch returned no download link');

  const r2 = await fetch(link, { headers: { Accept: 'application/json' } });
  if (!r2.ok) throw new Error(`EV batch file responded ${r2.status}`);
  const raw = await r2.json();
  return summariseEVStations(raw);
}

app.get('/api/ev', async (req, res) => {
  const now = Date.now();
  if (evCache.data && now - evCache.fetchedAt < EV_TTL_MS) {
    return res.json({
      data: evCache.data,
      fetchedAt: new Date(evCache.fetchedAt).toISOString(),
      stale: false,
    });
  }
  try {
    const data = await fetchEVStations();
    evCache = { data, fetchedAt: now };
    res.json({ data, fetchedAt: new Date(now).toISOString(), stale: false });
  } catch (err) {
    console.error('[lta] EV fetch failed:', err.message);
    if (evCache.data) {
      return res.json({
        data: evCache.data,
        fetchedAt: new Date(evCache.fetchedAt).toISOString(),
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

// index.html must never be cached — it's the app shell and changes on every deploy.
// (Other static assets could be cached, but this is a single-file SPA.)
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`ParkWhere SG running on http://localhost:${PORT}`);
});
