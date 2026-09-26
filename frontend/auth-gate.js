(function () {
  "use strict";

  const API_BASE = "http://127.0.0.1:5000/api";
  const TOKEN_KEY = "phantom_token";
  const USER_KEY = "phantom_user";

  var mode = "login"; // "login" | "register"
  var usernameCheckTimer = null;
  var usernameAvailable = null;

  // Wait until DOM is completely parsed
  document.addEventListener("DOMContentLoaded", initAuthGate);

  function initAuthGate() {
    var gate = document.getElementById("authGate");
    var form = document.getElementById("authForm");
    var tabLogin = document.getElementById("tabLogin");
    var tabRegister = document.getElementById("tabRegister");
    var usernameInput = document.getElementById("gateUsername");
    var passwordInput = document.getElementById("gatePassword");
    var passToggle = document.getElementById("passToggle");
    var usernameMsg = document.getElementById("usernameMsg");
    var passwordMsg = document.getElementById("passwordMsg");
    var strengthMeter = document.getElementById("strengthMeter");
    var strengthFill = document.getElementById("strengthFill");
    var strengthLabel = document.getElementById("strengthLabel");
    var authError = document.getElementById("authError");
    var authSubmit = document.getElementById("authSubmit");
    var switchText = document.getElementById("switchText");
    var switchLink = document.getElementById("switchLink");

    if (!tabLogin || !tabRegister || !form) {
      console.error("Auth Gate: Missing critical DOM elements.");
      return;
    }

    // ---------------- Storage Helpers ----------------
    function getToken() {
      try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
    }
    function setSession(token, user) {
      try {
        localStorage.setItem(TOKEN_KEY, token);
        localStorage.setItem(USER_KEY, JSON.stringify(user));
      } catch (e) {}
    }
    function clearSession() {
      try {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
      } catch (e) {}
    }

    window.authFetch = function (url, opts) {
      opts = opts || {};
      opts.headers = Object.assign({}, opts.headers || {});
      var token = getToken();
      if (token) opts.headers["Authorization"] = "Bearer " + token;
      return fetch(url, opts);
    };

    function showGate() {
      document.body.classList.add("gate-active");
      if (gate) gate.style.display = "flex";
    }

    function hideGate(user) {
      document.body.classList.remove("gate-active");
      if (gate) gate.style.display = "none";
      renderUserChip(user);
      document.dispatchEvent(new CustomEvent("phantom:authenticated", { detail: { user: user } }));
    }

    function renderUserChip(user) {
      var container = document.getElementById("authNavbarContainer");
      if (!container) return;
      container.innerHTML = "";
      var chip = document.createElement("div");
      chip.className = "user-chip";
      chip.innerHTML = '<span>Signed in as <strong>' + escapeHtml(user.username) + "</strong></span>";
      var logoutBtn = document.createElement("button");
      logoutBtn.className = "btn-link-danger";
      logoutBtn.type = "button";
      logoutBtn.textContent = "Logout";
      logoutBtn.addEventListener("click", logout);
      chip.appendChild(logoutBtn);
      container.appendChild(chip);
    }

    function escapeHtml(str) {
      if (!str) return "";
      return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    async function logout() {
      try {
        await window.authFetch(API_BASE + "/auth/logout", { method: "POST" });
      } catch (e) {}
      clearSession();
      window.location.reload();
    }
    window.phantomLogout = logout;

    // ---------------- Mode Switch Logic ----------------
    function setMode(next) {
      mode = next;
      if (mode === "login") {
        tabLogin.classList.add("active");
        tabRegister.classList.remove("active");
        if (strengthMeter) strengthMeter.style.display = "none";
        authSubmit.textContent = "Sign In";
        switchText.textContent = "Need an account?";
        switchLink.textContent = "Sign Up";
        usernameInput.setAttribute("placeholder", "Your username");
      } else {
        tabLogin.classList.remove("active");
        tabRegister.classList.add("active");
        if (strengthMeter) strengthMeter.style.display = "flex";
        authSubmit.textContent = "Create Account";
        switchText.textContent = "Already have an account?";
        switchLink.textContent = "Sign In";
        usernameInput.setAttribute("placeholder", "e.g. phantom_92");
      }
      usernameMsg.textContent = "";
      passwordMsg.textContent = "";
      authError.style.display = "none";
    }

    // Direct tab click attachments
    tabLogin.onclick = function (e) {
      e.preventDefault();
      setMode("login");
    };

    tabRegister.onclick = function (e) {
      e.preventDefault();
      setMode("register");
    };

    if (switchLink) {
      switchLink.onclick = function (e) {
        e.preventDefault();
        setMode(mode === "login" ? "register" : "login");
      };
    }

    if (passToggle) {
      passToggle.onclick = function () {
        passwordInput.type = passwordInput.type === "password" ? "text" : "password";
      };
    }

    // ---------------- Live Username Availability Check ----------------
    usernameInput.addEventListener("input", function () {
      usernameAvailable = null;
      usernameMsg.className = "field-msg";
      if (mode !== "register") return;

      var val = usernameInput.value.trim();
      clearTimeout(usernameCheckTimer);

      if (!val) {
        usernameMsg.textContent = "";
        return;
      }
      if (!/^[a-zA-Z0-9_]{3,20}$/.test(val)) {
        usernameMsg.textContent = "3-20 characters: letters, numbers, underscores only.";
        usernameMsg.className = "field-msg bad";
        return;
      }

      usernameMsg.textContent = "Checking availability…";
      usernameMsg.className = "field-msg checking";

      usernameCheckTimer = setTimeout(async function () {
        try {
          var res = await fetch(API_BASE + "/auth/check-username?u=" + encodeURIComponent(val));
          var data = await res.json();
          usernameAvailable = !!data.available;
          if (data.available) {
            usernameMsg.textContent = "Username is available.";
            usernameMsg.className = "field-msg ok";
          } else {
            usernameMsg.textContent = data.error || "That username is already taken.";
            usernameMsg.className = "field-msg bad";
          }
        } catch (e) {
          usernameMsg.textContent = "";
        }
      }, 350);
    });

    // ---------------- Password Strength ----------------
    function scorePassword(pw) {
      var score = 0;
      if (pw.length >= 8) score++;
      if (pw.length >= 12) score++;
      if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
      if (/[0-9]/.test(pw)) score++;
      if (/[^A-Za-z0-9]/.test(pw)) score++;
      return Math.min(score, 4);
    }

    var STRENGTH_LABELS = ["Weak", "Weak", "Fair", "Good", "Strong"];
    var STRENGTH_COLORS = ["#ef4444", "#ef4444", "#f59e0b", "#84cc16", "#22c55e"];

    passwordInput.addEventListener("input", function () {
      passwordMsg.textContent = "";
      if (mode !== "register") return;
      var pw = passwordInput.value;
      if (!pw) {
        strengthFill.style.width = "0%";
        strengthLabel.textContent = "";
        return;
      }
      var score = scorePassword(pw);
      strengthFill.style.width = (score / 4) * 100 + "%";
      strengthFill.style.background = STRENGTH_COLORS[score];
      strengthLabel.textContent = STRENGTH_LABELS[score];
    });

    // ---------------- Submit ----------------
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      authError.style.display = "none";

      var username = usernameInput.value.trim();
      var password = passwordInput.value;

      if (!username || !password) {
        authError.textContent = "Please fill in both fields.";
        authError.style.display = "block";
        return;
      }

      if (mode === "register") {
        if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
          authError.textContent = "Username must be 3-20 characters: letters, numbers, underscores only.";
          authError.style.display = "block";
          return;
        }
        if (usernameAvailable === false) {
          authError.textContent = "That username is already taken.";
          authError.style.display = "block";
          return;
        }
        if (scorePassword(password) < 3) {
          authError.textContent = "Please choose a stronger password (8+ chars, upper/lowercase, number, symbol).";
          authError.style.display = "block";
          return;
        }
      }

      authSubmit.disabled = true;
      authSubmit.textContent = mode === "login" ? "Signing in…" : "Creating account…";

      try {
        var endpoint = mode === "login" ? "/auth/login" : "/auth/register";
        var res = await fetch(API_BASE + endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: username, password: password })
        });
        var data = await res.json();

        if (!res.ok) {
          authError.textContent = data.error || "Something went wrong.";
          authError.style.display = "block";
          authSubmit.disabled = false;
          authSubmit.textContent = mode === "login" ? "Sign In" : "Create Account";
          return;
        }

        setSession(data.token, data.user);
        hideGate(data.user);
      } catch (err) {
        authError.textContent = "Couldn't reach the server. Is backend running on port 5000?";
        authError.style.display = "block";
        authSubmit.disabled = false;
        authSubmit.textContent = mode === "login" ? "Sign In" : "Create Account";
      }
    });

    // ---------------- Boot Session Check ----------------
    async function boot() {
      var token = getToken();
      if (!token) {
        showGate();
        return;
      }
      try {
        var res = await window.authFetch(API_BASE + "/auth/me");
        if (res.ok) {
          var data = await res.json();
          hideGate(data.user);
          return;
        }
      } catch (e) {}
      clearSession();
      showGate();
    }

    setMode("login");
    boot();
  }
})();