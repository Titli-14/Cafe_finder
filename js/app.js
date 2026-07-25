// app.js — BrewSpot (Leaflet + OSM + Overpass)
// Core data flow is unchanged from the original app: geolocation -> Overpass
// query -> markers + cards. Everything below the "CORE" section is additive
// UI behaviour (filtering, sorting, favorites, nav, etc.) layered on top.

let map;
let markers = [];
let currentLocation = null;
let allPlaces = [];          // full result set from the last fetch, enriched
let activeFilter = "all";
let activeSort = "distance";
const favorites = new Set(); // session-only, no persistence (see storage rules)
const markersById = new Map();

const DEFAULT_LOCATION = [22.5726, 88.3639]; // Kolkata (lat, lng)
const SEARCH_RADIUS_M = 3000;

// --- Reverse-geocoding fallback for places OSM didn't tag with an address ---
// Nominatim's usage policy caps free reverse-geocoding at ~1 request/second
// and asks that requests be issued serially, not in parallel batches. This
// queue enforces that, and caches results by coordinate so a place is only
// ever looked up once per session, even if the list re-renders (filter/sort).
const addressCache = new Map();   // "lat,lon" -> resolved address string | null (failed)
const queuedCoordKeys = new Set(); // coord keys already queued or resolved
const geocodeQueue = [];
let geocodeQueueRunning = false;
const NOMINATIM_MIN_DELAY_MS = 1100;

/* ============================================================
   CORE: map init, geolocation, Overpass fetch — behaviour preserved
   ============================================================ */

document.addEventListener("DOMContentLoaded", () => {
  map = L.map("mapCanvas", { zoomControl: false }).setView(DEFAULT_LOCATION, 14);

  // Free, no-API-key tile provider (CartoDB Positron) — falls back in spirit
  // to plain OSM tiles if this ever needs reverting; no paid service used.
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: 19,
    subdomains: "abcd",
  }).addTo(map);

  L.control.zoom({ position: "bottomright" }).addTo(map);
  addLocateControl();

  // Try geolocation
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        currentLocation = [pos.coords.latitude, pos.coords.longitude];
        map.setView(currentLocation, 15);
        fetchAndRender(currentLocation);
      },
      () => {
        currentLocation = DEFAULT_LOCATION;
        fetchAndRender(currentLocation);
      }
    );
  } else {
    currentLocation = DEFAULT_LOCATION;
    fetchAndRender(currentLocation);
  }

  wireSearchInputs();
  wireFilterChips();
  wireSortSelect();
  wireNav();
});

// Search by location input (Nominatim) — unchanged logic, now shared by both inputs
async function onSearch(query) {
  const q = (query || "").trim();
  if (!q) {
    fetchAndRender(currentLocation || DEFAULT_LOCATION);
    return;
  }

  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}`
  );
  const data = await res.json();

  if (data && data.length > 0) {
    const loc = [parseFloat(data[0].lat), parseFloat(data[0].lon)];
    currentLocation = loc;
    map.setView(loc, 14);
    fetchAndRender(loc);
  } else {
    alert("Couldn't find that location. Try another search term.");
  }
}

// Fetch cafes via Overpass API (expanded query, same tags as original)
async function fetchAndRender(location) {
  showLoader(true);
  clearMarkers();
  updateCount("Finding cafés…");

  const [lat, lon] = location;

  const query = `
    [out:json];
    (
      node["amenity"="cafe"](around:${SEARCH_RADIUS_M},${lat},${lon});
      node["shop"="coffee"](around:${SEARCH_RADIUS_M},${lat},${lon});
      node["amenity"="fast_food"](around:${SEARCH_RADIUS_M},${lat},${lon});
      node["amenity"="restaurant"](around:${SEARCH_RADIUS_M},${lat},${lon});
    );
    out;
  `;

  try {
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      body: query,
    });
    const data = await res.json();

    if (data.elements && data.elements.length > 0) {
      allPlaces = data.elements.map((place) => enrichPlace(place, location));
      renderResults();
    } else {
      allPlaces = [];
      renderEmptyState("No cafés found nearby", "Try searching a busier area, or widen your view on the map.");
      updateCount("0 cafés found");
    }
  } catch (err) {
    console.error("Overpass fetch error:", err);
    allPlaces = [];
    renderEmptyState("Couldn't load cafés", "The map data service didn't respond. Please try again in a moment.");
  }

  showLoader(false);
  updateStats();
}

/* ============================================================
   Enrichment: category + distance (does not touch fetched data shape)
   ============================================================ */

function enrichPlace(place, from) {
  const tags = place.tags || {};
  let category = "restaurant";
  if (tags.amenity === "cafe") category = "cafe";
  else if (tags.shop === "coffee") category = "coffee";
  else if (tags.amenity === "fast_food") category = "fast_food";
  else if (tags.amenity === "restaurant") category = "restaurant";

  const distanceKm = haversineKm(from[0], from[1], place.lat, place.lon);

  return { ...place, _category: category, _distanceKm: distanceKm };
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const CATEGORY_LABEL = {
  cafe: "Café",
  coffee: "Coffee shop",
  restaurant: "Restaurant",
  fast_food: "Fast food",
};

/* ============================================================
   Address fallback: reverse-geocode via Nominatim when OSM has
   no addr:street tag for a place. Free, no key, rate-limit-safe.
   ============================================================ */

function coordKey(lat, lon) {
  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}

// Best address we can build synchronously from existing OSM tags.
function taggedAddress(place) {
  const t = place.tags || {};
  if (t["addr:street"]) {
    return t["addr:housenumber"] ? `${t["addr:housenumber"]} ${t["addr:street"]}` : t["addr:street"];
  }
  return null;
}

// Returns a displayable address string, or null if it's still being
// resolved (in which case the caller should show a loading placeholder
// and re-render once applyResolvedAddress fires).
function getDisplayAddress(place) {
  const tagged = taggedAddress(place);
  if (tagged) return tagged;

  const key = coordKey(place.lat, place.lon);
  if (addressCache.has(key)) {
    return addressCache.get(key) || "Address unavailable";
  }
  enqueueReverseGeocode(place.lat, place.lon, key);
  return null;
}

function enqueueReverseGeocode(lat, lon, key) {
  if (queuedCoordKeys.has(key)) return;
  queuedCoordKeys.add(key);
  geocodeQueue.push({ lat, lon, key });
  runGeocodeQueue();
}

async function runGeocodeQueue() {
  if (geocodeQueueRunning) return;
  geocodeQueueRunning = true;

  while (geocodeQueue.length) {
    const job = geocodeQueue.shift();
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${job.lat}&lon=${job.lon}&zoom=18&addressdetails=1`
      );
      const data = await res.json();
      addressCache.set(job.key, buildAddressFromReverse(data));
    } catch (err) {
      console.error("Reverse geocode error:", err);
      addressCache.set(job.key, null);
    }
    applyResolvedAddress(job.key);

    if (geocodeQueue.length) await sleep(NOMINATIM_MIN_DELAY_MS);
  }

  geocodeQueueRunning = false;
}

function buildAddressFromReverse(data) {
  const a = data && data.address;
  if (!a) return null;

  const parts = [
    [a.house_number, a.road].filter(Boolean).join(" "),
    a.neighbourhood || a.suburb || a.quarter,
    a.city || a.town || a.village,
  ].filter(Boolean);

  if (parts.length) return parts.join(", ");
  return data.display_name ? data.display_name.split(",").slice(0, 3).join(",").trim() : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Called once a queued lookup resolves — updates any currently-rendered
// card and open marker popup for that coordinate, without a full re-render
// (so filter/sort state, scroll position, and favorites are undisturbed).
function applyResolvedAddress(key) {
  const value = addressCache.get(key) || "Address unavailable";

  document.querySelectorAll(`.address[data-address-key="${key}"]`).forEach((el) => {
    el.textContent = value;
    el.classList.remove("is-loading");
  });

  allPlaces
    .filter((p) => coordKey(p.lat, p.lon) === key)
    .forEach((p) => {
      const marker = markersById.get(p.id);
      if (marker) marker.setPopupContent(buildPopupHtml(p, value));
    });
}

/* ============================================================
   Rendering: markers + cards, filtered/sorted from allPlaces
   ============================================================ */

function renderResults() {
  clearMarkers();

  let list = activeFilter === "all" ? allPlaces.slice() : allPlaces.filter((p) => p._category === activeFilter);

  list.sort((a, b) => {
    if (activeSort === "name") {
      return (a.tags.name || "Unnamed Cafe").localeCompare(b.tags.name || "Unnamed Cafe");
    }
    return a._distanceKm - b._distanceKm;
  });

  if (list.length === 0) {
    renderEmptyState("No matches in this category", "Try a different filter, or choose “All”.");
    updateCount("0 cafés found");
    return;
  }

  const grid = document.getElementById("cardsGrid");
  grid.innerHTML = "";

  list.forEach((place, index) => {
    const marker = createMarker(place);
    markers.push(marker);
    addCard(place, index, marker, grid);
  });

  updateCount(`${list.length} ${list.length === 1 ? "café" : "cafés"} found`);
}

function createMarker(place) {
  const pos = [place.lat, place.lon];
  const address = getDisplayAddress(place) || "Locating address…";

  const icon = L.divIcon({
    className: "",
    html: `<div class="brew-marker" data-id="${place.id}">${cupSvg()}</div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 32],
    popupAnchor: [0, -30],
  });

  const marker = L.marker(pos, { icon }).addTo(map).bindPopup(buildPopupHtml(place, address));
  marker.on("click", () => setActiveCard(place.id));
  markersById.set(place.id, marker);

  return marker;
}

function buildPopupHtml(place, addressText) {
  const name = place.tags.name || "Unnamed Cafe";
  return `<div class="popup-card">
      <div class="popup-title">${escapeHtml(name)}</div>
      <div class="popup-badge">${CATEGORY_LABEL[place._category]}</div>
      <div class="popup-meta">${escapeHtml(addressText)} · ${place._distanceKm.toFixed(1)} km away</div>
    </div>`;
}

function cupSvg() {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M4 8h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8Z" stroke="white" stroke-width="2" stroke-linejoin="round"/><path d="M17 9h2a2.5 2.5 0 0 1 0 5h-2" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>`;
}

function addCard(place, index, marker, grid) {
  const name = place.tags.name || "Unnamed Cafe";
  const addressKey = coordKey(place.lat, place.lon);
  const resolvedAddress = getDisplayAddress(place);
  const isLoadingAddress = resolvedAddress === null;
  const address = resolvedAddress || "Locating address…";
  const isFav = favorites.has(place.id);

  const card = document.createElement("div");
  card.className = "card";
  card.dataset.id = place.id;
  card.style.animationDelay = `${Math.min(index, 8) * 35}ms`;
  card.setAttribute("tabindex", "0");
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", `${name}, ${CATEGORY_LABEL[place._category]}, ${place._distanceKm.toFixed(1)} kilometers away`);

  card.innerHTML = `
    <div class="card-media">
      <span class="card-rank">${index + 1}</span>
      ${cupSvg().replace(/width="16" height="16"/, 'width="34" height="34"').replace(/stroke="white"/g, 'stroke="currentColor"')}
    </div>
    <div class="card-body">
      <div class="card-top-row">
        <div class="card-title">${escapeHtml(name)}</div>
        <button class="fav-btn ${isFav ? "is-active" : ""}" aria-label="${isFav ? "Remove from favorites" : "Save to favorites"}" aria-pressed="${isFav}">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="${isFav ? "currentColor" : "none"}"><path d="M12 20s-7-4.5-9.5-9A5.5 5.5 0 0 1 12 6a5.5 5.5 0 0 1 9.5 5c-2.5 4.5-9.5 9-9.5 9Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
        </button>
      </div>
      <div class="address${isLoadingAddress ? " is-loading" : ""}" data-address-key="${addressKey}">${escapeHtml(address)}</div>
      <div class="card-meta-row">
        <span class="badge badge-category">${CATEGORY_LABEL[place._category]}</span>
        <span class="badge badge-distance">${place._distanceKm.toFixed(1)} km</span>
      </div>
      <a class="direction-btn" target="_blank" rel="noopener" href="https://www.openstreetmap.org/directions?from=&to=${place.lat},${place.lon}">
        Directions
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M7 17 17 7M17 7H9M17 7v8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </a>
    </div>
  `;

  // Click card → open marker popup (core behaviour preserved)
  const openOnMap = () => {
    setActiveCard(place.id);
    marker.openPopup();
    map.setView([place.lat, place.lon], 16);
  };
  card.addEventListener("click", (e) => {
    if (e.target.closest(".fav-btn") || e.target.closest(".direction-btn")) return;
    openOnMap();
  });
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openOnMap();
    }
  });

  card.querySelector(".fav-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFavorite(place.id, e.currentTarget);
  });

  grid.appendChild(card);
}

function toggleFavorite(id, btn) {
  if (favorites.has(id)) {
    favorites.delete(id);
    btn.classList.remove("is-active");
    btn.setAttribute("aria-pressed", "false");
    btn.setAttribute("aria-label", "Save to favorites");
    btn.querySelector("svg").setAttribute("fill", "none");
  } else {
    favorites.add(id);
    btn.classList.add("is-active");
    btn.setAttribute("aria-pressed", "true");
    btn.setAttribute("aria-label", "Remove from favorites");
    btn.querySelector("svg").setAttribute("fill", "currentColor");
  }
  document.getElementById("statFavorites").textContent = favorites.size;
}

function setActiveCard(id) {
  document.querySelectorAll(".card").forEach((c) => c.classList.toggle("is-active", c.dataset.id === String(id)));
  document.querySelectorAll(".brew-marker").forEach((m) => m.classList.toggle("is-active", m.dataset.id === String(id)));
}

function renderEmptyState(title, body) {
  const grid = document.getElementById("cardsGrid");
  grid.innerHTML = `
    <div class="no-results">
      <svg width="34" height="34" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M21 21l-4.3-4.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(body)}</p>
    </div>
  `;
}

/* ============================================================
   UI wiring: search inputs, filters, sort, nav, locate control
   ============================================================ */

function wireSearchInputs() {
  const topInput = document.getElementById("locationInput");
  const topBtn = document.getElementById("searchBtn");
  const heroForm = document.getElementById("heroSearchForm");
  const heroInput = document.getElementById("heroLocationInput");
  const heroLocateBtn = document.getElementById("heroLocateBtn");

  topBtn.addEventListener("click", () => onSearch(topInput.value));
  topInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") onSearch(topInput.value);
  });

  heroForm.addEventListener("submit", (e) => {
    e.preventDefault();
    topInput.value = heroInput.value;
    onSearch(heroInput.value);
    document.getElementById("results").scrollIntoView({ behavior: "smooth" });
  });

  heroLocateBtn.addEventListener("click", () => locateMe());
}

function wireFilterChips() {
  const chips = document.querySelectorAll(".chip");
  chips.forEach((chip) => {
    chip.addEventListener("click", () => {
      chips.forEach((c) => c.classList.remove("is-active"));
      chip.classList.add("is-active");
      activeFilter = chip.dataset.filter;
      renderResults();
    });
  });
}

function wireSortSelect() {
  document.getElementById("sortSelect").addEventListener("change", (e) => {
    activeSort = e.target.value;
    renderResults();
  });
}

function wireNav() {
  const topbar = document.getElementById("topbar");
  window.addEventListener("scroll", () => {
    topbar.classList.toggle("is-scrolled", window.scrollY > 8);
  });

  const toggle = document.getElementById("menuToggle");
  const mobileMenu = document.getElementById("mobileMenu");
  toggle.addEventListener("click", () => {
    const open = mobileMenu.classList.toggle("is-open");
    toggle.setAttribute("aria-expanded", String(open));
  });
  mobileMenu.querySelectorAll("a").forEach((a) =>
    a.addEventListener("click", () => {
      mobileMenu.classList.remove("is-open");
      toggle.setAttribute("aria-expanded", "false");
    })
  );

  const sections = ["map", "results", "about"].map((id) => document.getElementById(id)).filter(Boolean);
  const navLinks = document.querySelectorAll("[data-nav]");
  if ("IntersectionObserver" in window && sections.length) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            navLinks.forEach((l) => l.classList.toggle("is-active", l.dataset.nav === entry.target.id));
          }
        });
      },
      { rootMargin: "-40% 0px -50% 0px" }
    );
    sections.forEach((s) => observer.observe(s));
  }
}

function addLocateControl() {
  const LocateControl = L.Control.extend({
    options: { position: "bottomright" },
    onAdd: function () {
      const btn = L.DomUtil.create("button", "locate-control");
      btn.setAttribute("aria-label", "Locate me");
      btn.innerHTML =
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
      L.DomEvent.disableClickPropagation(btn);
      btn.addEventListener("click", () => locateMe(btn));
      return btn;
    },
  });
  map.addControl(new LocateControl());
}

function locateMe(btn) {
  if (!navigator.geolocation) return;
  if (btn) btn.classList.add("is-locating");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      currentLocation = [pos.coords.latitude, pos.coords.longitude];
      map.setView(currentLocation, 15);
      fetchAndRender(currentLocation);
      if (btn) btn.classList.remove("is-locating");
    },
    () => {
      alert("Couldn't access your location. Check your browser's location permission.");
      if (btn) btn.classList.remove("is-locating");
    }
  );
}

/* ============================================================
   Small helpers
   ============================================================ */

function clearMarkers() {
  markers.forEach((m) => map.removeLayer(m));
  markers = [];
  markersById.clear();
}

function updateCount(text) {
  document.getElementById("countText").textContent = text;
}

function updateStats() {
  document.getElementById("statCount").textContent = allPlaces.length;
  document.getElementById("statClosest").textContent = allPlaces.length
    ? Math.min(...allPlaces.map((p) => p._distanceKm)).toFixed(1)
    : "—";
  document.getElementById("statFavorites").textContent = favorites.size;
}

function showLoader(show) {
  const loader = document.getElementById("loader");
  const cards = document.getElementById("cardsGrid");
  loader.classList.toggle("is-visible", show);
  loader.setAttribute("aria-hidden", String(!show));
  cards.style.display = show ? "none" : "flex";
}

function escapeHtml(text) {
  if (!text) return "";
  return text.toString().replace(/[&<>"'`=\/]/g, function (s) {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
      "`": "&#96;",
      "=": "&#61;",
      "/": "&#47;",
    }[s];
  });
}