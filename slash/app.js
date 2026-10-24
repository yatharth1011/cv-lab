import { HandTracker, LM } from "../shared/handTracker.js";
import { coverTransform, mapMirroredPoint, clamp, segmentHitsCircle } from "../shared/utils.js";

const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d");
const loader = document.getElementById("loader");
const loaderText = document.getElementById("loaderText");
const errorScreen = document.getElementById("errorScreen");
const errorText = document.getElementById("errorText");
const startScreen = document.getElementById("startScreen");
const overScreen = document.getElementById("overScreen");
const startBtn = document.getElementById("startBtn");
const retryBtn = document.getElementById("retryBtn");
const scoreVal = document.getElementById("scoreVal");
const bestVal = document.getElementById("bestVal");
const livesVal = document.getElementById("livesVal");
const finalScore = document.getElementById("finalScore");
const overHigh = document.getElementById("overHigh");
const newHighBadge = document.getElementById("newHighBadge");
const comboPop = document.getElementById("comboPop");

// ---------- resize (this canvas mirrors via drawing math, not CSS, so text/emoji stay legible) ----------
function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

// ---------- SFX: tiny synthesized sound engine, no audio files ----------
class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuffer = null;
  }
  ensure() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;
    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.ratio.value = 10;
    this.master.connect(limiter).connect(this.ctx.destination);

    const len = this.ctx.sampleRate * 0.5;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buf;
  }
  _noise(duration, filterFreq, filterType, gainPeak) {
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(filterFreq, t);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gainPeak, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + duration + 0.05);
    return { src, filter, g, t };
  }
  slice(pitchVariant = 0) {
    this.ensure();
    const t = this.ctx.currentTime;
    const { filter } = this._noise(0.18, 3200 + pitchVariant * 400, "bandpass", 0.5);
    filter.frequency.exponentialRampToValueAtTime(900, t + 0.15);
    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(1400 + pitchVariant * 200, t);
    osc.frequency.exponentialRampToValueAtTime(300, t + 0.09);
    const og = this.ctx.createGain();
    og.gain.setValueAtTime(0.18, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    osc.connect(og).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.1);
  }
  bomb() {
    this.ensure();
    const t = this.ctx.currentTime;
    this._noise(0.4, 800, "lowpass", 0.7);
    const osc = this.ctx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(180, t);
    osc.frequency.exponentialRampToValueAtTime(40, t + 0.35);
    const og = this.ctx.createGain();
    og.gain.setValueAtTime(0.3, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    osc.connect(og).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.4);
  }
  combo(step) {
    this.ensure();
    const t = this.ctx.currentTime;
    const base = 520 + step * 90;
    [1, 1.25, 1.5].forEach((mul, i) => {
      const osc = this.ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = base * mul;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t + i * 0.045);
      g.gain.linearRampToValueAtTime(0.16, t + i * 0.045 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.045 + 0.22);
      osc.connect(g).connect(this.master);
      osc.start(t + i * 0.045);
      osc.stop(t + i * 0.045 + 0.24);
    });
  }
  twinBonus() {
    this.ensure();
    const t = this.ctx.currentTime;
    [660, 990, 1320].forEach((f, i) => {
      const osc = this.ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = f;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t + i * 0.06);
      g.gain.linearRampToValueAtTime(0.22, t + i * 0.06 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.06 + 0.4);
      osc.connect(g).connect(this.master);
      osc.start(t + i * 0.06);
      osc.stop(t + i * 0.06 + 0.42);
    });
  }
  lifeLost() {
    this.ensure();
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(200, t);
    osc.frequency.exponentialRampToValueAtTime(60, t + 0.3);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.22, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.32);
  }
  gameOver() {
    this.ensure();
    const t = this.ctx.currentTime;
    [440, 370, 294, 220].forEach((f, i) => {
      const osc = this.ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = f;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t + i * 0.13);
      g.gain.linearRampToValueAtTime(0.2, t + i * 0.13 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.13 + 0.3);
      osc.connect(g).connect(this.master);
      osc.start(t + i * 0.13);
      osc.stop(t + i * 0.13 + 0.32);
    });
  }
}
const sfx = new Sfx();

// ---------- game state ----------
const HIGH_SCORE_KEY = "slash-highscore";
const state = {
  mode: "start", // start | playing | over
  score: 0,
  lives: 3,
  combo: 0,
  comboExpire: 0,
  high: parseInt(localStorage.getItem(HIGH_SCORE_KEY) || "0", 10),
  elapsed: 0,
  shake: 0,
};
bestVal.textContent = state.high;

const FRUITS = ["🍉", "🍊", "🍇", "🍋", "🍓", "🥝"];
let orbs = [];
let particles = [];
let nextSpawnAt = 0;
let nextTwinId = 1;

function resetGame() {
  state.mode = "playing";
  state.score = 0;
  state.lives = 3;
  state.combo = 0;
  state.comboExpire = 0;
  state.elapsed = 0;
  orbs = [];
  particles = [];
  nextSpawnAt = 800;
  scoreVal.textContent = "0";
  updateLivesUI();
  startScreen.hidden = true;
  overScreen.hidden = true;
}

function updateLivesUI() {
  livesVal.textContent = "❤️".repeat(Math.max(state.lives, 0)) + "🖤".repeat(Math.max(3 - state.lives, 0));
}

function endGame() {
  if (state.mode !== "playing") return;
  state.mode = "over";
  sfx.gameOver();
  const beat = state.score > state.high;
  if (beat) {
    state.high = state.score;
    localStorage.setItem(HIGH_SCORE_KEY, String(state.high));
  }
  finalScore.textContent = state.score;
  overHigh.textContent = state.high;
  bestVal.textContent = state.high;
  newHighBadge.hidden = !beat;
  overScreen.hidden = false;
}

startBtn.addEventListener("click", () => {
  sfx.ensure();
  resetGame();
});
retryBtn.addEventListener("click", () => {
  sfx.ensure();
  resetGame();
});

// ---------- combo popup ----------
const COMBO_LABELS = ["", "", "GOOD!", "GREAT!", "AMAZING!", "INSANE!", "UNSTOPPABLE!"];
function popCombo(text, color) {
  comboPop.textContent = text;
  comboPop.style.color = color;
  comboPop.classList.remove("go");
  void comboPop.offsetWidth;
  comboPop.classList.add("go");
}

// ---------- orbs ----------
function spawnOrb(opts = {}) {
  const cw = canvas.width;
  const ch = canvas.height;
  const speedScale = 1 + state.elapsed * 0.012;
  const x = opts.x ?? cw * (0.12 + Math.random() * 0.76);
  const vy = -(ch * (0.78 + Math.random() * 0.22)) * speedScale;
  const vx = (Math.random() - 0.5) * cw * 0.22;
  orbs.push({
    x,
    y: ch + 60,
    vx,
    vy,
    r: opts.r || cw * 0.032,
    type: opts.type || "fruit",
    emoji: opts.emoji || FRUITS[(Math.random() * FRUITS.length) | 0],
    sliced: false,
    dead: false,
    slicedByHand: -1,
    twinId: opts.twinId || null,
    twinPartner: null,
    spin: (Math.random() - 0.5) * 4,
    rot: 0,
  });
  return orbs[orbs.length - 1];
}

function spawnTwinPair() {
  const cw = canvas.width;
  const id = nextTwinId++;
  const emoji = FRUITS[(Math.random() * FRUITS.length) | 0];
  const a = spawnOrb({ x: cw * (0.18 + Math.random() * 0.18), type: "twin", emoji, twinId: id });
  const b = spawnOrb({ x: cw * (0.64 + Math.random() * 0.18), type: "twin", emoji, twinId: id });
  a.twinPartner = b;
  b.twinPartner = a;
  a.twinBonusAt = b.twinBonusAt = performance.now() + 2200;
}

function scheduleSpawn() {
  const cw = canvas.width;
  const roll = Math.random();
  if (roll < 0.08) {
    spawnOrb({ type: "bomb", emoji: "💣", r: cw * 0.03 });
  } else if (roll < 0.14) {
    spawnOrb({ type: "star", emoji: "⭐" });
  } else if (roll < 0.2) {
    spawnTwinPair();
  } else {
    spawnOrb({});
  }
}

// ---------- particles ----------
function burst(x, y, color, count = 14) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const speed = 2 + Math.random() * 5;
    particles.push({
      x,
      y,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed,
      life: 1,
      color,
      r: 2 + Math.random() * 3,
    });
  }
}

function updateParticles(dtSec) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx * dtSec * 60;
    p.y += p.vy * dtSec * 60;
    p.vy += 9 * dtSec;
    p.life -= dtSec * 1.6;
    if (p.life <= 0) particles.splice(i, 1);
  }
}
function drawParticles() {
  particles.forEach((p) => {
    ctx.globalAlpha = clamp(p.life, 0, 1);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;
}

// ---------- hand trails + slicing ----------
const TRAILS = [
  { points: [], color: "125,211,252" },
  { points: [], color: "240,171,252" },
];
const SLICE_SPEED_MIN = 900; // canvas px/sec, in mirrored/visual space

function sliceOrb(orb, handIdx) {
  if (orb.sliced || orb.dead) return;
  orb.sliced = true;
  orb.slicedByHand = handIdx;
  const trailColor = `rgb(${TRAILS[handIdx].color})`;

  if (orb.type === "bomb") {
    sfx.bomb();
    state.lives -= 1;
    state.combo = 0;
    state.shake = 18;
    updateLivesUI();
    burst(orb.x, orb.y, "#fb7185", 26);
    popCombo("BOOM!", "#fb7185");
    orb.dead = true;
    if (state.lives <= 0) setTimeout(endGame, 260);
    return;
  }

  const now = performance.now();
  state.combo = now < state.comboExpire ? state.combo + 1 : 1;
  state.comboExpire = now + 1100;
  const mult = Math.min(1 + Math.floor(state.combo / 2) * 0.5, 4);

  let points = orb.type === "star" ? 50 : 10;

  if (
    orb.type === "twin" &&
    orb.twinPartner &&
    orb.twinPartner.sliced &&
    orb.twinPartner.slicedByHand !== handIdx &&
    now < orb.twinBonusAt
  ) {
    points = 150;
    sfx.twinBonus();
    burst(orb.x, orb.y, "#fde68a", 30);
    burst(orb.twinPartner.x, orb.twinPartner.y, "#fde68a", 20);
    popCombo("TWIN BONUS +150", "#fde68a");
  } else {
    sfx.slice((Math.random() - 0.5) * 2);
    burst(orb.x, orb.y, orb.type === "star" ? "#fde68a" : trailColor, 16);
    if (state.combo >= 2) {
      const label = COMBO_LABELS[Math.min(state.combo, COMBO_LABELS.length - 1)];
      if (label) popCombo(`${label} x${mult.toFixed(1)}`, "#7dd3fc");
      if (state.combo % 2 === 0) sfx.combo(Math.min(state.combo, 8));
    }
  }

  state.score += Math.round(points * mult);
  scoreVal.textContent = state.score;
  orb.dead = true;
}

function updateTrailsAndSlice(hands, t) {
  const cw = canvas.width;
  const withX = hands.map((hand) => ({ hand, mx: cw - (t.dx + hand[LM.WRIST].x * t.dw) }));
  withX.sort((a, b) => a.mx - b.mx);

  for (let slot = 0; slot < 2; slot++) {
    const trail = TRAILS[slot];
    const meta = withX[slot];
    if (!meta) {
      trail.points = [];
      continue;
    }
    const tip = mapMirroredPoint(meta.hand[LM.INDEX_TIP], t, cw);
    const now = performance.now();
    trail.points.push({ x: tip.x, y: tip.y, t: now });
    while (trail.points.length > 6) trail.points.shift();

    if (trail.points.length >= 2) {
      const p1 = trail.points[trail.points.length - 1];
      const p0 = trail.points[trail.points.length - 2];
      const dt = Math.max(p1.t - p0.t, 1) / 1000;
      const speed = Math.hypot(p1.x - p0.x, p1.y - p0.y) / dt;
      if (speed > SLICE_SPEED_MIN) {
        for (const orb of orbs) {
          if (orb.sliced || orb.dead) continue;
          if (segmentHitsCircle(p0, p1, orb.x, orb.y, orb.r * 1.3)) {
            sliceOrb(orb, slot);
          }
        }
      }
    }
  }
}

function drawTrails() {
  TRAILS.forEach((trail) => {
    if (trail.points.length < 2) return;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let i = 1; i < trail.points.length; i++) {
      const a = trail.points[i - 1];
      const b = trail.points[i];
      const alpha = i / trail.points.length;
      ctx.strokeStyle = `rgba(${trail.color},${alpha * 0.9})`;
      ctx.lineWidth = 2 + alpha * 8;
      ctx.shadowColor = `rgba(${trail.color},0.8)`;
      ctx.shadowBlur = 16;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    const tip = trail.points[trail.points.length - 1];
    const g = ctx.createRadialGradient(tip.x, tip.y, 0, tip.x, tip.y, 16);
    g.addColorStop(0, `rgba(${trail.color},0.9)`);
    g.addColorStop(1, `rgba(${trail.color},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });
}

// ---------- orb physics + render ----------
function updateOrbs(dtSec) {
  const gravity = canvas.height * 1.05;
  for (const orb of orbs) {
    orb.vy += gravity * dtSec;
    orb.x += orb.vx * dtSec;
    orb.y += orb.vy * dtSec;
    orb.rot += orb.spin * dtSec;
  }
  for (let i = orbs.length - 1; i >= 0; i--) {
    const orb = orbs[i];
    if (orb.dead) {
      orbs.splice(i, 1);
      continue;
    }
    if (orb.y - orb.r > canvas.height + 80) {
      if (!orb.sliced && orb.type !== "bomb") {
        state.lives -= 1;
        state.combo = 0;
        sfx.lifeLost();
        updateLivesUI();
        if (state.lives <= 0) {
          orbs.splice(i, 1);
          endGame();
          continue;
        }
      }
      orbs.splice(i, 1);
    }
  }
}

function drawOrbs() {
  const linkedDrawn = new Set();
  for (const orb of orbs) {
    if (orb.type === "twin" && orb.twinPartner && !orb.twinPartner.dead && !linkedDrawn.has(orb.twinId)) {
      linkedDrawn.add(orb.twinId);
      ctx.save();
      ctx.strokeStyle = "rgba(253,230,138,0.55)";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]);
      ctx.shadowColor = "rgba(253,230,138,0.6)";
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.moveTo(orb.x, orb.y);
      ctx.lineTo(orb.twinPartner.x, orb.twinPartner.y);
      ctx.stroke();
      ctx.restore();
    }
  }

  for (const orb of orbs) {
    ctx.save();
    ctx.translate(orb.x, orb.y);
    ctx.rotate(orb.rot);
    const glowColor = orb.type === "bomb" ? "255,80,80" : orb.type === "star" ? "253,230,138" : orb.type === "twin" ? "253,230,138" : "255,255,255";
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, orb.r * 2.4);
    g.addColorStop(0, `rgba(${glowColor},0.35)`);
    g.addColorStop(1, `rgba(${glowColor},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, orb.r * 2.4, 0, Math.PI * 2);
    ctx.fill();

    ctx.font = `${orb.r * 1.9}px serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(orb.emoji, 0, 2);
    ctx.restore();
  }
}

// ---------- render ----------
function drawBackground(video, width, height) {
  const cw = canvas.width;
  const ch = canvas.height;
  const t = coverTransform(width, height, cw, ch);
  ctx.save();
  ctx.translate(cw, 0);
  ctx.scale(-1, 1);
  ctx.filter = "brightness(0.55) saturate(0.8)";
  ctx.drawImage(video, 0, 0, width, height, t.dx, t.dy, t.dw, t.dh);
  ctx.filter = "none";
  ctx.restore();

  const grad = ctx.createLinearGradient(0, 0, 0, ch);
  grad.addColorStop(0, "rgba(5,6,10,0.15)");
  grad.addColorStop(1, "rgba(5,6,10,0.55)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, cw, ch);
  return t;
}

let lastTs = performance.now();

function onResults({ hands, width, height, video, t: nowTs }) {
  if (!width || !height) return;
  const dtMs = Math.min(nowTs - lastTs, 50);
  lastTs = nowTs;
  const dtSec = dtMs / 1000;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  if (state.shake > 0) {
    state.shake = Math.max(0, state.shake - dtMs * 0.08);
    const m = state.shake;
    ctx.translate((Math.random() - 0.5) * m, (Math.random() - 0.5) * m);
  }

  const t = drawBackground(video, width, height);

  if (state.mode === "playing") {
    state.elapsed += dtSec;
    nextSpawnAt -= dtMs;
    if (nextSpawnAt <= 0) {
      scheduleSpawn();
      nextSpawnAt = Math.max(360, 950 - state.elapsed * 9) + Math.random() * 260;
    }
    updateOrbs(dtSec);
  }
  // trail always tracks live hands (harmless attract-mode preview when not
  // playing, since there are no orbs to collide with outside "playing")
  updateTrailsAndSlice(hands, t);

  drawOrbs();
  updateParticles(dtSec);
  drawParticles();
  drawTrails();

  ctx.restore();
}

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
