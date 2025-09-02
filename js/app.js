let map, service, infowindow, markers = [];
let currentLocation;

function initMap() {
  map = new google.maps.Map(document.getElementById("map"), {
    zoom: 15,
    center: { lat: 28.6139, lng: 77.2090 }, // fallback: Delhi
  });

  infowindow = new google.maps.InfoWindow();

  // Autocomplete search
  const searchBox = new google.maps.places.Autocomplete(
    document.getElementById("searchBox")
  );

  searchBox.addListener("place_changed", () => {
    const place = searchBox.getPlace();
    if (!place.geometry) return;
    map.setCenter(place.geometry.location);
    currentLocation = place.geometry.location;
    fetchNearbyCafes();
  });

  // Try to get user location
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        currentLocation = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        };
        map.setCenter(currentLocation);
        fetchNearbyCafes();
      },
      () => fetchNearbyCafes()
    );
  } else {
    fetchNearbyCafes();
  }

  // Filters
  document.getElementById("openNow").addEventListener("change", fetchNearbyCafes);
  document.getElementById("minRating").addEventListener("change", fetchNearbyCafes);
  document.getElementById("radius").addEventListener("change", fetchNearbyCafes);
}

function fetchNearbyCafes() {
  clearMarkers();
  document.getElementById("placesList").innerHTML = "";

  const request = {
    location: currentLocation,
    radius: document.getElementById("radius").value,
    type: ["cafe"],
    openNow: document.getElementById("openNow").checked,
  };

  service = new google.maps.places.PlacesService(map);
  service.nearbySearch(request, (results, status) => {
    if (status !== google.maps.places.PlacesServiceStatus.OK) return;

    const minRating = parseFloat(document.getElementById("minRating").value);
    results = results.filter((place) => (place.rating || 0) >= minRating);

    results.forEach((place, i) => {
      addMarker(place, i);
      addToList(place, i);
    });
  });
}

function addMarker(place, index) {
  const marker = new google.maps.Marker({
    map,
    position: place.geometry.location,
    label: `${index + 1}`,
  });

  google.maps.event.addListener(marker, "click", () => {
    const photoUrl = place.photos ? place.photos[0].getUrl({ maxWidth: 200 }) : "";
    const content = `
      <div>
        <h3>${place.name}</h3>
        <p>Rating: ${place.rating || "N/A"} ⭐</p>
        <p>${place.vicinity || ""}</p>
        ${photoUrl ? `<img src="${photoUrl}" style="width:100px;height:80px;">` : ""}
        <br>
        <a href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
          place.vicinity
        )}" target="_blank">📍 Directions</a>
      </div>
    `;
    infowindow.setContent(content);
    infowindow.open(map, marker);
  });

  markers.push(marker);
}

function addToList(place, index) {
  const listItem = document.createElement("li");
  listItem.innerHTML = `
    <strong>${index + 1}. ${place.name}</strong><br>
    ⭐ ${place.rating || "N/A"}<br>
    ${place.vicinity || ""}
  `;
  listItem.addEventListener("click", () => {
    google.maps.event.trigger(markers[index], "click");
    map.setCenter(place.geometry.location);
  });
  document.getElementById("placesList").appendChild(listItem);
}

function clearMarkers() {
  markers.forEach((m) => m.setMap(null));
  markers = [];
}

function addToList(place, index) {
  const listItem = document.createElement("li");

  // Photo or fallback image
  const photoUrl = place.photos ? place.photos[0].getUrl({ maxWidth: 300, maxHeight: 200 }) 
                                : "https://via.placeholder.com/300x200?text=Cafe";

  listItem.className = "cafe-card";
  listItem.innerHTML = `
    <img src="${photoUrl}" alt="${place.name}">
    <div class="cafe-info">
      <h3>${index + 1}. ${place.name}</h3>
      <p>⭐ ${place.rating || "N/A"} | ${place.user_ratings_total || 0} reviews</p>
      <p>${place.vicinity || ""}</p>
      <a href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
        place.vicinity
      )}" target="_blank" class="directions-btn">📍 Get Directions</a>
    </div>
  `;

  listItem.addEventListener("click", () => {
    google.maps.event.trigger(markers[index], "click");
    map.setCenter(place.geometry.location);
  });

  document.getElementById("placesList").appendChild(listItem);
}


window.onload = initMap;