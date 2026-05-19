require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const LTA_API_KEY = process.env.LTA_API_KEY;
const URA_ACCESS_KEY = process.env.URA_ACCESS_KEY;
const LTA_ENDPOINT = 'https://datamall2.mytransport.sg/ltaodataservice/CarParkAvailabilityv2';
const URA_TOKEN_URL = 'https://www.ura.gov.sg/uraDataService/insertNewToken.action';
const URA_DS_URL = 'https://www.ura.gov.sg/uraDataService/invokeUraDS';
const ONEMAP_SEARCH = 'https://www.onemap.gov.sg/api/common/elastic/search';

const CACHE_TTL_MS = 55 * 1000;
let cache = { data: null, fetchedAt: 0, stale: false };

if (!LTA_API_KEY) {
  console.warn('[warn] LTA_API_KEY is not set — /api/carparks will return errors until it is configured.');
}
if (!URA_ACCESS_KEY) {
  console.warn('[warn] URA_ACCESS_KEY is not set — URA carparks (malls, private lots) will be skipped.');
}

// ---------- URA token management (token valid 24 h; refresh every 23 h) ----------
let uraToken = { token: null, fetchedAt: 0 };
const URA_TOKEN_TTL_MS = 23 * 60 * 60 * 1000;

async function getURAToken() {
  const now = Date.now();
  if (uraToken.token && now - uraToken.fetchedAt < URA_TOKEN_TTL_MS) {
    return uraToken.token;
  }
  const r = await fetch(`${URA_TOKEN_URL}?accesskey=${encodeURIComponent(URA_ACCESS_KEY)}`, {
    headers: { Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`URA token API: ${r.status} ${r.statusText}`);
  const j = await r.json();
  if (j.Status !== 'Success' || !j.Result) {
    throw new Error(`URA token failed: ${j.Message || JSON.stringify(j)}`);
  }
  uraToken = { token: j.Result, fetchedAt: now };
  console.log('[ura] refreshed token');
  return j.Result;
}

// ---------- SVY21 → WGS84 (inverse Transverse Mercator, Redfearn's formulae) ----------
// Parameters from SVY21 projection (EPSG:3414)
function svy21ToWgs84(northing, easting) {
  const a   = 6378137.0;           // WGS84 semi-major axis (m)
  const f   = 1 / 298.257223563;   // WGS84 flattening
  const k0  = 1.0;                 // scale factor
  const E0  = 28001.642;           // false easting (m)
  const N0  = 38744.572;           // false northing (m)
  const φ0  = 1.366666666666667 * (Math.PI / 180); // latitude of origin (rad)
  const λ0  = 103.8333333333333 * (Math.PI / 180); // central meridian (rad)

  const e2  = 2 * f - f * f;       // first eccentricity squared
  const ep2 = e2 / (1 - e2);       // second eccentricity squared
  const b   = a * Math.sqrt(1 - e2);

  const e4 = e2 * e2, e6 = e4 * e2;

  function meridArc(φ) {
    return a * (
      (1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * φ
      - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * φ)
      + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * φ)
      - (35 * e6 / 3072) * Math.sin(6 * φ)
    );
  }

  const M0 = meridArc(φ0);
  const M  = M0 + (northing - N0) / k0;
  const μ  = M / (a * (1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256));

  const e1   = (1 - b / a) / (1 + b / a);
  const e1_2 = e1 * e1, e1_3 = e1_2 * e1, e1_4 = e1_3 * e1;
  const φ1   = μ
    + (3 * e1 / 2       - 27 * e1_3 / 32)   * Math.sin(2 * μ)
    + (21 * e1_2 / 16   - 55 * e1_4 / 32)   * Math.sin(4 * μ)
    + (151 * e1_3 / 96)                       * Math.sin(6 * μ)
    + (1097 * e1_4 / 512)                     * Math.sin(8 * μ);

  const sinφ1 = Math.sin(φ1), cosφ1 = Math.cos(φ1), tanφ1 = Math.tan(φ1);
  const N1    = a / Math.sqrt(1 - e2 * sinφ1 * sinφ1);
  const R1    = a * (1 - e2) / Math.pow(1 - e2 * sinφ1 * sinφ1, 1.5);
  const T1    = tanφ1 * tanφ1;
  const C1    = ep2 * cosφ1 * cosφ1;
  const D     = (easting - E0) / (N1 * k0);
  const D2 = D * D, D3 = D2 * D, D4 = D3 * D, D5 = D4 * D, D6 = D5 * D;

  const φ = φ1 - (N1 * tanφ1 / R1) * (
      D2 / 2
    - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D4 / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D6 / 720
  );
  const λ = λ0 + (
      D
    - (1 + 2 * T1 + C1) * D3 / 6
    + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D5 / 120
  ) / cosφ1;

  return { lat: φ * 180 / Math.PI, lng: λ * 180 / Math.PI };
}

// ---------- URA carpark fetch ----------
async function fetchURACarparks() {
  const token = await getURAToken();
  const headers = {
    AccessKey: URA_ACCESS_KEY,
    Token: token,
    Accept: 'application/json',
  };

  // Fetch details (name, geometry, capacity) and availability in parallel
  const [dRes, aRes] = await Promise.all([
    fetch(`${URA_DS_URL}?service=Car_Park_Details`, { headers }),
    fetch(`${URA_DS_URL}?service=Car_Park_Availability`, { headers }),
  ]);
  if (!dRes.ok) throw new Error(`URA Car_Park_Details: ${dRes.status} ${dRes.statusText}`);
  if (!aRes.ok) throw new Error(`URA Car_Park_Availability: ${aRes.status} ${aRes.statusText}`);

  const [dJson, aJson] = await Promise.all([dRes.json(), aRes.json()]);
  if (dJson.Status !== 'Success') throw new Error(`URA details status: ${dJson.Message}`);
  if (aJson.Status !== 'Success') throw new Error(`URA avail status: ${aJson.Message}`);

  // Build availability map: ppCode → available car lots
  const availMap = new Map();
  for (const lot of aJson.Result || []) {
    if (lot.lotType !== 'C') continue;
    availMap.set(lot.carparkNo, parseInt(lot.lotsAvailable, 10) || 0);
  }

  // Process details → one record per car carpark with valid geometry
  const seen = new Set();
  const records = [];
  for (const cp of dJson.Result || []) {
    // Filter to car category only (URA uses "Car" as vehicle category)
    if (!cp.vehCat || !cp.vehCat.toLowerCase().startsWith('car')) continue;
    if (seen.has(cp.ppCode)) continue; // deduplicate ppCode
    seen.add(cp.ppCode);

    const geom = cp.geometries && cp.geometries[0];
    if (!geom || !geom.coordinates) continue;
    const parts = geom.coordinates.split(',');
    if (parts.length < 2) continue;
    const E = parseFloat(parts[0]); // Easting
    const N = parseFloat(parts[1]); // Northing
    if (!isFinite(E) || !isFinite(N)) continue;

    const { lat, lng } = svy21ToWgs84(N, E);
    if (!isFinite(lat) || !isFinite(lng)) continue;
    // Sanity-check: must be within Singapore bounding box
    if (lat < 1.1 || lat > 1.5 || lng < 103.5 || lng > 104.1) continue;

    const available = availMap.get(cp.ppCode) ?? 0;
    const total     = parseInt(cp.parkCapacity, 10) || 0;

    records.push({
      CarParkID:     `URA_${cp.ppCode}`,
      Development:   cp.ppName || cp.ppCode,
      Area:          '',
      Agency:        'URA',
      Location:      `${lat} ${lng}`,
      LotType:       'C',
      AvailableLots: available,
      TotalLots:     total,
    });
  }

  console.log(`[ura] loaded ${records.length} car carparks`);
  return records;
}

// ---------- LTA carpark fetch (paginated) ----------
async function fetchLTACarparks() {
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

// ---------- Merged fetch: LTA + URA ----------
async function fetchAllCarparks() {
  const [ltaResult, uraResult] = await Promise.allSettled([
    fetchLTACarparks(),
    URA_ACCESS_KEY ? fetchURACarparks() : Promise.resolve([]),
  ]);

  if (ltaResult.status === 'rejected' && uraResult.status === 'rejected') {
    throw ltaResult.reason;
  }

  const lta = ltaResult.status === 'fulfilled' ? ltaResult.value : [];
  const ura = uraResult.status === 'fulfilled' ? uraResult.value : [];

  if (ltaResult.status === 'rejected') {
    console.warn('[lta] fetch failed, URA-only fallback:', ltaResult.reason.message);
  }
  if (uraResult.status === 'rejected') {
    console.warn('[ura] fetch failed, LTA-only fallback:', uraResult.reason.message);
  }

  return [...lta, ...ura];
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

// ---------- Google Routes API proxy (v2 — replaces legacy Directions API) ----------
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const GROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

const ERP_CODES = ['AYE', 'BKE', 'CTE', 'ECP', 'KPE', 'MCE', 'PIE', 'SLE', 'TPE'];

// Scan any text (summary or step instruction) for Singapore ERP expressways
function extractExpressways(routeDescription, steps) {
  const found = new Set();

  function scan(raw) {
    // Strip any HTML tags (legacy compat) and uppercase
    const text = (raw || '').replace(/<[^>]+>/g, ' ').toUpperCase();
    for (const code of ERP_CODES)       { if (text.includes(code))             found.add(code); }
    if (text.includes('AYER RAJAH'))      found.add('AYE');
    if (text.includes('BUKIT TIMAH'))     found.add('BKE');
    if (text.includes('CENTRAL EXP'))     found.add('CTE');
    if (text.includes('EAST COAST'))      found.add('ECP');
    if (text.includes('KALLANG'))         found.add('KPE');
    if (text.includes('MARINA COASTAL'))  found.add('MCE');
    if (text.includes('PAN ISLAND'))      found.add('PIE');
    if (text.includes('SELETAR'))         found.add('SLE');
    if (text.includes('TAMPINES EXP'))    found.add('TPE');
  }

  scan(routeDescription);
  for (const step of steps || []) {
    // Routes API uses navigationInstruction.instructions (plain text)
    scan(step.navigationInstruction?.instructions || step.html_instructions || '');
  }
  return [...found];
}

// Routes API returns duration as "1440s" → "24 min" / "1 hr 5 min"
function humanDuration(durStr) {
  const s = parseInt((durStr || '0s'), 10);
  const h = Math.floor(s / 3600);
  const m = Math.ceil((s % 3600) / 60);
  if (h > 0 && m > 0) return `${h} hr ${m} min`;
  if (h > 0) return `${h} hr`;
  return `${m} min`;
}

// Routes API returns distanceMeters → "18.2 km"
function humanDistance(meters) {
  if (!meters) return '—';
  return meters < 1000 ? `${meters} m` : `${(meters / 1000).toFixed(1)} km`;
}

// ---------- ERP estimator (PDF-derived, corridor + time-window) ----------
let ERP_RATES = null;
try {
  ERP_RATES = JSON.parse(
    require('fs').readFileSync(path.join(__dirname, 'public', 'data', 'erp-rates.json'), 'utf8')
  );
  console.log(`[erp] loaded rate table (effective ${ERP_RATES.effectiveFrom}, ${ERP_RATES.corridors.length} corridors)`);
} catch (e) {
  console.warn('[erp] could not load erp-rates.json:', e.message);
}

// Current Singapore wall-clock (UTC+8, no DST)
function sgNow() {
  const utc = Date.now() + new Date().getTimezoneOffset() * 60000;
  const d = new Date(utc + 8 * 3600000);
  const dow = d.getDay(); // 0=Sun..6=Sat
  return {
    minutes: d.getHours() * 60 + d.getMinutes(),
    dow,
    hhmm: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
    isWeekday: dow >= 1 && dow <= 5,
  };
}
const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

// Estimate ERP for a route given the expressways it uses + vehicle type.
// Honest by design: per-corridor estimate (a route on AYE may not hit every AYE
// gantry), surfaced as a range, never a fake-precise total.
function estimateERP(expressways, vehicle) {
  if (!ERP_RATES) return null;
  const mult = ERP_RATES.vehicleMultipliers[vehicle] ?? 1.0;
  const now = sgNow();

  if (!now.isWeekday) {
    return { charging: false, total: 0, sgTime: now.hhmm,
      reason: 'No ERP — weekends & public holidays are free.', corridors: [] };
  }

  const matched = [];
  let lo = 0, hi = 0;
  for (const code of expressways) {
    const corr = ERP_RATES.corridors.find((c) => c.expressway === code);
    if (!corr) continue;
    const win = corr.windows.find(
      (w) => now.minutes >= toMin(w.start) && now.minutes < toMin(w.end)
    );
    if (win) {
      const r = +(win.rate * mult).toFixed(2);
      matched.push({ expressway: code, label: corr.label, rate: r,
        window: `${win.start}–${win.end}` });
      hi += r;          // upper bound: every matched corridor charges once
      lo = Math.max(lo, r); // lower bound: at least the single priciest corridor
    }
  }

  if (matched.length === 0) {
    const usedErpExpwy = expressways.some((e) =>
      ERP_RATES.corridors.some((c) => c.expressway === e));
    return { charging: false, total: 0, sgTime: now.hhmm,
      reason: usedErpExpwy
        ? 'No ERP now — outside charging hours on these roads.'
        : 'No priced ERP corridors on this route.',
      corridors: [] };
  }

  return {
    charging: true,
    sgTime: now.hhmm,
    estLow: +lo.toFixed(2),
    estHigh: +hi.toFixed(2),
    corridors: matched,
    reason: `Peak ERP in effect (${now.hhmm}, weekday).`,
  };
}

app.get('/api/directions', async (req, res) => {
  if (!GOOGLE_MAPS_API_KEY) {
    return res.status(503).json({ error: 'Directions service not configured on this server.' });
  }
  const { olat, olng, dlat, dlng } = req.query;
  const vehicle = ['car', 'motorcycle', 'heavy'].includes(req.query.vehicle)
    ? req.query.vehicle : 'car';
  if (!olat || !olng || !dlat || !dlng) {
    return res.status(400).json({ error: 'Missing coordinates: need olat, olng, dlat, dlng' });
  }

  const mapsBase =
    `https://www.google.com/maps/dir/?api=1` +
    `&origin=${olat},${olng}&destination=${dlat},${dlng}&travelmode=driving`;

  async function callRoutes(avoidTolls) {
    const body = {
      origin:      { location: { latLng: { latitude:  parseFloat(olat), longitude: parseFloat(olng) } } },
      destination: { location: { latLng: { latitude:  parseFloat(dlat), longitude: parseFloat(dlng) } } },
      travelMode: 'DRIVE',
      computeAlternativeRoutes: !avoidTolls, // alternates only needed on the primary call
      // TRAFFIC_AWARE → ETAs reflect live traffic, matching Google Maps app times
      routingPreference: 'TRAFFIC_AWARE',
      languageCode: 'en-US',
    };
    if (avoidTolls) body.routeModifiers = { avoidTolls: true };

    const r = await fetch(GROUTES_URL, {
      method: 'POST',
      headers: {
        'Content-Type':     'application/json',
        'X-Goog-Api-Key':   GOOGLE_MAPS_API_KEY,
        'X-Goog-FieldMask': 'routes.description,routes.duration,routes.distanceMeters,routes.routeLabels,routes.legs.steps.navigationInstruction',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const errBody = await r.json().catch(() => ({}));
      throw new Error(errBody.error?.message || `Routes API: ${r.status} ${r.statusText}`);
    }
    return r.json();
  }

  function mapRoute(route, label) {
    const steps = (route.legs || []).flatMap((leg) => leg.steps || []);
    const expressways = extractExpressways(route.description, steps);
    const erp = estimateERP(expressways, vehicle);
    return {
      label,
      summary:       route.description || '',
      distance:      humanDistance(route.distanceMeters),
      duration:      humanDuration(route.duration),
      durationValue: parseInt((route.duration || '0s'), 10),
      expressways,
      erpLikely:     expressways.length > 0,
      erp,
      mapsUrl:       mapsBase,
    };
  }
  const erpHigh = (rt) => (rt.erp && rt.erp.charging ? rt.erp.estHigh : 0);

  try {
    const j = await callRoutes(false);
    if (!j.routes || j.routes.length === 0) {
      return res.json({ routes: [], warning: 'No route found between these points.' });
    }

    // Keep every distinct route Google returns (up to 3) so the motorist can
    // weigh time vs ERP themselves. Dedupe only exact repeats.
    const routes = [];
    const seen = new Set();
    for (const rt of j.routes.slice(0, 4)) {
      const m = mapRoute(rt, 'Alternative');
      const key = `${(m.summary || '').toLowerCase()}|${m.durationValue}`;
      if (seen.has(key)) continue;
      seen.add(key);
      routes.push(m);
      if (routes.length >= 3) break;
    }
    routes[0].label = 'Fastest';

    // If every route so far is charged, do ONE avoidTolls call to try to
    // surface a cheaper / ERP-free option — added, never replacing the others.
    const cheapestHi = Math.min(...routes.map(erpHigh));
    if (cheapestHi > 0) {
      try {
        const ja = await callRoutes(true);
        const alt = ja.routes && ja.routes[0] ? mapRoute(ja.routes[0], 'Cheaper') : null;
        if (alt) {
          const altKey = `${(alt.summary || '').toLowerCase()}|${alt.durationValue}`;
          if (!seen.has(altKey) && erpHigh(alt) < cheapestHi) {
            alt.label = erpHigh(alt) === 0 ? 'ERP-free' : 'Cheaper';
            routes.push(alt);
          }
        }
      } catch (e) {
        console.warn('[directions] avoidTolls call failed:', e.message);
      }
    }

    // Order: Fastest stays first; the rest sorted cheapest-ERP first so the
    // money-saving option is easy to spot.
    const rest = routes.slice(1).sort((a, b) => erpHigh(a) - erpHigh(b));
    const ordered = [routes[0], ...rest].slice(0, 3);

    // Informational only — true when NO option avoids ERP entirely.
    const noErpFreeAlternative =
      ordered.every((r) => erpHigh(r) > 0) && erpHigh(ordered[0]) > 0;

    res.json({
      routes: ordered,
      vehicle,
      noErpFreeAlternative,
      erpEffectiveFrom: ERP_RATES ? ERP_RATES.effectiveFrom : null,
      erpRatesUrl: ERP_RATES ? ERP_RATES.officialRatesUrl : null,
    });
  } catch (err) {
    console.error('[directions] failed:', err.message);
    res.status(502).json({ error: 'Could not fetch directions', detail: err.message });
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

// ---------- Reverse geocode (coords → place name) ----------
// OneMap's revgeocode needs an auth token; OSM Nominatim is free + tokenless.
const revGeoCache = new Map(); // key "lat,lng"(4dp) → { label, at }
const REVGEO_TTL_MS = 24 * 60 * 60 * 1000;

app.get('/api/revgeocode', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (!isFinite(lat) || !isFinite(lng)) {
    return res.status(400).json({ error: 'lat & lng required' });
  }
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  const hit = revGeoCache.get(key);
  if (hit && Date.now() - hit.at < REVGEO_TTL_MS) {
    return res.json({ label: hit.label, cached: true });
  }
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}` +
                `&format=jsonv2&zoom=18&addressdetails=1`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'ParkWhereSG/1.0 (parkwhere.live)', Accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`Nominatim ${r.status}`);
    const j = await r.json();
    const a = j.address || {};
    // Build a concise, human label. A named place (amenity/building) stands
    // on its own; a plain road gets a suburb for context.
    const named = a.amenity || a.building || a.shop || a.office || '';
    const road  = a.road || '';
    const area  = a.suburb || a.neighbourhood || a.town || a.city || a.county || '';
    let label;
    if (named) {
      label = named;                                  // e.g. "Nanyang Technological University"
    } else if (road) {
      label = area && area !== road ? `${road}, ${area}` : road;
    } else {
      label = area || (j.display_name || '').split(',').slice(0, 2).join(',').trim()
              || 'Current location';
    }
    if (label.length > 48) label = label.slice(0, 47).trim() + '…';
    revGeoCache.set(key, { label, at: Date.now() });
    res.json({ label });
  } catch (err) {
    console.error('[revgeocode] failed:', err.message);
    // Soft-fail: caller falls back to "Current location"
    res.json({ label: null, error: err.message });
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
