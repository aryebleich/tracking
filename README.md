# GeoTrack

A lightweight, privacy-first GPS tracking website. Open it on your phone, press **Start**, and it records your route on a live map using your browser's Geolocation API.

**All data stays on your device** — tracks are stored in your browser's `localStorage`. There is no server, account, or analytics.

## Features

- Live map (OpenStreetMap / OpenTopoMap) with your position and GPS accuracy circle
- Start / Pause / Resume / Stop & save — pauses split the track into segments so breaks don't count
- Live stats: distance, duration, current & average speed, altitude, accuracy, coordinates
- Filters for poor-accuracy fixes and GPS jitter (configurable)
- Keeps the screen awake while recording (Screen Wake Lock API, where supported)
- Recovers an unfinished recording if the page is reloaded
- Saved track library: show/hide on the map, rename, delete
- Export to **GPX** or **GeoJSON**; import GPX or GeoJSON files
- Metric or imperial units
- Responsive: side panel on desktop, bottom sheet on mobile

## Run locally

Geolocation requires a secure context (HTTPS or `localhost`):

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploy on GitHub Pages

The included workflow (`.github/workflows/pages.yml`) publishes the site on every push to `main`.
In the repository go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
The site will be served at `https://<user>.github.io/tracking/`.

## Notes

- Browsers usually suspend web pages when the screen is off or the tab is in the background, so keep GeoTrack in the foreground while recording.
- Only your own device's location is tracked, and only after you grant permission.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page layout |
| `style.css` | Styling |
| `app.js` | Tracking, map, storage, import/export logic |
