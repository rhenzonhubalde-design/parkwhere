require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const LTA_API_KEY = process.env.LTA_API_KEY;
const URA_ACCESS_KEY = process.env.URA_ACCESS_KEY;
const LTA_ENDPOINT = 'https://datamall2.mytransport.sg/ltaodataservice/CarParkAvailabilityv2';
// URA migrated the Data Service to eservice.ura.gov.sg with versioned /v1
// paths; the access key is now an AccessKey header (not a query param) and
// a browser-like User-Agent is required or the gateway 404s.
const URA_TOKEN_URL = 'https://eservice.ura.gov.sg/uraDataService/insertNewToken/v1';
const URA_DS_URL = 'https://eservice.ura.gov.sg/uraDataService/invokeUraDS/v1';
const URA_UA = 'Mozilla/5.0 (compatible; ParkWhereSG/1.0; +parkwhere.live)';
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
  const r = await fetch(URA_TOKEN_URL, {
    headers: {
      AccessKey: URA_ACCESS_KEY,
      'User-Agent': URA_UA,
      Accept: 'application/json',
    },
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
    'User-Agent': URA_UA,
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

  // URA returns MANY rows per ppCode — one per vehicle category and per
  // time band (e.g. 7am–5pm vs 5pm–10pm). Group the Car rows so we keep
  // every time band's rate instead of an arbitrary first one.
  const groups = new Map(); // ppCode → { first, rows[] }
  for (const cp of dJson.Result || []) {
    if (!cp.vehCat || !cp.vehCat.toLowerCase().startsWith('car')) continue;
    let g = groups.get(cp.ppCode);
    if (!g) { g = { first: cp, rows: [] }; groups.set(cp.ppCode, g); }
    g.rows.push(cp);
  }

  const SYS = { B: 'Barrier', C: 'Coupon', E: 'Electronic parking' };
  const norm = (v) => {
    const s = String(v == null ? '' : v).trim();
    if (!s) return '';
    return /^\d/.test(s) ? `$${s}` : s;            // ensure a $ on bare numbers
  };
  // "08.30 AM–05.00 PM: $0.60 / 30 mins"
  const band = (rate, min, start, end) => {
    const r = norm(rate);
    if (!r || /^\$?0(\.0+)?$/.test(r)) return '';  // skip $0 / blank bands
    const t = (start && end) ? `${String(start).trim()}–${String(end).trim()}: ` : '';
    const m = String(min || '').trim();
    return `${t}${r}${m ? ` / ${m}` : ''}`;
  };
  const joinBands = (rows, rateKey, minKey) => {
    const out = [];
    let sawAny = false, sawZero = false;
    for (const r of rows) {
      const raw = r[rateKey];
      if (raw != null && String(raw).trim() !== '') {
        sawAny = true;
        if (/^\$?0(\.0+)?$/.test(norm(raw))) sawZero = true;
      }
      const s = band(r[rateKey], r[minKey], r.startTime, r.endTime);
      if (s && !out.includes(s)) out.push(s);
      if (out.length >= 4) break;                  // keep it readable
    }
    if (out.length) return out.join(' · ');
    // Rows existed but every band was $0 → genuinely free that day.
    return (sawAny && sawZero) ? 'Free' : '';
  };

  const records = [];
  for (const { first: cp, rows } of groups.values()) {
    const geom = cp.geometries && cp.geometries[0];
    if (!geom || !geom.coordinates) continue;
    const parts = geom.coordinates.split(',');
    if (parts.length < 2) continue;
    const E = parseFloat(parts[0]); // Easting
    const N = parseFloat(parts[1]); // Northing
    if (!isFinite(E) || !isFinite(N)) continue;

    const { lat, lng } = svy21ToWgs84(N, E);
    if (!isFinite(lat) || !isFinite(lng)) continue;
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
      // Rate strings built from every time band (URA, current — verified).
      Rates: {
        weekday:       joinBands(rows, 'weekdayRate', 'weekdayMin'),
        saturday:      joinBands(rows, 'satdayRate', 'satdayMin'),
        sunPH:         joinBands(rows, 'sunPHRate', 'sunPHMin'),
        startTime:     '',   // time bands are embedded in the rate strings
        endTime:       '',
        parkingSystem: SYS[cp.parkingSystem] || cp.parkingSystem || '',
        vehCat:        cp.vehCat || '',
      },
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

// ---------- Carpark metadata: HDB info + Singapore public holidays ----------
// Both change at most daily — fetched once and cached 24 h. HDB short-term
// rates are a fixed HDB policy (hard-coded client-side); this supplies the
// per-carpark operating hours / free-parking / night-parking / gantry meta.
const DATAGOV_DS = 'https://data.gov.sg/api/action/datastore_search';
const HDB_RESOURCE = 'd_23f946fa557947f93a8043bbef41dd09';
const HDB_AVAIL_URL = 'https://api.data.gov.sg/v1/transport/carpark-availability';
const LTA_RATES_RESOURCE = 'd_9f6056bdb6b1dfba57f063593e4f34ae';
const PH_COLLECTION = 'https://api-production.data.gov.sg/v2/public/api/collections/691/metadata';
const META_TTL_MS = 24 * 60 * 60 * 1000;
let metaCache = { hdb: null, publicHolidays: null, ltaRates: null, fetchedAt: 0 };

const ratesNorm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// LTA Carpark Rates CSV (~357 malls/attractions, last updated 2018).
// Keyed by normalised carpark name so live LTA/URA carparks can match by
// development name. Always surfaced as unverified in the UI.
async function fetchLTARates() {
  const url = `${DATAGOV_DS}?resource_id=${LTA_RATES_RESOURCE}&limit=500`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`LTA rates CSV ${r.status}`);
  const j = await r.json();
  const recs = (j.result && j.result.records) || [];
  const clean = (s) => (!s || s.trim() === '-') ? '' : s.trim().replace(/\s+/g, ' ');
  const sig = (s) => clean(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const out = {};
  for (const rec of recs) {
    const key = ratesNorm(rec.carpark);
    if (!key || key.length < 4) continue;
    const wd1 = clean(rec.weekdays_rate_1);
    const wd2 = clean(rec.weekdays_rate_2);
    const weekday = (!wd2 || sig(wd1) === sig(wd2)) ? wd1 : `${wd1} · ${wd2}`;
    out[key] = {
      name:     rec.carpark,
      weekday,
      saturday: clean(rec.saturday_rate) || 'Same as weekday',
      sunPH:    clean(rec.sunday_publicholiday_rate) || 'Same as Saturday',
    };
  }
  console.log(`[lta-rates] loaded ${Object.keys(out).length} carpark rate rows`);
  return out;
}

// HDB live capacity (total_lots) — not in the LTA feed nor the HDB info
// dataset. Capacity is near-static so it rides the 24 h meta cache.
async function fetchHDBCapacity() {
  const out = {};
  try {
    const r = await fetch(HDB_AVAIL_URL, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HDB availability ${r.status}`);
    const j = await r.json();
    const cd = (j.items && j.items[0] && j.items[0].carpark_data) || [];
    for (const c of cd) {
      const id = (c.carpark_number || '').trim().toUpperCase();
      const info = (c.carpark_info || []).find((x) => x.lot_type === 'C') || c.carpark_info?.[0];
      const total = info ? parseInt(info.total_lots, 10) : 0;
      if (id && total > 0) out[id] = total;
    }
  } catch (e) {
    console.warn('[hdb] capacity fetch failed:', e.message);
  }
  return out;
}

async function fetchHDBCarparks() {
  const out = {};
  let offset = 0;
  const limit = 500;
  while (true) {
    const url = `${DATAGOV_DS}?resource_id=${HDB_RESOURCE}&limit=${limit}&offset=${offset}`;
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HDB API ${r.status}`);
    const j = await r.json();
    const recs = (j.result && j.result.records) || [];
    for (const rec of recs) {
      const id = (rec.car_park_no || '').trim().toUpperCase();
      if (!id) continue;
      out[id] = {
        carParkType:   rec.car_park_type || '',
        parkingSystem: rec.type_of_parking_system || '',
        shortTerm:     rec.short_term_parking || '',
        freeParking:   rec.free_parking || '',
        nightParking:  rec.night_parking || '',
        decks:         rec.car_park_decks || '',
        gantryHeight:  rec.gantry_height || '',
      };
    }
    offset += limit;
    const total = j.result && j.result.total ? j.result.total : 0;
    if (recs.length < limit || offset >= total || offset > 6000) break;
  }
  console.log(`[hdb] loaded ${Object.keys(out).length} carpark records`);
  return out;
}

// Public-holiday datasets on data.gov.sg are annual (one resource per year).
// Discover the resource that covers the *current* year from collection 691,
// so this keeps working in future years with no code change.
async function fetchPublicHolidays() {
  const year = new Date().getFullYear();
  let childIds = [];
  try {
    const cr = await fetch(PH_COLLECTION, { headers: { Accept: 'application/json' } });
    if (cr.ok) {
      const cj = await cr.json();
      childIds = (cj.data && cj.data.collectionMetadata &&
                  cj.data.collectionMetadata.childDatasets) || [];
    }
  } catch (e) { console.warn('[ph] collection lookup failed:', e.message); }
  // Fast-path known 2026 dataset first, then discovered children.
  const candidates = ['d_149b61ad0a22f61c09dc80f2df5bbec8', ...childIds];
  for (const rid of [...new Set(candidates)]) {
    try {
      const r = await fetch(`${DATAGOV_DS}?resource_id=${rid}&limit=30`,
        { headers: { Accept: 'application/json' } });
      if (!r.ok) continue;
      const j = await r.json();
      const recs = (j.result && j.result.records) || [];
      const dates = recs
        .map((x) => (x.date || '').slice(0, 10))
        .filter((d) => d.startsWith(String(year)));
      if (dates.length) {
        console.log(`[ph] ${dates.length} holidays for ${year} (${rid})`);
        return dates;
      }
    } catch { /* try next */ }
  }
  console.warn(`[ph] no public-holiday dataset found for ${year}`);
  return [];
}

app.get('/api/carpark-meta', async (req, res) => {
  const now = Date.now();
  if (metaCache.hdb && now - metaCache.fetchedAt < META_TTL_MS) {
    return res.json({
      hdb: metaCache.hdb,
      publicHolidays: metaCache.publicHolidays || [],
      ltaRates: metaCache.ltaRates || {},
      fetchedAt: new Date(metaCache.fetchedAt).toISOString(),
      stale: false,
    });
  }
  try {
    // Each source fails independently — a transient rate-limit on one
    // (e.g. the HDB info dataset) must not blank out the others.
    const [hdb, capacity, publicHolidays, ltaRates] = await Promise.all([
      fetchHDBCarparks().catch((e) => {
        console.warn('[hdb] info fetch failed:', e.message); return {};
      }),
      fetchHDBCapacity(),
      fetchPublicHolidays().catch((e) => {
        console.warn('[ph] fetch failed:', e.message); return [];
      }),
      fetchLTARates().catch((e) => {
        console.warn('[lta-rates] fetch failed:', e.message); return {};
      }),
    ]);
    for (const id of Object.keys(hdb)) {
      if (capacity[id]) hdb[id].totalLots = capacity[id];
    }
    // Merge with any previously-cached pieces so a partial failure never
    // regresses data we already had.
    const merged = {
      hdb: Object.keys(hdb).length ? hdb : (metaCache.hdb || {}),
      publicHolidays: publicHolidays.length ? publicHolidays : (metaCache.publicHolidays || []),
      ltaRates: Object.keys(ltaRates).length ? ltaRates : (metaCache.ltaRates || {}),
    };
    // Only lock the 24 h cache once the (large) HDB set is present;
    // otherwise allow the next request to retry sooner.
    const solid = Object.keys(merged.hdb).length > 0;
    metaCache = { ...merged, fetchedAt: solid ? now : 0 };
    res.json({
      ...merged,
      fetchedAt: new Date(now).toISOString(),
      stale: !solid,
    });
  } catch (err) {
    console.error('[carpark-meta] failed:', err.message);
    if (metaCache.hdb) {
      return res.json({
        hdb: metaCache.hdb,
        publicHolidays: metaCache.publicHolidays || [],
        ltaRates: metaCache.ltaRates || {},
        fetchedAt: new Date(metaCache.fetchedAt).toISOString(),
        stale: true, error: err.message,
      });
    }
    res.status(502).json({ error: 'Carpark metadata unavailable', detail: err.message });
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

// ---------- Traffic camera images (Traffic-Images: ~90 expressway cameras) ----------
// Image links are signed and valid for 5 min only — we cache the API response
// for 50 s so links served to clients are always well within their validity.
const TRAFFIC_IMAGES_ENDPOINT = 'https://datamall2.mytransport.sg/ltaodataservice/Traffic-Imagesv2';
const TRAFFIC_IMG_TTL_MS = 50 * 1000;
let trafficImgCache = { data: null, fetchedAt: 0 };

// Camera labels: cameras are at fixed coordinates, so we reverse-geocode each
// CameraID once and persist it to disk (geocoded only ever once, then instant).
// A small curated override file handles landmark spots (checkpoints, Sentosa)
// where a bare road name reads poorly. Anything still unknown → coord fallback.
const CAM_OVERRIDE_PATH = path.join(__dirname, 'public', 'data', 'camera-locations.json');
const CAM_GEOCACHE_PATH = path.join(__dirname, 'public', 'data', 'camera-geocode-cache.json');
let camOverrides = {};
let camGeoCache = {};       // CameraID → label
let camGeoSaveTimer = null;
let camGeoBusy = false;
const camGeoQueue = [];     // [{ id, lat, lng }]

try {
  const j = JSON.parse(fs.readFileSync(CAM_OVERRIDE_PATH, 'utf8'));
  camOverrides = (j && j.locations) || {};
} catch { /* optional */ }
try {
  camGeoCache = JSON.parse(fs.readFileSync(CAM_GEOCACHE_PATH, 'utf8')) || {};
  console.log(`[cam] loaded ${Object.keys(camGeoCache).length} cached camera labels`);
} catch { camGeoCache = {}; }

function persistCamGeoCache() {
  clearTimeout(camGeoSaveTimer);
  camGeoSaveTimer = setTimeout(() => {
    fs.writeFile(CAM_GEOCACHE_PATH, JSON.stringify(camGeoCache, null, 0), (e) => {
      if (e) console.warn('[cam] could not persist geocode cache:', e.message);
    });
  }, 1500);
}

// Drains the geocode queue one-at-a-time, ~1.2 s apart (Nominatim fair-use).
async function drainCamGeoQueue() {
  if (camGeoBusy) return;
  camGeoBusy = true;
  while (camGeoQueue.length) {
    const { id, lat, lng } = camGeoQueue.shift();
    if (camGeoCache[id]) continue;
    try {
      const label = await nominatimLabel(lat, lng);
      if (label) { camGeoCache[id] = label; persistCamGeoCache(); }
    } catch (e) {
      console.warn(`[cam] geocode ${id} failed:`, e.message);
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  camGeoBusy = false;
}

// Attach a `Location` to each camera; enqueue any still-unknown IDs.
function enrichCameraLabels(cameras) {
  let queued = false;
  for (const c of cameras) {
    const label = camOverrides[c.CameraID] || camGeoCache[c.CameraID] || null;
    c.Location = label;
    if (!label && !camGeoQueue.some((q) => q.id === c.CameraID)) {
      camGeoQueue.push({ id: c.CameraID, lat: c.Latitude, lng: c.Longitude });
      queued = true;
    }
  }
  if (queued) drainCamGeoQueue();
  return cameras;
}

app.get('/api/traffic-images', async (req, res) => {
  const now = Date.now();
  if (trafficImgCache.data && now - trafficImgCache.fetchedAt < TRAFFIC_IMG_TTL_MS) {
    return res.json({
      data: enrichCameraLabels(trafficImgCache.data),
      fetchedAt: new Date(trafficImgCache.fetchedAt).toISOString(),
      stale: false,
    });
  }

  try {
    const r = await fetch(TRAFFIC_IMAGES_ENDPOINT, {
      headers: { AccountKey: LTA_API_KEY, Accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`LTA API responded ${r.status} ${r.statusText}`);
    const json = await r.json();
    const data = (Array.isArray(json.value) ? json.value : [])
      .map((c) => ({
        CameraID: String(c.CameraID),
        Latitude: parseFloat(c.Latitude),
        Longitude: parseFloat(c.Longitude),
        ImageLink: c.ImageLink,
      }))
      .filter((c) => isFinite(c.Latitude) && isFinite(c.Longitude) && c.ImageLink);
    trafficImgCache = { data, fetchedAt: now };
    res.json({ data: enrichCameraLabels(data), fetchedAt: new Date(now).toISOString(), stale: false });
  } catch (err) {
    console.error('[lta] traffic-images fetch failed:', err.message);
    // Do NOT serve a stale cache here — image links may already be expired.
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

// ---------- ERP estimator (gantry geometry + arrival-time + direction) ----------
let ERP_RATES = null;
try {
  ERP_RATES = JSON.parse(
    require('fs').readFileSync(path.join(__dirname, 'public', 'data', 'erp-rates.json'), 'utf8')
  );
  console.log(`[erp] loaded rate table (effective ${ERP_RATES.effectiveFrom}, ${ERP_RATES.corridors.length} corridors)`);
} catch (e) {
  console.warn('[erp] could not load erp-rates.json:', e.message);
}

// ERP gantry points (real LTA coords, SVY21→WGS84) with the bearing of the
// gantry span. A vehicle is "passing" a gantry only when the route comes
// within 40 m AND crosses roughly perpendicular to the span — this is the
// reliable, data-supported core of the direction fix (kills false positives
// from parallel / opposite-carriageway roads).
let ERP_GANTRIES = [];
try {
  const gj = JSON.parse(
    require('fs').readFileSync(path.join(__dirname, 'public', 'data', 'erp-gantries.geojson'), 'utf8')
  );
  ERP_GANTRIES = (gj.features || []).map((f) => ({
    gantryId:    f.properties.gantryId,
    ZoneID:      f.properties.ZoneID,
    expressway:  f.properties.expressway,
    name:        f.properties.name,
    spanBearing: f.properties.spanBearing,
    lat:         f.geometry.coordinates[1],
    lng:         f.geometry.coordinates[0],
  }));
  console.log(`[erp] loaded ${ERP_GANTRIES.length} located ERP gantries`);
} catch (e) {
  console.warn('[erp] could not load erp-gantries.geojson:', e.message);
}

// Per-direction gantry config (which gantry charges which direction, plus a
// morning/evening/all filter on rate windows). The LTA shapefile's spanBearing
// values are inconsistent — some encode the gantry bar (⟂ road), others the
// road axis itself — so geometric direction inference from spanBearing alone
// silently fails on corridors like CTE (sb gantries 33/34 have ~N–S spans,
// making the perpendicular check reject every southbound vehicle). Use the
// authoritative direction table instead.
let ERP_ZONE_MAP = null;
const GANTRY_DIRECTION = new Map(); // gantryId(str) → direction config
try {
  ERP_ZONE_MAP = JSON.parse(
    require('fs').readFileSync(path.join(__dirname, 'public', 'data', 'erp-zone-map.json'), 'utf8')
  );
  for (const [zoneId, zone] of Object.entries(ERP_ZONE_MAP.zones || {})) {
    for (const dir of zone.directions || []) {
      for (const gid of dir.gantries || []) {
        GANTRY_DIRECTION.set(String(gid), { ...dir, zoneId });
      }
    }
  }
  console.log(`[erp] loaded zone map (${Object.keys(ERP_ZONE_MAP.zones || {}).length} zones, ${GANTRY_DIRECTION.size} directional gantries)`);
} catch (e) {
  console.warn('[erp] could not load erp-zone-map.json:', e.message);
}

// CBD reference point for "citybound" direction calculations (Raffles Place-ish).
const CBD_LAT = 1.283;
const CBD_LNG = 103.851;

// metres between two WGS84 points
function haversineM(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const dLat = (bLat - aLat) * Math.PI / 180;
  const dLng = (bLng - aLng) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}
function bearingDeg(aLat, aLng, bLat, bLng) {
  const φ1 = aLat * Math.PI / 180, φ2 = bLat * Math.PI / 180;
  const dλ = (bLng - aLng) * Math.PI / 180;
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
// smallest absolute difference between two bearings, 0–180
function bearingDelta(a, b) {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return d > 180 ? 360 - d : d;
}
// Distribute the route's (traffic-aware) duration across the decoded
// polyline by cumulative distance → a timestamp + heading per point.
// We also densify: interpolate any segment longer than ~25 m so a
// gantry within 50 m of the route is guaranteed to have a sample
// point within 50 m of it (Google Routes polylines can be 100+ m
// apart on straight highway stretches, which silently dropped hits).
function buildTimedPolyline(points, totalSeconds, departure) {
  const n = points.length;
  if (n < 2) return [];
  const MAX_GAP_M = 25;
  const seg = new Array(n - 1);
  let totalDist = 0;
  for (let i = 0; i < n - 1; i++) {
    const d = haversineM(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]);
    seg[i] = d; totalDist += d;
  }
  if (totalDist <= 0) return [];
  const secPerM = totalSeconds / totalDist;
  const t0 = departure.getTime();
  const out = [];
  let cum = 0;
  for (let i = 0; i < n; i++) {
    const segBearing = i < n - 1
      ? bearingDeg(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1])
      : bearingDeg(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
    out.push({
      lat: points[i][0], lng: points[i][1],
      bearing: segBearing,
      t: new Date(t0 + cum * secPerM * 1000),
    });
    if (i < n - 1) {
      const d = seg[i];
      const k = Math.ceil(d / MAX_GAP_M);  // number of sub-segments
      for (let s = 1; s < k; s++) {
        const frac = s / k;
        out.push({
          lat: points[i][0] + (points[i + 1][0] - points[i][0]) * frac,
          lng: points[i][1] + (points[i + 1][1] - points[i][1]) * frac,
          bearing: segBearing,
          t: new Date(t0 + (cum + d * frac) * secPerM * 1000),
        });
      }
      cum += d;
    }
  }
  return out;
}
// Canonical bearing a vehicle must have to be considered moving in the
// gantry's charging direction. The opposite carriageway is filtered out
// because its bearing is ~180° away from this target.
function directionTargetBearing(dir, gantry) {
  switch (dir.id) {
    case 'sb': return 180;
    case 'nb': return 0;
    case 'wb': return 270;
    case 'eb': return 90;
    case 'cb': return bearingDeg(gantry.lat, gantry.lng, CBD_LAT, CBD_LNG);
    default:
      switch (dir.arrow) {
        case '↓': return 180;
        case '↑': return 0;
        case '←': return 270;
        case '→': return 90;
        default:  return null;
      }
  }
}

// Gantries the route actually passes: within 50 m of a timed point AND
// moving in the gantry's charging direction (per erp-zone-map.json).
// Direction is validated against the configured direction's canonical
// bearing, not the inconsistent spanBearing field — that's the fix for
// the CTE southbound under-charge bug.
function findGantryHits(timed) {
  const PROX_M = 50;
  const DIR_TOL = 60;          // accept vehicles within ±60° of the charging axis
  const hits = [];
  for (const g of ERP_GANTRIES) {
    const dir = GANTRY_DIRECTION.get(String(g.gantryId));
    if (!dir) continue;        // no direction config → can't charge it correctly
    const target = directionTargetBearing(dir, g);
    if (target == null) continue;
    let best = null;
    for (const pt of timed) {
      if (haversineM(pt.lat, pt.lng, g.lat, g.lng) > PROX_M) continue;
      if (bearingDelta(pt.bearing, target) > DIR_TOL) continue;
      if (!best || pt.t < best.t) best = pt;
    }
    if (best) hits.push({ gantry: g, arrival: best.t, direction: dir });
  }
  return hits;
}

// Narrow a corridor's rate windows to those that apply in the matched
// direction (morning rush vs evening rush). Mirrors the client's
// per-direction filter in the ERP rates view.
function filterWindowsByDirection(windows, windowFilter) {
  if (!windowFilter || windowFilter === 'all') return windows;
  return windows.filter((w) => {
    const startMin = toMin(w.start);
    if (windowFilter === 'morning') return startMin < 12 * 60;
    if (windowFilter === 'evening') return startMin >= 12 * 60;
    return true;
  });
}
function sgParts(date) {
  const utc = date.getTime() + date.getTimezoneOffset() * 60000;
  const d = new Date(utc + 8 * 3600000);
  const dow = d.getDay();
  return {
    dow,
    isWeekday: dow >= 1 && dow <= 5,
    minutes: d.getHours() * 60 + d.getMinutes(),
    hhmm: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
  };
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

// Single rate lookup. CRITICAL: no matching window strictly means $0 —
// never fall back to the nearest priced window (Fix B).
function gantryRate(corridor, arrivalParts, mult) {
  if (!arrivalParts.isWeekday) return { rate: 0, window: null };
  const w = corridor.windows.find(
    (x) => arrivalParts.minutes >= toMin(x.start) && arrivalParts.minutes < toMin(x.end)
  );
  if (!w) return { rate: 0, window: null };               // ← $0, no fallback
  return { rate: +(w.rate * mult).toFixed(2), window: `${w.start}–${w.end}` };
}

// Estimate ERP from the actual route geometry. Each priced gantry the route
// physically crosses (direction-validated) is charged at the *estimated
// arrival time at that gantry*, not the departure time.
function estimateERP(decodedPts, durationSec, vehicle) {
  if (!ERP_RATES) return null;
  const mult = ERP_RATES.vehicleMultipliers[vehicle] ?? 1.0;
  const departure = new Date();
  const dep = sgParts(departure);

  const timed = buildTimedPolyline(decodedPts || [], durationSec || 0, departure);
  const hits = findGantryHits(timed);

  if (hits.length === 0) {
    return {
      charging: false, sgTime: dep.hhmm, estLow: 0, estHigh: 0, corridors: [],
      reason: 'This route doesn’t pass any priced ERP gantry.',
    };
  }

  // One charge per corridor (our rates are corridor-level): keep the
  // earliest-arrival gantry hit for each ZoneID.
  const byZone = new Map();
  for (const h of hits) {
    const cur = byZone.get(h.gantry.ZoneID);
    if (!cur || h.arrival < cur.arrival) byZone.set(h.gantry.ZoneID, h);
  }

  const corridors = [];
  let total = 0;
  for (const h of byZone.values()) {
    const corr = ERP_RATES.corridors.find((c) => c.id === h.gantry.ZoneID);
    if (!corr) continue;
    const ap = sgParts(h.arrival);
    // Only the rate windows for the matched direction apply (e.g. CTE
    // southbound morning windows, not the northbound evening ones).
    const dirCorr = { ...corr, windows: filterWindowsByDirection(corr.windows, h.direction.windowFilter) };
    const { rate, window } = gantryRate(dirCorr, ap, mult);
    if (rate > 0) total += rate;
    corridors.push({
      expressway: h.gantry.expressway,
      label:      h.gantry.name,
      gantryId:   h.gantry.gantryId,
      direction:  h.direction.label,
      arrival:    ap.hhmm,
      dayType:    ap.isWeekday ? 'Weekday' : (ap.dow === 6 ? 'Saturday' : 'Sunday/PH'),
      rate,
      free:       rate === 0,
      window,
    });
  }
  corridors.sort((a, b) => b.rate - a.rate);
  total = +total.toFixed(2);

  return {
    charging: total > 0,
    sgTime: dep.hhmm,
    estLow: total,
    estHigh: total,
    corridors,
    reason: total > 0
      ? 'ERP estimated at each gantry’s arrival time.'
      : 'Passes ERP gantries but all free at your estimated arrival time.',
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
        'X-Goog-FieldMask': 'routes.description,routes.duration,routes.distanceMeters,routes.routeLabels,routes.legs.steps.navigationInstruction,routes.polyline.encodedPolyline',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const errBody = await r.json().catch(() => ({}));
      throw new Error(errBody.error?.message || `Routes API: ${r.status} ${r.statusText}`);
    }
    return r.json();
  }

  // Standard Google encoded-polyline decoder → [[lat,lng],...]
  function decodePolyline(str) {
    let idx = 0, lat = 0, lng = 0; const out = [];
    while (idx < str.length) {
      let b, shift = 0, result = 0;
      do { b = str.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lat += (result & 1) ? ~(result >> 1) : (result >> 1);
      shift = 0; result = 0;
      do { b = str.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lng += (result & 1) ? ~(result >> 1) : (result >> 1);
      out.push([lat / 1e5, lng / 1e5]);
    }
    return out;
  }

  // Build a Maps URL that follows THIS specific route by forcing it through
  // two waypoints sampled from the route's own polyline (Google's dir URL
  // has no route-index param, so via-points are the reliable way).
  function buildMapsUrl(route, avoidTolls) {
    let url = `https://www.google.com/maps/dir/?api=1` +
              `&origin=${olat},${olng}&destination=${dlat},${dlng}&travelmode=driving`;
    const enc = route.polyline && route.polyline.encodedPolyline;
    if (enc) {
      const pts = decodePolyline(enc);
      if (pts.length > 8) {
        const a = pts[Math.floor(pts.length * 0.33)];
        const b = pts[Math.floor(pts.length * 0.66)];
        url += `&waypoints=${a[0].toFixed(5)},${a[1].toFixed(5)}` +
               `|${b[0].toFixed(5)},${b[1].toFixed(5)}`;
      }
    }
    if (avoidTolls) url += `&avoid=tolls`;
    return url;
  }

  // Downsample a route's polyline to ≤60 [lat,lng] points so the client can
  // cheaply test which traffic cameras fall within ~1 km of the route.
  function routePath(route) {
    const enc = route.polyline && route.polyline.encodedPolyline;
    if (!enc) return [];
    const pts = decodePolyline(enc);
    if (pts.length <= 60) return pts.map((p) => [+p[0].toFixed(5), +p[1].toFixed(5)]);
    const step = Math.ceil(pts.length / 60);
    const out = [];
    for (let i = 0; i < pts.length; i += step) {
      out.push([+pts[i][0].toFixed(5), +pts[i][1].toFixed(5)]);
    }
    const last = pts[pts.length - 1];
    out.push([+last[0].toFixed(5), +last[1].toFixed(5)]);
    return out;
  }

  function mapRoute(route, label, avoidTolls = false) {
    const steps = (route.legs || []).flatMap((leg) => leg.steps || []);
    const expressways = extractExpressways(route.description, steps);
    // Full-resolution polyline + traffic-aware total duration → arrival-timed
    // gantry detection. routingPreference TRAFFIC_AWARE makes route.duration
    // the live-traffic ETA (Routes API v2's equivalent of duration_in_traffic).
    const enc = route.polyline && route.polyline.encodedPolyline;
    const fullPts = enc ? decodePolyline(enc) : [];
    const durationSec = parseInt((route.duration || '0s'), 10);
    const erp = estimateERP(fullPts, durationSec, vehicle);
    return {
      label,
      summary:       route.description || '',
      distance:      humanDistance(route.distanceMeters),
      duration:      humanDuration(route.duration),
      durationValue: durationSec,
      expressways:   (erp && erp.corridors.length)
        ? [...new Set(erp.corridors.map((c) => c.expressway))]
        : expressways,
      erpLikely:     !!(erp && erp.corridors.length),
      erp,
      mapsUrl:       buildMapsUrl(route, avoidTolls),
      path:          routePath(route),
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
        const alt = ja.routes && ja.routes[0] ? mapRoute(ja.routes[0], 'Cheaper', true) : null;
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

// Shared Nominatim reverse-geocode → concise human label (null on failure).
async function nominatimLabel(lat, lng) {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}` +
              `&format=jsonv2&zoom=17&addressdetails=1`;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'ParkWhereSG/1.0 (parkwhere.live)', Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`Nominatim ${r.status}`);
  const j = await r.json();
  const a = j.address || {};
  const named = a.amenity || a.building || a.shop || a.office || '';
  const road  = a.road || '';
  const area  = a.suburb || a.neighbourhood || a.town || a.city || a.county || '';
  let label;
  if (named) {
    label = named;
  } else if (road) {
    label = area && area !== road ? `${road}, ${area}` : road;
  } else {
    label = area || (j.display_name || '').split(',').slice(0, 2).join(',').trim() || null;
  }
  if (label && label.length > 48) label = label.slice(0, 47).trim() + '…';
  return label;
}

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
    const label = await nominatimLabel(lat, lng) || 'Current location';
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
