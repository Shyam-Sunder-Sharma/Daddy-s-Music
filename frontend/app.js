(function () {
  "use strict";

  const API_BASE = "http://127.0.0.1:5000/api";
  const audioEngine = document.getElementById("audioEngine");

  var TRACK_MAP = new Map();
  var searchCache = new Map();

  var state = {
    user: null,
    favorites: loadJSON("daddy_favorites", []),
    playlists: loadJSON("daddy_playlists", []),
    queue: [],
    history: [],
    searchResults: [],
    currentTrack: null,
    isPlaying: false,
    shuffle: false,
    repeat: false,
    view: { type: "browse", id: null },
    searchQuery: ""
  };

  function loadJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function saveJSON(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) {}
  }

  function fmtTime(s) {
    s = Math.max(0, Math.floor(s || 0));
    var m = Math.floor(s / 60), r = s % 60;
    return m + ":" + (r < 10 ? "0" : "") + r;
  }

  function registerTrack(track) {
    if (track && track.id) {
      TRACK_MAP.set(track.id, track);
    }
  }

  function escapeHtml(str) {
    if (!str) return "";
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // DOM References
  var trackContainer = document.getElementById("trackContainer");
  var queueContainer = document.getElementById("queueContainer");
  var playlistList = document.getElementById("playlistList");
  var viewTitle = document.getElementById("viewTitle");
  var viewHint = document.getElementById("viewHint");

  var nowCover = document.getElementById("nowCover");
  var nowTitle = document.getElementById("nowTitle");
  var nowArtist = document.getElementById("nowArtist");
  var nowFav = document.getElementById("nowFav");
  var playIcon = document.getElementById("playIcon");
  var seekFill = document.getElementById("seekFill");
  var seekTrack = document.getElementById("seekTrack");
  var curTime = document.getElementById("curTime");
  var durTime = document.getElementById("durTime");
  var volSlider = document.getElementById("volSlider");
  var searchInput = document.getElementById("searchInput");

  // In-App Modal Elements
  var playlistModal = document.getElementById("playlistModal");
  var modalPlaylistInput = document.getElementById("modalPlaylistInput");
  var cancelModalBtn = document.getElementById("cancelModalBtn");
  var createModalBtn = document.getElementById("createModalBtn");
  var newPlaylistBtn = document.getElementById("newPlaylistBtn");

  // Dropdown Elements
  var activeDropdownTrack = null;
  var trackDropdown = document.getElementById("trackDropdown");
  var dropdownPlaylistContainer = document.getElementById("dropdownPlaylistContainer");
  var dropdownQueueAction = document.getElementById("dropdownQueueAction");

  // Search Engine
  var searchTimeout = null;
  var activeController = null;

  // ---------- Backend Cloud Sync with JWT Bearer Token ----------
  async function syncToServer() {
    if (!state.user || typeof window.authFetch !== "function") return;
    try {
      var trackCacheObj = {};
      TRACK_MAP.forEach(function (val, key) {
        trackCacheObj[key] = val;
      });

      await window.authFetch(`${API_BASE}/sync/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          favorites: state.favorites,
          playlists: state.playlists,
          trackCache: trackCacheObj
        })
      });
    } catch (e) {
      console.warn("Sync failed:", e);
    }
  }

  async function loadUserSync() {
    if (!state.user || typeof window.authFetch !== "function") return;
    try {
      const res = await window.authFetch(`${API_BASE}/sync/load`);
      if (res.ok) {
        const data = await res.json();
        state.favorites = data.favorites || [];
        state.playlists = data.playlists || [];
        if (data.trackCache) {
          Object.keys(data.trackCache).forEach(function (k) {
            TRACK_MAP.set(k, data.trackCache[k]);
          });
        }
        saveJSON("daddy_favorites", state.favorites);
        saveJSON("daddy_playlists", state.playlists);
        renderPlaylists();
        renderTracks();
        updateNowFav();
      }
    } catch (e) {
      console.warn("Load sync error:", e);
    }
  }

  // ---------- Native MediaSession API ----------
  function setupMediaSession() {
    if (!("mediaSession" in navigator)) return;

    navigator.mediaSession.setActionHandler("play", function () {
      if (state.currentTrack && audioEngine.paused) audioEngine.play();
    });
    navigator.mediaSession.setActionHandler("pause", function () {
      if (!audioEngine.paused) audioEngine.pause();
    });
    navigator.mediaSession.setActionHandler("previoustrack", playPrev);
    navigator.mediaSession.setActionHandler("nexttrack", playNext);
    navigator.mediaSession.setActionHandler("seekbackward", function () {
      audioEngine.currentTime = Math.max(audioEngine.currentTime - 5, 0);
    });
    navigator.mediaSession.setActionHandler("seekforward", function () {
      audioEngine.currentTime = Math.min(audioEngine.currentTime + 5, audioEngine.duration || 0);
    });
  }

  function updateMediaSessionMetadata(track) {
    if (!("mediaSession" in navigator) || !track) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album || track.artist || "Single",
      artwork: [
        { src: track.thumbnail || "", sizes: "512x512", type: "image/jpeg" }
      ]
    });
  }

  // ---------- Global Hotkey Controls ----------
  window.addEventListener("keydown", function (e) {
    if (["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) return;

    if (e.code === "Space") {
      e.preventDefault();
      if (!state.currentTrack) return;
      if (audioEngine.paused) audioEngine.play();
      else audioEngine.pause();
    } else if (e.code === "ArrowRight") {
      audioEngine.currentTime = Math.min(audioEngine.currentTime + 5, audioEngine.duration || 0);
    } else if (e.code === "ArrowLeft") {
      audioEngine.currentTime = Math.max(audioEngine.currentTime - 5, 0);
    } else if (e.code === "ArrowUp") {
      e.preventDefault();
      audioEngine.volume = Math.min(1, audioEngine.volume + 0.05);
      volSlider.value = Math.round(audioEngine.volume * 100);
    } else if (e.code === "ArrowDown") {
      e.preventDefault();
      audioEngine.volume = Math.max(0, audioEngine.volume - 0.05);
      volSlider.value = Math.round(audioEngine.volume * 100);
    } else if (e.key.toLowerCase() === "m") {
      audioEngine.muted = !audioEngine.muted;
    }
  });

  // ---------- Search Engine ----------
  function renderSkeleton() {
    trackContainer.innerHTML = "";
    for (var i = 0; i < 5; i++) {
      var row = document.createElement("div");
      row.className = "track-row";
      row.style.opacity = "0.35";
      row.innerHTML = `
        <div class="idx">-</div>
        <div class="t-main">
          <div class="cover" style="background:var(--surface-2)"></div>
          <div class="t-meta">
            <div class="t-title">Loading track...</div>
            <div class="t-artist">...</div>
          </div>
        </div>
        <div class="t-album">...</div>
        <div></div>
        <div class="t-dur">--:--</div>
      `;
      trackContainer.appendChild(row);
    }
  }

  function handleLiveSearch(query) {
    state.searchQuery = query.trim();
    if (!state.searchQuery) {
      state.searchResults = [];
      renderTracks();
      return;
    }

    var qKey = state.searchQuery.toLowerCase();

    if (searchCache.has(qKey)) {
      state.searchResults = searchCache.get(qKey);
      viewTitle.textContent = 'Results for "' + state.searchQuery + '"';
      viewHint.textContent = state.searchResults.length + " track(s) found.";
      renderTracks();
      return;
    }

    viewTitle.textContent = 'Results for "' + state.searchQuery + '"';
    viewHint.textContent = "Fetching instantly...";
    renderSkeleton();

    if (activeController) activeController.abort();
    activeController = new AbortController();

    fetch(`${API_BASE}/search?q=${encodeURIComponent(state.searchQuery)}`, {
      signal: activeController.signal
    })
      .then((res) => res.json())
      .then((tracks) => {
        if (!Array.isArray(tracks)) tracks = [];
        tracks.forEach(registerTrack);
        searchCache.set(qKey, tracks);
        state.searchResults = tracks;
        viewHint.textContent = tracks.length + " track(s) found.";
        renderTracks();
      })
      .catch((err) => {
        if (err.name === "AbortError") return;
        viewHint.textContent = "Search error. Ensure server is online.";
      });
  }

  function currentList() {
    if (state.view.type === "favorites") {
      var favs = state.favorites.map((id) => TRACK_MAP.get(id)).filter(Boolean);
      viewTitle.textContent = "Favorites";
      viewHint.textContent = favs.length ? "Tracks you've liked." : "No favorites saved yet.";
      return favs;
    }
    if (state.view.type === "playlist") {
      var pl = state.playlists.find((p) => p.id === state.view.id);
      var plTracks = pl ? pl.trackIds.map((id) => TRACK_MAP.get(id)).filter(Boolean) : [];
      viewTitle.textContent = pl ? pl.name : "Playlist";
      viewHint.textContent = plTracks.length + " track(s) in playlist.";
      return plTracks;
    }
    if (state.searchQuery) {
      viewTitle.textContent = 'Results for "' + state.searchQuery + '"';
      viewHint.textContent = state.searchResults.length + " track(s) found.";
    } else {
      viewTitle.textContent = "Browse";
      viewHint.textContent = "Search any song, artist, or album to start listening.";
    }
    return state.searchResults;
  }

  // ---------- Track Rendering ----------
  function renderTracks() {
    var list = currentList();
    trackContainer.innerHTML = "";

    if (!list.length) {
      var empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent =
        state.view.type === "favorites"
          ? "No favorites yet. Tap the heart on any track to save it here."
          : state.view.type === "playlist"
          ? "This playlist is empty."
          : "Type any song name above to start listening.";
      trackContainer.appendChild(empty);
      return;
    }

    list.forEach(function (t, i) {
      var isCurrent = state.currentTrack && state.currentTrack.id === t.id;
      var row = document.createElement("div");
      row.className = "track-row" + (isCurrent ? " playing" : "");
      row.tabIndex = 0;

      var idx = document.createElement("div");
      idx.className = "idx";
      idx.textContent = isCurrent && state.isPlaying ? "♪" : i + 1;

      var main = document.createElement("div");
      main.className = "t-main";

      var cover = document.createElement("img");
      cover.className = "cover";
      cover.src = t.thumbnail || "";
      cover.alt = "";

      var meta = document.createElement("div");
      meta.className = "t-meta";
      meta.innerHTML = `<div class="t-title">${escapeHtml(t.title)}</div><div class="t-artist">${escapeHtml(t.artist)}</div>`;

      main.appendChild(cover);
      main.appendChild(meta);

      var album = document.createElement("div");
      album.className = "t-album";
      album.textContent = t.album || t.artist;

      var actions = document.createElement("div");
      actions.className = "t-actions";

      var favBtn = document.createElement("button");
      favBtn.className = "icon-btn fav" + (state.favorites.indexOf(t.id) !== -1 ? " active" : "");
      favBtn.setAttribute("aria-label", "Favorite");
      favBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20s-7-4.4-9.5-9A5.5 5.5 0 0112 5.5 5.5 5.5 0 0121.5 11c-2.5 4.6-9.5 9-9.5 9z"/></svg>';
      favBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        toggleFavorite(t);
      });

      var addBtn = document.createElement("button");
      addBtn.className = "icon-btn";
      addBtn.setAttribute("aria-label", "Options");
      addBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 5v14M5 12h14"/></svg>';
      
      addBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        openTrackDropdown(t, addBtn);
      });

      actions.appendChild(favBtn);
      actions.appendChild(addBtn);

      var dur = document.createElement("div");
      dur.className = "t-dur";
      dur.textContent = fmtTime(t.dur);

      row.appendChild(idx);
      row.appendChild(main);
      row.appendChild(album);
      row.appendChild(actions);
      row.appendChild(dur);

      row.addEventListener("click", function () {
        playTrack(t);
      });

      trackContainer.appendChild(row);
    });
  }

  function renderQueue() {
    queueContainer.innerHTML = "";
    if (!state.queue.length) {
      var e = document.createElement("div");
      e.className = "empty";
      e.style.padding = "20px 4px";
      e.textContent = "Queue is empty. Use the + icon to add tracks.";
      queueContainer.appendChild(e);
      return;
    }

    state.queue.forEach(function (t, i) {
      var row = document.createElement("div");
      row.className = "q-item";
      row.innerHTML = `
        <img class="cover" src="${t.thumbnail}" alt="" />
        <div class="t-meta" style="flex:1;min-width:0">
          <div class="t-title">${escapeHtml(t.title)}</div>
          <div class="t-artist">${escapeHtml(t.artist)}</div>
        </div>
      `;

      var rm = document.createElement("button");
      rm.className = "icon-btn q-remove";
      rm.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>';
      rm.addEventListener("click", function (e) {
        e.stopPropagation();
        state.queue.splice(i, 1);
        renderQueue();
      });

      row.appendChild(rm);
      row.addEventListener("click", function () {
        state.queue.splice(i, 1);
        playTrack(t);
      });

      queueContainer.appendChild(row);
    });
  }

  function renderPlaylists() {
    playlistList.innerHTML = "";
    state.playlists.forEach(function (p) {
      var row = document.createElement("div");
      row.className = "playlist-row";

      var titleSpan = document.createElement("span");
      titleSpan.textContent = p.name;
      titleSpan.style.flex = "1";
      titleSpan.style.overflow = "hidden";
      titleSpan.style.textOverflow = "ellipsis";
      titleSpan.style.whiteSpace = "nowrap";

      titleSpan.addEventListener("click", function () {
        setView({ type: "playlist", id: p.id });
      });

      var delBtn = document.createElement("button");
      delBtn.className = "pl-delete";
      delBtn.title = "Delete Playlist";
      delBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>';

      delBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        state.playlists = state.playlists.filter((item) => item.id !== p.id);
        saveJSON("daddy_playlists", state.playlists);
        syncToServer();
        renderPlaylists();
        if (state.view.type === "playlist" && state.view.id === p.id) {
          setView({ type: "browse" });
        }
      });

      row.appendChild(titleSpan);
      row.appendChild(delBtn);
      playlistList.appendChild(row);
    });
  }

  function setView(v) {
    state.view = v;
    document.querySelectorAll(".nav-item").forEach(function (el) {
      el.classList.remove("active");
    });
    if (v.type === "browse") {
      var el = document.querySelector('.nav-item[data-view="browse"]');
      if (el) el.classList.add("active");
    }
    if (v.type === "favorites") {
      var el = document.querySelector('.nav-item[data-view="favorites"]');
      if (el) el.classList.add("active");
    }
    renderTracks();
  }

  function toggleFavorite(track) {
    registerTrack(track);
    var i = state.favorites.indexOf(track.id);
    if (i === -1) {
      state.favorites.push(track.id);
    } else {
      state.favorites.splice(i, 1);
    }
    saveJSON("daddy_favorites", state.favorites);
    syncToServer();
    renderTracks();
    updateNowFav();
  }

  function addToQueue(track) {
    registerTrack(track);
    state.queue.push(track);
    renderQueue();
    prefetchNextTrack();
  }

  // ---------- Playback & Switching Engine ----------
  function prefetchNextTrack() {
    if (state.queue && state.queue.length > 0) {
      const next = state.queue[0];
      const target = next.queryTarget || `${next.artist} - ${next.title}`;
      fetch(`${API_BASE}/prefetch?id=${encodeURIComponent(next.id)}&q=${encodeURIComponent(target)}`).catch(() => {});
    }
  }

  function playTrack(track) {
    if (!track || !track.id) return;

    if (state.currentTrack && state.currentTrack.id !== track.id) {
      state.history.push(state.currentTrack);
      if (state.history.length > 50) state.history.shift();
    }

    registerTrack(track);
    state.currentTrack = track;

    nowTitle.textContent = track.title;
    nowArtist.textContent = track.artist;
    nowCover.src = track.thumbnail || "";
    nowCover.style.display = "block";
    curTime.textContent = "0:00";
    durTime.textContent = fmtTime(track.dur || 0);
    seekFill.style.width = "0%";
    state.isPlaying = true;
    updatePlayerUI();
    updateMediaSessionMetadata(track);
    renderTracks();

    audioEngine.pause();
    audioEngine.removeAttribute("src");
    audioEngine.load();

    const target = track.queryTarget || `${track.artist} - ${track.title}`;
    audioEngine.src = `${API_BASE}/stream?id=${encodeURIComponent(track.id)}&q=${encodeURIComponent(target)}`;
    
    var playPromise = audioEngine.play();
    if (playPromise !== undefined) {
      playPromise
        .then(() => {
          prefetchNextTrack();
        })
        .catch((err) => {
          if (err.name === "AbortError") return;
          console.error("Audio playback error:", err);
        });
    }
  }

  function updatePlayerUI() {
    playIcon.outerHTML = state.isPlaying
      ? '<svg id="playIcon" width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>'
      : '<svg id="playIcon" width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    playIcon = document.getElementById("playIcon");
    updateNowFav();
  }

  function updateNowFav() {
    var active = state.currentTrack && state.favorites.indexOf(state.currentTrack.id) !== -1;
    nowFav.classList.toggle("active", !!active);
  }

  async function fetchAutoRecommendation(track) {
    try {
      const res = await fetch(`${API_BASE}/search?q=${encodeURIComponent(track.artist)}`);
      if (res.ok) {
        const list = await res.json();
        const candidate = list.find((t) => t.id !== track.id);
        if (candidate) {
          playTrack(candidate);
        }
      }
    } catch (e) {
      console.warn("Auto recommendation error:", e);
    }
  }

  function playNext() {
    if (state.queue.length > 0) {
      var nextTrack = state.shuffle
        ? state.queue.splice(Math.floor(Math.random() * state.queue.length), 1)[0]
        : state.queue.shift();
      renderQueue();
      playTrack(nextTrack);
    } else if (state.currentTrack) {
      fetchAutoRecommendation(state.currentTrack);
    } else {
      audioEngine.pause();
      audioEngine.removeAttribute("src");
      audioEngine.load();
      state.isPlaying = false;
      updatePlayerUI();
      renderTracks();
    }
  }

  function playPrev() {
    if (audioEngine.currentTime > 3) {
      audioEngine.currentTime = 0;
      return;
    }

    if (state.history.length > 0) {
      var prevTrack = state.history.pop();
      if (state.currentTrack) {
        state.queue.unshift(state.currentTrack);
        renderQueue();
      }
      playTrack(prevTrack);
    } else {
      audioEngine.currentTime = 0;
    }
  }

  // ---------- Dropdown Logic ----------
  function openTrackDropdown(track, anchorBtn) {
    activeDropdownTrack = track;
    var rect = anchorBtn.getBoundingClientRect();

    var top = rect.bottom + 4;
    var left = Math.min(window.innerWidth - 200, rect.left - 150);
    trackDropdown.style.top = top + "px";
    trackDropdown.style.left = Math.max(10, left) + "px";

    dropdownPlaylistContainer.innerHTML = "";
    if (!state.playlists.length) {
      var emptyEl = document.createElement("div");
      emptyEl.className = "dropdown-empty";
      emptyEl.textContent = "No playlists created yet";
      dropdownPlaylistContainer.appendChild(emptyEl);
    } else {
      state.playlists.forEach(function (pl) {
        var plItem = document.createElement("div");
        plItem.className = "dropdown-item";
        
        var alreadyIn = pl.trackIds.includes(track.id);
        plItem.innerHTML = `<span>${escapeHtml(pl.name)}</span> ${alreadyIn ? '<small style="color:#1db954;margin-left:auto;">Added</small>' : ""}`;
        
        plItem.addEventListener("click", function (e) {
          e.stopPropagation();
          addTrackToPlaylist(track, pl.id);
          closeDropdown();
        });
        dropdownPlaylistContainer.appendChild(plItem);
      });
    }

    trackDropdown.style.display = "block";
  }

  function closeDropdown() {
    trackDropdown.style.display = "none";
    activeDropdownTrack = null;
  }

  function addTrackToPlaylist(track, playlistId) {
    registerTrack(track);
    var target = state.playlists.find((p) => p.id === playlistId);
    if (target) {
      if (!target.trackIds.includes(track.id)) {
        target.trackIds.push(track.id);
        saveJSON("daddy_playlists", state.playlists);
        syncToServer();
        if (state.view.type === "playlist" && state.view.id === playlistId) {
          renderTracks();
        }
      }
    }
  }

  // Modal Playlist Handler
  function commitNewPlaylist() {
    var name = modalPlaylistInput.value.trim();
    if (!name) return;
    var pl = { id: "pl_" + Date.now(), name: name.slice(0, 50), trackIds: [] };
    state.playlists.push(pl);
    saveJSON("daddy_playlists", state.playlists);
    syncToServer();
    renderPlaylists();
    playlistModal.style.display = "none";
    setView({ type: "playlist", id: pl.id });
  }

  // ---------- Audio Listeners ----------
  audioEngine.addEventListener("timeupdate", () => {
    if (!audioEngine.duration) return;
    var cur = audioEngine.currentTime;
    var dur = audioEngine.duration;
    curTime.textContent = fmtTime(cur);
    durTime.textContent = fmtTime(dur);
    seekFill.style.width = Math.min(100, (cur / dur) * 100) + "%";
  });

  audioEngine.addEventListener("ended", () => {
    if (state.repeat) {
      audioEngine.currentTime = 0;
      audioEngine.play();
    } else {
      playNext();
    }
  });

  audioEngine.addEventListener("play", () => {
    state.isPlaying = true;
    updatePlayerUI();
  });

  audioEngine.addEventListener("pause", () => {
    if (audioEngine.seeking) return;
    state.isPlaying = false;
    updatePlayerUI();
  });

  audioEngine.addEventListener("seeked", () => {
    if (state.isPlaying && audioEngine.paused) {
      audioEngine.play().catch(() => {});
    }
  });

  // ---------- Event Bindings ----------
  document.getElementById("playBtn").addEventListener("click", () => {
    if (!state.currentTrack) return;
    if (audioEngine.paused) audioEngine.play();
    else audioEngine.pause();
  });

  document.getElementById("nextBtn").addEventListener("click", playNext);
  document.getElementById("prevBtn").addEventListener("click", playPrev);

  document.getElementById("shuffleBtn").addEventListener("click", function () {
    state.shuffle = !state.shuffle;
    this.classList.toggle("active", state.shuffle);
  });

  document.getElementById("repeatBtn").addEventListener("click", function () {
    state.repeat = !state.repeat;
    this.classList.toggle("active", state.repeat);
  });

  nowFav.addEventListener("click", () => {
    if (state.currentTrack) toggleFavorite(state.currentTrack);
  });

  seekTrack.addEventListener("click", (e) => {
    var dur = audioEngine.duration || (state.currentTrack && state.currentTrack.dur);
    if (!dur || isNaN(dur) || !isFinite(dur)) return;

    var rect = seekTrack.getBoundingClientRect();
    var clickX = e.clientX - rect.left;
    var pct = Math.max(0, Math.min(1, clickX / rect.width));
    var targetTime = pct * dur;

    seekFill.style.width = (pct * 100) + "%";
    curTime.textContent = fmtTime(targetTime);

    try {
      audioEngine.currentTime = targetTime;
    } catch (err) {
      console.error("Seeking error:", err);
    }

    if (state.isPlaying || audioEngine.paused) {
      var playPromise = audioEngine.play();
      if (playPromise !== undefined) {
        playPromise.catch((err) => {
          if (err.name === "AbortError") return;
          console.error("Resume playback after seek failed:", err);
        });
      }
    }
  });

  volSlider.addEventListener("input", (e) => {
    audioEngine.volume = e.target.value / 100;
  });

  var browseNav = document.querySelector('.nav-item[data-view="browse"]');
  if (browseNav) browseNav.addEventListener("click", () => setView({ type: "browse" }));

  var favNav = document.querySelector('.nav-item[data-view="favorites"]');
  if (favNav) favNav.addEventListener("click", () => setView({ type: "favorites" }));

  searchInput.addEventListener("input", (e) => {
    clearTimeout(searchTimeout);
    var q = e.target.value;
    searchTimeout = setTimeout(() => {
      handleLiveSearch(q);
    }, 200);
  });

  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      clearTimeout(searchTimeout);
      handleLiveSearch(e.target.value);
    }
  });

  // Modal listeners
  newPlaylistBtn.addEventListener("click", () => {
    modalPlaylistInput.value = "";
    playlistModal.style.display = "flex";
    modalPlaylistInput.focus();
  });

  cancelModalBtn.addEventListener("click", () => {
    playlistModal.style.display = "none";
  });

  createModalBtn.addEventListener("click", commitNewPlaylist);
  modalPlaylistInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commitNewPlaylist();
    if (e.key === "Escape") playlistModal.style.display = "none";
  });

  // Dropdown listeners
  dropdownQueueAction.addEventListener("click", function (e) {
    e.stopPropagation();
    if (activeDropdownTrack) {
      addToQueue(activeDropdownTrack);
    }
    closeDropdown();
  });

  window.addEventListener("click", function (e) {
    if (!trackDropdown.contains(e.target)) {
      closeDropdown();
    }
  });

  // ---------- Authenticated Lifecycle Handshake ----------
  document.addEventListener("phantom:authenticated", function (e) {
    state.user = e.detail.user;
    loadUserSync();
  });

  setupMediaSession();
  renderPlaylists();
  renderQueue();
  setView({ type: "browse" });
})();