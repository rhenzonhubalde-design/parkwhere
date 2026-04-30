# ParkQuick SG

A fast, mobile-first web app that shows real-time Singapore carpark availability sorted by distance from your current location. Tap any carpark to open Google Maps directions. Data refreshes every 60 seconds.

---

## Data sources

| Source | Used for | Update frequency |
|---|---|---|
| [LTA DataMall — Carpark Availability v2](https://datamall.lta.gov.sg/content/datamall/en/dynamic-data.html) | Real-time available lots, carpark names, locations, agencies | Every 1 minute |
| Browser Geolocation API | User's current coordinates | On demand |
| [OneMap Search API](https://www.onemap.gov.sg/docs/) | Geocode area names / postal codes when location is denied | On demand |

---

## Get an LTA API key

1. Go to [datamall.lta.gov.sg/content/datamall/en/request-for-api.html](https://datamall.lta.gov.sg/content/datamall/en/request-for-api.html)
2. Fill the form. Approval is usually within 1 business day.
3. You'll receive an `AccountKey` by email.

---

## Local development

```bash
# 1. Install dependencies
npm install

# 2. Create your .env file (copy .env.example and fill in your key)
cp .env.example .env
# then edit .env and paste your LTA AccountKey

# 3. Start the server
npm start
```

Open [http://localhost:3000](http://localhost:3000) in a browser.

> Geolocation requires **HTTPS or localhost**. It works on `http://localhost:3000` for development, but if you tunnel it to another device, use HTTPS (e.g. via `ngrok`).

For development with auto-restart on file changes:

```bash
npm run dev
```

---

## Deploy to Render

Render's free tier is enough to host this. The app sleeps after ~15 min of inactivity and wakes on the next request (~30s cold start).

### One-time setup

1. **Push this folder to GitHub** as a new repository.
2. Go to [dashboard.render.com](https://dashboard.render.com/) and sign in (free, GitHub login works).
3. Click **New → Web Service**.
4. Connect your GitHub account and pick the repository you just pushed.
5. Render auto-detects `render.yaml` and pre-fills the build/start commands. Confirm:
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Plan:** Free
6. Under **Environment Variables**, add:
   - `LTA_API_KEY` = your LTA AccountKey (the value from your .env, **never** commit it)
7. Click **Create Web Service**.

Render will build, deploy, and give you a public URL like `https://parkquick-sg.onrender.com` in ~2 minutes.

### Subsequent deploys

Push to your `main` branch on GitHub. Render auto-deploys.

---

## How the app works

```
┌─────────────────────────────┐
│         Frontend            │
│  HTML + CSS + Vanilla JS    │
│  Mobile-first, dark mode    │
└────────────┬────────────────┘
             │ GET /api/carparks
┌────────────▼────────────────┐
│    Express server (Node)    │
│  — Hides API key            │
│  — Caches 55s in memory     │
│  — Paginates LTA response   │
│  — Proxies OneMap geocode   │
└────────────┬────────────────┘
             │ AccountKey header
┌────────────▼────────────────┐
│   LTA DataMall API          │
└─────────────────────────────┘
```

- The LTA AccountKey lives only in `.env` / Render env vars. The browser never sees it.
- The backend caches the full carpark list for 55 seconds so concurrent users don't hammer LTA.
- The frontend computes distances locally using the Haversine formula.
- Carparks are aggregated by `CarParkID` so one carpark = one card, even though LTA returns multiple records per lot type (Car / Motorcycle / Heavy).
- Filter chips switch between Car (default), Motorcycle, and Heavy lot types without re-fetching.

---

## File layout

```
parkquick-sg/
├── server.js          # Express server: LTA proxy + OneMap proxy + cache
├── public/
│   └── index.html     # Single-page app (HTML + CSS + JS)
├── .env               # Your secrets (gitignored)
├── .env.example
├── .gitignore
├── package.json
├── render.yaml        # Render.com deploy config
└── README.md
```
