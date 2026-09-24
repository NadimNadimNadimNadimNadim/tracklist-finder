// 8tracks tracklist finder: page script.
//
// Safety rule: everything shown on the page is built with DOM methods and
// textContent. Text from the archive is never parsed as HTML, and links are only
// created for https addresses on a short list of known sites. ESLint enforces the
// first part; safeHref() below enforces the second.
(function () {
  "use strict";

  var API = "/api/v1/lookup?url=";
  var CLIENT_TIMEOUT_MS = 45000;
  var LINK_HOSTS = ["web.archive.org", "www.youtube.com", "open.spotify.com", "8tracks.com"];
  var ATTRS = ["class", "type", "title", "alt", "rel", "target", "role", "loading", "referrerpolicy", "decoding", "aria-label", "aria-hidden"];

  var $ = function (id) { return document.getElementById(id); };
  var nf = new Intl.NumberFormat("en-US");
  var fmtDate = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  var current = null;
  var busy = false;

  // ---------- small DOM helpers ----------

  function safeHref(value) {
    try {
      var u = new URL(value);
      return u.protocol === "https:" && LINK_HOSTS.indexOf(u.hostname) !== -1 && !u.username && !u.password ? u.href : null;
    } catch {
      return null;
    }
  }

  // el("a", { class: "btn", href: "https://..." }, "text", childNode, ...)
  function el(tag, props) {
    var node = document.createElement(tag);
    var p = props || {};
    Object.keys(p).forEach(function (k) {
      var v = p[k];
      if (v === null || v === undefined || v === false) return;
      if (k === "href") {
        var safe = safeHref(v);
        if (safe) { node.setAttribute("href", safe); node.setAttribute("rel", "noopener noreferrer"); node.setAttribute("target", "_blank"); }
      } else if (k === "data") {
        Object.keys(v).forEach(function (d) { node.dataset[d] = String(v[d]); });
      } else if (ATTRS.indexOf(k) !== -1) {
        node.setAttribute(k, String(v));
      } else {
        throw new Error("Attribute not allowed: " + k);
      }
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : String(c));
    }
    return node;
  }

  function clear(node) { node.replaceChildren(); }

  function toast(msg) {
    var t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.classList.remove("show"); }, 1800);
  }

  function stampToText(ts) {
    if (typeof ts !== "string" || !/^\d{14}$/.test(ts)) return "";
    return fmtDate.format(Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8)));
  }

  function duration(s) {
    if (typeof s !== "number" || s <= 0) return "";
    var h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    if (m === 60) { h++; m = 0; }
    return (h ? h + " hr " : "") + m + " min";
  }

  // ---------- recent lookups, kept only in this browser ----------

  var RECENT_KEY = "recent-8tracks";
  function loadRecent() {
    try {
      var list = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
      return Array.isArray(list) ? list.filter(function (r) { return r && typeof r.url === "string"; }).slice(0, 8) : [];
    } catch { return []; }
  }
  function saveRecent(url, name) {
    var list = loadRecent().filter(function (r) { return r.url !== url; });
    list.unshift({ url: url.slice(0, 2048), name: String(name || url).slice(0, 120) });
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8))); } catch { /* storage full or blocked */ }
    showRecent();
  }
  function showRecent() {
    var list = loadRecent(), box = $("recent");
    clear(box);
    if (!list.length) { box.hidden = true; return; }
    box.hidden = false;
    box.append(el("span", { class: "label" }, "Recent:"));
    list.forEach(function (r) {
      box.append(el("button", { class: "chip", type: "button", title: r.url, data: { url: r.url } }, r.name || r.url));
    });
  }

  // ---------- lookups ----------

  function run(input) {
    input = String(input || "").trim();
    if (!input || busy) return;
    busy = true;
    $("go").disabled = true;
    $("url").value = input;
    try { history.replaceState(null, "", "?url=" + encodeURIComponent(input)); } catch { /* ignore */ }
    $("notice").hidden = true;
    $("result").hidden = true;
    $("status").hidden = false;

    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, CLIENT_TIMEOUT_MS);

    fetch(API + encodeURIComponent(input), { signal: controller.signal, headers: { Accept: "application/json" } })
      .then(function (res) {
        return res.json().then(
          function (body) { return { ok: res.ok, status: res.status, body: body }; },
          function () { return { ok: false, status: res.status, body: null }; }
        );
      })
      .then(function (r) {
        if (r.ok && r.body && r.body.mix && Array.isArray(r.body.tracks)) {
          current = r.body;
          render(r.body);
          saveRecent(input, r.body.mix.name);
        } else {
          showError((r.body && r.body.error) || { code: r.status === 429 ? "RATE_LIMITED" : "UNKNOWN" });
        }
      })
      .catch(function (e) {
        showError({ code: e && e.name === "AbortError" ? "CLIENT_TIMEOUT" : "NETWORK" });
      })
      .then(function () {
        clearTimeout(timer);
        busy = false;
        $("go").disabled = false;
        $("status").hidden = true;
      });
  }

  function showError(err) {
    var n = $("notice");
    clear(n);
    n.className = "notice";
    n.hidden = false;
    var message = typeof err.message === "string" ? err.message : "";
    var headline = function (text) { return el("p", { class: "headline" }, text); };

    switch (err.code) {
      case "PAGE_NOT_ARCHIVED": {
        n.append(headline(message), el("p", null, "Check the link for typos. If you have the mix's number from an old share link (8tracks.com/mixes/12345), paste that instead."));
        if (typeof err.path === "string" && /^\/[A-Za-z0-9._~-]+\/[A-Za-z0-9._~-]+$/.test(err.path)) {
          n.append(el("p", null, el("a", { href: "https://web.archive.org/web/*/8tracks.com" + err.path + "*" }, "See everything the Wayback Machine saved at this address")));
        }
        break;
      }
      case "TRACKS_NOT_ARCHIVED": {
        n.append(headline(message));
        var page = err.page && typeof err.page === "object" ? err.page : null;
        if (page && typeof page.title === "string") {
          n.append(el("p", null, "The page is for “", page.title, "” (mix number " + String(err.mixId || "") + ")."));
        }
        n.append(el("p", null, "Listeners often named songs in the comments, so the archived page may still hold clues."));
        if (page && safeHref(page.pageUrl)) n.append(el("p", null, el("a", { href: page.pageUrl }, "Open the archived page")));
        break;
      }
      case "ARCHIVE_UNAVAILABLE":
      case "BUSY":
      case "RATE_LIMITED": {
        var retry = el("button", { class: "btn", type: "button" }, "Try again");
        retry.addEventListener("click", function () { run($("url").value); });
        n.append(headline(message || "The service is busy."), el("p", null, retry));
        break;
      }
      case "CLIENT_TIMEOUT":
        n.append(headline("That took too long."), el("p", null, "The Wayback Machine may be slow right now. Try again in a minute."));
        break;
      case "NETWORK":
        n.append(headline("Couldn't reach the service."), el("p", null, "Check your internet connection and try again."));
        break;
      default:
        n.append(headline(message || "Something went wrong. Try again later."));
    }
  }

  // ---------- showing a result ----------

  function certChip(c) {
    if (c !== "gold" && c !== "platinum" && c !== "diamond") return null;
    return el("span", { class: "cert " + c }, c.charAt(0).toUpperCase() + c.slice(1));
  }
  function youtube(t) { return "https://www.youtube.com/results?search_query=" + encodeURIComponent(t.artist + " " + t.title); }
  function spotify(t) { return "https://open.spotify.com/search/" + encodeURIComponent(t.artist + " " + t.title); }

  function coverImage(cover) {
    var src = safeCoverSrc(cover);
    if (!src) return null;
    var img = el("img", { class: "cover", alt: "", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
    img.addEventListener("error", function () {
      var head = img.parentNode;
      img.remove();
      if (head) head.classList.add("no-cover");
    });
    img.src = src;
    return img;
  }
  function safeCoverSrc(cover) {
    try {
      var u = new URL(cover);
      if (u.protocol !== "https:" || u.hostname !== "images.8tracks.com") return null;
      return "https://web.archive.org/web/2019im_/" + u.href;
    } catch { return null; }
  }

  function render(r) {
    var m = r.mix;
    var bits = [];
    if (m.user) bits.push("By " + m.user + ".");
    if (m.published) bits.push("Published " + fmtDate.format(Date.parse(m.published)) + ".");
    bits.push(r.tracks.length + " tracks" + (m.durationSec ? ", " + duration(m.durationSec) : "") + ".");
    if (typeof m.plays === "number") bits.push(nf.format(m.plays) + " plays" + (typeof m.likes === "number" ? " and " + nf.format(m.likes) + " likes." : "."));

    var out = $("result");
    clear(out);

    if (r.warning) {
      out.append(el("div", { class: "notice warn", role: "note" }, el("p", null, el("span", { class: "headline" }, "Heads up: "), r.warning)));
    }

    var cover = coverImage(m.cover);
    out.append(el("div", { class: cover ? "head" : "head no-cover" },
      cover,
      el("div", null,
        el("h2", null, m.name || "Mix " + m.id),
        el("p", { class: "meta" }, bits.join(" "), " ", certChip(m.certification)))));

    if (Array.isArray(m.tags) && m.tags.length) {
      var tags = el("ul", { class: "tags", "aria-label": "Tags" });
      m.tags.forEach(function (t) { tags.append(el("li", null, t)); });
      out.append(tags);
    }
    if (m.description) out.append(el("p", { class: "desc" }, m.description));

    var copy = el("button", { class: "btn dark", type: "button" }, "Copy tracklist");
    copy.addEventListener("click", function () { copyText(asText()); });
    var txt = el("button", { class: "btn", type: "button" }, "Download .txt");
    txt.addEventListener("click", function () { download(fileBase() + ".txt", asText(), "text/plain"); });
    var csv = el("button", { class: "btn", type: "button" }, "Download .csv");
    csv.addEventListener("click", function () { download(fileBase() + ".csv", asCsv(), "text/csv"); });
    out.append(el("div", { class: "actions" },
      copy, txt, csv,
      r.page && safeHref(r.page.pageUrl) ? el("a", { class: "btn", href: r.page.pageUrl }, "Archived page") : null,
      r.sources && safeHref(r.sources.trackFileUrl) ? el("a", { class: "btn", href: r.sources.trackFileUrl }, "Saved track file") : null));

    if (typeof m.trackCountOnSite === "number" && m.trackCountOnSite !== r.tracks.length) {
      out.append(el("p", { class: "count-note" }, "8tracks listed " + m.trackCountOnSite + " tracks for this mix, but the saved file has " + r.tracks.length + "."));
    }

    var list = el("ol", { class: "tracks" });
    r.tracks.forEach(function (t, i) {
      list.append(el("li", null,
        el("span", { class: "no" }, String(i + 1)),
        el("span", { class: "t" },
          t.title,
          el("span", { class: "a" }, t.artist),
          t.release ? el("span", { class: "r" }, t.release + (t.year ? ", " + t.year : "")) : null),
        el("span", { class: "listen" },
          el("a", { href: youtube(t), "aria-label": "Search YouTube for " + t.title }, "YouTube"),
          el("a", { href: spotify(t), "aria-label": "Search Spotify for " + t.title }, "Spotify"))));
    });
    out.append(list);

    var page = r.page ? stampToText(r.page.pageCapture) : "";
    var file = r.sources ? stampToText(r.sources.trackFileCapture) : "";
    out.append(el("p", { class: "sources" },
      "Mix number " + m.id + "." + (page ? " Page copy saved " + page + "." : "") + (file ? " Track file copy saved " + file + "." : "")));
    out.hidden = false;
  }

  // ---------- copy and download ----------

  function fileBase() {
    var m = current.mix;
    var slug = m.url ? m.url.split("/").pop() : "";
    return /^[A-Za-z0-9._~-]{1,150}$/.test(slug || "") ? slug : "mix-" + m.id;
  }
  function asText() {
    var m = current.mix;
    return (m.name || "Mix " + m.id) + (m.url ? "\n" + m.url : "") + "\n\n" +
      current.tracks.map(function (t, i) { return (i + 1) + ". " + t.artist + " – " + t.title; }).join("\n") + "\n";
  }
  function asCsv() {
    // Prefix cells that spreadsheet apps would treat as formulas.
    var cell = function (v) {
      v = v === null || v === undefined ? "" : String(v);
      if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
      return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    var rows = [["number", "title", "artist", "release", "year", "youtube_url"]];
    current.tracks.forEach(function (t, i) {
      rows.push([i + 1, t.title, t.artist, t.release, t.year, t.youtubeId ? "https://www.youtube.com/watch?v=" + t.youtubeId : ""]);
    });
    return rows.map(function (r) { return r.map(cell).join(","); }).join("\n") + "\n";
  }
  function download(name, text, type) {
    var url = URL.createObjectURL(new Blob([text], { type: type + ";charset=utf-8" }));
    var a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { toast("Tracklist copied"); }, function () { toast("Your browser blocked copying"); });
    } else {
      toast("Copying isn't available here. Use Download .txt instead.");
    }
  }

  // ---------- wiring ----------

  document.addEventListener("DOMContentLoaded", function () {
    $("form").addEventListener("submit", function (e) { e.preventDefault(); run($("url").value); });
    document.addEventListener("click", function (e) {
      var chip = e.target instanceof Element ? e.target.closest(".chip[data-url]") : null;
      if (chip) run(chip.dataset.url);
    });
    showRecent();
    var start = null;
    try { start = new URLSearchParams(location.search).get("url"); } catch { /* ignore */ }
    if (start) run(start); else $("url").focus();
  });
})();
