/* GeoTrack — record, view and export your own GPS tracks.
 * Everything runs client-side; tracks are stored in localStorage. */
(() => {
  'use strict';

  // ---------- Storage ----------
  const KEY_TRACKS = 'geotrack.tracks.v1';
  const KEY_CURRENT = 'geotrack.current.v1';
  const KEY_SETTINGS = 'geotrack.settings.v1';

  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; }
      catch (e) { toast('Could not save to browser storage (is it full or disabled?)'); return false; }
    },
    remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
  };

  // ---------- Helpers ----------
  const $ = (id) => document.getElementById(id);
  const PALETTE = ['#22c55e', '#3b82f6', '#f59e0b', '#ec4899', '#a855f7', '#14b8a6', '#ef4444', '#eab308'];
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function haversine(a, b) {
    const R = 6371008.8;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function segmentsDistance(segments) {
    let d = 0;
    for (const seg of segments) for (let i = 1; i < seg.length; i++) d += haversine(seg[i - 1], seg[i]);
    return d;
  }

  function segmentsDuration(segments) {
    let ms = 0;
    for (const seg of segments) if (seg.length > 1 && seg[0].t && seg[seg.length - 1].t) ms += seg[seg.length - 1].t - seg[0].t;
    return ms;
  }

  const pointCount = (segments) => segments.reduce((n, s) => n + s.length, 0);

  function fmtDuration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = String(Math.floor(s / 3600)).padStart(2, '0');
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const sec = String(s % 60).padStart(2, '0');
    return `${h}:${m}:${sec}`;
  }

  const imperial = () => settings.imperial;
  const fmtDist = (m) => imperial() ? `${(m / 1609.344).toFixed(2)} mi` : `${(m / 1000).toFixed(2)} km`;
  const fmtSpeed = (mps) => (mps == null || isNaN(mps)) ? '–'
    : imperial() ? `${(mps * 2.236936).toFixed(1)} mph` : `${(mps * 3.6).toFixed(1)} km/h`;
  const fmtAlt = (m) => (m == null) ? '–' : imperial() ? `${Math.round(m * 3.28084)} ft` : `${Math.round(m)} m`;
  const fmtAcc = (m) => (m == null) ? '–' : imperial() ? `±${Math.round(m * 3.28084)} ft` : `±${Math.round(m)} m`;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  let toastTimer;
  function toast(msg, ms = 3500) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const safeName = (s) => s.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'track';

  // ---------- Settings ----------
  const settings = Object.assign(
    { follow: true, wake: true, imperial: false, maxAcc: 50, minMove: 3 },
    store.get(KEY_SETTINGS, {})
  );

  function bindSettings() {
    const follow = $('opt-follow'), wake = $('opt-wake'), imp = $('opt-imperial');
    const acc = $('opt-acc'), move = $('opt-move');
    follow.checked = settings.follow;
    wake.checked = settings.wake;
    imp.checked = settings.imperial;
    acc.value = settings.maxAcc;
    move.value = settings.minMove;
    $('acc-val').textContent = settings.maxAcc;
    $('move-val').textContent = settings.minMove;

    const save = () => store.set(KEY_SETTINGS, settings);
    follow.onchange = () => { settings.follow = follow.checked; save(); if (settings.follow && lastFix) map.panTo(lastFix); };
    wake.onchange = () => { settings.wake = wake.checked; save(); state === 'tracking' && settings.wake ? requestWakeLock() : releaseWakeLock(); };
    imp.onchange = () => { settings.imperial = imp.checked; save(); renderStats(); renderTrackList(); };
    acc.oninput = () => { settings.maxAcc = +acc.value; $('acc-val').textContent = acc.value; save(); };
    move.oninput = () => { settings.minMove = +move.value; $('move-val').textContent = move.value; save(); };
  }

  // ---------- Map ----------
  const map = L.map('map', { zoomControl: false }).setView([20, 0], 2);
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.control.scale({ position: 'bottomright' }).addTo(map);

  const baseLayers = {
    'Streets': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }),
    'Topo': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
      attribution: 'Map data &copy; OpenStreetMap contributors, SRTM | Style &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
    }),
  };
  baseLayers.Streets.addTo(map);
  L.control.layers(baseLayers, null, { position: 'topright' }).addTo(map);

  // "Locate me" button
  const LocateControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const div = L.DomUtil.create('div', 'leaflet-bar');
      const a = L.DomUtil.create('a', '', div);
      a.href = '#';
      a.title = 'Show my location';
      a.setAttribute('role', 'button');
      a.innerHTML = '&#9678;';
      a.style.fontSize = '18px';
      L.DomEvent.on(a, 'click', (e) => { L.DomEvent.preventDefault(e); locateOnce(); });
      L.DomEvent.disableClickPropagation(div);
      return div;
    },
  });
  map.addControl(new LocateControl());

  // Stop auto-follow when the user drags the map manually while tracking.
  map.on('dragstart', () => {
    if (state === 'tracking' && settings.follow) {
      settings.follow = false;
      $('opt-follow').checked = false;
      store.set(KEY_SETTINGS, settings);
      toast('Auto-centering off. Re-enable it in Settings or tap ◎.');
    }
  });

  const meIcon = L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
  let meMarker = null, accCircle = null, lastFix = null;

  function showMe(lat, lng, acc) {
    lastFix = L.latLng(lat, lng);
    if (!meMarker) {
      meMarker = L.marker(lastFix, { icon: meIcon, interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(map);
      accCircle = L.circle(lastFix, { radius: acc || 0, color: '#3b82f6', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(map);
    } else {
      meMarker.setLatLng(lastFix);
      accCircle.setLatLng(lastFix).setRadius(acc || 0);
    }
  }

  // ---------- Recording state ----------
  // A track is { id, name, color, createdAt, segments: [[{lat,lng,t,alt,acc,spd}]] }
  // Pausing starts a new segment so the gap isn't counted as distance or time.
  let state = 'idle'; // idle | tracking | paused
  let current = null;
  let watchId = null;
  let liveLine = null;
  let lastSpeed = null;
  let tickTimer = null;

  function newTrack() {
    const now = new Date();
    return {
      id: uid(),
      name: `Track ${now.toLocaleDateString()} ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
      color: PALETTE[loadTracks().length % PALETTE.length],
      createdAt: now.toISOString(),
      segments: [[]],
    };
  }

  function persistCurrent() {
    if (current) store.set(KEY_CURRENT, { state, track: current });
  }

  function drawLive() {
    const latlngs = current.segments.map((s) => s.map((p) => [p.lat, p.lng]));
    if (!liveLine) liveLine = L.polyline(latlngs, { color: '#ef4444', weight: 5, opacity: 0.9 }).addTo(map);
    else liveLine.setLatLngs(latlngs);
  }

  function setStatus(text, cls) {
    const el = $('status');
    el.textContent = text;
    el.className = `status ${cls}`;
  }

  function updateButtons() {
    $('btn-start').disabled = state === 'tracking';
    $('btn-start').textContent = state === 'paused' ? 'Resume' : 'Start';
    $('btn-pause').disabled = state !== 'tracking';
    $('btn-stop').disabled = state === 'idle';
  }

  function onPosition(pos) {
    const { latitude: lat, longitude: lng, accuracy: acc, altitude: alt, speed } = pos.coords;
    showMe(lat, lng, acc);
    $('s-acc').textContent = fmtAcc(acc);
    $('s-pos').textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    if (alt != null) $('s-alt').textContent = fmtAlt(alt);
    if (settings.follow) map.panTo(lastFix, { animate: true });

    if (state !== 'tracking' || !current) return;

    if (acc > settings.maxAcc) {
      setStatus(`Weak GPS (±${Math.round(acc)} m)`, 'paused');
      return;
    }
    setStatus('Tracking', 'tracking');

    const seg = current.segments[current.segments.length - 1];
    const pt = { lat, lng, t: pos.timestamp || Date.now(), acc: Math.round(acc) };
    if (alt != null) pt.alt = Math.round(alt * 10) / 10;

    const prev = seg[seg.length - 1];
    if (prev) {
      const d = haversine(prev, pt);
      if (d < settings.minMove) return; // jitter filter
      const dt = (pt.t - prev.t) / 1000;
      lastSpeed = speed != null && !isNaN(speed) ? speed : (dt > 0 ? d / dt : null);
    } else {
      lastSpeed = speed != null && !isNaN(speed) ? speed : null;
    }
    if (lastSpeed != null) pt.spd = Math.round(lastSpeed * 100) / 100;

    seg.push(pt);
    drawLive();
    persistCurrent();
    renderStats();
  }

  function onPositionError(err) {
    const msgs = {
      1: 'Location permission denied. Allow location access for this site in your browser settings.',
      2: 'Position unavailable. Check that location services are on.',
      3: 'Location request timed out. Still trying…',
    };
    toast(msgs[err.code] || err.message);
    if (err.code === 1) {
      setStatus('No permission', 'error');
      stopWatch();
      if (state === 'tracking') { state = 'paused'; updateButtons(); persistCurrent(); }
    }
  }

  function startWatch() {
    if (watchId != null) return;
    watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 20000,
    });
  }

  function stopWatch() {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  function locateOnce() {
    if (!('geolocation' in navigator)) return toast('Geolocation is not supported by this browser.');
    if (lastFix) map.setView(lastFix, Math.max(map.getZoom(), 16));
    navigator.geolocation.getCurrentPosition((pos) => {
      showMe(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
      $('s-acc').textContent = fmtAcc(pos.coords.accuracy);
      $('s-pos').textContent = `${pos.coords.latitude.toFixed(6)}, ${pos.coords.longitude.toFixed(6)}`;
      map.setView(lastFix, Math.max(map.getZoom(), 16));
      if (state === 'tracking') {
        settings.follow = true;
        $('opt-follow').checked = true;
        store.set(KEY_SETTINGS, settings);
      }
    }, onPositionError, { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 });
  }

  function start() {
    if (!('geolocation' in navigator)) return toast('Geolocation is not supported by this browser.');
    if (!window.isSecureContext) toast('Location needs HTTPS (or localhost) to work.');
    if (state === 'idle') {
      current = newTrack();
      clearViewed();
    } else if (state === 'paused') {
      const last = current.segments[current.segments.length - 1];
      if (last.length) current.segments.push([]);
    }
    state = 'tracking';
    lastSpeed = null;
    setStatus('Waiting for GPS…', 'tracking');
    updateButtons();
    persistCurrent();
    startWatch();
    startTick();
    if (settings.wake) requestWakeLock();
    if (lastFix) map.setView(lastFix, Math.max(map.getZoom(), 16));
    drawLive();
  }

  function pause() {
    if (state !== 'tracking') return;
    state = 'paused';
    lastSpeed = null;
    setStatus('Paused', 'paused');
    updateButtons();
    persistCurrent();
    stopTick();
    renderStats();
    releaseWakeLock();
  }

  function stop() {
    if (state === 'idle') return;
    stopWatch();
    stopTick();
    releaseWakeLock();
    current.segments = current.segments.filter((s) => s.length);
    const n = pointCount(current.segments);
    if (n >= 2) {
      const tracks = loadTracks();
      tracks.unshift(current);
      if (saveTracks(tracks)) toast(`Saved “${current.name}” (${fmtDist(segmentsDistance(current.segments))})`);
      viewTrack(current.id);
    } else {
      toast('Track discarded — not enough points recorded.');
    }
    if (liveLine) { liveLine.remove(); liveLine = null; }
    current = null;
    state = 'idle';
    lastSpeed = null;
    store.remove(KEY_CURRENT);
    setStatus('Idle', 'idle');
    updateButtons();
    renderStats();
    renderTrackList();
  }

  function startTick() { stopTick(); tickTimer = setInterval(renderStats, 1000); }
  function stopTick() { clearInterval(tickTimer); tickTimer = null; }

  function renderStats() {
    if (!current) {
      $('s-dist').textContent = fmtDist(0);
      $('s-time').textContent = fmtDuration(0);
      $('s-speed').textContent = '–';
      $('s-avg').textContent = '–';
      return;
    }
    const dist = segmentsDistance(current.segments);
    let ms = segmentsDuration(current.segments);
    // While tracking, include time since the last fix in the active segment.
    const seg = current.segments[current.segments.length - 1];
    if (state === 'tracking' && seg.length) ms += Date.now() - seg[seg.length - 1].t;
    $('s-dist').textContent = fmtDist(dist);
    $('s-time').textContent = fmtDuration(ms);
    $('s-speed').textContent = state === 'tracking' ? fmtSpeed(lastSpeed) : '–';
    $('s-avg').textContent = ms > 0 ? fmtSpeed(dist / (ms / 1000)) : '–';
  }

  // ---------- Wake lock ----------
  let wakeLock = null;
  async function requestWakeLock() {
    if (!('wakeLock' in navigator) || wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { /* not allowed right now */ }
  }
  function releaseWakeLock() { if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; } }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state === 'tracking' && settings.wake) requestWakeLock();
  });

  // ---------- Saved tracks ----------
  function loadTracks() { return store.get(KEY_TRACKS, []); }
  function saveTracks(t) { return store.set(KEY_TRACKS, t); }

  const viewed = new Map(); // id -> L.LayerGroup

  function trackLayer(t) {
    const group = L.featureGroup();
    const latlngs = t.segments.map((s) => s.map((p) => [p.lat, p.lng]));
    L.polyline(latlngs, { color: t.color, weight: 5, opacity: 0.9 }).addTo(group);
    const first = t.segments.find((s) => s.length)?.[0];
    const lastSeg = [...t.segments].reverse().find((s) => s.length);
    const last = lastSeg?.[lastSeg.length - 1];
    if (first) L.circleMarker([first.lat, first.lng], { radius: 6, color: '#fff', weight: 2, fillColor: '#22c55e', fillOpacity: 1 })
      .bindTooltip('Start').addTo(group);
    if (last) L.circleMarker([last.lat, last.lng], { radius: 6, color: '#fff', weight: 2, fillColor: '#ef4444', fillOpacity: 1 })
      .bindTooltip('End').addTo(group);
    group.bindPopup(() => `<b>${escapeHtml(t.name)}</b><br>${fmtDist(segmentsDistance(t.segments))} · ${fmtDuration(segmentsDuration(t.segments))}`);
    return group;
  }

  function viewTrack(id, fit = true) {
    const t = loadTracks().find((x) => x.id === id);
    if (!t) return;
    if (!viewed.has(id)) viewed.set(id, trackLayer(t).addTo(map));
    const layer = viewed.get(id);
    if (fit && layer.getBounds().isValid()) map.fitBounds(layer.getBounds(), { padding: [40, 40], maxZoom: 17 });
    renderTrackList();
  }

  function hideTrack(id) {
    viewed.get(id)?.remove();
    viewed.delete(id);
    renderTrackList();
  }

  function clearViewed() { for (const id of [...viewed.keys()]) hideTrack(id); }

  function renameTrack(id) {
    const tracks = loadTracks();
    const t = tracks.find((x) => x.id === id);
    if (!t) return;
    const name = prompt('Track name', t.name);
    if (name == null || !name.trim()) return;
    t.name = name.trim().slice(0, 100);
    saveTracks(tracks);
    if (viewed.has(id)) { hideTrack(id); viewTrack(id, false); }
    renderTrackList();
  }

  function deleteTrack(id) {
    const tracks = loadTracks();
    const t = tracks.find((x) => x.id === id);
    if (!t || !confirm(`Delete “${t.name}”? This cannot be undone.`)) return;
    hideTrack(id);
    saveTracks(tracks.filter((x) => x.id !== id));
    renderTrackList();
  }

  function renderTrackList() {
    const list = $('track-list');
    const tracks = loadTracks();
    $('no-tracks').hidden = tracks.length > 0;
    list.innerHTML = '';
    for (const t of tracks) {
      const li = document.createElement('li');
      const on = viewed.has(t.id);
      if (on) li.classList.add('active');
      const dist = segmentsDistance(t.segments);
      const dur = segmentsDuration(t.segments);
      li.innerHTML = `
        <div class="track-title"><span class="swatch" style="background:${escapeHtml(t.color)}"></span>${escapeHtml(t.name)}</div>
        <div class="track-meta">${new Date(t.createdAt).toLocaleString()} · ${fmtDist(dist)} · ${fmtDuration(dur)} · ${pointCount(t.segments)} pts</div>
        <div class="track-actions">
          <button data-act="${on ? 'hide' : 'show'}">${on ? 'Hide' : 'Show'}</button>
          <button data-act="rename">Rename</button>
          <button data-act="gpx">GPX</button>
          <button data-act="geojson">GeoJSON</button>
          <button data-act="delete" class="del">Delete</button>
        </div>`;
      li.querySelector('.track-actions').addEventListener('click', (e) => {
        const act = e.target.dataset.act;
        if (act === 'show') viewTrack(t.id);
        else if (act === 'hide') hideTrack(t.id);
        else if (act === 'rename') renameTrack(t.id);
        else if (act === 'gpx') download(`${safeName(t.name)}.gpx`, toGPX(t), 'application/gpx+xml');
        else if (act === 'geojson') download(`${safeName(t.name)}.geojson`, JSON.stringify(toGeoJSON(t), null, 2), 'application/geo+json');
        else if (act === 'delete') deleteTrack(t.id);
      });
      li.querySelector('.track-title').addEventListener('click', () => viewTrack(t.id));
      li.querySelector('.track-title').style.cursor = 'pointer';
      list.appendChild(li);
    }
  }

  // ---------- Export ----------
  function toGPX(t) {
    const x = (s) => escapeHtml(s);
    const segs = t.segments.map((seg) => '    <trkseg>\n' + seg.map((p) => {
      let inner = '';
      if (p.alt != null) inner += `<ele>${p.alt}</ele>`;
      if (p.t) inner += `<time>${new Date(p.t).toISOString()}</time>`;
      return `      <trkpt lat="${p.lat}" lon="${p.lng}">${inner}</trkpt>`;
    }).join('\n') + '\n    </trkseg>').join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GeoTrack" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${x(t.name)}</name><time>${x(t.createdAt)}</time></metadata>
  <trk>
    <name>${x(t.name)}</name>
${segs}
  </trk>
</gpx>
`;
  }

  function toGeoJSON(t) {
    return {
      type: 'Feature',
      properties: {
        name: t.name,
        createdAt: t.createdAt,
        distance_m: Math.round(segmentsDistance(t.segments)),
        duration_s: Math.round(segmentsDuration(t.segments) / 1000),
        coordTimes: t.segments.map((s) => s.map((p) => (p.t ? new Date(p.t).toISOString() : null))),
      },
      geometry: {
        type: 'MultiLineString',
        coordinates: t.segments.map((s) => s.map((p) => (p.alt != null ? [p.lng, p.lat, p.alt] : [p.lng, p.lat]))),
      },
    };
  }

  // ---------- Import ----------
  function parseGPX(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('Invalid GPX file');
    const byTag = (el, tag) => [...el.getElementsByTagNameNS('*', tag)];
    const toPt = (el) => {
      const p = { lat: parseFloat(el.getAttribute('lat')), lng: parseFloat(el.getAttribute('lon')) };
      const ele = byTag(el, 'ele')[0], time = byTag(el, 'time')[0];
      if (ele) p.alt = parseFloat(ele.textContent);
      if (time) { const ts = Date.parse(time.textContent); if (!isNaN(ts)) p.t = ts; }
      return p;
    };
    let segments = byTag(doc, 'trkseg').map((s) => byTag(s, 'trkpt').map(toPt));
    if (!segments.length) segments = byTag(doc, 'rte').map((r) => byTag(r, 'rtept').map(toPt));
    const name = byTag(doc, 'name')[0]?.textContent?.trim();
    return { name, segments };
  }

  function parseGeoJSON(text) {
    const gj = JSON.parse(text);
    const segments = [];
    let name;
    const walk = (g, props) => {
      if (!g) return;
      if (g.type === 'FeatureCollection') return g.features.forEach((f) => walk(f));
      if (g.type === 'Feature') { name = name || g.properties?.name; return walk(g.geometry, g.properties); }
      const times = props?.coordTimes;
      const toPt = (c, i, j) => {
        const p = { lng: c[0], lat: c[1] };
        if (c.length > 2) p.alt = c[2];
        const tv = j == null ? times?.[i] : times?.[j]?.[i];
        if (tv) { const ts = Date.parse(tv); if (!isNaN(ts)) p.t = ts; }
        return p;
      };
      if (g.type === 'LineString') segments.push(g.coordinates.map((c, i) => toPt(c, i)));
      else if (g.type === 'MultiLineString') g.coordinates.forEach((line, j) => segments.push(line.map((c, i) => toPt(c, i, j))));
      else if (g.type === 'GeometryCollection') g.geometries.forEach((x) => walk(x));
    };
    walk(gj);
    return { name, segments };
  }

  async function importFile(file) {
    try {
      const text = await file.text();
      const parsed = /\.gpx$/i.test(file.name) || text.trimStart().startsWith('<') ? parseGPX(text) : parseGeoJSON(text);
      const segments = parsed.segments
        .map((s) => s.filter((p) => isFinite(p.lat) && isFinite(p.lng)))
        .filter((s) => s.length);
      if (!segments.length) throw new Error('No track points found in file');
      const tracks = loadTracks();
      const firstT = segments[0][0].t;
      const t = {
        id: uid(),
        name: (parsed.name || file.name.replace(/\.[^.]+$/, '')).slice(0, 100),
        color: PALETTE[tracks.length % PALETTE.length],
        createdAt: new Date(firstT || Date.now()).toISOString(),
        segments,
      };
      tracks.unshift(t);
      if (saveTracks(tracks)) {
        toast(`Imported “${t.name}”`);
        viewTrack(t.id);
      }
    } catch (e) {
      toast(`Import failed: ${e.message}`);
    }
  }

  // ---------- Wire up ----------
  $('btn-start').onclick = start;
  $('btn-pause').onclick = pause;
  $('btn-stop').onclick = stop;
  $('file-import').onchange = (e) => {
    const f = e.target.files[0];
    if (f) importFile(f);
    e.target.value = '';
  };
  window.addEventListener('beforeunload', (e) => {
    if (state === 'tracking') { persistCurrent(); e.preventDefault(); e.returnValue = ''; }
  });

  bindSettings();

  // Restore an in-progress recording after a reload (resumes as paused).
  const saved = store.get(KEY_CURRENT, null);
  if (saved?.track?.segments) {
    current = saved.track;
    state = 'paused';
    setStatus('Paused', 'paused');
    drawLive();
    if (liveLine.getBounds().isValid()) map.fitBounds(liveLine.getBounds(), { padding: [40, 40], maxZoom: 17 });
    toast('Recovered your unfinished track. Press Resume to continue or Stop to save.', 6000);
  }

  updateButtons();
  renderStats();
  renderTrackList();
  if (!current) {
    const tracks = loadTracks();
    if (tracks[0]) viewTrack(tracks[0].id);
  }
})();
