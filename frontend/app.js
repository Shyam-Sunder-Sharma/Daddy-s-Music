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
      if (!track.dur && track.duration) {
        track.dur = track.duration;
      }
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

  // View Actions Container (Play All / Shuffle Play)
  var viewActionsContainer = document.createElement("div");
  viewActionsContainer.className = "view-actions";
  viewActionsContainer.style.display = "none";
  if (viewHint && viewHint.parentNode) {
    viewHint.parentNode.insertBefore(viewActionsContainer, viewHint.nextSibling);
  }

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
            registerTrack(data.trackCache[k]);
          });
        }
        saveJSON("daddy_favorites", state.favorites);
        saveJSON("daddy_playlists", state.playlists);
        renderPlaylists();

        if (state.view.type !== "browse") {
          renderTracks();
        }
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
      const newVol = Math.min(1, audioEngine.volume + 0.05);
      audioEngine.volume = newVol;
      volSlider.value = Math.round(newVol * 100);
      localStorage.setItem("phantom_volume", newVol);
    } else if (e.code === "ArrowDown") {
      e.preventDefault();
      const newVol = Math.max(0, audioEngine.volume - 0.05);
      audioEngine.volume = newVol;
      volSlider.value = Math.round(newVol * 100);
      localStorage.setItem("phantom_volume", newVol);
    } else if (e.key.toLowerCase() === "m") {
      audioEngine.muted = !audioEngine.muted;
      volSlider.value = audioEngine.muted ? 0 : Math.round(audioEngine.volume * 100);
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

  // ---------- Action Controls: Play All & Shuffle Play ----------
  function updateViewActions(list) {
    if ((state.view.type === "favorites" || state.view.type === "playlist") && list.length > 0) {
      viewActionsContainer.innerHTML = "";
      viewActionsContainer.style.display = "flex";

      var playAllBtn = document.createElement("button");
      playAllBtn.type = "button";
      playAllBtn.className = "action-btn play-all";
      playAllBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        <span>Play All</span>
      `;
      playAllBtn.onclick = function () {
        if (!list.length) return;
        state.queue = list.slice(1);
        renderQueue();
        playTrack(list[0]);
      };

      var shufflePlayBtn = document.createElement("button");
      shufflePlayBtn.type = "button";
      shufflePlayBtn.className = "action-btn shuffle-play";
      shufflePlayBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 3h5v5M4 20L21 3M21 16v5h-5M4 4l5 5"/></svg>
        <span>Shuffle Play</span>
      `;
      shufflePlayBtn.onclick = function () {
        if (!list.length) return;
        var shuffled = list.slice();
        for (var i = shuffled.length - 1; i > 0; i--) {
          var j = Math.floor(Math.random() * (i + 1));
          var temp = shuffled[i];
          shuffled[i] = shuffled[j];
          shuffled[j] = temp;
        }
        state.queue = shuffled.slice(1);
        renderQueue();
        playTrack(shuffled[0]);
      };

      viewActionsContainer.appendChild(playAllBtn);
      viewActionsContainer.appendChild(shufflePlayBtn);
    } else {
      viewActionsContainer.style.display = "none";
      viewActionsContainer.innerHTML = "";
    }
  }

  // ---------- Track Rendering ----------
  function renderTracks() {
    var list = currentList();
    updateViewActions(list);
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
      favBtn.type = "button";
      favBtn.className = "icon-btn fav" + (state.favorites.indexOf(t.id) !== -1 ? " active" : "");
      favBtn.setAttribute("aria-label", "Favorite");
      favBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20s-7-4.4-9.5-9A5.5 5.5 0 0112 5.5 5.5 5.5 0 0121.5 11c-2.5 4.6-9.5 9-9.5 9z"/></svg>';
      favBtn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        toggleFavorite(t, favBtn);
      });

      var addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "icon-btn";
      addBtn.setAttribute("aria-label", "Options");
      addBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 5v14M5 12h14"/></svg>';
      
      addBtn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        openTrackDropdown(t, addBtn);
      });

      actions.appendChild(favBtn);
      actions.appendChild(addBtn);

      if (state.view.type === "playlist") {
        var removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "icon-btn remove-track";
        removeBtn.title = "Remove from playlist";
        removeBtn.setAttribute("aria-label", "Remove from playlist");
        removeBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2M10 11v6M14 11v6"/></svg>';

        removeBtn.addEventListener("click", function (e) {
          e.preventDefault();
          e.stopPropagation();
          removeTrackFromPlaylist(t.id, state.view.id);
        });

        actions.appendChild(removeBtn);
      }

      var durVal = t.dur || t.duration || 0;
      var dur = document.createElement("div");
      dur.className = "t-dur";
      dur.textContent = fmtTime(durVal);

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
      rm.type = "button";
      rm.className = "icon-btn q-remove";
      rm.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>';
      rm.addEventListener("click", function (e) {
        e.preventDefault();
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
      delBtn.type = "button";
      delBtn.className = "pl-delete";
      delBtn.title = "Delete Playlist";
      delBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>';

      delBtn.addEventListener("click", function (e) {
        e.preventDefault();
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

  function toggleFavorite(track, btnEl) {
    registerTrack(track);
    var i = state.favorites.indexOf(track.id);
    var isNowFav = false;

    if (i === -1) {
      state.favorites.push(track.id);
      isNowFav = true;
    } else {
      state.favorites.splice(i, 1);
      isNowFav = false;
    }

    saveJSON("daddy_favorites", state.favorites);
    syncToServer();

    if (btnEl) {
      btnEl.classList.toggle("active", isNowFav);
    }

    if (state.view.type === "favorites") {
      renderTracks();
    }

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
    
    var trackDur = track.dur || track.duration || 0;
    durTime.textContent = fmtTime(trackDur);
    seekFill.style.width = "0%";
    state.isPlaying = true;
    updatePlayerUI();
    updateMediaSessionMetadata(track);
    renderTracks();

    // Trigger synced lyrics fetch for the newly selected track
    loadLyrics(track.title, track.artist, trackDur);

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
        plItem.innerHTML = `<span>${escapeHtml(pl.name)}</span> ${alreadyIn ? '<small style="color:#22c55e;margin-left:auto;">Added</small>' : ""}`;
        
        plItem.addEventListener("click", function (e) {
          e.preventDefault();
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
    if (!target) return;

    if (!target.trackIds.includes(track.id)) {
      target.trackIds.push(track.id);
      saveJSON("daddy_playlists", state.playlists);
      syncToServer();

      if (state.view.type === "playlist" && state.view.id === playlistId) {
        renderTracks();
      }
    }
  }

  function removeTrackFromPlaylist(trackId, playlistId) {
    var target = state.playlists.find((p) => p.id === playlistId);
    if (!target) return;

    var index = target.trackIds.indexOf(trackId);
    if (index !== -1) {
      target.trackIds.splice(index, 1);
      saveJSON("daddy_playlists", state.playlists);
      syncToServer();
      renderTracks();
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
  audioEngine.preload = "auto";

  audioEngine.addEventListener("timeupdate", () => {
    if (!audioEngine.duration) return;
    var cur = audioEngine.currentTime;
    var dur = audioEngine.duration;
    curTime.textContent = fmtTime(cur);
    durTime.textContent = fmtTime(dur);
    seekFill.style.width = Math.min(100, (cur / dur) * 100) + "%";

    // Synchronize active lyrics line position
    syncActiveLyricLine(cur);
  });

  audioEngine.addEventListener("waiting", () => {
    console.log("Buffering audio chunk...");
  });

  audioEngine.addEventListener("stalled", () => {
    if (state.isPlaying && !audioEngine.paused) {
      var resumeTime = audioEngine.currentTime;
      audioEngine.currentTime = resumeTime;
      audioEngine.play().catch(() => {});
    }
  });

  audioEngine.addEventListener("ended", () => {
    var expectedDur =
      audioEngine.duration ||
      (state.currentTrack && (state.currentTrack.dur || state.currentTrack.duration));

    if (expectedDur && audioEngine.currentTime < expectedDur - 6) {
      console.warn("Premature stream cutoff detected. Resuming from:", audioEngine.currentTime);
      var resumePos = audioEngine.currentTime;
      audioEngine.currentTime = resumePos;
      audioEngine.play().catch(() => {});
      return;
    }

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
    var dur = audioEngine.duration || (state.currentTrack && (state.currentTrack.dur || state.currentTrack.duration));
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

  // ---------- Feature 1: Volume Slider with Persistence ----------
  function initVolumeControl() {
    const savedVol = localStorage.getItem("phantom_volume");
    const initialVol = savedVol !== null ? parseFloat(savedVol) : 0.7;

    audioEngine.volume = initialVol;
    if (volSlider) {
      volSlider.value = Math.round(initialVol * 100);
    }
  }

  if (volSlider) {
    volSlider.addEventListener("input", (e) => {
      const val = parseFloat(e.target.value) / 100;
      audioEngine.volume = val;
      audioEngine.muted = false;
      localStorage.setItem("phantom_volume", val);
    });
  }

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
    e.preventDefault();
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

  // =========================================================================
  // Feature 2: Universal Scored Lyrics Engine (Film / Pop / Global Adaptive)
  // =========================================================================
  var currentParsedLyrics = [];
  var lyricsModal = document.getElementById("lyrics-modal");
  var lyricsContainer = document.getElementById("lyrics-container");
  var lyricsTitle = document.getElementById("lyrics-song-title");
  var lyricsArtist = document.getElementById("lyrics-song-artist");
  var offsetDisplay = document.getElementById("lyricOffsetDisplay");

  var lyricOffset = parseFloat(localStorage.getItem("phantom_lyric_offset") || "-0.35");

  window.toggleLyricsModal = function () {
    if (lyricsModal) lyricsModal.classList.toggle("hidden");
  };

  window.adjustLyricOffset = function (delta) {
    lyricOffset = Math.round((lyricOffset + delta) * 10) / 10;
    localStorage.setItem("phantom_lyric_offset", lyricOffset);
    if (offsetDisplay) {
      offsetDisplay.innerText = `${lyricOffset > 0 ? "+" : ""}${lyricOffset.toFixed(1)}s`;
    }
    if (audioEngine) syncActiveLyricLine(audioEngine.currentTime);
  };

  // Universal metadata extractor for YouTube track titles
  function parseTrackContext(rawTitle, rawArtist) {
    var title = rawTitle || "";
    var artist = rawArtist || "";
    var albumOrMovie = "";

    // 1. Extract bracketed tokens if they contain "From <Movie>" or "OST" before wiping
    var movieBracketMatch = title.match(/[\(\[](?:from\vert{}movie\vert{}film\vert{}album)\s+["']?([^'"\)\]]+)["']?[\)\]]/i);
    if (movieBracketMatch && movieBracketMatch[1]) {
      albumOrMovie = movieBracketMatch[1].trim();
    }

    // 2. Remove standard parenthetical noise: (Official Video), [4K], etc.
    title = title.replace(/\(.*?\)|\[.*?\]|\{.*?\}/g, " ");

    // 3. Remove common YouTube fluff words
    var fluff = [
      /official\s*(music)?\s*(video|audio|lyric\s*video|track)/gi,
      /full\s*(song|video|audio|track)/gi,
      /latest\s*(hindi|punjabi|tamil|telugu|bhojpuri|english)?\s*song/gi,
      /\b(4k|hd|uhd|remix|slowed|reverb|teaser|trailer|promo)\b/gi,
      /\b(t-series|zee music company|sony music india|yrf|speed records|tips official|saregama)\b/gi
    ];
    fluff.forEach(function (pattern) {
      title = title.replace(pattern, " ");
    });

    // 4. Extract Pipe | or Colon : or Hyphen - segments
    // Example: "Zinda | Bharat | Salman Khan | Vishal Dadlani"
    if (title.includes("|")) {
      var segments = title.split("|").map(function (s) { return s.trim(); }).filter(Boolean);
      title = segments[0];
      if (segments.length > 1 && !albumOrMovie) {
        albumOrMovie = segments[1];
      }
      if (segments.length > 2) {
        artist = artist + " " + segments.slice(2).join(" ");
      }
    } else if (title.includes("-")) {
      var dashParts = title.split("-").map(function (s) { return s.trim(); }).filter(Boolean);
      if (dashParts.length >= 2) {
        artist = dashParts[0];
        title = dashParts[1];
      }
    }

    // Clean up channel noise like "- Topic" or "VEVO"
    artist = artist.replace(/- Topic/gi, "").replace(/vevo/gi, "").replace(/official/gi, "").trim();

    return {
      title: title.replace(/[,\/\\#+]/g, " ").replace(/\s+/g, " ").trim(),
      artist: artist.replace(/[,\/\\#+]/g, " ").replace(/\s+/g, " ").trim(),
      movie: albumOrMovie.replace(/[,\/\\#+]/g, " ").replace(/\s+/g, " ").trim()
    };
  }

  // Multi-Factor scoring algorithm to rank candidates accurately
  function scoreCandidate(candidate, ctx, targetDur) {
    var score = 0;
    var cTitle = (candidate.trackName || "").toLowerCase();
    var cArtist = (candidate.artistName || "").toLowerCase();
    var cAlbum = (candidate.albumName || "").toLowerCase();

    var qTitle = ctx.title.toLowerCase();
    var qArtist = ctx.artist.toLowerCase();
    var qMovie = ctx.movie.toLowerCase();

    // 1. Duration match (up to 40 pts)
    if (targetDur > 0 && candidate.duration) {
      var diff = Math.abs(candidate.duration - targetDur);
      if (diff <= 3) score += 40;
      else if (diff <= 7) score += 30;
      else if (diff <= 15) score += 15;
      else score -= 25; // Heavily penalize duration mismatches
    }

    // 2. Title similarity (up to 30 pts)
    if (cTitle === qTitle) {
      score += 30;
    } else if (cTitle.includes(qTitle) || qTitle.includes(cTitle)) {
      score += 20;
    }

    // 3. Movie / Album context (up to 25 pts)
    if (qMovie && (cAlbum.includes(qMovie) || cTitle.includes(qMovie))) {
      score += 25;
    }

    // 4. Artist / Singer cross-validation (up to 25 pts)
    if (qArtist) {
      var artistWords = qArtist.split(/\s+/).filter(function (w) { return w.length > 2; });
      var matchedWords = artistWords.filter(function (word) {
        return cArtist.includes(word) || cAlbum.includes(word);
      });
      if (matchedWords.length > 0) {
        score += Math.min(25, matchedWords.length * 10);
      }
    }

    // Bonus for having synchronized lyrics
    if (candidate.syncedLyrics) score += 10;

    return score;
  }

  async function loadLyrics(rawTitle, rawArtist, durationSec) {
    if (!lyricsContainer) return;

    currentParsedLyrics = [];
    if (lyricsTitle) lyricsTitle.innerText = rawTitle;
    if (lyricsArtist) lyricsArtist.innerText = rawArtist;
    if (offsetDisplay) offsetDisplay.innerText = `${lyricOffset > 0 ? "+" : ""}${lyricOffset.toFixed(1)}s`;

    lyricsContainer.innerHTML = '<p class="lyrics-status">Searching verified lyrics...</p>';

    var ctx = parseTrackContext(rawTitle, rawArtist);
    var targetDur = Math.round(durationSec || 0);

    // Build layered search queries
    var queries = [
      `${ctx.title} ${ctx.movie} ${ctx.artist}`.trim(),
      `${ctx.title} ${ctx.movie}`.trim(),
      `${ctx.title} ${ctx.artist}`.trim(),
      ctx.title
    ];

    try {
      var allCandidates = [];
      var seenIds = new Set();

      // Query LRCLIB with distinct candidate variations
      for (var i = 0; i < queries.length; i++) {
        var q = queries[i];
        if (!q || q.length < 2) continue;

        try {
          var res = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`);
          if (res.ok) {
            var items = await res.json();
            if (Array.isArray(items)) {
              items.forEach(function (item) {
                if (!seenIds.has(item.id)) {
                  seenIds.add(item.id);
                  allCandidates.push(item);
                }
              });
            }
          }
        } catch (e) {}

        // Break early if we already have strong candidates to reduce latency
        if (allCandidates.length >= 8) break;
      }

      if (allCandidates.length === 0) {
        lyricsContainer.innerHTML = '<p class="lyrics-status">No lyrics found for this track.</p>';
        return;
      }

      // Rank all collected candidates using the scoring engine
      var scored = allCandidates.map(function (candidate) {
        return {
          candidate: candidate,
          score: scoreCandidate(candidate, ctx, targetDur)
        };
      });

      // Sort descending by highest score
      scored.sort(function (a, b) { return b.score - a.score; });

      var bestMatch = scored[0];

      // Confidence threshold check (prevents picking random songs)
      if (bestMatch.score < 35) {
        lyricsContainer.innerHTML = '<p class="lyrics-status">No verified lyrics matched this track.</p>';
        return;
      }

      var chosen = bestMatch.candidate;
      if (chosen.syncedLyrics) {
        parseAndRenderLyrics(chosen.syncedLyrics);
      } else if (chosen.plainLyrics) {
        lyricsContainer.innerHTML = chosen.plainLyrics
          .split("\n")
          .map(function (line) { return `<p class="lyric-line">${escapeHtml(line) || "♪"}</p>`; })
          .join("");
      } else {
        lyricsContainer.innerHTML = '<p class="lyrics-status">No synchronized lyrics available.</p>';
      }
    } catch (err) {
      console.warn("Universal lyrics fetch error:", err);
      lyricsContainer.innerHTML = '<p class="lyrics-status">Unable to load lyrics.</p>';
    }
  }

  function parseAndRenderLyrics(lrcText) {
    currentParsedLyrics = [];
    var lines = lrcText.split("\n");
    var timeRegex = /\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\]/;

    lines.forEach(function (line) {
      var match = timeRegex.exec(line);
      if (match) {
        var min = parseInt(match[1], 10);
        var sec = parseInt(match[2], 10);
        var ms = match[3] ? parseFloat("0." + match[3]) : 0;
        var totalTime = min * 60 + sec + ms;
        var text = line.replace(timeRegex, "").trim();

        if (text) {
          currentParsedLyrics.push({ time: totalTime, text: text });
        }
      }
    });

    lyricsContainer.innerHTML = currentParsedLyrics
      .map(function (item, idx) {
        return `<p class="lyric-line" id="lyric-line-${idx}">${escapeHtml(item.text)}</p>`;
      })
      .join("");

    currentParsedLyrics.forEach(function (item, idx) {
      var el = document.getElementById(`lyric-line-${idx}`);
      if (el) {
        el.addEventListener("click", function () {
          var seekTarget = Math.max(0, item.time - lyricOffset);
          audioEngine.currentTime = seekTarget;
          if (audioEngine.paused) audioEngine.play().catch(function () {});
        });
      }
    });
  }

  function syncActiveLyricLine(cur) {
    if (
      currentParsedLyrics.length === 0 ||
      !lyricsModal ||
      lyricsModal.classList.contains("hidden")
    ) {
      return;
    }

    var calibratedTime = cur + lyricOffset;
    var activeIdx = -1;

    for (var i = 0; i < currentParsedLyrics.length; i++) {
      if (calibratedTime >= currentParsedLyrics[i].time) {
        activeIdx = i;
      } else {
        break;
      }
    }

    if (activeIdx !== -1) {
      var prevActive = document.querySelector(".lyric-line.active");
      var newActive = document.getElementById(`lyric-line-${activeIdx}`);

      if (newActive && prevActive !== newActive) {
        if (prevActive) prevActive.classList.remove("active");
        newActive.classList.add("active");
        newActive.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  }

  // =========================================================
  // Feature 3: Web Audio API 5-Band Equalizer & Presets
  // =========================================================
  var audioCtx = null;
  var sourceNode = null;
  var eqBands = [];
  var EQ_FREQUENCIES = [60, 250, 1000, 4000, 16000];

  var EQ_PRESETS = {
    flat: [0, 0, 0, 0, 0],
    bass: [8, 5, 0, -2, -3],
    treble: [-4, -2, 1, 6, 8],
    vocal: [-2, 2, 6, 3, -1],
    electronic: [7, 4, -1, 3, 5]
  };

  function ensureAudioContextRunning() {
    if (!audioCtx) {
      initEqualizer();
    }
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().catch((err) => console.warn("Context resume failed:", err));
    }
  }

  function initEqualizer() {
    if (audioCtx || !audioEngine) return;

    try {
      var AudioContext = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioContext();

      // Ensure cross-origin audio streaming is permitted for Web Audio analysis
      audioEngine.crossOrigin = "anonymous";

      sourceNode = audioCtx.createMediaElementSource(audioEngine);

      eqBands = EQ_FREQUENCIES.map((freq, index) => {
        var filter = audioCtx.createBiquadFilter();
        if (index === 0) {
          filter.type = "lowshelf";
        } else if (index === EQ_FREQUENCIES.length - 1) {
          filter.type = "highshelf";
        } else {
          filter.type = "peaking";
          filter.Q.value = 1.0;
        }
        filter.frequency.value = freq;
        filter.gain.value = 0;
        return filter;
      });

      // Pipeline chain: Source -> EQ 1 -> ... -> EQ 5 -> Speakers
      sourceNode.connect(eqBands[0]);
      for (var i = 0; i < eqBands.length - 1; i++) {
        eqBands[i].connect(eqBands[i + 1]);
      }
      eqBands[eqBands.length - 1].connect(audioCtx.destination);
    } catch (e) {
      console.warn("Web Audio API node connection failed, falling back to standard audio:", e);
    }
  }

  // Wake AudioContext on any user interaction
  window.addEventListener("click", ensureAudioContextRunning);
  window.addEventListener("keydown", ensureAudioContextRunning);

  window.toggleEqModal = function () {
    var eqModal = document.getElementById("eq-modal");
    if (eqModal) {
      eqModal.classList.toggle("hidden");
    }
  };

  window.updateBand = function (index, value) {
    ensureAudioContextRunning();
    var gainVal = parseFloat(value);
    if (eqBands[index]) {
      eqBands[index].gain.value = gainVal;
    }

    var bandIds = ["band-60", "band-250", "band-1k", "band-4k", "band-16k"];
    var label = document.getElementById("val-" + bandIds[index]);
    if (label) {
      label.innerText = `${gainVal > 0 ? "+" : ""}${gainVal}dB`;
    }
  };

  window.applyEqPreset = function (name) {
    ensureAudioContextRunning();
    var gains = EQ_PRESETS[name] || EQ_PRESETS.flat;
    var bandIds = ["band-60", "band-250", "band-1k", "band-4k", "band-16k"];

    gains.forEach((gain, idx) => {
      window.updateBand(idx, gain);
      var slider = document.getElementById(bandIds[idx]);
      if (slider) slider.value = gain;
    });
  };

  // Lifecycle boot
  initVolumeControl();
  setupMediaSession();
  renderPlaylists();
  renderQueue();
  setView({ type: "browse" });
})();