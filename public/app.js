// Spool web page: paste links, watch them back to back. No build step, no framework.

const $ = (sel) => document.querySelector(sel);
const player = $("#player");
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

let videos = [];
let currentId = store.get("spool.current", null);
let loadedId = null; // the id whose file is in the <video> element
let pendingAutoplay = false; // start the current video once its download finishes
let pollTimer = null;
let lastSaved = 0;
let toastTimer = null;

// ---------- api ----------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body && typeof opts.body === "string" ? { "content-type": "application/json", ...opts.headers } : opts.headers,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error("unauthorized");
  }
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw Object.assign(new Error(data?.error || `HTTP ${res.status}`), { data });
  return data;
}

const patch = (id, body) => api(`/api/videos/${id}`, { method: "PATCH", body: JSON.stringify(body) });

// ---------- helpers ----------

function fmtDuration(s) {
  if (!s && s !== 0) return "";
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? h + ":" : ""}${mm}:${String(sec).padStart(2, "0")}`;
}
function fmtSize(b) {
  if (!b) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i >= 2 ? 1 : 0)} ${u[i]}`;
}
function label(v) {
  return v.title || v.url.replace(/^https?:\/\/(www\.)?/, "");
}
function toast(msg, ms = 4000) {
  const el = $("#toast");
  el.textContent = msg;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => (el.textContent = ""), ms);
}
const queue = () => videos.filter((v) => !v.watched);
const byId = (id) => videos.find((v) => v.id === id);

function statusLine(v) {
  switch (v.status) {
    case "queued": return v.watched ? "Watched" : "Waiting to download";
    case "downloading": return `Downloading ${Math.round((v.progress || 0) * 100)}%`;
    case "ready": return [v.channel, fmtSize(v.size)].filter(Boolean).join(" · ") || "Ready";
    case "failed": return "Download failed";
    case "cleared": return "Watched · file cleaned up";
    default: return v.status;
  }
}

// ---------- rendering ----------

const nodes = new Map();

function renderItem(v) {
  let li = nodes.get(v.id);
  if (!li) {
    li = $("#item-tpl").content.firstElementChild.cloneNode(true);
    li.dataset.id = v.id;
    nodes.set(v.id, li);
    wireDrag(li);
  }
  const img = li.querySelector("img");
  if (v.thumbnail && img.getAttribute("src") !== v.thumbnail) img.src = v.thumbnail;
  li.querySelector(".dur").textContent = fmtDuration(v.duration);
  li.querySelector(".title").textContent = label(v);
  const sub = li.querySelector(".sub");
  sub.textContent = v.watched
    ? [v.channel, v.status === "cleared" ? "file cleaned up" : "watched"].filter(Boolean).join(" · ")
    : statusLine(v);
  const bar = li.querySelector(".bar");
  bar.hidden = v.status !== "downloading";
  bar.firstElementChild.style.width = `${Math.round((v.progress || 0) * 100)}%`;
  const err = li.querySelector(".err");
  err.hidden = !(v.status === "failed" && v.error);
  err.textContent = v.error || "";
  li.querySelector('[data-act="retry"]').hidden = v.status !== "failed";
  li.querySelector('[data-act="unwatch"]').hidden = !v.watched;
  li.querySelector('[data-act="up"]').hidden = v.watched;
  li.querySelector('[data-act="down"]').hidden = v.watched;
  li.draggable = !v.watched;
  li.classList.toggle("playing", v.id === currentId && !v.watched);
  return li;
}

function render() {
  const q = queue();
  const w = videos.filter((v) => v.watched).sort((a, b) => (b.watchedAt || 0) - (a.watchedAt || 0));
  const qEl = $("#queue"), wEl = $("#watched");
  q.forEach((v) => qEl.appendChild(renderItem(v)));
  w.forEach((v) => wEl.appendChild(renderItem(v)));
  const live = new Set(videos.map((v) => v.id));
  for (const [id, li] of nodes) if (!live.has(id)) { li.remove(); nodes.delete(id); }

  $("#queue-empty").hidden = q.length > 0;
  const total = q.reduce((s, v) => s + (v.duration || 0), 0);
  $("#count").textContent = q.length ? `${q.length}${total ? " · " + fmtDuration(total) : ""}` : "";
  $("#watched-wrap").hidden = w.length === 0;
  $("#watched-count").textContent = w.length ? String(w.length) : "";
  renderNow();
}

function renderNow() {
  const v = byId(currentId);
  const empty = !v || v.watched;
  $("#player-empty").hidden = !!loadedId;
  if (empty) {
    $("#now-title").textContent = queue().length ? "Pick something to play" : "Nothing playing";
    $("#now-sub").textContent = "";
  } else {
    $("#now-title").textContent = label(v);
    $("#now-sub").textContent =
      v.status === "ready" ? v.channel || "" :
      v.status === "failed" ? "This one failed to download. Retry it or skip ahead." :
      `Waiting for the download: ${statusLine(v).toLowerCase()}`;
  }
  const q = queue();
  const idx = q.findIndex((x) => x.id === currentId);
  $("#btn-next").disabled = !q.length || idx === q.length - 1;
  $("#btn-prev").disabled = !q.length || idx <= 0;
}

// ---------- playback ----------

function setCurrent(id) {
  currentId = id;
  store.set("spool.current", id);
}

function play(id, { autoplay = true } = {}) {
  const v = byId(id);
  if (!v) return;
  setCurrent(id);
  if (v.status === "ready" && v.src) {
    if (loadedId !== id) {
      loadedId = id;
      player.src = v.src;
      const resume = v.resumeAt || 0;
      player.addEventListener("loadedmetadata", () => {
        if (resume > 5 && (!player.duration || resume < player.duration - 10)) player.currentTime = resume;
      }, { once: true });
    }
    if (autoplay) player.play().catch(() => {});
    setMediaSession(v);
  } else {
    // Not downloaded yet: wait, and the poll loop starts it when it's ready.
    loadedId = null;
    player.removeAttribute("src");
    player.load();
    pendingAutoplay = autoplay;
  }
  render();
}
function nextAfter(id) {
  const q = queue();
  const idx = q.findIndex((v) => v.id === id);
  const rest = idx === -1 ? q : q.slice(idx + 1);
  return rest.find((v) => v.status !== "failed") || null;
}
function prevBefore(id) {
  const q = queue();
  const idx = q.findIndex((v) => v.id === id);
  return idx > 0 ? q[idx - 1] : null;
}

async function finishCurrent() {
  const id = currentId;
  const next = nextAfter(id);
  const v = byId(id);
  if (v) {
    v.watched = true;
    v.watchedAt = Date.now();
    patch(id, { watched: true }).catch(() => {});
  }
  if (next && $("#autoplay").checked) play(next.id);
  else {
    loadedId = null;
    setCurrent(next ? next.id : null);
    player.removeAttribute("src");
    player.load();
    if (next) play(next.id, { autoplay: false });
    render();
  }
}

function skip(dir) {
  const target = dir > 0 ? nextAfter(currentId) : prevBefore(currentId);
  if (target) play(target.id);
}

player.addEventListener("ended", finishCurrent);
player.addEventListener("timeupdate", () => {
  const now = Date.now();
  if (loadedId && now - lastSaved > 5000) {
    lastSaved = now;
    patch(loadedId, { resumeAt: Math.floor(player.currentTime) }).catch(() => {});
  }
});
player.addEventListener("pause", () => {
  if (loadedId && !player.ended) patch(loadedId, { resumeAt: Math.floor(player.currentTime) }).catch(() => {});
});
player.addEventListener("error", () => {
  if (loadedId) toast("This file won't play in this browser. Try another browser or re-download it.");
});

function setMediaSession(v) {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: label(v),
    artist: v.channel || "",
    artwork: v.thumbnail ? [{ src: new URL(v.thumbnail, location.href).href, sizes: "640x360", type: "image/jpeg" }] : [],
  });
  navigator.mediaSession.setActionHandler("nexttrack", () => skip(1));
  navigator.mediaSession.setActionHandler("previoustrack", () => skip(-1));
}

$("#btn-next").addEventListener("click", () => skip(1));
$("#btn-prev").addEventListener("click", () => skip(-1));
const autoplayBox = $("#autoplay");
autoplayBox.checked = store.get("spool.autoplay", true);
autoplayBox.addEventListener("change", () => store.set("spool.autoplay", autoplayBox.checked));

document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea")) return;
  if (e.key === "n" || e.key === "N") skip(1);
  if (e.key === "p" || e.key === "P") skip(-1);
});

// ---------- queue actions ----------

async function reorder(ids) {
  const pos = new Map(ids.map((id, i) => [id, i]));
  videos.sort((a, b) => (a.watched - b.watched) || ((pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9)));
  render();
  await api("/api/reorder", { method: "POST", body: JSON.stringify({ ids }) }).catch(() => refresh());
}

function move(id, delta) {
  const ids = queue().map((v) => v.id);
  const i = ids.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  reorder(ids);
}

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const li = btn.closest(".item");
  const id = Number(li.dataset.id);
  const v = byId(id);
  switch (btn.dataset.act) {
    case "play":
      if (v?.watched) {
        await patch(id, { watched: false }).catch(() => {});
        await refresh();
      }
      play(id);
      break;
    case "up": move(id, -1); break;
    case "down": move(id, 1); break;
    case "retry":
      await api(`/api/videos/${id}/retry`, { method: "POST" }).catch((err) => toast(err.message));
      refresh();
      break;
    case "unwatch":
      await patch(id, { watched: false }).catch((err) => toast(err.message));
      refresh();
      break;
    case "remove": {
      if (id === currentId) {
        const next = nextAfter(id);
        loadedId = null;
        player.removeAttribute("src");
        player.load();
        setCurrent(next ? next.id : null);
      }
      videos = videos.filter((x) => x.id !== id);
      render();
      await api(`/api/videos/${id}`, { method: "DELETE" }).catch(() => {});
      refresh();
      break;
    }
  }
});

$("#btn-clear").addEventListener("click", async () => {
  const n = videos.filter((v) => v.watched).length;
  if (!confirm(`Remove ${n} watched video${n === 1 ? "" : "s"} and delete their files?`)) return;
  await api("/api/clear-watched", { method: "POST" }).catch((err) => toast(err.message));
  refresh();
});

// Drag to reorder (mouse). On phones, use the arrows.
let dragId = null;
function wireDrag(li) {
  li.addEventListener("dragstart", (e) => {
    dragId = Number(li.dataset.id);
    li.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });
  li.addEventListener("dragend", () => {
    li.classList.remove("dragging");
    document.querySelectorAll(".drop-above").forEach((x) => x.classList.remove("drop-above"));
    dragId = null;
  });
  li.addEventListener("dragover", (e) => {
    if (dragId === null || byId(Number(li.dataset.id))?.watched) return;
    e.preventDefault();
    document.querySelectorAll(".drop-above").forEach((x) => x.classList.remove("drop-above"));
    li.classList.add("drop-above");
  });
  li.addEventListener("drop", (e) => {
    e.preventDefault();
    const target = Number(li.dataset.id);
    if (dragId === null || dragId === target) return;
    const ids = queue().map((v) => v.id).filter((x) => x !== dragId);
    ids.splice(ids.indexOf(target), 0, dragId);
    reorder(ids);
  });
}

// ---------- adding links ----------

async function addLinks(text) {
  if (!/https?:\/\//i.test(text)) {
    toast("No links found in that.");
    return;
  }
  toast("Adding…", 0);
  try {
    const r = await api("/api/videos", { method: "POST", body: JSON.stringify({ text }) });
    const parts = [`Added ${r.added}`];
    if (r.skipped) parts.push(`${r.skipped} already in the queue`);
    if (r.errors?.length) parts.push(`${r.errors.length} couldn't be read`);
    toast(parts.join(", ") + ".");
    await refresh();
    if (!currentId || !byId(currentId) || byId(currentId).watched) {
      const first = queue()[0];
      if (first) play(first.id);
    }
  } catch (err) {
    if (err.message !== "unauthorized") toast(err.data?.error || err.message);
  }
}

const links = $("#links");
$("#add-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = links.value.trim();
  if (!text) return;
  links.value = "";
  autosize();
  addLinks(text);
});
links.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("#add-form").requestSubmit();
  }
});
links.addEventListener("paste", () => setTimeout(() => { if (/https?:\/\//i.test(links.value)) $("#add-form").requestSubmit(); }, 0));
function autosize() {
  links.style.height = "auto";
  links.style.height = `${Math.min(links.scrollHeight, 160)}px`;
}
links.addEventListener("input", autosize);
// Paste anywhere on the page to add.
document.addEventListener("paste", (e) => {
  if (e.target.closest("input, textarea")) return;
  const text = e.clipboardData?.getData("text") || "";
  if (/https?:\/\//i.test(text)) addLinks(text);
});

// ---------- polling ----------

async function refresh() {
  try {
    const state = await api("/api/state");
    videos = state.videos;
    if (currentId && !byId(currentId)) setCurrent(null);
    // Start a video we were waiting on as soon as it finishes downloading.
    const cur = byId(currentId);
    if (cur && !cur.watched && cur.status === "ready" && loadedId !== cur.id && (pendingAutoplay || !loadedId)) {
      const auto = pendingAutoplay;
      pendingAutoplay = false;
      play(cur.id, { autoplay: auto });
    } else if (!currentId) {
      const first = queue().find((v) => v.status === "ready");
      if (first) play(first.id, { autoplay: false });
    }
    render();
    schedule(state.videos.some((v) => v.status === "downloading" || (v.status === "queued" && !v.watched)) ? 2000 : 8000);
  } catch (err) {
    if (err.message !== "unauthorized") schedule(10000);
  }
}
function schedule(ms) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(refresh, document.hidden ? Math.max(ms, 15000) : ms);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

// ---------- sign in ----------

function showLogin() {
  $("#app").hidden = true;
  $("#login").hidden = false;
  $("#password").focus();
}
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#login-error");
  err.hidden = true;
  try {
    await api("/api/login", { method: "POST", body: JSON.stringify({ password: $("#password").value }) });
    $("#login").hidden = true;
    start();
  } catch (ex) {
    err.textContent = ex.data?.error || "Couldn't sign in.";
    err.hidden = false;
  }
});

// ---------- boot ----------

function start() {
  $("#app").hidden = false;
  const add = `${location.origin}/add?url=`;
  $("#bookmarklet").href = `javascript:(()=>{window.open('${add}'+encodeURIComponent(location.href),'spool')})()`;
  $("#bookmarklet").addEventListener("click", (e) => {
    e.preventDefault();
    toast("Drag that link to your bookmarks bar, then click it on any YouTube page.");
  });
  refresh().then(() => {
    const cur = byId(currentId);
    if (cur && !cur.watched) play(cur.id, { autoplay: false });
  });
}

api("/api/session").then((s) => (s.needsPassword && !s.authed ? showLogin() : start())).catch(() => start());
