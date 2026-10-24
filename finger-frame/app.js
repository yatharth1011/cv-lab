import { HandTracker, LM } from "../shared/handTracker.js";
import { coverTransform, mapPoint, SmoothedPoint, fmtFps } from "../shared/utils.js";

const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d");
const hint = document.getElementById("hint");
const handsDot = document.getElementById("handsDot");
const handsLabel = document.getElementById("handsLabel");
const fpsPill = document.getElementById("fpsPill");
const filtersEl = document.getElementById("filters");
const shutter = document.getElementById("shutter");
const flash = document.getElementById("flash");
const loader = document.getElementById("loader");
const loaderText = document.getElementById("loaderText");
const errorScreen = document.getElementById("errorScreen");
const errorText = document.getElementById("errorText");

// ---------- filters ----------
const FILTERS = [
  { id: "classic", label: "Classic" },
  { id: "noir", label: "Noir" },
  { id: "invert", label: "Invert" },
  { id: "thermal", label: "Thermal" },
  { id: "cyberpunk", label: "Cyberpunk" },
  { id: "vhs", label: "VHS" },
  { id: "pixelate", label: "Pixelate" },
  { id: "dreamy", label: "Dreamy" },
];
let currentFilter = "cyberpunk";

const tmpSmall = document.createElement("canvas");
const tmpSmallCtx = tmpSmall.getContext("2d");

function drawFullFrame(ctx, video, t, filterCss) {
  ctx.filter = filterCss || "none";
  ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight, t.dx, t.dy, t.dw, t.dh);
  ctx.filter = "none";
}

const FILTER_FX = {
  classic: (ctx, video, t) => drawFullFrame(ctx, video, t, "contrast(1.1) saturate(1.15)"),
  noir: (ctx, video, t) => drawFullFrame(ctx, video, t, "grayscale(1) contrast(1.35) brightness(0.92)"),
  invert: (ctx, video, t) => drawFullFrame(ctx, video, t, "invert(1) saturate(1.4) hue-rotate(10deg)"),
  thermal: (ctx, video, t) =>
    drawFullFrame(ctx, video, t, "grayscale(1) sepia(1) hue-rotate(180deg) saturate(6) contrast(1.15)"),
  cyberpunk: (ctx, video, t) => {
    drawFullFrame(ctx, video, t, "saturate(2.1) hue-rotate(255deg) contrast(1.15)");
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = 0.4;
    ctx.filter = "hue-rotate(320deg) saturate(3)";
    ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight, t.dx - 5, t.dy, t.dw, t.dh);
    ctx.filter = "none";
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  },
  vhs: (ctx, video, t) => {
    drawFullFrame(ctx, video, t, "contrast(1.25) saturate(1.5) brightness(1.02)");
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = 0.28;
    ctx.filter = "none";
    ctx.fillStyle = "#ff2b6d";
    ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight, t.dx - 3, t.dy, t.dw, t.dh);
    ctx.fillStyle = "#00e5ff";
    ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight, t.dx + 3, t.dy, t.dw, t.dh);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = "rgba(0,0,0,0.18)";
    ctx.lineWidth = 1;
    for (let y = t.dy; y < t.dy + t.dh; y += 3) {
      ctx.beginPath();
      ctx.moveTo(t.dx, y);
      ctx.lineTo(t.dx + t.dw, y);
      ctx.stroke();
    }
  },
  pixelate: (ctx, video, t) => {
    const size = 22;
    tmpSmall.width = size;
    tmpSmall.height = size;
    tmpSmallCtx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight, 0, 0, size, size);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmpSmall, t.dx, t.dy, t.dw, t.dh);
    ctx.imageSmoothingEnabled = true;
  },
  dreamy: (ctx, video, t) => drawFullFrame(ctx, video, t, "blur(3.5px) brightness(1.18) saturate(1.35)"),
};

function buildFilterChips() {
  FILTERS.forEach((f) => {
    const btn = document.createElement("button");
    btn.className = "btn filter-chip" + (f.id === currentFilter ? " active" : "");
    btn.textContent = f.label;
    btn.onclick = () => {
      currentFilter = f.id;
      [...filtersEl.children].forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
    };
    filtersEl.appendChild(btn);
  });
}
buildFilterChips();

// ---------- rendering ----------
function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

const smoothers = {
  A_thumb: new SmoothedPoint(0.55),
  A_index: new SmoothedPoint(0.55),
  B_thumb: new SmoothedPoint(0.55),
  B_index: new SmoothedPoint(0.55),
};

let lastTs = performance.now();
let fpsSmoothed = 0;
let handsPresent = 0;

function drawQuadPath(ctx, quad) {
  ctx.beginPath();
  ctx.moveTo(quad[0].x, quad[0].y);
  for (let i = 1; i < quad.length; i++) ctx.lineTo(quad[i].x, quad[i].y);
  ctx.closePath();
}

function drawFilteredQuad(video, t, quad) {
  ctx.save();
  drawQuadPath(ctx, quad);
  ctx.clip();
  (FILTER_FX[currentFilter] || FILTER_FX.classic)(ctx, video, t);
  ctx.restore();
}

function drawFrameBorder(quad, time) {
  ctx.save();
  drawQuadPath(ctx, quad);
  const grad = ctx.createLinearGradient(quad[0].x, quad[0].y, quad[2].x, quad[2].y);
  grad.addColorStop(0, "#7dd3fc");
  grad.addColorStop(0.5, "#f0abfc");
  grad.addColorStop(1, "#fde68a");
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = grad;
  ctx.shadowColor = "rgba(165,243,252,0.9)";
  ctx.shadowBlur = 22;
  ctx.setLineDash([16, 10]);
  ctx.lineDashOffset = -(time / 24);
  ctx.stroke();
  ctx.restore();
}

function drawFingerDots(quad) {
  quad.forEach((p) => {
    const r = 7;
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3.2);
    g.addColorStop(0, "rgba(255,255,255,0.95)");
    g.addColorStop(0.35, "rgba(125,211,252,0.55)");
    g.addColorStop(1, "rgba(125,211,252,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 0.45, 0, Math.PI * 2);
    ctx.fill();
  });
}

function onResults({ hands, width, height, video, t: nowTs }) {
  if (!width || !height) return;
  const dt = nowTs - lastTs;
  lastTs = nowTs;
  fpsSmoothed = fpsSmoothed ? fpsSmoothed * 0.9 + fmtFps(dt) * 0.1 : fmtFps(dt);
  fpsPill.textContent = `${Math.round(fpsSmoothed)} fps`;

  const cw = canvas.width;
  const ch = canvas.height;
  const t = coverTransform(width, height, cw, ch);

  ctx.clearRect(0, 0, cw, ch);
  drawFullFrame(ctx, video, t, "brightness(0.98)");

  handsPresent = hands.length;
  if (hands.length >= 2) {
    hint.hidden = true;
    handsDot.classList.add("on");
    handsLabel.textContent = "2 hands · framing";

    const sorted = hands
      .slice(0, 2)
      .map((h) => ({ h, cx: (h[LM.THUMB_TIP].x + h[LM.INDEX_TIP].x) / 2 }))
      .sort((a, b) => a.cx - b.cx);
    const [A, B] = sorted;

    const aThumb = smoothers.A_thumb.update(...toXY(mapPoint(A.h[LM.THUMB_TIP], t)));
    const aIndex = smoothers.A_index.update(...toXY(mapPoint(A.h[LM.INDEX_TIP], t)));
    const bIndex = smoothers.B_index.update(...toXY(mapPoint(B.h[LM.INDEX_TIP], t)));
    const bThumb = smoothers.B_thumb.update(...toXY(mapPoint(B.h[LM.THUMB_TIP], t)));

    const quad = [
      { x: aThumb.x, y: aThumb.y },
      { x: aIndex.x, y: aIndex.y },
      { x: bIndex.x, y: bIndex.y },
      { x: bThumb.x, y: bThumb.y },
    ];

    drawFilteredQuad(video, t, quad);
    drawFrameBorder(quad, nowTs);
    drawFingerDots(quad);
    lastQuad = quad;
  } else {
    hint.hidden = false;
    handsDot.classList.remove("on");
    handsLabel.textContent = hands.length === 1 ? "1 hand · need both" : "searching…";
    lastQuad = null;
  }
}

function toXY(p) {
  return [p.x, p.y];
}

let lastQuad = null;

// ---------- capture ----------
function showToast(msg) {
  let toast = document.querySelector(".toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast glass";
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  requestAnimationFrame(() => toast.classList.add("show"));
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove("show"), 1600);
}

shutter.addEventListener("click", () => {
  const out = document.createElement("canvas");
  out.width = canvas.width;
  out.height = canvas.height;
  const octx = out.getContext("2d");
  octx.translate(out.width, 0);
  octx.scale(-1, 1);
  octx.drawImage(canvas, 0, 0);
  out.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `frame-${Date.now()}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }, "image/png");
  flash.classList.remove("go");
  void flash.offsetWidth;
  flash.classList.add("go");
  showToast("Saved to downloads");
});

// ---------- boot ----------
async function boot() {
  try {
    const tracker = new HandTracker({ numHands: 2 });
    await tracker.init((msg) => (loaderText.textContent = msg));
    await tracker.start((msg) => (loaderText.textContent = msg));
    tracker.addEventListener("results", (e) => onResults(e.detail));
    loader.classList.add("hidden");
  } catch (err) {
    console.error(err);
    loader.classList.add("hidden");
    errorScreen.classList.add("show");
    if (err && err.name === "NotAllowedError") {
      errorText.textContent = "Camera permission was denied. Allow camera access for this site and reload.";
    } else if (err && err.name === "NotFoundError") {
      errorText.textContent = "No camera was found on this device.";
    } else {
      errorText.textContent = "Something went wrong loading the vision model or camera. Check your connection and reload.";
    }
  }
}
boot();
