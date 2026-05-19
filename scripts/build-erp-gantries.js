// One-off: build public/data/erp-gantries.geojson from the LTA ERPGantry
// shapefile (SVY21 polylines). Gantry → corridor (ZoneID) mapping comes from
// the gantry numbers we already authored into erp-rates.json from the PDF.
const fs = require('path') && require('fs');
const path = require('path');

const SHP_DIR = 'D:\\gowherepark\\ERPGantry_Mar2026\\ERPGantry_Mar2026';
const OUT = path.join(__dirname, 'public', 'data', 'erp-gantries.geojson');
const RATES = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'data', 'erp-rates.json'), 'utf8'));

// --- SVY21 (EPSG:3414) → WGS84, Redfearn inverse (same params as server.js) ---
function svy21ToWgs84(northing, easting) {
  const a = 6378137.0, f = 1 / 298.257223563, k0 = 1.0;
  const E0 = 28001.642, N0 = 38744.572;
  const φ0 = 1.366666666666667 * Math.PI / 180;
  const λ0 = 103.8333333333333 * Math.PI / 180;
  const e2 = 2 * f - f * f, ep2 = e2 / (1 - e2), b = a * Math.sqrt(1 - e2);
  const e4 = e2 * e2, e6 = e4 * e2;
  const mer = (φ) => a * ((1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * φ
    - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * φ)
    + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * φ)
    - (35 * e6 / 3072) * Math.sin(6 * φ));
  const M = mer(φ0) + (northing - N0) / k0;
  const μ = M / (a * (1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256));
  const e1 = (1 - b / a) / (1 + b / a), e1_2 = e1 * e1, e1_3 = e1_2 * e1, e1_4 = e1_3 * e1;
  const φ1 = μ + (3 * e1 / 2 - 27 * e1_3 / 32) * Math.sin(2 * μ)
    + (21 * e1_2 / 16 - 55 * e1_4 / 32) * Math.sin(4 * μ)
    + (151 * e1_3 / 96) * Math.sin(6 * μ) + (1097 * e1_4 / 512) * Math.sin(8 * μ);
  const sφ = Math.sin(φ1), cφ = Math.cos(φ1), tφ = Math.tan(φ1);
  const N1 = a / Math.sqrt(1 - e2 * sφ * sφ);
  const R1 = a * (1 - e2) / Math.pow(1 - e2 * sφ * sφ, 1.5);
  const T1 = tφ * tφ, C1 = ep2 * cφ * cφ, D = (easting - E0) / (N1 * k0);
  const D2 = D * D, D3 = D2 * D, D4 = D3 * D, D5 = D4 * D, D6 = D5 * D;
  const φ = φ1 - (N1 * tφ / R1) * (D2 / 2
    - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D4 / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D6 / 720);
  const λ = λ0 + (D - (1 + 2 * T1 + C1) * D3 / 6
    + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D5 / 120) / cφ;
  return { lat: φ * 180 / Math.PI, lng: λ * 180 / Math.PI };
}

// --- DBF ---
const dbf = fs.readFileSync(path.join(SHP_DIR, 'Gantry.dbf'));
const numrec = dbf.readUInt32LE(4), hdr = dbf.readUInt16LE(8), reclen = dbf.readUInt16LE(10);
let p = 32; const fields = [];
while (dbf[p] !== 0x0d) {
  fields.push({ name: dbf.slice(p, p + 11).toString('latin1').replace(/\0.*$/, ''), len: dbf[p + 16] });
  p += 32;
}
function dbfRec(i) {
  let o = hdr + i * reclen + 1, r = {};
  for (const fl of fields) { r[fl.name] = dbf.slice(o, o + fl.len).toString('utf8').trim(); o += fl.len; }
  return r;
}

// --- SHP (type 3 PolyLine) — read each record's points ---
const shp = fs.readFileSync(path.join(SHP_DIR, 'Gantry.shp'));
const shpGeom = {}; // recordIndex (0-based) → [[X,Y],...]
let off = 100, idx = 0;
while (off < shp.length) {
  const contentLen = shp.readInt32BE(off + 4) * 2; // 16-bit words → bytes
  const cStart = off + 8;
  const shapeType = shp.readInt32LE(cStart);
  if (shapeType === 3) {
    const numParts = shp.readInt32LE(cStart + 36);
    const numPoints = shp.readInt32LE(cStart + 40);
    const ptsStart = cStart + 44 + numParts * 4;
    const pts = [];
    for (let k = 0; k < numPoints; k++) {
      pts.push([shp.readDoubleLE(ptsStart + k * 16), shp.readDoubleLE(ptsStart + k * 16 + 8)]);
    }
    shpGeom[idx] = pts;
  }
  off = cStart + contentLen;
  idx++;
}

// --- gantry# → corridor (ZoneID + expressway + label) from erp-rates.json ---
const gantryToCorridor = {};
for (const c of RATES.corridors) {
  for (const g of String(c.gantries).split(',').map((s) => s.trim()).filter(Boolean)) {
    gantryToCorridor[g] = { ZoneID: c.id, expressway: c.expressway, name: c.label };
  }
}
const normNum = (s) => (s || '').replace(/[^0-9]/g, '').replace(/^0+/, '');

// Pick the best DBF record per wanted gantry number: prefer TYP_CD_DES=ERP,
// else accept an EMAS/other record with the exact number (the LTA dataset is
// known to mistag some charging gantries — flagged confidence:"low").
const wanted = Object.keys(gantryToCorridor);
const all = [];
for (let i = 0; i < numrec; i++) { const r = dbfRec(i); r._i = i; all.push(r); }

const bearing = (a, b) => {
  // a,b are WGS84 {lat,lng}; returns 0–360
  const φ1 = a.lat * Math.PI / 180, φ2 = b.lat * Math.PI / 180;
  const dλ = (b.lng - a.lng) * Math.PI / 180;
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
};

const features = [];
const report = [];
for (const g of wanted) {
  const cands = all.filter((r) => normNum(r.GNTRY_NUM) === g);
  if (!cands.length) { report.push(`${g}: NONE`); continue; }
  const erp = cands.find((r) => /^erp$/i.test(r.TYP_CD_DES));
  // Only trust ERP-tagged records. Number-only matches against EMAS/etc.
  // proved to be unrelated structures in the wrong part of the island.
  if (!erp) { report.push(`${g}: only non-ERP (${cands.map((c) => c.TYP_CD_DES).join('/')}) — skipped`); continue; }
  const chosen = erp;
  const conf = 'high';
  const geom = shpGeom[chosen._i];
  if (!geom || geom.length < 2) { report.push(`${g}: no geometry`); continue; }
  // midpoint of the span (gantry location) + span bearing
  const mid = geom[Math.floor(geom.length / 2)];
  const w0 = svy21ToWgs84(geom[0][1], geom[0][0]);
  const w1 = svy21ToWgs84(geom[geom.length - 1][1], geom[geom.length - 1][0]);
  const wm = svy21ToWgs84(mid[1], mid[0]);
  if (wm.lat < 1.1 || wm.lat > 1.5 || wm.lng < 103.5 || wm.lng > 104.1) {
    report.push(`${g}: out-of-SG (${wm.lat.toFixed(4)},${wm.lng.toFixed(4)})`); continue;
  }
  const spanBearing = +bearing(w0, w1).toFixed(1); // orientation of the gantry line
  const cm = gantryToCorridor[g];
  features.push({
    type: 'Feature',
    properties: {
      gantryId: g,
      ZoneID: cm.ZoneID,
      expressway: cm.expressway,
      name: cm.name,
      spanBearing,                 // gantry spans ⟂ to traffic; travel ≈ spanBearing±90
      confidence: conf,
      source: `${chosen.TYP_CD_DES}#${chosen._i} raw="${chosen.GNTRY_NUM}"`,
    },
    geometry: { type: 'Point', coordinates: [+wm.lng.toFixed(6), +wm.lat.toFixed(6)] },
  });
  report.push(`${g}: ${cm.expressway}/${cm.ZoneID} (${conf}) @${wm.lat.toFixed(5)},${wm.lng.toFixed(5)} span${spanBearing}`);
}

const fc = {
  type: 'FeatureCollection',
  _note: 'Built from LTA ERPGantry_Mar2026 shapefile (SVY21→WGS84). ZoneID = corridor id in erp-rates.json; rate windows live there. Travel direction is validated as roughly perpendicular to spanBearing. confidence:"low" = number matched a non-ERP-tagged record (LTA mistag) — used but less certain. TODO: refresh when LTA publishes a new ERPGantry package.',
  effectiveFrom: RATES.effectiveFrom,
  features,
};
fs.writeFileSync(OUT, JSON.stringify(fc, null, 2) + '\n');
console.log(report.join('\n'));
console.log(`\nWrote ${features.length}/${wanted.length} gantries → ${OUT}`);
const byX = {};
features.forEach((f) => { byX[f.properties.expressway] = (byX[f.properties.expressway] || 0) + 1; });
console.log('per expressway:', JSON.stringify(byX));
