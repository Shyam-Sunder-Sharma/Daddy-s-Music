(function () {
  "use strict";

  const IS_LOCAL_SPLIT_PORT =
    window.location.protocol === "file:" ||
    ((window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost") &&
      window.location.port !== "" &&
      window.location.port !== "5000");
  const BACKEND_ORIGIN = IS_LOCAL_SPLIT_PORT ? "http://127.0.0.1:5000" : window.location.origin;
  const API_BASE = BACKEND_ORIGIN + "/api";
  const SOCKET_BASE = BACKEND_ORIGIN;
  const audioEngine = document.getElementById("audioEngine");
  const audioEngineB = document.getElementById("audioEngineB");

  var TRACK_MAP = new Map();
  var searchCache = new Map();

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

  function loadSessionView() {
    try {
      var raw = sessionStorage.getItem("daddy_active_view");
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.type) return parsed;
      }
    } catch (e) {}
    return { type: "browse", id: null };
  }

  function saveSessionView(v) {
    try {
      sessionStorage.setItem("daddy_active_view", JSON.stringify(v));
    } catch (e) {}
  }

  var state = {
    user: null,
    favorites: loadJSON("daddy_favorites", []),
    playlists: loadJSON("daddy_playlists", []),
    playCounts: loadJSON("daddy_play_counts", {}),
    lastPlayedAt: loadJSON("daddy_last_played", {}),
    queue: [],
    history: loadJSON("daddy_history", []),
    searchResults: [],
    quickMixTracks: [],
    currentTrack: null,
    isPlaying: false,
    shuffle: false,
    repeat: false,
    playbackRate: parseFloat(localStorage.getItem("phantom_speed") || "1.0"),
    crossfadeSec: parseInt(localStorage.getItem("phantom_crossfade") || "3", 10),
    replayGain: localStorage.getItem("phantom_replaygain") !== "false",
    vizMode: localStorage.getItem("phantom_viz_mode") || "bars",
    sleepTimer: { mode: null, endsAt: null, intervalId: null, fading: false },
    room: { code: null, members: [], isSyncingRemote: false },
    playbackContext: { type: "auto", id: null },
    sessionPlayedIds: [],
    view: loadSessionView(),
    searchQuery: ""
  };

  function showToast(msg) {
    var existing = document.querySelector(".phantom-toast");
    if (existing) existing.remove();
    var toast = document.createElement("div");
    toast.className = "phantom-toast";
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(function () {
      if (toast.parentNode) toast.remove();
    }, 2600);
  }

  function fmtTime(s) {
    s = Math.max(0, Math.floor(s || 0));
    var m = Math.floor(s / 60), r = s % 60;
    return m + ":" + (r < 10 ? "0" : "") + r;
  }

  function persistTrackMap() {
    try {
      var obj = {};
      TRACK_MAP.forEach(function (val, key) {
        obj[key] = val;
      });
      localStorage.setItem("daddy_track_cache", JSON.stringify(obj));
    } catch (e) {}
  }

  var NON_SONG_KEYWORDS = [
    "reaction", "reacts to", "react to", "review", "interview", "podcast",
    "behind the scenes", "making of", "vlog", "trailer", "teaser",
    "unboxing", "full movie", "gameplay", "walkthrough", "tutorial",
    "parody", "funny moments", "roast", "whatsapp status", "status video",
    "episode", "ep ", "news", "comedy", "scene", "shorts", "tiktok"
  ];

  function isSongTrack(track) {
    if (!track || !track.title) return false;
    var tLower = (track.title || "").toLowerCase();
    for (var i = 0; i < NON_SONG_KEYWORDS.length; i++) {
      if (tLower.includes(NON_SONG_KEYWORDS[i])) {
        return false;
      }
    }
    var dur = track.dur || track.duration || 0;
    if (dur > 0 && (dur < 40 || dur > 660)) {
      return false;
    }
    return true;
  }

  // Automatic legacy cache purge to clean out non-song videos from previous versions
  try {
    if (!localStorage.getItem("daddy_songs_only_v20")) {
      localStorage.setItem("daddy_songs_only_v20", "1");
      localStorage.removeItem("daddy_track_cache");
      var curHist = loadJSON("daddy_history", []);
      if (Array.isArray(curHist)) {
        saveJSON("daddy_history", curHist.filter(isSongTrack));
      }
    }
  } catch (e) {}

  function registerTrack(track, skipSave) {
    if (track && track.id && isSongTrack(track)) {
      if (!track.dur && track.duration) {
        track.dur = track.duration;
      }
      TRACK_MAP.set(String(track.id), track);
      if (!skipSave) {
        persistTrackMap();
      }
    }
  }

  (function hydrateTrackCache() {
    var cached = loadJSON("daddy_track_cache", {});
    if (cached && typeof cached === "object") {
      Object.keys(cached).forEach(function (k) {
        var tr = cached[k];
        if (isSongTrack(tr)) {
          registerTrack(tr, true);
        }
      });
    }
    if (Array.isArray(state.history)) {
      state.history = state.history.filter(isSongTrack);
      state.history.forEach(function (t) {
        registerTrack(t, true);
      });
    }
  })();

  function escapeHtml(str) {
    if (!str) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ---------- Fuzzy & Multi-Field Levenshtein Search ----------
  function levenshteinDistance(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    var v0 = new Array(b.length + 1);
    var v1 = new Array(b.length + 1);
    for (var i = 0; i <= b.length; i++) v0[i] = i;
    for (var i = 0; i < a.length; i++) {
      v1[0] = i + 1;
      for (var j = 0; j < b.length; j++) {
        var cost = a[i] === b[j] ? 0 : 1;
        v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
      }
      for (var j = 0; j <= b.length; j++) v0[j] = v1[j];
    }
    return v1[b.length];
  }

  function fuzzyScoreTrack(track, query) {
    if (!track || !query) return 1;
    var tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return 1;

    var haystack = `${track.title || ""} ${track.artist || ""} ${track.album || ""}`.toLowerCase();
    var words = haystack.split(/[^a-z0-9]+/).filter(Boolean);

    var totalScore = 0;
    for (var t = 0; t < tokens.length; t++) {
      var tok = tokens[t];
      if (haystack.includes(tok)) {
        totalScore += 10;
        continue;
      }
      var maxDist = tok.length >= 6 ? 2 : tok.length >= 4 ? 1 : 0;
      if (maxDist === 0) return 0;

      var matchedToken = false;
      for (var w = 0; w < words.length; w++) {
        var word = words[w];
        var prefix = word.slice(0, tok.length);
        if (
          levenshteinDistance(tok, word) <= maxDist ||
          (prefix.length >= 3 && levenshteinDistance(tok, prefix) <= 1)
        ) {
          matchedToken = true;
          totalScore += 6;
          break;
        }
      }
      if (!matchedToken) return 0;
    }
    return totalScore;
  }

  function filterAndRankTracksFuzzy(tracks, query) {
    if (!query || !query.trim()) return tracks;
    var scored = [];
    tracks.forEach(function (t) {
      var s = fuzzyScoreTrack(t, query);
      if (s > 0) scored.push({ track: t, score: s });
    });
    scored.sort(function (a, b) {
      return b.score - a.score;
    });
    return scored.map(function (item) {
      return item.track;
    });
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
  var activeDropdownBtn = null;
  var trackDropdown = document.getElementById("trackDropdown");
  var dropdownPlaylistContainer = document.getElementById("dropdownPlaylistContainer");
  var dropdownQueueAction = document.getElementById("dropdownQueueAction");

  // Search Control
  var searchTimeout = null;
  var activeController = null;

  // View Actions Container
  var viewActionsContainer = document.createElement("div");
  viewActionsContainer.className = "view-actions";
  viewActionsContainer.style.display = "none";
  if (viewHint && viewHint.parentNode) {
    viewHint.parentNode.insertBefore(viewActionsContainer, viewHint.nextSibling);
  }

  // ---------- Dynamic Palette Background Extractor ----------
  function applyDynamicPalette(imgEl, fallbackSeed) {
    try {
      var canvas = document.createElement("canvas");
      canvas.width = 16;
      canvas.height = 16;
      var ctx = canvas.getContext("2d");
      ctx.drawImage(imgEl, 0, 0, 16, 16);
      var data = ctx.getImageData(0, 0, 16, 16).data;
      var rTotal = 0, gTotal = 0, bTotal = 0, count = 0;

      for (var i = 0; i < data.length; i += 4) {
        var r = data[i], g = data[i + 1], b = data[i + 2];
        var lum = (r + g + b) / 3;
        if (lum > 20 && lum < 235) {
          rTotal += r;
          gTotal += g;
          bTotal += b;
          count++;
        }
      }
      if (count > 0) {
        var rAvg = Math.round(rTotal / count);
        var gAvg = Math.round(gTotal / count);
        var bAvg = Math.round(bTotal / count);
        document.documentElement.style.setProperty("--dynamic-tint", `rgba(${rAvg}, ${gAvg}, ${bAvg}, 0.22)`);
        document.documentElement.style.setProperty("--dynamic-tint-secondary", `rgba(${rAvg}, ${gAvg}, ${bAvg}, 0.07)`);
        return;
      }
    } catch (e) {}

    // Deterministic vibrant fallback if CORS restricts canvas read
    var str = String(fallbackSeed || "phantom");
    var hash = 0;
    for (var j = 0; j < str.length; j++) {
      hash = str.charCodeAt(j) + ((hash << 5) - hash);
    }
    var h = Math.abs(hash) % 360;
    document.documentElement.style.setProperty("--dynamic-tint", `hsla(${h}, 70%, 45%, 0.18)`);
    document.documentElement.style.setProperty("--dynamic-tint-secondary", `hsla(${(h + 40) % 360}, 65%, 35%, 0.06)`);
  }

  if (nowCover) {
    nowCover.addEventListener("load", function () {
      if (state.currentTrack) {
        applyDynamicPalette(nowCover, state.currentTrack.title + state.currentTrack.artist);
      }
    });
    nowCover.addEventListener("error", function () {
      if (state.currentTrack) {
        applyDynamicPalette(null, state.currentTrack.title + state.currentTrack.artist);
      }
    });
  }

  // ---------- Backend Cloud Sync (Safe No-Reload) ----------
  var hasLocalModification = false;

  async function syncToServer() {
    hasLocalModification = true;
    persistTrackMap();
    if (!state.user || typeof window.authFetch !== "function") return;
    try {
      var trackCacheObj = {};
      TRACK_MAP.forEach(function (val, key) {
        trackCacheObj[key] = val;
      });

      window.authFetch(`${API_BASE}/sync/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          favorites: state.favorites,
          playlists: state.playlists,
          playCounts: state.playCounts,
          lastPlayedAt: state.lastPlayedAt,
          lastTrack: state.currentTrack,
          trackCache: trackCacheObj
        })
      }).catch(function (err) {
        console.warn("Background sync skipped:", err);
      });
    } catch (e) {
      console.warn("Sync error ignored:", e);
    }
  }

  async function loadUserSync() {
    if (!state.user || typeof window.authFetch !== "function") return;
    try {
      const res = await window.authFetch(`${API_BASE}/sync/load`);
      if (res && res.ok) {
        const data = await res.json();
        if (data.trackCache) {
          Object.keys(data.trackCache).forEach(function (k) {
            registerTrack(data.trackCache[k], true);
          });
          persistTrackMap();
        }
        if (data.playCounts) {
          state.playCounts = Object.assign({}, data.playCounts, state.playCounts);
          saveJSON("daddy_play_counts", state.playCounts);
        }
        if (data.lastPlayedAt) {
          state.lastPlayedAt = Object.assign({}, data.lastPlayedAt, state.lastPlayedAt);
          saveJSON("daddy_last_played", state.lastPlayedAt);
        }
        if (!hasLocalModification) {
          state.favorites = data.favorites || [];
          state.playlists = data.playlists || [];
          saveJSON("daddy_favorites", state.favorites);
          saveJSON("daddy_playlists", state.playlists);
        }
        if (data.lastTrack && !state.currentTrack) {
          saveJSON("daddy_last_track", data.lastTrack);
          restoreLastPlayedTrack(data.lastTrack);
        } else if (!state.currentTrack) {
          restoreLastPlayedTrack();
        }
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

  // ---------- MediaSession API ----------
  function setupMediaSession() {
    if (!("mediaSession" in navigator)) return;

    navigator.mediaSession.setActionHandler("play", function () {
      if (!state.currentTrack) return;
      if (ytPlayer && typeof ytPlayer.playVideo === "function") {
        try {
          if (typeof ytPlayer.unMute === "function") {
            ytPlayer.unMute();
          }
          ytPlayer.playVideo();
          startPlayKicker();
        } catch (e) {}
      } else {
        playTrack(state.currentTrack);
      }
    });
    navigator.mediaSession.setActionHandler("pause", function () {
      if (ytPlayer && typeof ytPlayer.pauseVideo === "function") {
        ytPlayer.pauseVideo();
      }
    });
    navigator.mediaSession.setActionHandler("previoustrack", playPrev);
    navigator.mediaSession.setActionHandler("nexttrack", playNext);
    navigator.mediaSession.setActionHandler("seekbackward", function () {
      seekPlayerTo(Math.max(getPlayerCurrentTime() - 5, 0));
    });
    navigator.mediaSession.setActionHandler("seekforward", function () {
      seekPlayerTo(getPlayerCurrentTime() + 5);
    });
    try {
      navigator.mediaSession.setActionHandler("seekto", function (details) {
        if (typeof details.seekTime === "number") {
          seekPlayerTo(details.seekTime);
        }
      });
    } catch (e) {}
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

  // ---------- Global Hotkey Controls & Command Palette (Ctrl + K) ----------
  window.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key && e.key.toLowerCase() === "k") {
      e.preventDefault();
      e.stopPropagation();
      toggleCommandPalette();
      return;
    }

    if (e.key === "Escape") {
      var cmdModal = document.getElementById("cmdPaletteModal");
      if (cmdModal && cmdModal.style.display !== "none") {
        cmdModal.style.display = "none";
        return;
      }
      var roomModal = document.getElementById("listenAlongModal");
      if (roomModal && roomModal.style.display !== "none") {
        roomModal.style.display = "none";
        return;
      }
      var vidModal = document.getElementById("videoModal");
      if (vidModal && !vidModal.classList.contains("hidden")) {
        closeVideoModal();
        return;
      }
    }

    if (document.activeElement && (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "TEXTAREA" || document.activeElement.tagName === "SELECT")) {
      return;
    }

    var key = e.key ? e.key.toLowerCase() : "";

    if (e.code === "Space") {
      e.preventDefault();
      toggleCurrentTrackPlayPause();
    } else if (e.code === "ArrowRight") {
      seekPlayerTo(getPlayerCurrentTime() + 5);
    } else if (e.code === "ArrowLeft") {
      seekPlayerTo(Math.max(getPlayerCurrentTime() - 5, 0));
    } else if (key === "l") {
      seekPlayerTo(getPlayerCurrentTime() + 10);
    } else if (key === "j") {
      seekPlayerTo(Math.max(getPlayerCurrentTime() - 10, 0));
    } else if (key === "n") {
      playNext();
    } else if (key === "p") {
      playPrev();
    } else if (key === "f") {
      if (state.currentTrack) toggleFavorite(state.currentTrack);
    } else if (e.code === "ArrowUp") {
      e.preventDefault();
      setPlayerVolume((state.volume ?? 0.8) + 0.05);
    } else if (e.code === "ArrowDown") {
      e.preventDefault();
      setPlayerVolume((state.volume ?? 0.8) - 0.05);
    } else if (key === "m") {
      if (ytPlayer && typeof ytPlayer.isMuted === "function") {
        if (ytPlayer.isMuted()) {
          ytPlayer.unMute();
          if (volSlider) volSlider.value = Math.round((state.volume || 0.8) * 100);
        } else {
          ytPlayer.mute();
          if (volSlider) volSlider.value = 0;
        }
      }
    }
  });

  // ---------- Search Engine & Fuzzy Filter ----------
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
    state.searchQuery = (query || "").trim();

    // If user is in Favorites, Playlist, or Smart Mix, filter that view in-memory using Levenshtein fuzzy search
    if (state.view.type !== "browse") {
      renderTracks();
      return;
    }

    if (!state.searchQuery) {
      state.searchResults = [];
      renderTracks();
      return;
    }

    var qKey = state.searchQuery.toLowerCase();

    // Use cached search only if all cached results are valid songs
    if (searchCache.has(qKey)) {
      var cachedTracks = (searchCache.get(qKey) || []).filter(isSongTrack);
      if (cachedTracks.length > 0) {
        state.searchResults = cachedTracks;
        viewTitle.textContent = 'Results for "' + state.searchQuery + '"';
        viewHint.textContent = state.searchResults.length + " song(s) found.";
        renderTracks();
        return;
      }
    }

    viewTitle.textContent = 'Results for "' + state.searchQuery + '"';
    viewHint.textContent = "Searching songs on YouTube Music...";
    renderSkeleton();

    if (activeController) {
      try { activeController.abort(); } catch (e) {}
    }
    activeController = new AbortController();

    fetch(`${API_BASE}/search?q=${encodeURIComponent(state.searchQuery)}`, {
      signal: activeController.signal
    })
      .then((res) => {
        if (!res.ok) throw new Error("Search response error");
        return res.json();
      })
      .then((tracks) => {
        if (!Array.isArray(tracks)) tracks = [];

        // Strictly filter to pure songs ONLY — eliminates random videos, podcasts, vlogs, memes
        tracks = tracks.filter(isSongTrack);

        tracks.forEach(function (t) {
          registerTrack(t, true);
        });
        persistTrackMap();

        searchCache.set(qKey, tracks);
        state.searchResults = tracks;
        viewHint.textContent = tracks.length + " song(s) found.";
        renderTracks();
      })
      .catch((err) => {
        if (err.name === "AbortError") return;
        viewHint.textContent = "Search error. Ensure server is online.";
      });
  }

  // ---------- Smart Dynamic Playlists ----------
  function getTopPlayedList() {
    var allTracks = [];
    TRACK_MAP.forEach(function (t) {
      var c = state.playCounts[String(t.id)] || 0;
      if (c > 0) {
        allTracks.push({ track: t, count: c });
      }
    });
    if (allTracks.length === 0) {
      state.history.forEach(function (t, idx) {
        registerTrack(t, true);
        allTracks.push({ track: t, count: Math.max(1, state.history.length - idx) });
      });
    }
    allTracks.sort(function (a, b) {
      return b.count - a.count;
    });
    return allTracks.slice(0, 25).map(function (item) {
      return item.track;
    });
  }

  function getForgottenFavoritesList() {
    var now = Date.now();
    var thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    var favTracks = state.favorites.map((id) => TRACK_MAP.get(String(id))).filter(Boolean);

    var forgotten = favTracks.filter(function (t) {
      var last = state.lastPlayedAt[String(t.id)] || 0;
      return now - last >= thirtyDaysMs;
    });

    if (forgotten.length > 0) {
      return { list: forgotten, exact30d: true };
    }

    // Sort favorites by oldest played first so user always gets a useful list
    var sortedOldest = favTracks.slice().sort(function (a, b) {
      var la = state.lastPlayedAt[String(a.id)] || 0;
      var lb = state.lastPlayedAt[String(b.id)] || 0;
      return la - lb;
    });
    return { list: sortedOldest, exact30d: false };
  }

  async function generateQuickMix() {
    var seedTrack = state.currentTrack || state.history[0] || (state.favorites[0] && TRACK_MAP.get(String(state.favorites[0])));
    var seedArtist = seedTrack ? seedTrack.artist : "Arijit Singh";
    var seedTitle = seedTrack ? seedTrack.title : "Top Hits";

    setView({ type: "smart-quickmix", id: null });
    viewTitle.textContent = "Quick Mix";
    viewHint.textContent = `Building a dynamic mix inspired by ${seedArtist}…`;
    renderSkeleton();

    try {
      var res = await fetch(`${API_BASE}/search?q=${encodeURIComponent(seedArtist)}`);
      var tracks = res.ok ? await res.json() : [];
      if (!Array.isArray(tracks)) tracks = [];
      tracks.forEach(function (t) {
        registerTrack(t, true);
      });
      persistTrackMap();

      // Mix in matching local favorites/history from different artists for variety
      var extras = [];
      TRACK_MAP.forEach(function (t) {
        if (tracks.length + extras.length < 15 && !tracks.some((x) => String(x.id) === String(t.id))) {
          extras.push(t);
        }
      });

      state.quickMixTracks = tracks.concat(extras.slice(0, 6));
      viewHint.textContent = `Dynamic mix based on "${seedTitle}" by ${seedArtist} (${state.quickMixTracks.length} tracks).`;
      renderTracks();

      if (state.quickMixTracks.length > 0 && !state.isPlaying) {
        state.queue = state.quickMixTracks.slice(1);
        renderQueue();
        playTrack(state.quickMixTracks[0]);
      }
    } catch (e) {
      viewHint.textContent = "Quick Mix using your cached library tracks.";
      var fallback = [];
      TRACK_MAP.forEach((t) => fallback.push(t));
      state.quickMixTracks = fallback.slice(0, 15);
      renderTracks();
    }
  }

  function currentList() {
    var baseList = [];

    if (state.view.type === "favorites") {
      baseList = state.favorites.map((id) => TRACK_MAP.get(String(id))).filter(Boolean);
      viewTitle.textContent = "Favorites";
      viewHint.textContent = baseList.length ? "Tracks you've liked." : "No favorites saved yet.";
      return state.searchQuery ? filterAndRankTracksFuzzy(baseList, state.searchQuery) : baseList;
    }

    if (state.view.type === "smart-top") {
      baseList = getTopPlayedList();
      viewTitle.textContent = "Top Played";
      viewHint.textContent = baseList.length
        ? "Auto-generated from your most-streamed tracks."
        : "Play some tracks to build your Top Played chart.";
      return state.searchQuery ? filterAndRankTracksFuzzy(baseList, state.searchQuery) : baseList;
    }

    if (state.view.type === "smart-forgotten") {
      var res = getForgottenFavoritesList();
      baseList = res.list;
      viewTitle.textContent = "Forgotten Favorites";
      viewHint.textContent = !baseList.length
        ? "Add tracks to Favorites to rediscover them here."
        : res.exact30d
        ? "Favorites you haven't played in over 30 days."
        : "Your least-recently played favorite tracks.";
      return state.searchQuery ? filterAndRankTracksFuzzy(baseList, state.searchQuery) : baseList;
    }

    if (state.view.type === "smart-quickmix") {
      baseList = state.quickMixTracks || [];
      viewTitle.textContent = "Quick Mix";
      if (!baseList.length) {
        viewHint.textContent = "Click Quick Mix in the sidebar to generate an instant mix.";
      }
      return state.searchQuery ? filterAndRankTracksFuzzy(baseList, state.searchQuery) : baseList;
    }

    if (state.view.type === "playlist") {
      var pl = state.playlists.find((p) => p.id === state.view.id);
      if (!pl) {
        state.view = { type: "browse", id: null };
        saveSessionView(state.view);
        updateNavHighlight();
      } else {
        baseList = (pl.trackIds || []).map((id) => TRACK_MAP.get(String(id))).filter(Boolean);
        viewTitle.textContent = pl.name;
        viewHint.textContent = baseList.length + " track(s) in playlist. Drag (⋮⋮) to reorder.";
        return state.searchQuery ? filterAndRankTracksFuzzy(baseList, state.searchQuery) : baseList;
      }
    }

    if (state.view.type === "queue") {
      baseList = (state.queue || []).slice();
      viewTitle.textContent = "Up Next (Queue)";
      viewHint.textContent = baseList.length
        ? baseList.length + " track(s) scheduled to play next."
        : "Your queue is currently empty. Tap the + icon on any track to add it here.";
      return state.searchQuery ? filterAndRankTracksFuzzy(baseList, state.searchQuery) : baseList;
    }

    if (state.searchQuery) {
      viewTitle.textContent = 'Results for "' + state.searchQuery + '"';
      viewHint.textContent = state.searchResults.length + " track(s) found.";
      return state.searchResults;
    } else {
      var recent = state.history.map((t) => {
        registerTrack(t, true);
        return t;
      });

      if (recent.length > 0) {
        viewTitle.textContent = "Recently Played";
        viewHint.textContent = "Jump back into what you were listening to.";
      } else {
        viewTitle.textContent = "Browse";
        viewHint.textContent = "Search any song, artist, or album to start listening.";
      }
      return recent;
    }
  }

  // ---------- M3U8 & JSON Playlist Export / Import ----------
  function downloadFile(filename, content, mimeType) {
    var blob = new Blob([content], { type: mimeType });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  function exportCurrentListAsJSON(list, name) {
    var payload = {
      name: name || "Daddy's Music Playlist",
      exportedAt: new Date().toISOString(),
      tracks: list
    };
    var safeName = (name || "playlist").replace(/[^a-z0-9_\-]+/gi, "_").toLowerCase();
    downloadFile(`${safeName}.json`, JSON.stringify(payload, null, 2), "application/json");
    showToast(`Exported "${name}" as JSON`);
  }

  function exportCurrentListAsM3U8(list, name) {
    var lines = ["#EXTM3U", `#PLAYLIST:${name || "Daddy's Music Playlist"}`];
    list.forEach(function (t) {
      var dur = t.dur || t.duration || -1;
      var metaJson = JSON.stringify({
        id: t.id,
        title: t.title,
        artist: t.artist,
        album: t.album || "Single",
        thumbnail: t.thumbnail || "",
        dur: dur,
        queryTarget: t.queryTarget || `${t.artist} - ${t.title}`
      });
      lines.push(`#EXTPHANTOM:${metaJson}`);
      lines.push(`#EXTINF:${dur},${t.artist} - ${t.title}`);
      lines.push(`${API_BASE}/stream?id=${encodeURIComponent(t.id)}&q=${encodeURIComponent(t.queryTarget || (t.artist + " - " + t.title))}`);
    });
    var safeName = (name || "playlist").replace(/[^a-z0-9_\-]+/gi, "_").toLowerCase();
    downloadFile(`${safeName}.m3u8`, lines.join("\n"), "audio/x-mpegurl");
    showToast(`Exported "${name}" as M3U8`);
  }

  function importPlaylistFromFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (ev) {
      try {
        var text = String(ev.target.result || "").trim();
        var plName = file.name.replace(/\.(json|m3u8?)$/i, "");
        var importedTracks = [];

        if (file.name.toLowerCase().endsWith(".json") || text.startsWith("{") || text.startsWith("[")) {
          var parsed = JSON.parse(text);
          if (Array.isArray(parsed)) {
            importedTracks = parsed;
          } else if (parsed && Array.isArray(parsed.tracks)) {
            plName = parsed.name || plName;
            importedTracks = parsed.tracks;
          }
        } else {
          // Parse .m3u / .m3u8
          var lines = text.split(/\r?\n/);
          var pendingPhantom = null;
          var pendingInf = null;

          lines.forEach(function (line) {
            line = line.trim();
            if (!line) return;
            if (line.startsWith("#PLAYLIST:")) {
              plName = line.slice(10).trim() || plName;
            } else if (line.startsWith("#EXTPHANTOM:")) {
              try {
                pendingPhantom = JSON.parse(line.slice(12));
              } catch (e) {}
            } else if (line.startsWith("#EXTINF:")) {
              var parts = line.slice(8).split(",");
              var dur = parseInt(parts[0], 10) || 0;
              var info = parts.slice(1).join(",").trim();
              var dash = info.split(" - ");
              pendingInf = {
                dur: Math.max(0, dur),
                artist: dash.length > 1 ? dash[0].trim() : "Unknown Artist",
                title: dash.length > 1 ? dash.slice(1).join(" - ").trim() : info
              };
            } else if (!line.startsWith("#")) {
              if (pendingPhantom && pendingPhantom.id) {
                importedTracks.push(pendingPhantom);
              } else if (pendingInf) {
                var idMatch = line.match(/[?&]id=([^&]+)/);
                var synthId = idMatch ? decodeURIComponent(idMatch[1]) : "imp_" + Math.random().toString(36).slice(2, 10);
                importedTracks.push({
                  id: synthId,
                  title: pendingInf.title,
                  artist: pendingInf.artist,
                  album: "Imported",
                  thumbnail: "",
                  dur: pendingInf.dur,
                  duration: pendingInf.dur,
                  queryTarget: `${pendingInf.artist} - ${pendingInf.title}`
                });
              }
              pendingPhantom = null;
              pendingInf = null;
            }
          });
        }

        if (!importedTracks.length) {
          showToast("No valid tracks found in file.");
          return;
        }

        var trackIds = [];
        importedTracks.forEach(function (t) {
          if (t && t.id) {
            registerTrack(t, true);
            trackIds.push(String(t.id));
          }
        });
        persistTrackMap();

        var newPl = {
          id: "pl_" + Date.now(),
          name: (plName || "Imported Playlist").slice(0, 50),
          trackIds: trackIds
        };
        state.playlists.push(newPl);
        saveJSON("daddy_playlists", state.playlists);
        syncToServer();
        renderPlaylists();
        setView({ type: "playlist", id: newPl.id });
        showToast(`Imported "${newPl.name}" (${trackIds.length} tracks)`);
      } catch (err) {
        console.error("Import error:", err);
        showToast("Failed to parse playlist file.");
      }
    };
    reader.readAsText(file);
  }

  function updateViewActions(list) {
    var isBrowseHistory = state.view.type === "browse" && !state.searchQuery && list.length > 0;
    var isPlaylistView = state.view.type === "playlist";
    var isQueueView = state.view.type === "queue";
    var isSavedList =
      (state.view.type === "favorites" ||
        state.view.type === "playlist" ||
        state.view.type === "queue" ||
        state.view.type.startsWith("smart-")) &&
      list.length > 0;

    if (isBrowseHistory || isSavedList || isPlaylistView || isQueueView) {
      viewActionsContainer.innerHTML = "";
      viewActionsContainer.style.display = "flex";

      if (list.length > 0) {
        var playAllBtn = document.createElement("button");
        playAllBtn.type = "button";
        playAllBtn.className = "action-btn play-all";
        playAllBtn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          <span>Play All</span>
        `;
        playAllBtn.onclick = function (e) {
          e.preventDefault();
          e.stopPropagation();
          if (!list.length) return;
          state.playbackContext = isPlaylistView
            ? { type: "playlist", id: state.view.id }
            : { type: "auto", id: null };
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
        shufflePlayBtn.onclick = function (e) {
          e.preventDefault();
          e.stopPropagation();
          if (!list.length) return;
          state.playbackContext = isPlaylistView
            ? { type: "playlist", id: state.view.id }
            : { type: "auto", id: null };
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
      }

      if (isPlaylistView) {
        var currentPl = state.playlists.find((p) => p.id === state.view.id);
        if (currentPl) {
          var renamePlBtn = document.createElement("button");
          renamePlBtn.type = "button";
          renamePlBtn.className = "action-btn shuffle-play";
          renamePlBtn.innerHTML = `
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            <span>Rename</span>
          `;
          renamePlBtn.onclick = function (e) {
            e.preventDefault();
            e.stopPropagation();
            openRenamePlaylistModal(currentPl);
          };
          viewActionsContainer.appendChild(renamePlBtn);
        }
      }

      if (isBrowseHistory) {
        var clearBtn = document.createElement("button");
        clearBtn.type = "button";
        clearBtn.className = "action-btn";
        clearBtn.style.background = "rgba(239, 68, 68, 0.12)";
        clearBtn.style.color = "#ef4444";
        clearBtn.style.border = "1px solid rgba(239, 68, 68, 0.25)";
        clearBtn.innerHTML = `
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          <span>Clear All</span>
        `;
        clearBtn.onclick = function (e) {
          e.preventDefault();
          e.stopPropagation();
          state.history = [];
          saveJSON("daddy_history", []);
          renderTracks();
        };
        viewActionsContainer.appendChild(clearBtn);
      }

      if (isQueueView && list.length > 0) {
        var clearQBtn = document.createElement("button");
        clearQBtn.type = "button";
        clearQBtn.className = "action-btn";
        clearQBtn.style.background = "rgba(239, 68, 68, 0.12)";
        clearQBtn.style.color = "#ef4444";
        clearQBtn.style.border = "1px solid rgba(239, 68, 68, 0.25)";
        clearQBtn.innerHTML = `
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          <span>Clear Queue</span>
        `;
        clearQBtn.onclick = function (e) {
          e.preventDefault();
          e.stopPropagation();
          state.queue = [];
          renderQueue();
          renderTracks();
          broadcastRoomUpdate();
          showToast("Queue cleared");
        };
        viewActionsContainer.appendChild(clearQBtn);
      }
    } else {
      viewActionsContainer.style.display = "none";
      viewActionsContainer.innerHTML = "";
    }
  }

  function removeTrackFromHistory(trackId) {
    state.history = state.history.filter((t) => String(t.id) !== String(trackId));
    saveJSON("daddy_history", state.history);
    renderTracks();
  }

  // ---------- Drag-and-Drop Reordering State ----------
  var draggedPlaylistIdx = null;
  var draggedQueueIdx = null;

  function renderTracks() {
    closeDropdown();
    var list = currentList();
    updateViewActions(list);
    trackContainer.innerHTML = "";

    var isBrowseHistory = state.view.type === "browse" && !state.searchQuery;
    var isPlaylistReorderable = state.view.type === "playlist" && !state.searchQuery;

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
      var isCurrent = state.currentTrack && String(state.currentTrack.id) === String(t.id);
      var row = document.createElement("div");
      row.className = "track-row" + (isCurrent ? " playing" : "");
      row.tabIndex = 0;

      var idx = document.createElement("div");
      idx.className = "idx";
      if (isPlaylistReorderable) {
        var handle = document.createElement("span");
        handle.className = "drag-handle";
        handle.textContent = "⋮⋮";
        handle.title = "Drag to reorder";
        idx.appendChild(handle);

        row.draggable = true;
        row.addEventListener("dragstart", function (e) {
          draggedPlaylistIdx = i;
          row.classList.add("dragging");
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        });
        row.addEventListener("dragover", function (e) {
          e.preventDefault();
          row.classList.add("drag-over");
        });
        row.addEventListener("dragleave", function () {
          row.classList.remove("drag-over");
        });
        row.addEventListener("drop", function (e) {
          e.preventDefault();
          e.stopPropagation();
          row.classList.remove("drag-over");
          if (draggedPlaylistIdx === null || draggedPlaylistIdx === i) return;
          var pl = state.playlists.find((p) => p.id === state.view.id);
          if (pl && Array.isArray(pl.trackIds)) {
            var moved = pl.trackIds.splice(draggedPlaylistIdx, 1)[0];
            pl.trackIds.splice(i, 0, moved);
            saveJSON("daddy_playlists", state.playlists);
            syncToServer();
            renderTracks();
          }
          draggedPlaylistIdx = null;
        });
        row.addEventListener("dragend", function () {
          row.classList.remove("dragging");
          draggedPlaylistIdx = null;
        });
      }

      var numSpan = document.createElement("span");
      numSpan.textContent = isCurrent && state.isPlaying ? "♪" : i + 1;
      idx.appendChild(numSpan);

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
      if (state.view.type === "smart-top") {
        var plays = state.playCounts[String(t.id)] || 1;
        var badge = document.createElement("span");
        badge.className = "play-count-badge";
        badge.textContent = `${plays} play${plays === 1 ? "" : "s"}`;
        album.appendChild(badge);
      }

      var actions = document.createElement("div");
      actions.className = "t-actions";

      var favBtn = document.createElement("button");
      favBtn.type = "button";
      favBtn.className = "icon-btn fav" + (state.favorites.map(String).includes(String(t.id)) ? " active" : "");
      favBtn.setAttribute("aria-label", "Favorite");
      favBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20s-7-4.4-9.5-9A5.5 5.5 0 0112 5.5 5.5 5.5 0 0121.5 11c-2.5 4.6-9.5 9-9.5 9z"/></svg>';
      favBtn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        closeDropdown();
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
          closeDropdown();
          removeTrackFromPlaylist(t.id, state.view.id);
        });

        actions.appendChild(removeBtn);
      }

      if (isBrowseHistory) {
        var removeHistBtn = document.createElement("button");
        removeHistBtn.type = "button";
        removeHistBtn.className = "icon-btn remove-track";
        removeHistBtn.title = "Remove from history";
        removeHistBtn.setAttribute("aria-label", "Remove from history");
        removeHistBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 6L6 18M6 6l12 12"/></svg>';

        removeHistBtn.addEventListener("click", function (e) {
          e.preventDefault();
          e.stopPropagation();
          closeDropdown();
          removeTrackFromHistory(t.id);
        });

        actions.appendChild(removeHistBtn);
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

      row.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        closeDropdown();
        if (state.view.type === "playlist" && state.view.id) {
          state.playbackContext = { type: "playlist", id: state.view.id };
          var remaining = list.slice(i + 1).concat(list.slice(0, i));
          state.queue = remaining;
          renderQueue();
        } else {
          state.playbackContext = { type: "auto", id: null };
        }
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
      row.draggable = true;

      row.innerHTML = `
        <span class="drag-handle" title="Drag to reorder">⋮⋮</span>
        <img class="cover" src="${t.thumbnail || ''}" alt="" />
        <div class="t-meta" style="flex:1;min-width:0">
          <div class="t-title">${escapeHtml(t.title)}</div>
          <div class="t-artist">${escapeHtml(t.artist)}</div>
        </div>
      `;

      row.addEventListener("dragstart", function (e) {
        draggedQueueIdx = i;
        row.classList.add("dragging");
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      });
      row.addEventListener("dragover", function (e) {
        e.preventDefault();
        row.classList.add("drag-over");
      });
      row.addEventListener("dragleave", function () {
        row.classList.remove("drag-over");
      });
      row.addEventListener("drop", function (e) {
        e.preventDefault();
        e.stopPropagation();
        row.classList.remove("drag-over");
        if (draggedQueueIdx === null || draggedQueueIdx === i) return;
        var moved = state.queue.splice(draggedQueueIdx, 1)[0];
        state.queue.splice(i, 0, moved);
        draggedQueueIdx = null;
        renderQueue();
        prefetchNextTrack();
        broadcastRoomUpdate();
      });
      row.addEventListener("dragend", function () {
        row.classList.remove("dragging");
        draggedQueueIdx = null;
      });

      var rm = document.createElement("button");
      rm.type = "button";
      rm.className = "icon-btn q-remove";
      rm.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>';
      rm.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        state.queue.splice(i, 1);
        renderQueue();
        broadcastRoomUpdate();
      });

      row.appendChild(rm);
      row.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        state.queue.splice(i, 1);
        renderQueue();
        playTrack(t);
      });

      queueContainer.appendChild(row);
    });
  }

  function renderPlaylists() {
    playlistList.innerHTML = "";
    state.playlists.forEach(function (p) {
      var row = document.createElement("div");
      var isActive = state.view.type === "playlist" && state.view.id === p.id;
      row.className = "playlist-row" + (isActive ? " active" : "");
      row.setAttribute("data-playlist-id", p.id);

      var titleSpan = document.createElement("span");
      titleSpan.textContent = p.name;
      titleSpan.style.flex = "1";
      titleSpan.style.overflow = "hidden";
      titleSpan.style.textOverflow = "ellipsis";
      titleSpan.style.whiteSpace = "nowrap";

      row.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        setView({ type: "playlist", id: p.id });
      });

      var actWrap = document.createElement("div");
      actWrap.className = "pl-actions";

      var editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "pl-edit";
      editBtn.title = "Rename Playlist";
      editBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
      editBtn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        openRenamePlaylistModal(p);
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

      actWrap.appendChild(editBtn);
      actWrap.appendChild(delBtn);

      row.appendChild(titleSpan);
      row.appendChild(actWrap);
      playlistList.appendChild(row);
    });
  }

  function updateNavHighlight() {
    document.querySelectorAll(".nav-item").forEach(function (el) {
      var dv = el.getAttribute("data-view");
      el.classList.toggle("active", dv === state.view.type);
    });
    document.querySelectorAll(".playlist-row").forEach(function (el) {
      var pid = el.getAttribute("data-playlist-id");
      el.classList.toggle("active", state.view.type === "playlist" && pid === state.view.id);
    });
  }

  function setView(v) {
    state.view = v;
    saveSessionView(v);
    updateNavHighlight();
    renderTracks();
  }

  function toggleFavorite(track, btnEl) {
    registerTrack(track);
    var strId = String(track.id);
    var i = state.favorites.map(String).indexOf(strId);
    var isNowFav = false;

    if (i === -1) {
      state.favorites.push(strId);
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

    if (state.view.type === "favorites" || state.view.type === "smart-forgotten") {
      renderTracks();
    }

    updateNowFav();
    updatePiPWindow();
  }

  function addToQueue(track) {
    registerTrack(track);
    state.queue.push(track);
    renderQueue();
    broadcastRoomUpdate();
    showToast(`Added "${track.title}" to queue`);
  }

  // ---------- Playback Engine, Gapless Crossfade & Speed Control ----------
  var isCrossfading = false;
  var prefetchedForTrackId = null;
  var videoSyncTimer = null;
  var musicVideoEl = document.getElementById("musicVideoEl");

  function applySpeedToAudio(el) {
    if (!el) return;
    el.playbackRate = state.playbackRate || 1.0;
    if ("preservesPitch" in el) el.preservesPitch = true;
    if ("mozPreservesPitch" in el) el.mozPreservesPitch = true;
    if ("webkitPreservesPitch" in el) el.webkitPreservesPitch = true;
    if (musicVideoEl && el === audioEngine) {
      musicVideoEl.playbackRate = state.playbackRate || 1.0;
    }
  }

  function prefetchNextTrack() {
    if (state.queue && state.queue.length > 0) {
      const next = state.queue[0];
      if (prefetchedForTrackId === String(next.id)) return;
      prefetchedForTrackId = String(next.id);
      const target = next.queryTarget || `${next.artist} - ${next.title}`;
      fetch(`${API_BASE}/prefetch?id=${encodeURIComponent(next.id)}&q=${encodeURIComponent(target)}`).catch(() => {});
    }
  }

  // ---------- YouTube Music Video Modal & Last Played Restoration ----------
  var videoModal = document.getElementById("videoModal");
  var videoModalTitle = document.getElementById("videoModalTitle");
  var videoModalArtist = document.getElementById("videoModalArtist");
  var videoLoadingOverlay = document.getElementById("videoLoadingOverlay");
  var videoToggleBtn = document.getElementById("videoToggleBtn");
  var videoDockBtn = document.getElementById("videoDockBtn");
  var videoFullscreenBtn = document.getElementById("videoFullscreenBtn");
  var closeVideoModalBtn = document.getElementById("closeVideoModalBtn");
  var nowTrackClickArea = document.getElementById("nowTrackClickArea");
  var videoStage = document.getElementById("videoStage");

  // ---------- Unified YouTube Engine (Audio & Synced Video) ----------
  var ytPlayer = null;
  var isYtReady = false;
  var pendingTrackId = null;
  var pendingPlay = false;
  var playKickerTimer = null;

  function stopPlayKicker() {
    if (playKickerTimer) {
      clearInterval(playKickerTimer);
      playKickerTimer = null;
    }
  }

  function startPlayKicker() {
    stopPlayKicker();
    var attempts = 0;
    playKickerTimer = setInterval(function () {
      attempts++;
      if (!state.isPlaying || attempts > 25) {
        stopPlayKicker();
        return;
      }
      if (ytPlayer && typeof ytPlayer.getPlayerState === "function") {
        try {
          var s = ytPlayer.getPlayerState();
          if (s === 1) { // PLAYING!
            stopPlayKicker();
            return;
          }
          if (typeof ytPlayer.unMute === "function") {
            ytPlayer.unMute();
          }
          if (typeof ytPlayer.playVideo === "function") {
            ytPlayer.playVideo();
          }
        } catch (e) {}
      }
    }, 200);
  }

  function initYtPlayer() {
    if (ytPlayer || !window.YT || !window.YT.Player) return;
    var container = document.getElementById("ytPlayerContainer");
    if (!container) return;

    try {
      ytPlayer = new YT.Player("ytPlayerContainer", {
        height: "100%",
        width: "100%",
        host: "https://www.youtube.com",
        playerVars: {
          autoplay: 1,
          controls: 1,
          disablekb: 0,
          fs: 1,
          iv_load_policy: 3,
          cc_load_policy: 0,
          modestbranding: 1,
          playsinline: 1,
          rel: 0,
          enablejsapi: 1,
          origin: window.location.origin
        },
        events: {
          onReady: function () {
            isYtReady = true;
            try {
              var iframe = ytPlayer.getIframe ? ytPlayer.getIframe() : document.getElementById("ytPlayerContainer");
              if (iframe) {
                iframe.setAttribute("allow", "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share");
                iframe.setAttribute("playsinline", "1");
              }
            } catch (e) {}

            var savedVol = parseFloat(localStorage.getItem("phantom_volume") || "0.8");
            setPlayerVolume(savedVol);
            if (state.playbackRate && state.playbackRate !== 1.0) {
              applySpeedToPlayer(state.playbackRate);
            }
            if (pendingTrackId) {
              var tid = pendingTrackId;
              var shouldPlay = pendingPlay;
              pendingTrackId = null;
              pendingPlay = false;
              ytPlayer.loadVideoById({
                videoId: tid,
                startSeconds: 0
              });
              if (shouldPlay) {
                try {
                  ytPlayer.unMute();
                  ytPlayer.playVideo();
                } catch (e) {}
                startPlayKicker();
              }
            }
          },
          onStateChange: function (event) {
            // YT.PlayerState: -1 (UNSTARTED), 0 (ENDED), 1 (PLAYING), 2 (PAUSED), 3 (BUFFERING), 5 (CUED)
            if (event.data === 1) { // PLAYING
              stopPlayKicker();
              state.isPlaying = true;
              if (videoLoadingOverlay) videoLoadingOverlay.classList.add("hidden");
              updatePlayerUI();
              updatePiPWindow();
              broadcastRoomUpdate();
            } else if (event.data === 5) { // CUED (Crucial for mobile initial playback!)
              if (state.isPlaying && ytPlayer && typeof ytPlayer.playVideo === "function") {
                try {
                  ytPlayer.unMute();
                  ytPlayer.playVideo();
                } catch (e) {}
              }
            } else if (event.data === -1) { // UNSTARTED
              if (state.isPlaying && ytPlayer && typeof ytPlayer.playVideo === "function") {
                try {
                  ytPlayer.unMute();
                  ytPlayer.playVideo();
                } catch (e) {}
              }
            } else if (event.data === 2) { // PAUSED
              state.isPlaying = false;
              updatePlayerUI();
              updatePiPWindow();
              broadcastRoomUpdate();
            } else if (event.data === 0) { // ENDED
              stopPlayKicker();
              if (state.sleepTimer.mode === "eot") {
                clearSleepTimer();
                state.isPlaying = false;
                updatePlayerUI();
                showToast("Sleep Timer: Paused at end of track");
                return;
              }
              if (state.repeat) {
                ytPlayer.seekTo(0, true);
                ytPlayer.playVideo();
              } else {
                playNext();
              }
            }
          },
          onError: function (event) {
            console.warn("YouTube player error:", event.data);
            if (event.data === 101 || event.data === 150 || event.data === 100 || event.data === 2) {
              showToast("Track unavailable, auto-advancing to next song...");
              setTimeout(function () {
                playNext();
              }, 800);
            }
          }
        }
      });
    } catch (e) {
      console.error("Failed to initialize YouTube player:", e);
    }
  }

  window.onYouTubeIframeAPIReady = function () {
    initYtPlayer();
  };
  if (window.YT && window.YT.Player) {
    initYtPlayer();
  }

  function getPlayerCurrentTime() {
    if (ytPlayer && typeof ytPlayer.getCurrentTime === "function") {
      try {
        return ytPlayer.getCurrentTime() || 0;
      } catch (e) {}
    }
    return 0;
  }

  function getPlayerDuration() {
    if (ytPlayer && typeof ytPlayer.getDuration === "function") {
      try {
        var d = ytPlayer.getDuration();
        if (d && isFinite(d) && d > 0) return d;
      } catch (e) {}
    }
    return (state.currentTrack && (state.currentTrack.dur || state.currentTrack.duration)) || 0;
  }

  function seekPlayerTo(seconds) {
    var dur = getPlayerDuration();
    var target = Math.max(0, Math.min(seconds, dur || 99999));
    if (ytPlayer && typeof ytPlayer.seekTo === "function") {
      try {
        ytPlayer.seekTo(target, true);
      } catch (e) {}
    }
    if (dur > 0) {
      seekFill.style.width = Math.min(100, (target / dur) * 100) + "%";
    }
    curTime.textContent = fmtTime(target);
  }

  function setPlayerVolume(vol) {
    vol = Math.max(0, Math.min(1, vol));
    state.volume = vol;
    localStorage.setItem("phantom_volume", vol);
    if (volSlider) volSlider.value = Math.round(vol * 100);
    if (ytPlayer && typeof ytPlayer.setVolume === "function") {
      try {
        ytPlayer.setVolume(Math.round(vol * 100));
        if (vol > 0 && ytPlayer.isMuted && ytPlayer.isMuted()) {
          ytPlayer.unMute();
        }
      } catch (e) {}
    }
  }

  function applySpeedToPlayer(speed) {
    state.playbackRate = speed;
    localStorage.setItem("phantom_speed", speed);
    if (ytPlayer && typeof ytPlayer.setPlaybackRate === "function") {
      try {
        ytPlayer.setPlaybackRate(speed);
      } catch (e) {}
    }
  }

  function openVideoModal() {
    if (!videoModal) return;
    videoModal.classList.remove("hidden");
    if (videoToggleBtn) videoToggleBtn.classList.add("active");
    if (videoModalTitle && state.currentTrack) videoModalTitle.textContent = state.currentTrack.title;
    if (videoModalArtist && state.currentTrack) videoModalArtist.textContent = state.currentTrack.artist;
  }

  function closeVideoModal() {
    if (!videoModal) return;
    videoModal.classList.add("hidden");
    if (videoToggleBtn) videoToggleBtn.classList.remove("active");
  }

  function toggleVideoModal() {
    if (!videoModal) return;
    if (videoModal.classList.contains("hidden")) {
      openVideoModal();
    } else {
      closeVideoModal();
    }
  }
  window.toggleVideoModal = toggleVideoModal;

  function findBestFallbackLastTrack() {
    var saved = loadJSON("daddy_last_track", null);
    if (saved && saved.id && saved.title) return saved;
    if (Array.isArray(state.history) && state.history.length > 0 && state.history[0].id) {
      return state.history[0];
    }
    var bestId = null;
    var bestTime = -1;
    Object.keys(state.lastPlayedAt || {}).forEach(function (tid) {
      var ts = state.lastPlayedAt[tid] || 0;
      if (ts > bestTime && TRACK_MAP.has(String(tid))) {
        bestTime = ts;
        bestId = String(tid);
      }
    });
    if (bestId) return TRACK_MAP.get(bestId);
    if (Array.isArray(state.favorites) && state.favorites.length > 0) {
      var favTrack = TRACK_MAP.get(String(state.favorites[0]));
      if (favTrack) return favTrack;
    }
    return null;
  }

  function restoreLastPlayedTrack(explicitTrack) {
    if (state.currentTrack && state.isPlaying) return;
    var track = explicitTrack || findBestFallbackLastTrack();
    if (!track || !track.id) return;

    registerTrack(track);
    saveJSON("daddy_last_track", track);
    state.currentTrack = track;
    state.isPlaying = false;

    nowTitle.textContent = track.title;
    nowArtist.textContent = track.artist;
    nowCover.src = track.thumbnail || "";
    nowCover.style.display = "block";
    curTime.textContent = "0:00";

    var trackDur = track.dur || track.duration || 0;
    durTime.textContent = fmtTime(trackDur);
    seekFill.style.width = "0%";

    if (videoModalTitle) videoModalTitle.textContent = track.title;
    if (videoModalArtist) videoModalArtist.textContent = track.artist;
    if (musicVideoEl) {
      musicVideoEl.poster = track.thumbnail || "";
    }

    updatePlayerUI();
    updateMediaSessionMetadata(track);
    loadLyrics(track.title, track.artist, trackDur);
    renderTracks();
  }

  function recordTrackPlay(track) {
    var tid = String(track.id);
    state.playCounts[tid] = (state.playCounts[tid] || 0) + 1;
    state.lastPlayedAt[tid] = Date.now();
    state.sessionPlayedIds = (state.sessionPlayedIds || []).filter(function (id) {
      return id !== tid;
    });
    state.sessionPlayedIds.unshift(tid);
    if (state.sessionPlayedIds.length > 35) {
      state.sessionPlayedIds.pop();
    }
    saveJSON("daddy_play_counts", state.playCounts);
    saveJSON("daddy_last_played", state.lastPlayedAt);
    saveJSON("daddy_last_track", track);
    syncToServer();
  }

  function playTrack(track, fromCrossfade, skipRoomBroadcast) {
    if (!track || !track.id) return;

    state.history = state.history.filter((t) => String(t.id) !== String(track.id));
    state.history.unshift(track);
    if (state.history.length > 50) state.history.pop();
    saveJSON("daddy_history", state.history);
    saveJSON("daddy_last_track", track);

    registerTrack(track);
    state.currentTrack = track;
    recordTrackPlay(track);

    nowTitle.textContent = track.title;
    nowArtist.textContent = track.artist;
    nowCover.src = track.thumbnail || "";
    nowCover.style.display = "block";
    curTime.textContent = "0:00";

    if (videoModalTitle) videoModalTitle.textContent = track.title;
    if (videoModalArtist) videoModalArtist.textContent = track.artist;

    var trackDur = track.dur || track.duration || 0;
    durTime.textContent = fmtTime(trackDur);
    seekFill.style.width = "0%";
    state.isPlaying = true;
    updatePlayerUI();
    updateMediaSessionMetadata(track);
    updatePiPWindow();
    renderTracks();

    loadLyrics(track.title, track.artist, trackDur);

    var vid = String(track.id);
    if (ytPlayer && isYtReady && typeof ytPlayer.loadVideoById === "function") {
      try {
        if (typeof ytPlayer.unMute === "function") {
          ytPlayer.unMute();
        }
        ytPlayer.loadVideoById({
          videoId: vid,
          startSeconds: 0
        });
        ytPlayer.playVideo();
        startPlayKicker();
        if (state.playbackRate && state.playbackRate !== 1.0) {
          applySpeedToPlayer(state.playbackRate);
        }
      } catch (e) {
        console.error("Error loading video in ytPlayer:", e);
      }
    } else {
      pendingTrackId = vid;
      pendingPlay = true;
      initYtPlayer();
    }

    if (!skipRoomBroadcast) {
      broadcastRoomUpdate();
    }
  }

  function triggerCrossfadeToNext() {
    if (state.sleepTimer.mode === "eot") {
      clearSleepTimer();
      if (ytPlayer && typeof ytPlayer.pauseVideo === "function") ytPlayer.pauseVideo();
      state.isPlaying = false;
      updatePlayerUI();
      showToast("Sleep Timer: Paused at end of track");
      return;
    }
    if (state.repeat && state.currentTrack) {
      playTrack(state.currentTrack, true);
    } else {
      playNext(true);
    }
  }

  function updatePlayerUI() {
    playIcon.outerHTML = state.isPlaying
      ? '<svg id="playIcon" width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>'
      : '<svg id="playIcon" width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    playIcon = document.getElementById("playIcon");
    updateNowFav();
    updatePiPWindow();
  }

  function updateNowFav() {
    var active = state.currentTrack && state.favorites.map(String).includes(String(state.currentTrack.id));
    nowFav.classList.toggle("active", !!active);
  }

  async function fetchAutoRecommendation(track, fromCrossfade) {
    if (!track) return;
    var excludeIds = (state.sessionPlayedIds || []).slice(0, 30);
    if (excludeIds.indexOf(String(track.id)) === -1) {
      excludeIds.unshift(String(track.id));
    }

    try {
      var recUrl =
        `${API_BASE}/recommend?id=${encodeURIComponent(track.id)}` +
        `&title=${encodeURIComponent(track.title || "")}` +
        `&artist=${encodeURIComponent(track.artist || "")}` +
        `&genre=${encodeURIComponent(track.genre || "")}` +
        `&exclude=${encodeURIComponent(excludeIds.join(","))}`;

      var res = await fetch(recUrl);
      if (res.ok) {
        var data = await res.json();
        var list = (data && Array.isArray(data.tracks)) ? data.tracks : [];

        // If all candidates in this genre were recently played, clear session history and retry so autoplay never stops
        if (list.length === 0 && excludeIds.length > 1) {
          state.sessionPlayedIds = [String(track.id)];
          var retryRes = await fetch(
            `${API_BASE}/recommend?id=${encodeURIComponent(track.id)}` +
            `&title=${encodeURIComponent(track.title || "")}` +
            `&artist=${encodeURIComponent(track.artist || "")}` +
            `&genre=${encodeURIComponent(track.genre || "")}` +
            `&exclude=${encodeURIComponent(track.id)}`
          );
          if (retryRes.ok) {
            data = await retryRes.json();
            list = (data && Array.isArray(data.tracks)) ? data.tracks : [];
          }
        }

        if (data && data.genre && !track.genre) {
          track.genre = data.genre;
          registerTrack(track);
        }

        if (list.length > 0) {
          list.forEach(function (t) {
            registerTrack(t, true);
          });
          persistTrackMap();
          var candidate = list[0];
          showToast(`Autoplay (${(data && data.genre) || candidate.genre || "Similar Genre"}): ${candidate.title}`);
          playTrack(candidate, fromCrossfade);
          return;
        }
      }
    } catch (e) {
      console.warn("Genre recommendation error, trying fallback:", e);
    }

    // Fallback: search by genre or artist, then local TRACK_MAP so playback never stops
    try {
      var fbTerm = track.genre ? `${track.genre} hits` : track.artist;
      var fbRes = await fetch(`${API_BASE}/search?q=${encodeURIComponent(fbTerm)}`);
      if (fbRes.ok) {
        var fbList = await fbRes.json();
        if (Array.isArray(fbList) && fbList.length > 0) {
          var fbCandidate =
            fbList.find((t) => excludeIds.indexOf(String(t.id)) === -1) ||
            fbList.find((t) => String(t.id) !== String(track.id)) ||
            fbList[0];
          if (fbCandidate) {
            playTrack(fbCandidate, fromCrossfade);
            return;
          }
        }
      }
    } catch (e2) {}

    var localPool = [];
    TRACK_MAP.forEach(function (t) {
      if (String(t.id) !== String(track.id)) localPool.push(t);
    });
    if (localPool.length > 0) {
      var pick = localPool[Math.floor(Math.random() * localPool.length)];
      playTrack(pick, fromCrossfade);
    }
  }

  function getActivePlaylistTracks() {
    if (!state.playbackContext || state.playbackContext.type !== "playlist" || !state.playbackContext.id) {
      return [];
    }
    var pl = state.playlists.find(function (p) {
      return p.id === state.playbackContext.id;
    });
    if (!pl || !Array.isArray(pl.trackIds)) return [];
    return pl.trackIds
      .map(function (id) {
        return TRACK_MAP.get(String(id));
      })
      .filter(Boolean);
  }

  function playNext(fromCrossfade) {
    if (state.sleepTimer.mode === "eot") {
      clearSleepTimer();
      if (ytPlayer && typeof ytPlayer.pauseVideo === "function") ytPlayer.pauseVideo();
      state.isPlaying = false;
      updatePlayerUI();
      showToast("Sleep Timer: Playback stopped");
      return;
    }

    var plTracks = getActivePlaylistTracks();
    if (state.queue.length === 0 && plTracks.length > 0) {
      state.queue = plTracks.slice();
    }

    if (state.queue.length > 0) {
      var nextTrack;
      if (state.shuffle) {
        var pickIdx = Math.floor(Math.random() * state.queue.length);
        if (state.queue.length > 1 && state.currentTrack && String(state.queue[pickIdx].id) === String(state.currentTrack.id)) {
          pickIdx = (pickIdx + 1) % state.queue.length;
        }
        nextTrack = state.queue.splice(pickIdx, 1)[0];
      } else {
        nextTrack = state.queue.shift();
      }

      // If this was the last song in an active playlist, immediately refill the queue so the playlist loops forever
      if (state.queue.length === 0 && plTracks.length > 0) {
        state.queue = plTracks.slice();
      }

      renderQueue();
      playTrack(nextTrack, fromCrossfade);
    } else if (state.currentTrack) {
      fetchAutoRecommendation(state.currentTrack, fromCrossfade);
    } else {
      if (ytPlayer && typeof ytPlayer.pauseVideo === "function") ytPlayer.pauseVideo();
      state.isPlaying = false;
      updatePlayerUI();
      renderTracks();
    }
  }

  function playPrev() {
    var cur = getPlayerCurrentTime();
    if (cur > 3) {
      seekPlayerTo(0);
      return;
    }

    if (state.history.length > 1) {
      var prevTrack = state.history[1];
      if (state.currentTrack) {
        state.queue.unshift(state.currentTrack);
        renderQueue();
      }
      playTrack(prevTrack);
    } else {
      seekPlayerTo(0);
    }
  }

  // ---------- Playback Speed Control (Pitch-Preserved) ----------
  var SPEED_STEPS = [0.75, 1.0, 1.25, 1.5, 2.0];
  var speedBtn = document.getElementById("speedBtn");

  function updateSpeedUI() {
    if (!speedBtn) return;
    speedBtn.textContent = state.playbackRate + "×";
    speedBtn.classList.toggle("active", state.playbackRate !== 1.0);
    applySpeedToPlayer(state.playbackRate);
  }

  if (speedBtn) {
    speedBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      var idx = SPEED_STEPS.indexOf(state.playbackRate);
      var nextIdx = (idx + 1) % SPEED_STEPS.length;
      state.playbackRate = SPEED_STEPS[nextIdx];
      localStorage.setItem("phantom_speed", state.playbackRate);
      updateSpeedUI();
      showToast(`Playback speed: ${state.playbackRate}× (Pitch Preserved)`);
    });
  }

  // ---------- Sleep Timer ----------
  var sleepTimerBtn = document.getElementById("sleepTimerBtn");
  var sleepTimerMenu = document.getElementById("sleepTimerMenu");
  var sleepTimerBadge = document.getElementById("sleepTimerBadge");

  function clearSleepTimer() {
    if (state.sleepTimer.intervalId) {
      clearInterval(state.sleepTimer.intervalId);
    }
    state.sleepTimer = { mode: null, endsAt: null, intervalId: null, fading: false };
    if (sleepTimerBadge) sleepTimerBadge.classList.add("hidden");
    if (sleepTimerBtn) sleepTimerBtn.classList.remove("active");
    document.querySelectorAll("#sleepTimerMenu .popover-option").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-sleep") === "0");
    });
  }

  function setSleepTimer(val) {
    clearSleepTimer();
    document.querySelectorAll("#sleepTimerMenu .popover-option").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-sleep") === String(val));
    });

    if (val === "0" || !val) {
      showToast("Sleep Timer turned off");
      return;
    }

    if (sleepTimerBtn) sleepTimerBtn.classList.add("active");

    if (val === "eot") {
      state.sleepTimer.mode = "eot";
      if (sleepTimerBadge) {
        sleepTimerBadge.textContent = "EOT";
        sleepTimerBadge.classList.remove("hidden");
      }
      showToast("Sleep Timer set to End of Track");
      return;
    }

    var mins = parseInt(val, 10);
    state.sleepTimer.mode = "countdown";
    state.sleepTimer.endsAt = Date.now() + mins * 60 * 1000;

    function tickSleep() {
      var remMs = state.sleepTimer.endsAt - Date.now();
      if (remMs <= 0) {
        var savedVol = parseFloat(localStorage.getItem("phantom_volume") || "0.8");
        clearSleepTimer();
        if (ytPlayer && typeof ytPlayer.pauseVideo === "function") ytPlayer.pauseVideo();
        state.isPlaying = false;
        setPlayerVolume(savedVol);
        updatePlayerUI();
        showToast("Sleep Timer expired — Goodnight!");
        return;
      }
      // Smoothly fade out audio volume during the last 5 seconds
      if (remMs <= 5000) {
        var baseVol = parseFloat(localStorage.getItem("phantom_volume") || "0.8");
        setPlayerVolume(Math.max(0.02, baseVol * (remMs / 5000)));
      }
      if (sleepTimerBadge) {
        var remMin = Math.ceil(remMs / 60000);
        sleepTimerBadge.textContent = remMin + "m";
        sleepTimerBadge.classList.remove("hidden");
      }
    }

    tickSleep();
    state.sleepTimer.intervalId = setInterval(tickSleep, 1000);
    showToast(`Sleep Timer set for ${mins} minutes`);
  }

  if (sleepTimerBtn && sleepTimerMenu) {
    sleepTimerBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      sleepTimerMenu.classList.toggle("hidden");
    });

    sleepTimerMenu.querySelectorAll(".popover-option").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        setSleepTimer(btn.getAttribute("data-sleep"));
        sleepTimerMenu.classList.add("hidden");
      });
    });
  }

  // ---------- Dropdown Logic ----------
  var editingPlaylistId = null;
  var playlistModalTitle = document.getElementById("playlistModalTitle");
  var playlistModalDesc = document.getElementById("playlistModalDesc");

  function openTrackDropdown(track, anchorBtn) {
    if (trackDropdown.style.display === "block" && activeDropdownBtn === anchorBtn) {
      closeDropdown();
      return;
    }
    activeDropdownTrack = track;
    activeDropdownBtn = anchorBtn;

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
        
        var alreadyIn = (pl.trackIds || []).map(String).includes(String(track.id));
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
    var rect = anchorBtn.getBoundingClientRect();
    var ddRect = trackDropdown.getBoundingClientRect();
    var ddWidth = ddRect.width || 200;
    var ddHeight = ddRect.height || 180;

    var top = rect.bottom + 6;
    if (rect.bottom + ddHeight + 12 > window.innerHeight) {
      top = Math.max(10, rect.top - ddHeight - 8);
    }
    var left = rect.left < 220 ? Math.max(10, rect.left) : Math.min(window.innerWidth - ddWidth - 12, rect.left - 140);
    trackDropdown.style.top = top + "px";
    trackDropdown.style.left = Math.max(10, left) + "px";
  }

  function closeDropdown() {
    if (trackDropdown) {
      trackDropdown.style.display = "none";
    }
    activeDropdownTrack = null;
    activeDropdownBtn = null;
  }

  function addTrackToPlaylist(track, playlistId) {
    registerTrack(track);
    var target = state.playlists.find((p) => p.id === playlistId);
    if (!target) return;

    if (!target.trackIds) target.trackIds = [];
    if (!target.trackIds.map(String).includes(String(track.id))) {
      target.trackIds.push(String(track.id));
      saveJSON("daddy_playlists", state.playlists);
      syncToServer();
      showToast(`Added to "${target.name}"`);

      if (state.view.type === "playlist" && state.view.id === playlistId) {
        renderTracks();
      }
    } else {
      showToast(`Already in "${target.name}"`);
    }
  }

  function removeTrackFromPlaylist(trackId, playlistId) {
    var target = state.playlists.find((p) => p.id === playlistId);
    if (!target || !target.trackIds) return;

    var index = target.trackIds.map(String).indexOf(String(trackId));
    if (index !== -1) {
      target.trackIds.splice(index, 1);
      saveJSON("daddy_playlists", state.playlists);
      syncToServer();
      renderTracks();
    }
  }

  function openNewPlaylistModal() {
    editingPlaylistId = null;
    if (playlistModalTitle) playlistModalTitle.textContent = "New Playlist";
    if (playlistModalDesc) playlistModalDesc.textContent = "Give your playlist a title to start adding tracks.";
    if (createModalBtn) createModalBtn.textContent = "Create";
    modalPlaylistInput.value = "";
    playlistModal.style.display = "flex";
    modalPlaylistInput.focus();
  }

  function openRenamePlaylistModal(pl) {
    if (!pl) return;
    editingPlaylistId = pl.id;
    if (playlistModalTitle) playlistModalTitle.textContent = "Rename Playlist";
    if (playlistModalDesc) playlistModalDesc.textContent = "Enter a new name for this playlist.";
    if (createModalBtn) createModalBtn.textContent = "Save";
    modalPlaylistInput.value = pl.name || "";
    playlistModal.style.display = "flex";
    modalPlaylistInput.focus();
    try {
      modalPlaylistInput.select();
    } catch (e) {}
  }

  function commitNewPlaylist() {
    var name = modalPlaylistInput.value.trim();
    if (!name) return;

    if (editingPlaylistId) {
      var targetPl = state.playlists.find((p) => p.id === editingPlaylistId);
      editingPlaylistId = null;
      if (targetPl) {
        targetPl.name = name.slice(0, 50);
        saveJSON("daddy_playlists", state.playlists);
        syncToServer();
        renderPlaylists();
        renderTracks();
        showToast(`Renamed playlist to "${targetPl.name}"`);
      }
      playlistModal.style.display = "none";
      return;
    }

    var pl = { id: "pl_" + Date.now(), name: name.slice(0, 50), trackIds: [] };
    state.playlists.push(pl);
    saveJSON("daddy_playlists", state.playlists);
    syncToServer();
    renderPlaylists();
    playlistModal.style.display = "none";
    setView({ type: "playlist", id: pl.id });
  }

  // ---------- YouTube Playback Progress & Sync Ticker ----------
  setInterval(function () {
    if (!ytPlayer || typeof ytPlayer.getCurrentTime !== "function") return;
    if (!state.isPlaying) return;

    var cur = getPlayerCurrentTime();
    var dur = getPlayerDuration();
    if (!dur || dur <= 0) return;

    curTime.textContent = fmtTime(cur);
    durTime.textContent = fmtTime(dur);
    seekFill.style.width = Math.min(100, (cur / dur) * 100) + "%";

    syncActiveLyricLine(cur);
    updatePiPProgress(cur, dur);

    // Auto recommendation prefetch near end of track
    if (dur > 20 && cur / dur > 0.7) {
      prefetchNextTrack();
    }

    // Sleep timer countdown
    if (state.sleepTimer && state.sleepTimer.mode === "countdown" && state.sleepTimer.endsAt) {
      var remMs = state.sleepTimer.endsAt - Date.now();
      if (remMs <= 0) {
        var savedVol = parseFloat(localStorage.getItem("phantom_volume") || "0.8");
        clearSleepTimer();
        if (ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo();
        state.isPlaying = false;
        setPlayerVolume(savedVol);
        updatePlayerUI();
        showToast("Sleep Timer expired — Goodnight!");
      } else if (remMs <= 5000) {
        var baseVol = parseFloat(localStorage.getItem("phantom_volume") || "0.8");
        setPlayerVolume(Math.max(0.02, baseVol * (remMs / 5000)));
      }
    }
  }, 250);

  function toggleCurrentTrackPlayPause() {
    if (!state.currentTrack) return;
    if (!ytPlayer || typeof ytPlayer.getPlayerState !== "function") {
      playTrack(state.currentTrack);
      return;
    }
    try {
      var pState = ytPlayer.getPlayerState();
      if (pState === 1) { // PLAYING
        stopPlayKicker();
        ytPlayer.pauseVideo();
        state.isPlaying = false;
      } else {
        if (typeof ytPlayer.unMute === "function") {
          ytPlayer.unMute();
        }
        ytPlayer.playVideo();
        startPlayKicker();
        state.isPlaying = true;
      }
      updatePlayerUI();
    } catch (e) {
      playTrack(state.currentTrack);
    }
    broadcastRoomUpdate();
  }

  // ---------- Event Bindings ----------
  if (nowTrackClickArea) {
    nowTrackClickArea.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (!state.currentTrack) return;
      openVideoModal();
    });
  }

  if (videoToggleBtn) {
    videoToggleBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggleVideoModal();
    });
  }

  if (closeVideoModalBtn) {
    closeVideoModalBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      closeVideoModal();
    });
  }

  if (videoDockBtn && videoModal) {
    videoDockBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      var isDocked = videoModal.classList.toggle("docked");
      showToast(isDocked ? "Docked to Floating Mini-Video" : "Expanded to Cinema Mode");
    });
  }

  if (videoFullscreenBtn) {
    videoFullscreenBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      var targetEl = videoStage || musicVideoEl;
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(function () {});
      } else if (targetEl && targetEl.requestFullscreen) {
        targetEl.requestFullscreen().catch(function () {});
      }
    });
  }

  if (videoStage) {
    videoStage.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggleCurrentTrackPlayPause();
    });

    videoStage.addEventListener("dblclick", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(function () {});
      } else if (videoStage.requestFullscreen) {
        videoStage.requestFullscreen().catch(function () {});
      }
    });
  }

  if (videoModal) {
    videoModal.addEventListener("click", function (e) {
      if (e.target === videoModal && !videoModal.classList.contains("docked")) {
        closeVideoModal();
      }
    });
  }

  document.getElementById("playBtn").addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleCurrentTrackPlayPause();
  });

  document.getElementById("nextBtn").addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    playNext();
  });
  
  document.getElementById("prevBtn").addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    playPrev();
  });

  document.getElementById("shuffleBtn").addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    state.shuffle = !state.shuffle;
    this.classList.toggle("active", state.shuffle);
  });

  document.getElementById("repeatBtn").addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    state.repeat = !state.repeat;
    this.classList.toggle("active", state.repeat);
  });

  nowFav.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (state.currentTrack) toggleFavorite(state.currentTrack);
  });

  var nowAddPlaylistBtn = document.getElementById("nowAddPlaylistBtn");
  if (nowAddPlaylistBtn) {
    nowAddPlaylistBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (!state.currentTrack) {
        showToast("Play or select a track first");
        return;
      }
      openTrackDropdown(state.currentTrack, nowAddPlaylistBtn);
    });
  }

  var clearQueueBtn = document.getElementById("clearQueueBtn");
  if (clearQueueBtn) {
    clearQueueBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      state.queue = [];
      renderQueue();
      broadcastRoomUpdate();
    });
  }

  function handleSeekToClientX(clientX) {
    var dur = getPlayerDuration();
    if (!dur || isNaN(dur) || !isFinite(dur)) return;

    var rect = seekTrack.getBoundingClientRect();
    var clickX = clientX - rect.left;
    var pct = Math.max(0, Math.min(1, clickX / rect.width));
    var targetTime = pct * dur;

    seekFill.style.width = (pct * 100) + "%";
    curTime.textContent = fmtTime(targetTime);

    seekPlayerTo(targetTime);
    if (!state.isPlaying && ytPlayer && typeof ytPlayer.playVideo === "function") {
      ytPlayer.playVideo();
      state.isPlaying = true;
      updatePlayerUI();
    }
    broadcastRoomUpdate();
  }

  seekTrack.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    handleSeekToClientX(e.clientX);
  });

  seekTrack.addEventListener("touchstart", function (e) {
    if (e.touches && e.touches[0]) {
      e.stopPropagation();
      handleSeekToClientX(e.touches[0].clientX);
    }
  }, { passive: true });

  seekTrack.addEventListener("touchmove", function (e) {
    if (e.touches && e.touches[0]) {
      handleSeekToClientX(e.touches[0].clientX);
    }
  }, { passive: true });

  // ---------- Volume Slider ----------
  function initVolumeControl() {
    const savedVol = localStorage.getItem("phantom_volume");
    const initialVol = savedVol !== null ? parseFloat(savedVol) : 0.8;
    setPlayerVolume(initialVol);
  }

  if (volSlider) {
    volSlider.addEventListener("input", (e) => {
      e.stopPropagation();
      const val = parseFloat(e.target.value) / 100;
      setPlayerVolume(val);
    });
  }

  document.querySelectorAll(".nav-item[data-view]").forEach(function (navEl) {
    navEl.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      var viewType = navEl.getAttribute("data-view");
      if (viewType === "smart-quickmix") {
        generateQuickMix();
      } else {
        setView({ type: viewType, id: null });
      }
    });
  });

  var searchClearBtn = document.getElementById("searchClearBtn");
  function syncSearchClearVisibility() {
    if (!searchClearBtn || !searchInput) return;
    searchClearBtn.classList.toggle("hidden", !searchInput.value.length);
  }

  if (searchClearBtn) {
    searchClearBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      clearTimeout(searchTimeout);
      searchInput.value = "";
      syncSearchClearVisibility();
      handleLiveSearch("");
      searchInput.focus();
    });
  }

  searchInput.addEventListener("input", function (e) {
    e.stopPropagation();
    clearTimeout(searchTimeout);
    var q = e.target.value;
    syncSearchClearVisibility();
    searchTimeout = setTimeout(function () {
      handleLiveSearch(q);
    }, 220);
  });

  searchInput.addEventListener("keydown", function (e) {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(searchTimeout);
      syncSearchClearVisibility();
      handleLiveSearch(searchInput.value);
    }
  });

  newPlaylistBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openNewPlaylistModal();
  });

  cancelModalBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    editingPlaylistId = null;
    playlistModal.style.display = "none";
  });

  createModalBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    commitNewPlaylist();
  });
  
  modalPlaylistInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitNewPlaylist();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      editingPlaylistId = null;
      playlistModal.style.display = "none";
    }
  });

  dropdownQueueAction.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (activeDropdownTrack) {
      addToQueue(activeDropdownTrack);
    }
    closeDropdown();
  });

  window.addEventListener("click", function (e) {
    if (trackDropdown && !trackDropdown.contains(e.target)) {
      closeDropdown();
    }
    if (sleepTimerMenu && !sleepTimerMenu.contains(e.target) && e.target !== sleepTimerBtn) {
      sleepTimerMenu.classList.add("hidden");
    }
  });

  document.addEventListener("phantom:authenticated", function (e) {
    state.user = e.detail.user;
    loadUserSync();
  });

  // ---------- Lyrics Engine ----------
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
    syncActiveLyricLine(getPlayerCurrentTime());
  };

  function parseTrackContext(rawTitle, rawArtist) {
    var title = rawTitle || "";
    var artist = rawArtist || "";
    var albumOrMovie = "";

    var movieBracketMatch = title.match(/[\(\[](?:from|movie|film|album)\s+["']?([^'"\)\]]+)["']?[\)\]]/i);
    if (movieBracketMatch && movieBracketMatch[1]) {
      albumOrMovie = movieBracketMatch[1].trim();
    }

    title = title.replace(/\(.*?\)|\[.*?\]|\{.*?\}/g, " ");

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

    artist = artist.replace(/- Topic/gi, "").replace(/vevo/gi, "").replace(/official/gi, "").trim();

    return {
      title: title.replace(/[,\/\\#+]/g, " ").replace(/\s+/g, " ").trim(),
      artist: artist.replace(/[,\/\\#+]/g, " ").replace(/\s+/g, " ").trim(),
      movie: albumOrMovie.replace(/[,\/\\#+]/g, " ").replace(/\s+/g, " ").trim()
    };
  }

  function scoreCandidate(candidate, ctx, targetDur) {
    var score = 0;
    var cTitle = (candidate.trackName || "").toLowerCase();
    var cArtist = (candidate.artistName || "").toLowerCase();
    var cAlbum = (candidate.albumName || "").toLowerCase();

    var qTitle = ctx.title.toLowerCase();
    var qArtist = ctx.artist.toLowerCase();
    var qMovie = ctx.movie.toLowerCase();

    if (targetDur > 0 && candidate.duration) {
      var diff = Math.abs(candidate.duration - targetDur);
      if (diff <= 3) score += 40;
      else if (diff <= 7) score += 30;
      else if (diff <= 15) score += 15;
      else score -= 25;
    }

    if (cTitle === qTitle) {
      score += 30;
    } else if (cTitle.includes(qTitle) || qTitle.includes(cTitle)) {
      score += 20;
    }

    if (qMovie && (cAlbum.includes(qMovie) || cTitle.includes(qMovie))) {
      score += 25;
    }

    if (qArtist) {
      var artistWords = qArtist.split(/\s+/).filter(function (w) { return w.length > 2; });
      var matchedWords = artistWords.filter(function (word) {
        return cArtist.includes(word) || cAlbum.includes(word);
      });
      if (matchedWords.length > 0) {
        score += Math.min(25, matchedWords.length * 10);
      }
    }

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

    var queries = [
      `${ctx.title} ${ctx.movie} ${ctx.artist}`.trim(),
      `${ctx.title} ${ctx.movie}`.trim(),
      `${ctx.title} ${ctx.artist}`.trim(),
      ctx.title
    ];

    try {
      var allCandidates = [];
      var seenIds = new Set();

      for (var i = 0; i < queries.length; i++) {
        var q = queries[i];
        if (!q || q.length < 2) continue;

        try {
          var res = await fetch(`${API_BASE}/lyrics?q=${encodeURIComponent(q)}`);
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

        if (allCandidates.length >= 8) break;
      }

      if (allCandidates.length === 0) {
        lyricsContainer.innerHTML = '<p class="lyrics-status">No lyrics found for this track.</p>';
        return;
      }

      var scored = allCandidates.map(function (candidate) {
        return {
          candidate: candidate,
          score: scoreCandidate(candidate, ctx, targetDur)
        };
      });

      scored.sort(function (a, b) { return b.score - a.score; });

      var bestMatch = scored[0];

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
        el.addEventListener("click", function (e) {
          e.preventDefault();
          e.stopPropagation();
          var seekTarget = Math.max(0, item.time - lyricOffset);
          seekPlayerTo(seekTarget);
          if (!state.isPlaying && ytPlayer && typeof ytPlayer.playVideo === "function") {
            ytPlayer.playVideo();
            state.isPlaying = true;
            updatePlayerUI();
          }
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

  // ---------- Equalizer, ReplayGain Normalizer, Crossfade & Visualizer Engine ----------
  var audioCtx = null;
  var sourceNode = null;
  var crossfadeGainNode = null;
  var compressorNode = null;
  var normMakeUpGain = null;
  var analyserNode = null;
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

  function applyReplayGainSettings() {
    if (!compressorNode || !normMakeUpGain || !audioCtx) return;
    if (state.replayGain) {
      compressorNode.threshold.setValueAtTime(-24, audioCtx.currentTime);
      compressorNode.knee.setValueAtTime(30, audioCtx.currentTime);
      compressorNode.ratio.setValueAtTime(8, audioCtx.currentTime);
      compressorNode.attack.setValueAtTime(0.003, audioCtx.currentTime);
      compressorNode.release.setValueAtTime(0.25, audioCtx.currentTime);
      normMakeUpGain.gain.setValueAtTime(1.18, audioCtx.currentTime);
    } else {
      compressorNode.threshold.setValueAtTime(0, audioCtx.currentTime);
      compressorNode.ratio.setValueAtTime(1, audioCtx.currentTime);
      normMakeUpGain.gain.setValueAtTime(1.0, audioCtx.currentTime);
    }
  }

  function initEqualizer() {
    if (audioCtx || !audioEngine) return;

    try {
      var AudioContext = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioContext();

      sourceNode = audioCtx.createMediaElementSource(audioEngine);
      crossfadeGainNode = audioCtx.createGain();
      crossfadeGainNode.gain.value = 1.0;

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

      compressorNode = audioCtx.createDynamicsCompressor();
      normMakeUpGain = audioCtx.createGain();
      analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = 128;
      analyserNode.smoothingTimeConstant = 0.8;

      applyReplayGainSettings();

      sourceNode.connect(crossfadeGainNode);
      crossfadeGainNode.connect(eqBands[0]);
      for (var i = 0; i < eqBands.length - 1; i++) {
        eqBands[i].connect(eqBands[i + 1]);
      }
      eqBands[eqBands.length - 1].connect(compressorNode);
      compressorNode.connect(normMakeUpGain);
      normMakeUpGain.connect(analyserNode);
      analyserNode.connect(audioCtx.destination);
    } catch (e) {
      console.warn("Web Audio API fallback to standard audio:", e);
    }
  }

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

  // Studio Controls Bindings (Crossfade, ReplayGain, Visualizer Mode)
  var crossfadeSlider = document.getElementById("crossfadeSlider");
  var crossfadeVal = document.getElementById("crossfadeVal");
  var replayGainToggle = document.getElementById("replayGainToggle");
  var vizModeSelect = document.getElementById("vizModeSelect");

  if (crossfadeSlider && crossfadeVal) {
    crossfadeSlider.value = state.crossfadeSec;
    crossfadeVal.textContent = state.crossfadeSec === 0 ? "Off" : state.crossfadeSec + "s";
    crossfadeSlider.addEventListener("input", function (e) {
      e.stopPropagation();
      state.crossfadeSec = parseInt(e.target.value, 10) || 0;
      crossfadeVal.textContent = state.crossfadeSec === 0 ? "Off" : state.crossfadeSec + "s";
      localStorage.setItem("phantom_crossfade", state.crossfadeSec);
    });
  }

  if (replayGainToggle) {
    replayGainToggle.checked = state.replayGain;
    replayGainToggle.addEventListener("change", function (e) {
      e.stopPropagation();
      state.replayGain = !!e.target.checked;
      localStorage.setItem("phantom_replaygain", state.replayGain);
      ensureAudioContextRunning();
      applyReplayGainSettings();
      showToast(state.replayGain ? "ReplayGain Normalizer: Enabled" : "ReplayGain Normalizer: Off");
    });
  }

  // ---------- Canvas Real-Time Audio Visualizer ----------
  var playerCanvas = document.getElementById("playerVisualizer");
  var lyricsCanvas = document.getElementById("lyricsVisualizer");
  var VIZ_MODES = ["bars", "retro", "wave"];

  function cycleVizMode() {
    var idx = VIZ_MODES.indexOf(state.vizMode);
    state.vizMode = VIZ_MODES[(idx + 1) % VIZ_MODES.length];
    localStorage.setItem("phantom_viz_mode", state.vizMode);
    if (vizModeSelect) vizModeSelect.value = state.vizMode;
    showToast(`Visualizer: ${state.vizMode.toUpperCase()}`);
  }

  if (playerCanvas) playerCanvas.addEventListener("click", cycleVizMode);
  if (lyricsCanvas) lyricsCanvas.addEventListener("click", cycleVizMode);
  if (vizModeSelect) {
    vizModeSelect.value = state.vizMode;
    vizModeSelect.addEventListener("change", function (e) {
      state.vizMode = e.target.value;
      localStorage.setItem("phantom_viz_mode", state.vizMode);
    });
  }

  function drawVisualizerToCanvas(canvas, freqData, timeData) {
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    var w = canvas.width;
    var h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    var mode = state.vizMode || "bars";
    var barCount = 22;

    if (mode === "bars") {
      var barW = (w / barCount) - 2;
      for (var i = 0; i < barCount; i++) {
        var val = freqData ? freqData[i * 2] || 4 : 4;
        var barH = Math.max(3, (val / 255) * (h - 4));
        var x = i * (barW + 2) + 1;
        var y = h - barH;
        var grad = ctx.createLinearGradient(0, y, 0, h);
        grad.addColorStop(0, "#4ade80");
        grad.addColorStop(1, "#16a34a");
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, barW, barH);
      }
    } else if (mode === "retro") {
      var cols = 16;
      var colW = (w / cols) - 2;
      var segs = 6;
      var segH = Math.floor((h - 4) / segs) - 1;
      for (var c = 0; c < cols; c++) {
        var v = freqData ? freqData[c * 2] || 0 : 0;
        var activeSegs = Math.max(1, Math.round((v / 255) * segs));
        for (var s = 0; s < activeSegs; s++) {
          ctx.fillStyle = s >= segs - 1 ? "#ef4444" : s >= segs - 2 ? "#facc15" : "#22c55e";
          var sx = c * (colW + 2) + 1;
          var sy = h - (s + 1) * (segH + 1);
          ctx.fillRect(sx, sy, colW, segH);
        }
      }
    } else {
      ctx.beginPath();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#22c55e";
      var len = timeData ? timeData.length : 32;
      var slice = w / (len - 1);
      for (var k = 0; k < len; k++) {
        var sample = timeData ? (timeData[k] - 128) / 128 : 0;
        var wy = h / 2 + sample * (h * 0.45);
        var wx = k * slice;
        if (k === 0) ctx.moveTo(wx, wy);
        else ctx.lineTo(wx, wy);
      }
      ctx.stroke();
    }
  }

  function startVisualizerLoop() {
    var freqBuf = new Uint8Array(64);
    var timeBuf = new Uint8Array(64);
    var phase = 0;

    function renderFrame() {
      if (state.isPlaying) {
        phase += 0.08;
        for (var i = 0; i < 64; i++) {
          var base = Math.sin(phase + i * 0.2) * 45 + Math.cos(phase * 1.5 + i * 0.4) * 35 + 95;
          freqBuf[i] = Math.max(10, Math.min(255, Math.floor(base)));
          timeBuf[i] = Math.max(0, Math.min(255, Math.floor(128 + Math.sin(phase * 2 + i * 0.3) * 60)));
        }
      } else {
        for (var i = 0; i < 64; i++) {
          freqBuf[i] = Math.max(2, Math.floor(freqBuf[i] * 0.85));
          timeBuf[i] = 128;
        }
      }
      drawVisualizerToCanvas(playerCanvas, freqBuf, timeBuf);
      if (lyricsModal && !lyricsModal.classList.contains("hidden")) {
        drawVisualizerToCanvas(lyricsCanvas, freqBuf, timeBuf);
      }
      requestAnimationFrame(renderFrame);
    }
    requestAnimationFrame(renderFrame);
  }

  // ---------- Picture-in-Picture / Floating Mini-Player ----------
  var pipWindow = null;
  var pipBtn = document.getElementById("pipBtn");

  function updatePiPWindow() {
    if (!pipWindow || pipWindow.closed) return;
    var doc = pipWindow.document;
    var titleEl = doc.getElementById("pipTitle");
    var artistEl = doc.getElementById("pipArtist");
    var coverEl = doc.getElementById("pipCover");
    var playBtnEl = doc.getElementById("pipPlay");
    var favBtnEl = doc.getElementById("pipFav");

    if (titleEl) titleEl.textContent = state.currentTrack ? state.currentTrack.title : "Nothing playing";
    if (artistEl) artistEl.textContent = state.currentTrack ? state.currentTrack.artist : "Pick a track";
    if (coverEl && state.currentTrack) coverEl.src = state.currentTrack.thumbnail || "";
    if (playBtnEl) playBtnEl.textContent = state.isPlaying ? "⏸" : "▶";
    if (favBtnEl && state.currentTrack) {
      var isFav = state.favorites.map(String).includes(String(state.currentTrack.id));
      favBtnEl.style.color = isFav ? "#ef4444" : "#8e8e9f";
    }
  }

  function updatePiPProgress(cur, dur) {
    if (!pipWindow || pipWindow.closed || !dur) return;
    var fill = pipWindow.document.getElementById("pipSeekFill");
    if (fill) fill.style.width = Math.min(100, (cur / dur) * 100) + "%";
  }

  async function togglePictureInPicture() {
    if (pipWindow && !pipWindow.closed) {
      pipWindow.close();
      pipWindow = null;
      return;
    }

    if ("documentPictureInPicture" in window) {
      try {
        pipWindow = await window.documentPictureInPicture.requestWindow({
          width: 340,
          height: 136
        });
        var d = pipWindow.document;
        d.body.style.cssText =
          "margin:0;padding:12px 14px;background:#0f0f13;color:#f0f0f5;font-family:Inter,sans-serif;display:flex;flex-direction:column;justify-content:space-between;height:100vh;box-sizing:border-box;user-select:none;";
        d.body.innerHTML = `
          <div style="display:flex;align-items:center;gap:12px;min-width:0;">
            <img id="pipCover" src="${(state.currentTrack && state.currentTrack.thumbnail) || ''}" style="width:52px;height:52px;border-radius:8px;object-fit:cover;background:#272733;flex-shrink:0;" />
            <div style="flex:1;min-width:0;">
              <div id="pipTitle" style="font-weight:700;font-size:0.9rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(state.currentTrack ? state.currentTrack.title : "Nothing playing")}</div>
              <div id="pipArtist" style="font-size:0.78rem;color:#8e8e9f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;">${escapeHtml(state.currentTrack ? state.currentTrack.artist : "Pick a track")}</div>
            </div>
            <button id="pipFav" style="background:none;border:none;font-size:1.15rem;cursor:pointer;color:#8e8e9f;">♥</button>
          </div>
          <div style="display:flex;align-items:center;justify-content:center;gap:18px;margin:6px 0;">
            <button id="pipPrev" style="background:none;border:none;color:#f0f0f5;font-size:1rem;cursor:pointer;">⏮</button>
            <button id="pipPlay" style="background:#22c55e;border:none;color:#000;width:34px;height:34px;border-radius:50%;font-weight:700;cursor:pointer;">${state.isPlaying ? "⏸" : "▶"}</button>
            <button id="pipNext" style="background:none;border:none;color:#f0f0f5;font-size:1rem;cursor:pointer;">⏭</button>
          </div>
          <div style="height:4px;background:#242430;border-radius:2px;overflow:hidden;">
            <div id="pipSeekFill" style="height:100%;width:0%;background:#22c55e;"></div>
          </div>
        `;
        d.getElementById("pipPrev").onclick = playPrev;
        d.getElementById("pipNext").onclick = function () { playNext(); };
        d.getElementById("pipPlay").onclick = function () {
          toggleCurrentTrackPlayPause();
        };
        d.getElementById("pipFav").onclick = function () {
          if (state.currentTrack) toggleFavorite(state.currentTrack);
        };
        updatePiPWindow();
        return;
      } catch (err) {
        console.warn("documentPictureInPicture failed:", err);
      }
    }

    showToast("Mini-Player opened (Document PiP requires Chrome/Edge 116+)");
  }

  if (pipBtn) {
    pipBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      togglePictureInPicture();
    });
  }

  // ---------- Command Palette & Keyboard Shortcuts Modal ----------
  var cmdPaletteModal = document.getElementById("cmdPaletteModal");
  var cmdPaletteInput = document.getElementById("cmdPaletteInput");
  var cmdPaletteResults = document.getElementById("cmdPaletteResults");
  var cmdPaletteBtn = document.getElementById("cmdPaletteBtn");
  var closeCmdPaletteBtn = document.getElementById("closeCmdPaletteBtn");

  function renderCommandPaletteResults(query) {
    if (!cmdPaletteResults) return;
    cmdPaletteResults.innerHTML = "";
    var q = (query || "").trim();

    var actions = [
      { label: "Play / Pause Current Track", tag: "Command", run: () => toggleCurrentTrackPlayPause() },
      { label: "Toggle YouTube Music Video Player", tag: "Video", run: () => toggleVideoModal() },
      { label: "Generate Instant Quick Mix", tag: "Smart Mix", run: () => generateQuickMix() },
      { label: "View Top Played Chart", tag: "Smart Mix", run: () => setView({ type: "smart-top", id: null }) },
      { label: "View Forgotten Favorites", tag: "Smart Mix", run: () => setView({ type: "smart-forgotten", id: null }) },
      { label: "Open Studio Equalizer & Crossfade", tag: "Audio", run: () => window.toggleEqModal() },
      { label: "Toggle Time-Synced Lyrics", tag: "Lyrics", run: () => window.toggleLyricsModal() },
      { label: "Open Listen Along Live Room", tag: "Collab", run: () => openListenAlongModal() },
      { label: "Cycle Visualizer Style (Bars / Retro / Wave)", tag: "Visualizer", run: () => cycleVizMode() }
    ];

    state.playlists.forEach(function (pl) {
      actions.push({
        label: `Playlist: ${pl.name}`,
        tag: "Playlist",
        run: () => setView({ type: "playlist", id: pl.id })
      });
    });

    var matchedActions = actions.filter(function (a) {
      return !q || a.label.toLowerCase().includes(q.toLowerCase());
    });

    if (matchedActions.length === 0) {
      var empty = document.createElement("div");
      empty.className = "dropdown-empty";
      empty.textContent = "No matching commands or playlists";
      cmdPaletteResults.appendChild(empty);
      return;
    }

    matchedActions.forEach(function (act) {
      var item = document.createElement("div");
      item.className = "cmd-item";
      item.innerHTML = `<span>${escapeHtml(act.label)}</span><span class="cmd-item-tag">${escapeHtml(act.tag)}</span>`;
      item.onclick = function () {
        cmdPaletteModal.style.display = "none";
        act.run();
      };
      cmdPaletteResults.appendChild(item);
    });
  }

  function toggleCommandPalette() {
    if (!cmdPaletteModal) return;
    if (cmdPaletteModal.style.display === "none") {
      cmdPaletteModal.style.display = "flex";
      if (cmdPaletteInput) {
        cmdPaletteInput.value = "";
        cmdPaletteInput.focus();
      }
      renderCommandPaletteResults("");
    } else {
      cmdPaletteModal.style.display = "none";
    }
  }

  if (cmdPaletteBtn) cmdPaletteBtn.addEventListener("click", toggleCommandPalette);
  if (closeCmdPaletteBtn) {
    closeCmdPaletteBtn.addEventListener("click", function () {
      cmdPaletteModal.style.display = "none";
    });
  }
  if (cmdPaletteInput) {
    cmdPaletteInput.addEventListener("input", function (e) {
      renderCommandPaletteResults(e.target.value);
    });
  }

  // ---------- Multi-User Collaboration ("Listen Along" Rooms via Socket.IO) ----------
  var socket = null;
  var listenAlongBtn = document.getElementById("listenAlongBtn");
  var listenAlongModal = document.getElementById("listenAlongModal");
  var closeListenAlongBtn = document.getElementById("closeListenAlongBtn");
  var createRoomBtn = document.getElementById("createRoomBtn");
  var joinRoomBtn = document.getElementById("joinRoomBtn");
  var leaveRoomBtn = document.getElementById("leaveRoomBtn");
  var copyRoomCodeBtn = document.getElementById("copyRoomCodeBtn");
  var broadcastStateBtn = document.getElementById("broadcastStateBtn");
  var roomCodeInput = document.getElementById("roomCodeInput");
  var roomDisconnectedView = document.getElementById("roomDisconnectedView");
  var roomConnectedView = document.getElementById("roomConnectedView");
  var activeRoomCodeDisplay = document.getElementById("activeRoomCodeDisplay");
  var roomMemberCount = document.getElementById("roomMemberCount");
  var roomMembersList = document.getElementById("roomMembersList");
  var roomBadge = document.getElementById("roomBadge");
  var listenAlongLabel = document.getElementById("listenAlongLabel");

  function ensureSocketConnected() {
    if (socket || typeof window.io !== "function") return;
    try {
      socket = window.io(SOCKET_BASE, { transports: ["websocket", "polling"] });

      socket.on("room_joined", function (data) {
        state.room.code = data.room;
        state.room.members = data.members || [];
        updateRoomUI();
        showToast(`Joined Listen Along Room: ${data.room}`);
        if (data.state && data.state.currentTrack) {
          applyRemoteRoomState(data.state);
        }
      });

      socket.on("room_members", function (data) {
        state.room.members = data.members || [];
        updateRoomUI();
      });

      socket.on("room_sync", function (remoteState) {
        applyRemoteRoomState(remoteState);
      });
    } catch (e) {
      console.warn("Socket.IO init warning:", e);
    }
  }

  function applyRemoteRoomState(remote) {
    if (!remote) return;
    state.room.isSyncingRemote = true;
    try {
      if (Array.isArray(remote.queue)) {
        state.queue = remote.queue;
        state.queue.forEach((t) => registerTrack(t, true));
        renderQueue();
      }
      if (remote.currentTrack && remote.currentTrack.id) {
        var isDiffTrack = !state.currentTrack || String(state.currentTrack.id) !== String(remote.currentTrack.id);
        if (isDiffTrack) {
          playTrack(remote.currentTrack, false, true);
        }
        var cur = getPlayerCurrentTime();
        if (typeof remote.currentTime === "number" && Math.abs(cur - remote.currentTime) > 2.5) {
          seekPlayerTo(remote.currentTime);
        }
        if (remote.isPlaying && !state.isPlaying) {
          if (ytPlayer && typeof ytPlayer.playVideo === "function") ytPlayer.playVideo();
          state.isPlaying = true;
          updatePlayerUI();
        } else if (!remote.isPlaying && state.isPlaying) {
          if (ytPlayer && typeof ytPlayer.pauseVideo === "function") ytPlayer.pauseVideo();
          state.isPlaying = false;
          updatePlayerUI();
        }
      }
    } finally {
      setTimeout(function () {
        state.room.isSyncingRemote = false;
      }, 300);
    }
  }

  function broadcastRoomUpdate() {
    if (!state.room.code || state.room.isSyncingRemote || !socket) return;
    socket.emit("sync_state", {
      room: state.room.code,
      state: {
        currentTrack: state.currentTrack,
        currentTime: getPlayerCurrentTime(),
        isPlaying: state.isPlaying,
        queue: state.queue
      }
    });
  }

  function updateRoomUI() {
    var active = !!state.room.code;
    if (roomDisconnectedView) roomDisconnectedView.classList.toggle("hidden", active);
    if (roomConnectedView) roomConnectedView.classList.toggle("hidden", !active);
    if (roomBadge) roomBadge.classList.toggle("hidden", !active);
    if (listenAlongBtn) listenAlongBtn.classList.toggle("active-room", active);
    if (listenAlongLabel) listenAlongLabel.textContent = active ? `Room ${state.room.code}` : "Listen Along";
    if (activeRoomCodeDisplay) activeRoomCodeDisplay.textContent = state.room.code || "------";
    if (roomMemberCount) roomMemberCount.textContent = state.room.members.length || 1;
    if (roomMembersList) {
      roomMembersList.innerHTML = "";
      (state.room.members.length ? state.room.members : [state.user ? state.user.username : "You"]).forEach(function (m) {
        var pill = document.createElement("span");
        pill.className = "room-member-pill";
        pill.textContent = m;
        roomMembersList.appendChild(pill);
      });
    }
  }

  function openListenAlongModal() {
    ensureSocketConnected();
    if (listenAlongModal) {
      listenAlongModal.style.display = "flex";
      updateRoomUI();
    }
  }

  if (listenAlongBtn) listenAlongBtn.addEventListener("click", openListenAlongModal);
  if (closeListenAlongBtn) {
    closeListenAlongBtn.addEventListener("click", function () {
      listenAlongModal.style.display = "none";
    });
  }
  if (createRoomBtn) {
    createRoomBtn.addEventListener("click", function () {
      ensureSocketConnected();
      var code = "PHN" + Math.floor(100 + Math.random() * 900);
      var username = (state.user && state.user.username) || "Guest";
      if (socket) {
        socket.emit("join_room_event", {
          room: code,
          username: username,
          state: {
            currentTrack: state.currentTrack,
            currentTime: getPlayerCurrentTime(),
            isPlaying: state.isPlaying,
            queue: state.queue
          }
        });
      }
      state.room.code = code;
      state.room.members = [username];
      updateRoomUI();
    });
  }
  if (joinRoomBtn) {
    joinRoomBtn.addEventListener("click", function () {
      ensureSocketConnected();
      var code = (roomCodeInput.value || "").trim().toUpperCase();
      if (!code) return;
      var username = (state.user && state.user.username) || "Guest";
      if (socket) {
        socket.emit("join_room_event", { room: code, username: username });
      }
      state.room.code = code;
      updateRoomUI();
    });
  }
  if (leaveRoomBtn) {
    leaveRoomBtn.addEventListener("click", function () {
      if (socket && state.room.code) {
        socket.emit("leave_room_event", {
          room: state.room.code,
          username: (state.user && state.user.username) || "Guest"
        });
      }
      state.room.code = null;
      state.room.members = [];
      updateRoomUI();
      showToast("Left Listen Along room");
    });
  }
  if (copyRoomCodeBtn) {
    copyRoomCodeBtn.addEventListener("click", function () {
      if (state.room.code && navigator.clipboard) {
        navigator.clipboard.writeText(state.room.code);
        showToast(`Copied room code: ${state.room.code}`);
      }
    });
  }
  if (broadcastStateBtn) {
    broadcastStateBtn.addEventListener("click", function () {
      broadcastRoomUpdate();
      showToast("Synced room to your current playback!");
    });
  }

  // ---------- Mobile Navigation Drawer & Image Fallback ----------
  var mobileMenuBtn = document.getElementById("mobileMenuBtn");
  var mobileNavBackdrop = document.getElementById("mobileNavBackdrop");
  var navEl = document.querySelector(".nav");

  function closeMobileNav() {
    if (navEl) navEl.classList.remove("mobile-open");
    if (mobileNavBackdrop) mobileNavBackdrop.classList.remove("active");
  }

  function toggleMobileNav() {
    if (!navEl) return;
    var isOpen = navEl.classList.toggle("mobile-open");
    if (mobileNavBackdrop) mobileNavBackdrop.classList.toggle("active", isOpen);
  }

  var navCloseBtn = document.getElementById("navCloseBtn");

  if (mobileMenuBtn) {
    mobileMenuBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggleMobileNav();
    });
  }

  if (navCloseBtn) {
    navCloseBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      closeMobileNav();
    });
  }

  if (mobileNavBackdrop) {
    mobileNavBackdrop.addEventListener("click", closeMobileNav);
  }

  // Auto-close nav drawer on mobile when clicking any navigation link, playlist or action
  document.addEventListener("click", function (e) {
    if (window.innerWidth <= 860) {
      if (
        e.target.closest(".nav-item") ||
        e.target.closest(".playlist-row") ||
        e.target.closest("#newPlaylistBtn") ||
        e.target.closest(".nav-logout-btn")
      ) {
        closeMobileNav();
      }
    }
  });

  // Global Image error fallback so expired hq720 thumbnails cleanly fallback to canonical static hqdefault
  document.addEventListener("error", function (e) {
    var target = e.target;
    if (target && target.tagName === "IMG" && !target.dataset.triedFallback) {
      target.dataset.triedFallback = "1";
      var src = target.getAttribute("src") || "";
      var m = src.match(/\/vi\/([A-Za-z0-9_-]{11})\//);
      if (m && m[1]) {
        target.src = "https://i.ytimg.com/vi/" + m[1] + "/hqdefault.jpg";
      }
    }
  }, true);

  // ---------- Mobile Touch Audio Primer ----------
  var hasPrimedMobileAudio = false;
  function primeMobileAudio() {
    if (hasPrimedMobileAudio) return;
    hasPrimedMobileAudio = true;
    if (ytPlayer && typeof ytPlayer.unMute === "function") {
      try {
        ytPlayer.unMute();
      } catch (e) {}
    }
  }
  window.addEventListener("pointerdown", primeMobileAudio, { passive: true, once: true });
  window.addEventListener("touchend", primeMobileAudio, { passive: true, once: true });
  window.addEventListener("click", primeMobileAudio, { passive: true, once: true });

  // ---------- PWA Service Worker Registration ----------
  if ("serviceWorker" in navigator && (window.location.protocol === "http:" || window.location.protocol === "https:")) {
    window.addEventListener("load", function () {
      if ("caches" in window) {
        caches.keys().then(function (keys) {
          keys.forEach(function (k) {
            if (k !== "daddy-music-shell-v22") {
              caches.delete(k).catch(function () {});
            }
          });
        }).catch(function () {});
      }
      navigator.serviceWorker.register("sw.js").then(function (reg) {
        reg.update().catch(function () {});
      }).catch(function () {});
    });
  }

  // Boot
  initVolumeControl();
  updateSpeedUI();
  setupMediaSession();
  renderPlaylists();
  renderQueue();
  restoreLastPlayedTrack();
  setView(state.view);
  startVisualizerLoop();
})();