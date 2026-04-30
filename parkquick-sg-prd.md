# PRD: ParkQuick SG
**Product Requirements Document v1.0**
**Type:** Web App (Mobile-First)
**Stack:** Node.js + Express backend · Vanilla HTML/CSS/JS frontend · Single repo

---

## 1. Problem Statement

Singaporeans waste 10–20 minutes circling carparks because checking lot availability requires opening a slow, cluttered government app with no location-first UX. There is no fast, purpose-built tool that answers the one question drivers actually ask: **"Which nearby carpark has lots right now?"**

---

## 2. Goal

Build a fast, mobile-first web app that:
1. Detects the user's location
2. Fetches real-time carpark availability from Singapore's LTA DataMall API
3. Displays the nearest carparks sorted by available lots
4. Gets the user to a decision in under 15 seconds

---

## 3. Users

**Primary:** Singapore drivers looking for parking near their current location.
**Secondary:** Drivers planning ahead — searching for parking near a destination.

---

## 4. Core User Flow

```
App loads
  └─> Request geolocation permission
        ├─> [Granted] Fetch carpark data from backend → Calculate distances → Show sorted list
        └─> [Denied]  Show postal code / area name search input as fallback

User sees list of nearest carparks
  └─> Tap a carpark card
        └─> Opens Google Maps navigation to that carpark's coordinates (new tab)

Data auto-refreshes every 60 seconds
  └─> Subtle countdown timer visible on screen
```

---

## 5. Data Sources

### 5.1 LTA DataMall — Carpark Availability API
- **Endpoint:** `https://datamall2.mytransport.sg/ltaodataservice/CarParkAvailabilityv2`
- **Method:** GET
- **Auth:** Request header `AccountKey: {YOUR_LTA_API_KEY}`
- **Update frequency:** Every 1 minute
- **Response fields used:**

| Field | Description |
|---|---|
| `CarParkID` | Unique carpark identifier |
| `Area` | District/area name |
| `Development` | Human-readable carpark name |
| `Location` | Lat/lng as string e.g. `"1.289143 103.849382"` |
| `AvailableLots` | Integer — number of available lots right now |
| `LotType` | `C` = Car, `Y` = Motorcycle, `H` = Heavy Vehicle, `M` = Motorcycle (alt) |
| `Agency` | `HDB`, `LTA`, or `URA` |

- **Pagination:** API returns 500 records per call. Must paginate with `$skip` parameter (0, 500, 1000…) until empty result is returned. Merge all pages before processing.
- **Coverage:** HDB public carparks, LTA carparks (malls/commercial in Orchard, Marina, HarbourFront, JLD), URA carparks

### 5.2 Location
- Browser Geolocation API (`navigator.geolocation.getCurrentPosition`)
- Fallback: Singapore OneMap API or manual coordinate lookup for postal code input

---

## 6. Architecture

```
┌─────────────────────────────┐
│         Frontend            │
│  HTML + CSS + Vanilla JS    │
│  Served as static files     │
└────────────┬────────────────┘
             │ GET /api/carparks
┌────────────▼────────────────┐
│         Backend             │
│  Node.js + Express          │
│  Proxy layer — hides API key│
└────────────┬────────────────┘
             │ GET with AccountKey header
┌────────────▼────────────────┐
│   LTA DataMall API          │
│   (paginated, all records)  │
└─────────────────────────────┘
```

**Why a backend proxy:** The LTA AccountKey must never be exposed in frontend JS. All API calls go through `/api/carparks` on the Express server which injects the key server-side.

**Backend caching:** Cache the full LTA response in memory for 55 seconds. Serve cached data to all frontend requests within that window. This prevents hammering the LTA API if multiple users hit the app simultaneously.

---

## 7. Frontend Specification

### 7.1 Pages / Views

**Single page app — no routing needed. Three states:**

| State | Trigger | What renders |
|---|---|---|
| Loading | App start | Spinner + "Finding your location…" |
| Results | Location granted + data fetched | Carpark list |
| Fallback | Location denied | Search input |

---

### 7.2 Results View — Layout

**Header bar (fixed top)**
- App name: "ParkQuick" with "SG" in accent colour
- Subtitle: "Updated X seconds ago" with a live countdown ring/bar
- Refresh icon button (manual refresh)

**Location pill (below header)**
- Shows "Near Bishan" or "Near your location" — derive from coords using reverse geocode or just show "Near you"

**Carpark Cards (scrollable list)**
Each card contains:
- **Carpark name** (Development field) — truncate at 2 lines
- **Distance** — calculated from user coords to carpark coords, shown as "350m" or "1.2km"
- **Available lots** — large, bold number, colour-coded:
  - 🟢 Green: > 20 lots
  - 🟡 Yellow: 5–20 lots
  - 🔴 Red: 1–4 lots
  - ⬛ Grey: 0 lots (still show but push to bottom)
- **Lot type badge:** C / Y / H
- **Agency badge:** HDB / LTA / URA (subtle, small)
- Entire card is tappable → opens Google Maps

**Sort order:**
1. Carparks with 0 lots go to bottom
2. Remaining sorted by distance (nearest first)
3. Within same distance bucket, sort by available lots descending

**Display limit:** Show nearest 10 carparks within 2km radius. If fewer than 5 results within 2km, automatically expand to 5km. Show "Showing results within Xkm" label.

---

### 7.3 Fallback View (Location Denied)

- Friendly message: "Enable location for automatic results, or search below"
- Text input: "Enter area or postal code (e.g. Bishan, 570123)"
- On submit: Geocode the input using Singapore OneMap API (free, no key needed):
  `https://www.onemap.gov.sg/api/common/elastic/search?searchVal={query}&returnGeom=Y&getAddrDetails=Y`
  Use first result's lat/lng as the user's position, then run normal flow

---

### 7.4 Auto-Refresh

- Poll `/api/carparks` every 60 seconds
- Show a countdown indicator (e.g. thin progress bar under header or small ring icon)
- On refresh: smoothly update lot numbers on existing cards (no full re-render flash)
- Show "Just updated" briefly after each refresh

---

### 7.5 Design Direction

**Theme:** Dark mode only. Clean, utilitarian, fast-feeling.

**Colour palette:**
- Background: `#0f0f0f`
- Card surface: `#1a1a1a`
- Border: `#2a2a2a`
- Primary text: `#f0f0f0`
- Secondary text: `#888888`
- Green (plenty): `#22c55e`
- Yellow (limited): `#eab308`
- Red (almost full): `#ef4444`
- Grey (full): `#444444`
- Accent (brand): `#3b82f6` (blue)

**Typography:**
- Use system font stack: `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`
- Available lots number: `48px`, `font-weight: 800`
- Carpark name: `16px`, `font-weight: 600`
- Distance + meta: `13px`, `color: #888`

**Cards:**
- Rounded corners: `12px`
- Comfortable padding: `16px`
- Gap between cards: `8px`
- Subtle border, no heavy shadows

**Mobile-first:**
- Max content width: `480px`, centred on desktop
- Touch targets minimum `44px` height
- No horizontal scroll

---

## 8. Backend Specification

### 8.1 Endpoints

**`GET /api/carparks`**
- Fetches all carpark availability from LTA DataMall (paginated)
- Merges all pages into single array
- Caches result for 55 seconds in memory
- Returns JSON: `{ data: [...], fetchedAt: ISO8601_timestamp }`
- On LTA API error: return last cached data with `{ data: [...], fetchedAt: ..., stale: true }`

**`GET /`**
- Serves `index.html` (the frontend)

**`GET /health`**
- Returns `{ status: "ok", cacheAge: seconds }` — for uptime monitoring

### 8.2 Environment Variables

```
LTA_API_KEY=your_lta_accountkey_here
PORT=3000
```

### 8.3 Dependencies

```json
{
  "express": "^4.18.0",
  "node-fetch": "^3.0.0",
  "dotenv": "^16.0.0"
}
```

---

## 9. Distance Calculation

Parse `Location` field: split `"1.289143 103.849382"` → `lat = 1.289143`, `lng = 103.849382`

Use Haversine formula to calculate distance in metres between user coordinates and each carpark. No external library needed — implement inline.

```javascript
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000; // Earth radius in metres
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) ** 2 +
            Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
            Math.sin(dLng/2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
```

Format for display:
- < 1000m → show as `"350m"`
- ≥ 1000m → show as `"1.2km"`

---

## 10. Error States

| Scenario | Behaviour |
|---|---|
| Location permission denied | Show fallback search input |
| Location timeout (>8s) | Show fallback search input with message "Location took too long" |
| LTA API down | Show stale cached data with yellow banner "Data may be outdated" |
| No carparks within 2km | Auto-expand to 5km, show "Showing results within 5km" |
| No carparks within 5km | Show "No carparks found nearby. Try searching by area." |
| 0 available lots everywhere | Show all carparks anyway, greyed out, with message "All nearby carparks appear full" |
| User on non-mobile, no location | Show search input by default (desktop users rarely have GPS) |

---

## 11. Google Maps Integration

On card tap, open:
```
https://www.google.com/maps/dir/?api=1&destination={lat},{lng}&travelmode=driving
```

Opens in new tab. No Google Maps API key needed — this is the public directions URL.

---

## 12. File Structure

```
parkquick-sg/
├── server.js          # Express server + LTA proxy + caching
├── public/
│   ├── index.html     # Single page app (HTML + CSS + JS all-in-one)
│   └── favicon.ico    # Simple P icon or car icon
├── .env               # LTA_API_KEY (gitignored)
├── .env.example       # Template with empty values
├── .gitignore
├── package.json
├── render.yaml        # Render.com deployment config
└── README.md          # Setup + deployment instructions
```

---

## 13. Deployment

**Platform:** Render.com (free tier)

**`render.yaml`:**
```yaml
services:
  - type: web
    name: parkquick-sg
    env: node
    buildCommand: npm install
    startCommand: node server.js
    envVars:
      - key: LTA_API_KEY
        sync: false
      - key: PORT
        value: 3000
```

Set `LTA_API_KEY` as an environment variable in the Render dashboard (never in code).

---

## 14. README Requirements

The README must include:
1. What the app does (1 paragraph)
2. How to get an LTA API key (link + steps)
3. Local development setup (`npm install`, create `.env`, `node server.js`)
4. How to deploy to Render (step by step)
5. The 3 data sources used and their update frequencies

---

## 15. Out of Scope (V1)

These are explicitly NOT in V1. Do not build them:

- User accounts or saved favourites
- Push notifications
- Historical availability patterns / best-time-to-park
- EV charging lot filter
- Carpark rates / pricing
- PWA / install-to-homescreen
- Multiple languages
- In-app map view (Google Maps embed)

---

## 16. Success Criteria

The app is complete when:
- [ ] Opening the URL on mobile and granting location shows a sorted carpark list within 5 seconds
- [ ] Tapping any card opens Google Maps directions correctly
- [ ] Data refreshes every 60 seconds with a visible countdown
- [ ] Location denied → fallback search works and returns results
- [ ] LTA API key is never visible in browser devtools / frontend source
- [ ] App is deployed live on Render with a public URL
- [ ] Works correctly on iOS Safari and Android Chrome

---

*End of PRD v1.0*
