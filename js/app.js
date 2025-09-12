// script.js - CafeFinder main (Leaflet + OSM)
let map;
let markers = [];
let currentLocation = null;
const DEFAULT_LOCATION = [22.5726, 88.3639]; // Kolkata (lat, lng)

// Initialize map
document.addEventListener("DOMContentLoaded", () => {
  map = L.map("map").setView(DEFAULT_LOCATION, 14);

  // OSM tiles
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/">OpenStreetMap</a> contributors',
  }).addTo(map);

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

  // Wire search
  document.getElementById("searchBtn").addEventListener("click", onSearch);
  document.getElementById("locationInput").addEventListener("keypress", (e) => {
    if (e.key === "Enter") onSearch();
  });
});

// Search by location input (Nominatim)
async function onSearch() {
  const q = document.getElementById("locationInput").value.trim();
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

// Fetch cafes via Overpass API
// Fetch cafes via Overpass API (expanded)
async function fetchAndRender(location) {
  showLoader(true);
  clearMarkers();
  updateCount(0);

  const [lat, lon] = location;
  
  // Expanded Overpass query
  const query = `
    [out:json];
    (
      node["amenity"="cafe"](around:3000,${lat},${lon});
      node["shop"="coffee"](around:3000,${lat},${lon});
      node["amenity"="fast_food"](around:3000,${lat},${lon});
      node["amenity"="restaurant"](around:3000,${lat},${lon});
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
      data.elements.forEach((place, i) => {
        createMarkerAndCard(place, i);
      });
      updateCount(data.elements.length);
    } else {
      document.getElementById("cardsGrid").innerHTML =
        `<div class="no-results" style="padding:36px;color:#666">No cafes found nearby.</div>`;
      updateCount(0);
    }
  } catch (err) {
    console.error("Overpass fetch error:", err);
    document.getElementById("cardsGrid").innerHTML =
      `<div class="no-results" style="padding:36px;color:#666">Failed to fetch cafes.</div>`;
  }

  showLoader(false);
}


// Create marker + card
function createMarkerAndCard(place, index) {
  const pos = [place.lat, place.lon];
  const name = place.tags.name || "Unnamed Cafe";
  const address = place.tags["addr:street"] || "Address unavailable";

  // Marker
  const marker = L.marker(pos)
    .addTo(map)
    .bindPopup(`<b>${name}</b><br>${address}`);
  markers.push(marker);

  // Card
  addCard(place, index, marker);
}

// Build card UI
function addCard(place, index, marker) {
  const grid = document.getElementById("cardsGrid");
  const name = place.tags.name || "Unnamed Cafe";
  const address = place.tags["addr:street"] || "Address unavailable";

  const card = document.createElement("div");
  card.className = "card";
  card.dataset.index = index;

  card.innerHTML = `
    <img class="card-media" src="https://images.unsplash.com/photo-1509042239860-f550ce710b93?q=80&w=800&auto=format&fit=crop" alt="${escapeHtml(name)}">
    <div class="card-body">
      <div class="card-title">${index + 1}. ${escapeHtml(name)}</div>
      <div class="card-meta">
        <div class="address">${escapeHtml(address)}</div>
      </div>
    </div>
    <div class="card-footer">
      <a class="direction-btn" target="_blank" rel="noopener" href="https://www.openstreetmap.org/directions?from=&to=${place.lat},${place.lon}">Directions</a>
    </div>
  `;

  // Click card → open marker popup
  card.addEventListener("click", () => {
    document.querySelectorAll(".card").forEach((c) => c.classList.remove("active"));
    card.classList.add("active");
    marker.openPopup();
    map.setView([place.lat, place.lon], 16);
  });

  grid.appendChild(card);
}

// Helpers
function clearMarkers() {
  markers.forEach((m) => map.removeLayer(m));
  markers = [];
  document.getElementById("cardsGrid").innerHTML = "";
}

function updateCount(n) {
  document.getElementById("countText").textContent = `${n} cafes found`;
}

function showLoader(show) {
  const loader = document.getElementById("loader");
  const cards = document.getElementById("cardsGrid");
  if (show) {
    loader.style.display = "flex";
    cards.style.display = "none";
  } else {
    loader.style.display = "none";
    cards.style.display = "grid";
  }
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
