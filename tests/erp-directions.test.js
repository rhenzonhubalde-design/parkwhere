// Per-gantry direction tests for the ERP estimator.
//
// Mirrors the pure helpers in server.js (directionTargetBearing,
// findGantryHits, filterWindowsByDirection) and exercises every entry in
// erp-gantries.geojson against:
//   • the charging-direction bearing (must MATCH),
//   • the opposite carriageway (must NOT match),
//   • a perpendicular bearing (must NOT match),
//   • boundary tolerances at ±60° / ±70°,
//   • a realistic local road bearing where the canonical direction id
//     and the actual road axis disagree (cb on AYE, diagonal MCE, etc).
//
// Run: node --test tests/erp-directions.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const GANTRIES = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/erp-gantries.geojson'), 'utf8'))
  .features.map((f) => ({
    gantryId: f.properties.gantryId,
    ZoneID: f.properties.ZoneID,
    expressway: f.properties.expressway,
    name: f.properties.name,
    spanBearing: f.properties.spanBearing,
    lat: f.geometry.coordinates[1],
    lng: f.geometry.coordinates[0],
  }));
const ZONE_MAP = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/erp-zone-map.json'), 'utf8'));
const RATES = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/erp-rates.json'), 'utf8'));

const GANTRY_DIRECTION = new Map();
for (const [zoneId, zone] of Object.entries(ZONE_MAP.zones || {})) {
  for (const dir of zone.directions || []) {
    for (const gid of dir.gantries || []) {
      GANTRY_DIRECTION.set(String(gid), { ...dir, zoneId });
    }
  }
}

const CBD_LAT = 1.283, CBD_LNG = 103.851;
const PROX_M = 50;
const DIR_TOL = 60;

function bearingDelta(a, b) {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return d > 180 ? 360 - d : d;
}
function bearingDeg(aLat, aLng, bLat, bLng) {
  const φ1 = aLat * Math.PI / 180, φ2 = bLat * Math.PI / 180;
  const dλ = (bLng - aLng) * Math.PI / 180;
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function haversineM(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const dLat = (bLat - aLat) * Math.PI / 180;
  const dLng = (bLng - aLng) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}
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
function passes(gantry, vehicleLat, vehicleLng, vehicleBearing) {
  const dir = GANTRY_DIRECTION.get(String(gantry.gantryId));
  if (!dir) return { hit: false, reason: 'no direction config' };
  const target = directionTargetBearing(dir, gantry);
  if (target == null) return { hit: false, reason: 'no target bearing for dir.id=' + dir.id };
  const dist = haversineM(vehicleLat, vehicleLng, gantry.lat, gantry.lng);
  if (dist > PROX_M) return { hit: false, reason: `${dist.toFixed(0)}m away`, target };
  const delta = bearingDelta(vehicleBearing, target);
  if (delta > DIR_TOL) return { hit: false, reason: `bearing off by ${delta.toFixed(0)}°`, target, delta };
  return { hit: true, target, delta, distance: dist };
}

// Hand-curated estimate of the actual vehicle bearing for a vehicle
// physically driving past each gantry in the charging direction. Derived
// from each expressway's real road geometry on a map; used to verify
// that the canonical bearing is still within the ±60° tolerance window
// even when the road doesn't run exactly N/S/E/W.
const REAL_ROAD_BEARING = {
  // CTE through Braddell / AMK – essentially due south
  '33': 180,
  '34': 180,
  // PIE westbound past Bendemeer/Eunos – due west
  '32': 270, '37': 270, '38': 270, '42': 270, '45': 270, '65': 270,
  // AYE citybound – tilts east-then-southeast as it approaches CBD
  '36': 80,   // Clementi: mostly east, mild NE tilt
  '41': 95,   // Pandan: due east
  '52': 110,  // Tuas-side: ESE
  '53': 110,
  '74': 110,
  // MCE before Central Blvd / after Maxwell – the segment runs roughly
  // E↔W but tunnels in/out at a slight diagonal; pick the carriageway
  // bearing rather than the cardinal.
  '90': 285,  // westbound, slight WNW
  '91': 105,  // eastbound, slight ESE
  '92': 285,
  '93': 105,
};

test('every located gantry has a direction config in erp-zone-map.json', () => {
  const orphans = GANTRIES.filter((g) => !GANTRY_DIRECTION.has(String(g.gantryId)));
  assert.deepEqual(orphans.map((g) => `${g.expressway}/${g.gantryId}`), [],
    'gantries in the geojson must be assigned to a direction so they can be charged');
});

test('every direction has a resolvable canonical bearing', () => {
  for (const g of GANTRIES) {
    const dir = GANTRY_DIRECTION.get(String(g.gantryId));
    if (!dir) continue;
    const target = directionTargetBearing(dir, g);
    assert.notEqual(target, null,
      `gantry ${g.expressway}/${g.gantryId} dir=${dir.id}/${dir.arrow || '?'} → no canonical bearing`);
  }
});

test.describe('per-gantry: charging direction matches, opposite rejected', () => {
  for (const g of GANTRIES) {
    const dir = GANTRY_DIRECTION.get(String(g.gantryId));
    if (!dir) continue;
    const target = directionTargetBearing(dir, g);
    if (target == null) continue;

    test(`${g.expressway}/${g.gantryId} (${dir.label}) — charging direction at canonical bearing ${target.toFixed(0)}°`, () => {
      const r = passes(g, g.lat, g.lng, target);
      assert.equal(r.hit, true, `expected MATCH, got: ${r.reason}`);
    });

    test(`${g.expressway}/${g.gantryId} (${dir.label}) — opposite carriageway rejected`, () => {
      const r = passes(g, g.lat, g.lng, (target + 180) % 360);
      assert.equal(r.hit, false, 'opposite-direction traffic must not be charged');
    });

    test(`${g.expressway}/${g.gantryId} (${dir.label}) — perpendicular rejected`, () => {
      const r = passes(g, g.lat, g.lng, (target + 90) % 360);
      assert.equal(r.hit, false, 'perpendicular traffic must not be charged');
    });

    test(`${g.expressway}/${g.gantryId} (${dir.label}) — proximity gate (>50 m off-route)`, () => {
      // Step 200 m due north of the gantry; same bearing, but out of range.
      const dLat = 200 / 111320; // ~m per degree latitude
      const r = passes(g, g.lat + dLat, g.lng, target);
      assert.equal(r.hit, false, '>50 m from gantry must not match');
    });

    test(`${g.expressway}/${g.gantryId} (${dir.label}) — boundary ±60° matches, ±70° rejected`, () => {
      const inBand = passes(g, g.lat, g.lng, (target + 60) % 360);
      assert.equal(inBand.hit, true, '±60° must still match (boundary)');
      const outBand = passes(g, g.lat, g.lng, (target + 70) % 360);
      assert.equal(outBand.hit, false, '±70° must not match (over tolerance)');
    });

    if (REAL_ROAD_BEARING[g.gantryId] != null) {
      const real = REAL_ROAD_BEARING[g.gantryId];
      test(`${g.expressway}/${g.gantryId} (${dir.label}) — realistic local road bearing ${real}° matches`, () => {
        const r = passes(g, g.lat, g.lng, real);
        assert.equal(r.hit, true,
          `vehicle on actual ${dir.label} carriageway (bearing ${real}°) should match; got: ${r.reason} (target=${r.target?.toFixed(0)}°)`);
      });
      test(`${g.expressway}/${g.gantryId} (${dir.label}) — realistic OPPOSITE-side bearing rejected`, () => {
        const r = passes(g, g.lat, g.lng, (real + 180) % 360);
        assert.equal(r.hit, false, 'opposite carriageway under the same gantry must NOT match');
      });
    }
  }
});

test.describe('user-reported scenario: southbound CTE Sembawang → Harvey Rd', () => {
  // Synthetic timed-polyline going due south past CTE gantry 33.
  // Origin near Sembawang (postal 761481), destination near MacPherson (369930).
  // What matters is the bearing AT the gantry, not the full route.
  const CTE_33 = GANTRIES.find((g) => g.gantryId === '33');
  assert.ok(CTE_33, 'CTE-33 must exist in the geojson');

  test('southbound (bearing 180°) is charged', () => {
    const r = passes(CTE_33, CTE_33.lat, CTE_33.lng, 180);
    assert.equal(r.hit, true, 'southbound traffic on CTE-33 must register a hit');
  });

  test('return trip northbound (bearing 0°) is NOT charged', () => {
    const r = passes(CTE_33, CTE_33.lat, CTE_33.lng, 0);
    assert.equal(r.hit, false, 'CTE-33 only charges southbound; northbound must be free');
  });
});

test.describe('regression: pre-fix perpendicular logic rejected southbound CTE', () => {
  // The old findGantryHits in server.js validated direction by:
  //   perpA = spanBearing + 90, perpB = spanBearing + 270
  //   crosses = min(Δ(vb, perpA), Δ(vb, perpB)) <= 50
  // CTE-33 has spanBearing 177.4° (≈ road axis, not bar) → perp = 87.4° / 267.4°.
  // A southbound car (bearing 180°) was Δ=87° from the nearest "perpendicular"
  // → REJECTED → no gantry hit → $0. These tests pin that behavior and prove
  // the new direction filter fixes it.
  const OLD_TOL = 50;
  function oldPerpendicularCheck(spanBearing, vehicleBearing) {
    const perpA = (spanBearing + 90) % 360;
    const perpB = (spanBearing + 270) % 360;
    return Math.min(bearingDelta(vehicleBearing, perpA), bearingDelta(vehicleBearing, perpB)) <= OLD_TOL;
  }

  test('OLD logic: southbound CTE-33 (180°) is wrongly rejected', () => {
    const cte33 = GANTRIES.find((g) => g.gantryId === '33');
    assert.equal(oldPerpendicularCheck(cte33.spanBearing, 180), false,
      'demonstrates the original bug — southbound car was rejected by perp check');
  });

  test('OLD logic: southbound CTE-34 (180°) is wrongly rejected', () => {
    const cte34 = GANTRIES.find((g) => g.gantryId === '34');
    assert.equal(oldPerpendicularCheck(cte34.spanBearing, 180), false);
  });

  test('NEW logic: same vehicles now correctly match', () => {
    for (const id of ['33', '34']) {
      const g = GANTRIES.find((x) => x.gantryId === id);
      assert.equal(passes(g, g.lat, g.lng, 180).hit, true, `CTE-${id} southbound must now match`);
    }
  });
});

test.describe('polyline densification — sparse Google polylines must still hit gantries', () => {
  // Mirrors server.js buildTimedPolyline: any segment > 25 m gets
  // interpolated so consecutive samples are ≤ 25 m apart.
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
      out.push({ lat: points[i][0], lng: points[i][1], bearing: segBearing, t: new Date(t0 + cum * secPerM * 1000) });
      if (i < n - 1) {
        const d = seg[i];
        const k = Math.ceil(d / MAX_GAP_M);
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
  function findGantryHits(timed) {
    const hits = [];
    for (const g of GANTRIES) {
      const dir = GANTRY_DIRECTION.get(String(g.gantryId));
      if (!dir) continue;
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

  test('every densified segment is ≤ 25 m', () => {
    // Two points 500 m apart (typical sparse highway stretch).
    const a = [1.4307, 103.8329];
    const b = [1.4262, 103.8329]; // ~500 m due south
    const dense = buildTimedPolyline([a, b], 60, new Date());
    for (let i = 1; i < dense.length; i++) {
      const d = haversineM(dense[i - 1].lat, dense[i - 1].lng, dense[i].lat, dense[i].lng);
      assert.ok(d <= 25 + 1e-6, `segment ${i} is ${d.toFixed(1)} m, expected ≤ 25 m`);
    }
  });

  test('regression: a 200 m straight polyline THROUGH CTE-33 would miss without densification', () => {
    // Build a "Google-sparse" polyline of just 2 points: 200 m north and
    // 200 m south of CTE-33, going due south. Without densification the
    // closest sample point is 200 m from the gantry — past PROX_M.
    const g = GANTRIES.find((x) => x.gantryId === '33');
    const north = [g.lat + 200 / 111320, g.lng];
    const south = [g.lat - 200 / 111320, g.lng];

    // Without densification (mimic original behavior — just 2 points)
    const sparse = [
      { lat: north[0], lng: north[1], bearing: 180, t: new Date() },
      { lat: south[0], lng: south[1], bearing: 180, t: new Date(Date.now() + 30000) },
    ];
    const minDist = Math.min(
      haversineM(sparse[0].lat, sparse[0].lng, g.lat, g.lng),
      haversineM(sparse[1].lat, sparse[1].lng, g.lat, g.lng)
    );
    assert.ok(minDist > PROX_M, `sparse min-dist ${minDist.toFixed(0)}m should be > ${PROX_M}m (proves the bug)`);

    // With densification: at least one interpolated point falls within 50m.
    const dense = buildTimedPolyline([north, south], 30, new Date());
    const hits = findGantryHits(dense);
    assert.ok(hits.find((h) => h.gantry.gantryId === '33'),
      'densified polyline must register the CTE-33 hit');
  });

  test('user scenario: a coarse southbound polyline past CTE-33 and CTE-34 charges both', () => {
    const g33 = GANTRIES.find((x) => x.gantryId === '33');
    const g34 = GANTRIES.find((x) => x.gantryId === '34');
    // Three points 500 m apart, route line passing directly over both gantries.
    // Bearings end up as the leg bearing from densification.
    const route = [
      [g33.lat + 500 / 111320, g33.lng], // 500 m north of g33
      [g33.lat,                g33.lng], // at g33
      [g34.lat,                g34.lng], // at g34 (1.2 km south)
      [g34.lat - 500 / 111320, g34.lng], // 500 m south
    ];
    const dense = buildTimedPolyline(route, 120, new Date());
    const hits = findGantryHits(dense);
    const hitIds = hits.map((h) => h.gantry.gantryId).sort();
    assert.ok(hitIds.includes('33'), `expected CTE-33 hit, got ${hitIds.join(',') || 'none'}`);
    assert.ok(hitIds.includes('34'), `expected CTE-34 hit, got ${hitIds.join(',') || 'none'}`);
  });
});

test.describe('rate-window filtering by direction', () => {
  function filterWindows(windows, f) {
    if (!f || f === 'all') return windows;
    return windows.filter((w) => {
      const m = Number(w.start.slice(0, 2)) * 60 + Number(w.start.slice(3, 5));
      if (f === 'morning') return m < 12 * 60;
      if (f === 'evening') return m >= 12 * 60;
      return true;
    });
  }
  const CTE = RATES.corridors.find((c) => c.id === 'CTE');

  test('CTE southbound (morning filter) drops evening windows', () => {
    const w = filterWindows(CTE.windows, 'morning');
    assert.ok(w.length > 0, 'morning windows must exist');
    assert.ok(w.every((x) => Number(x.start.slice(0, 2)) < 12), 'all returned windows must start AM');
    assert.ok(w.length < CTE.windows.length, 'morning filter must drop some evening rows');
  });

  test('CTE northbound (evening filter) drops morning windows', () => {
    const w = filterWindows(CTE.windows, 'evening');
    assert.ok(w.length > 0, 'evening windows must exist');
    assert.ok(w.every((x) => Number(x.start.slice(0, 2)) >= 12), 'all returned windows must start PM');
  });

  test("AYE 'all' filter passes every window through", () => {
    const AYE = RATES.corridors.find((c) => c.id === 'AYE');
    assert.deepEqual(filterWindows(AYE.windows, 'all'), AYE.windows);
  });
});
