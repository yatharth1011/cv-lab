import { HandTracker, LM } from "../shared/handTracker.js";
import { coverTransform, mapPoint, clamp, lerp, fmtFps } from "../shared/utils.js";

const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d");
const hint = document.getElementById("hint");
const handsDot = document.getElementById("handsDot");
const handsLabel = document.getElementById("handsLabel");
const loader = document.getElementById("loader");
const loaderText = document.getElementById("loaderText");
const errorScreen = document.getElementById("errorScreen");
const errorText = document.getElementById("errorText");
const volumeSlider = document.getElementById("volume");
const toneSelect = document.getElementById("toneSelect");

const hudEls = [
  {
    root: document.getElementById("hudLower"),
    note: document.getElementById("hudLowerNote"),
    fill: document.getElementById("hudLowerFill"),
    distFill: document.getElementById("hudLowerDistFill"),
    dist: document.getElementById("hudLowerDist"),
  },
  {
    root: document.getElementById("hudUpper"),
    note: document.getElementById("hudUpperNote"),
    fill: document.getElementById("hudUpperFill"),
    distFill: document.getElementById("hudUpperDistFill"),
    dist: document.getElementById("hudUpperDist"),
  },
];

// ---------- registers: two 2-octave bands, left = low, right = high ----------
const REGISTERS = [
  { fLow: 65.41, fHigh: 261.63, color: [125, 211, 252] }, // C2 -> C4
  { fLow: 261.63, fHigh: 1046.5, color: [240, 171, 252] }, // C4 -> C6
];

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function freqToNote(freq) {
  const midi = 69 + 12 * Math.log2(freq / 440);
  const rounded = Math.round(midi);
  const cents = Math.round((midi - rounded) * 100);
  const name = NOTE_NAMES[((rounded % 12) + 12) % 12];
  const octave = Math.floor(rounded / 12) - 1;
  return { name: `${name}${octave}`, cents };
}

const TOP_Y = 0.12;
const BOTTOM_Y = 0.88;
function heightToFactor(y) {
  const k = clamp((y - TOP_Y) / (BOTTOM_Y - TOP_Y), 0, 1);
  return 1 - k; // 1 = top of frame = highest pitch
}

const TIMBRES = {
  warm: { core: "triangle", layer: "triangle", oct: "sine" },
  glass: { core: "sine", layer: "sine", oct: "sine" },
  bright: { core: "sawtooth", layer: "sawtooth", oct: "square" },
};
let currentTimbre = "warm";

// ---------- spatial mapping: hand position IN 3D RELATIVE TO THE USER'S OWN HEAD ----------
// We detect the user's head (not just assume the camera is the listener), so a hand
// held to either side, above/below, or reached back behind the head pans correctly —
// including truly "behind" you, which the camera alone can't tell you from "in front".
const SPATIAL_WIDTH = 2.0; // meters, full left-right span relative to the head
const SPATIAL_HEIGHT = 1.3; // meters, full up-down span relative to the head
const REF_HAND_SIZE = 0.16; // normalized wrist->knuckle span treated as "1m from camera"
const REF_FACE_SIZE = 0.32; // normalized face box size treated as "1m from camera"
const REL_DEPTH_RANGE = 0.8; // meters, how far in front/behind counts as "fully" there
const DIST_NEAR = 0.3;
const DIST_FAR = 2.6;

function distanceWetAmount(absRelDepth) {
  return 0.03 + clamp(absRelDepth / REL_DEPTH_RANGE, 0, 1) * 0.5;
}

// ---------- audio engine: two continuously-gliding, spatially-positioned voices ----------
class Voice {
  constructor(ctx, master, convolver) {
    this.ctx = ctx;
    this.master = master;
    this.convolver = convolver;
    this.active = false;
    this.nodes = null;
  }

  start(state) {
    const { freq, openness, x, y, z, distance } = state;
    const t = this.ctx.currentTime;
    const timbre = TIMBRES[currentTimbre];

    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 900 + openness * 4500;

    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.5, t + 0.09);

    const core = this.ctx.createOscillator();
    core.type = timbre.core;
    core.frequency.value = freq;
    const coreGain = this.ctx.createGain();
    coreGain.gain.value = 0.55;
    core.connect(coreGain).connect(filter);

    const layerA = this.ctx.createOscillator();
    layerA.type = timbre.layer;
    layerA.frequency.value = freq;
    layerA.detune.value = 10;
    const layerB = this.ctx.createOscillator();
    layerB.type = timbre.layer;
    layerB.frequency.value = freq;
    layerB.detune.value = -10;
    const layerGain = this.ctx.createGain();
    layerGain.gain.value = openness * 0.4;
    layerA.connect(layerGain).connect(filter);
    layerB.connect(layerGain).connect(filter);

    const oct = this.ctx.createOscillator();
    oct.type = timbre.oct;
    oct.frequency.value = freq * 2;
    const octGain = this.ctx.createGain();
    octGain.gain.value = openness * 0.28;
    oct.connect(octGain).connect(filter);

    const panner = this.ctx.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "inverse";
    panner.refDistance = 0.5;
    panner.maxDistance = 3;
    panner.rolloffFactor = 1.1;
    this._setPosition(panner, x, y, z, t, true);

    const distWet = this.ctx.createGain();
    distWet.gain.value = distanceWetAmount(distance);

    filter.connect(env);
    env.connect(panner);
    panner.connect(this.master);
    panner.connect(distWet).connect(this.convolver);

    [core, layerA, layerB, oct].forEach((o) => o.start(t));

    this.nodes = { core, layerA, layerB, oct, filter, env, coreGain, layerGain, octGain, panner, distWet };
    this.active = true;
  }

  update(state) {
    if (!this.active) return;
    const { freq, openness, x, y, z, distance } = state;
    const t = this.ctx.currentTime;
    const { core, layerA, layerB, oct, filter, layerGain, octGain, panner, distWet } = this.nodes;
    const glide = 0.06;
    core.frequency.setTargetAtTime(freq, t, glide);
    layerA.frequency.setTargetAtTime(freq, t, glide);
    layerB.frequency.setTargetAtTime(freq, t, glide);
    oct.frequency.setTargetAtTime(freq * 2, t, glide);
    filter.frequency.setTargetAtTime(900 + openness * 4500, t, 0.08);
    layerGain.gain.setTargetAtTime(openness * 0.4, t, 0.08);
    octGain.gain.setTargetAtTime(openness * 0.28, t, 0.08);
    this._setPosition(panner, x, y, z, t, false);
    distWet.gain.setTargetAtTime(distanceWetAmount(distance), t, 0.15);
  }

  _setPosition(panner, x, y, z, t, immediate) {
    if (panner.positionX) {
      if (immediate) {
        panner.positionX.value = x;
        panner.positionY.value = y;
        panner.positionZ.value = z;
      } else {
        panner.positionX.setTargetAtTime(x, t, 0.08);
        panner.positionY.setTargetAtTime(y, t, 0.08);
        panner.positionZ.setTargetAtTime(z, t, 0.08);
      }
    } else if (panner.setPosition) {
      panner.setPosition(x, y, z);
    }
  }

  stop() {
    if (!this.active || !this.nodes) return;
    const t = this.ctx.currentTime;
    const { core, layerA, layerB, oct, env } = this.nodes;
    env.gain.cancelScheduledValues(t);
    env.gain.setValueAtTime(env.gain.value, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    [core, layerA, layerB, oct].forEach((o) => o.stop(t + 0.32));
    this.active = false;
    this.nodes = null;
  }
}

class Engine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.voices = [null, null];
  }

  ensure() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();

    const listener = this.ctx.listener;
    if (listener.positionX) {
      listener.positionX.value = 0;
      listener.positionY.value = 0;
      listener.positionZ.value = 0;
      listener.forwardX.value = 0;
      listener.forwardY.value = 0;
      listener.forwardZ.value = -1;
      listener.upX.value = 0;
      listener.upY.value = 1;
      listener.upZ.value = 0;
    } else if (listener.setOrientation) {
      listener.setPosition(0, 0, 0);
      listener.setOrientation(0, 0, -1, 0, 1, 0);
    }

    this.master = this.ctx.createGain();
    this.master.gain.value = parseFloat(volumeSlider.value);

    const dry = this.ctx.createGain();
    dry.gain.value = 0.72;
    const wet = this.ctx.createGain();
    wet.gain.value = 0.3;
    const convolver = this.ctx.createConvolver();
    convolver.buffer = this._impulse(2.6, 2.6);

    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    limiter.connect(this.ctx.destination);

    this.master.connect(dry).connect(limiter);
    this.master.connect(convolver); // baseline ambience for every voice
    convolver.connect(wet).connect(limiter); // + each voice's distance-scaled extra send joins here too

    this.voices = [new Voice(this.ctx, this.master, convolver), new Voice(this.ctx, this.master, convolver)];
  }

  _impulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const len = rate * seconds;
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const data = buf.getChannelData(c);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  setVolume(v) {
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  setSlot(i, target) {
    this.ensure();
    const voice = this.voices[i];
    if (target) {
      if (!voice.active) voice.start(target);
      else voice.update(target);
    } else if (voice.active) {
      voice.stop();
    }
  }
}
const engine = new Engine();

volumeSlider.addEventListener("input", () => engine.setVolume(parseFloat(volumeSlider.value)));
toneSelect.addEventListener("click", (e) => {
  const btn = e.target.closest(".tone-opt");
  if (!btn) return;
  [...toneSelect.children].forEach((c) => c.classList.remove("active"));
  btn.classList.add("active");
  currentTimbre = btn.dataset.tone;
});

// ---------- particles ----------
const particles = [];
function spawnSparkle(x, y, hue, count) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const speed = 0.6 + Math.random() * 1.6;
    particles.push({ x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed - 0.6, life: 1, hue });
  }
}
function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx * dt * 0.06;
    p.y += p.vy * dt * 0.06;
    p.vy += 0.04 * dt * 0.06;
    p.life -= dt * 0.002;
    if (p.life <= 0) particles.splice(i, 1);
  }
}
function drawParticles() {
  particles.forEach((p) => {
    ctx.globalAlpha = clamp(p.life, 0, 1);
    ctx.fillStyle = `hsl(${p.hue}, 90%, 72%)`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3 * p.life + 1, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;
}

// ---------- resize ----------
function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

// ---------- hand skeleton + halo ----------
const CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];
function drawHand(hand, t, rgb, openness) {
  ctx.save();
  const lineAlpha = 0.55 + openness * 0.35;
  ctx.strokeStyle = `rgba(${rgb.join(",")},${lineAlpha})`;
  ctx.lineWidth = 1.6 + openness * 1.8;
  ctx.shadowColor = `rgba(${rgb.join(",")},0.9)`;
  ctx.shadowBlur = 6 + openness * 14;
  ctx.beginPath();
  CONNECTIONS.forEach(([a, b]) => {
    const pa = mapPoint(hand[a], t);
    const pb = mapPoint(hand[b], t);
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
  });
  ctx.stroke();
  ctx.restore();
}

function drawHalo(center, rgb, openness) {
  const radius = (34 + openness * 110) * (Math.min(window.devicePixelRatio || 1, 2));
  const g = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, radius);
  g.addColorStop(0, `rgba(${rgb.join(",")},${0.35 + openness * 0.25})`);
  g.addColorStop(1, `rgba(${rgb.join(",")},0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
  ctx.fill();
}

// ---------- openness metric ----------
const FINGERTIPS = [LM.THUMB_TIP, LM.INDEX_TIP, LM.MIDDLE_TIP, LM.RING_TIP, LM.PINKY_TIP];
function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function computeOpenness(hand) {
  const wrist = hand[LM.WRIST];
  const handSize = dist(wrist, hand[9]) || 0.001;
  const avg = FINGERTIPS.reduce((sum, idx) => sum + dist(hand[idx], wrist), 0) / FINGERTIPS.length;
  const ratio = avg / handSize;
  return clamp((ratio - 1.15) / (2.3 - 1.15), 0, 1);
}

// Apparent hand/face size shrinks with distance from the camera (~inverse-proportional
// to real-world distance for an object of roughly fixed physical size). These give us
// two independent camera-distance estimates that we then difference to get hand-vs-head
// relative depth — the actual signal we care about, so the absolute calibration of
// either constant matters less than them being roughly consistent with each other.
function computeHandDistance(hand) {
  const handSize = dist(hand[LM.WRIST], hand[9]) || 0.001;
  return clamp(REF_HAND_SIZE / handSize, DIST_NEAR, DIST_FAR);
}
function computeHeadDistance(face) {
  return clamp(REF_FACE_SIZE / Math.max(face.size, 0.001), DIST_NEAR, DIST_FAR);
}

// ---------- head tracking state (the listener's actual reference point) ----------
// Defaults approximate "face roughly centered, one arm's length away" so hands are
// still playable for the few frames before the face model locks on.
const headState = { xRaw: 0.5, y: 0.42, mirroredX: 0.5, distance: 1.0 };

function drawHeadMarker(center) {
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([3, 5]);
  ctx.beginPath();
  ctx.arc(center.x, center.y, 30 * Math.min(window.devicePixelRatio || 1, 2), 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// ---------- per-slot smoothed state ----------
const slotState = [
  { factor: 0.5, openness: 0, relDepth: 0, relX: -0.2, relY: 0 },
  { factor: 0.5, openness: 0, relDepth: 0, relX: 0.2, relY: 0 },
];
let sparkleAccum = [0, 0];

let lastTs = performance.now();

function onResults({ hands, face, width, height, video, t: nowTs }) {
  if (!width || !height) return;
  const dt = nowTs - lastTs;
  lastTs = nowTs;

  const cw = canvas.width;
  const ch = canvas.height;
  const t = coverTransform(width, height, cw, ch);

  ctx.clearRect(0, 0, cw, ch);
  ctx.filter = "brightness(0.5) saturate(0.85)";
  ctx.drawImage(video, 0, 0, width, height, t.dx, t.dy, t.dw, t.dh);
  ctx.filter = "none";

  const grad = ctx.createLinearGradient(0, 0, 0, ch);
  grad.addColorStop(0, "rgba(5,6,10,0.1)");
  grad.addColorStop(1, "rgba(5,6,10,0.55)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, cw, ch);

  handsLabel.textContent = hands.length ? `${hands.length} hand${hands.length > 1 ? "s" : ""} · playing` : "searching…";
  handsDot.classList.toggle("on", hands.length > 0);
  hint.hidden = hands.length > 0;

  if (face) {
    headState.xRaw = lerp(headState.xRaw, face.x, 0.2);
    headState.mirroredX = lerp(headState.mirroredX, 1 - face.x, 0.2);
    headState.y = lerp(headState.y, face.y, 0.2);
    headState.distance = lerp(headState.distance, computeHeadDistance(face), 0.15);
    drawHeadMarker(mapPoint({ x: headState.xRaw, y: headState.y }, t));
  }

  // classify up to two hands into [lower-slot, upper-slot] by position relative to the HEAD
  const withMeta = hands.map((hand) => {
    const wrist = hand[LM.WRIST];
    const mid = hand[9];
    const mirroredX = 1 - (wrist.x + mid.x) / 2;
    const centerY = (wrist.y + mid.y) / 2;
    return {
      hand,
      centerY,
      openness: computeOpenness(hand),
      relX: mirroredX - headState.mirroredX,
      relY: headState.y - centerY,
      relDepth: computeHandDistance(hand) - headState.distance, // + = behind head, - = in front
    };
  });
  withMeta.sort((a, b) => a.relX - b.relX);

  const slots = [null, null];
  if (withMeta.length === 1) {
    slots[withMeta[0].relX < 0 ? 0 : 1] = withMeta[0];
  } else if (withMeta.length >= 2) {
    slots[0] = withMeta[0];
    slots[1] = withMeta[withMeta.length - 1];
  }

  slots.forEach((meta, i) => {
    const hud = hudEls[i];
    if (!meta) {
      hud.root.classList.remove("show");
      engine.setSlot(i, null);
      return;
    }
    const targetFactor = heightToFactor(meta.centerY);
    const st = slotState[i];
    st.factor = lerp(st.factor, targetFactor, 0.22);
    st.openness = lerp(st.openness, meta.openness, 0.18);
    st.relDepth = lerp(st.relDepth, meta.relDepth, 0.15);
    st.relX = lerp(st.relX, meta.relX, 0.2);
    st.relY = lerp(st.relY, meta.relY, 0.2);

    const reg = REGISTERS[i];
    const freq = reg.fLow * Math.pow(reg.fHigh / reg.fLow, st.factor);

    // 3D point around the listener's own head: offset-from-head -> azimuth/elevation,
    // hand-vs-head camera-distance difference -> depth (+Z behind, -Z in front of face).
    const px = st.relX * SPATIAL_WIDTH;
    const py = st.relY * SPATIAL_HEIGHT;
    const pz = st.relDepth;

    engine.setSlot(i, { freq, openness: st.openness, distance: Math.abs(st.relDepth), x: px, y: py, z: pz });

    const note = freqToNote(freq);
    hud.note.textContent = note.name;
    hud.fill.style.width = `${Math.round(st.openness * 100)}%`;

    const relClamped = clamp(st.relDepth / REL_DEPTH_RANGE, -1, 1);
    const pct = Math.abs(relClamped) * 50;
    hud.distFill.style.width = `${pct}%`;
    hud.distFill.style.left = relClamped >= 0 ? "50%" : `${50 - pct}%`;
    const absM = Math.abs(st.relDepth);
    hud.dist.textContent = absM < 0.12 ? "at head" : `${absM.toFixed(1)}m ${st.relDepth >= 0 ? "behind" : "in front"}`;
    hud.root.classList.add("show");

    drawHand(meta.hand, t, reg.color, st.openness);
    const center = mapPoint({ x: (meta.hand[LM.WRIST].x + meta.hand[9].x) / 2, y: (meta.hand[LM.WRIST].y + meta.hand[9].y) / 2 }, t);
    drawHalo(center, reg.color, st.openness);

    sparkleAccum[i] += dt;
    const interval = 220 - st.openness * 160;
    if (sparkleAccum[i] > interval) {
      sparkleAccum[i] = 0;
      spawnSparkle(center.x, center.y, i === 0 ? 195 : 300, 1 + Math.round(st.openness * 4));
    }
  });

  updateParticles(dt || 16);
  drawParticles();
}

// ---------- boot ----------
async function boot() {
  try {
    const tracker = new HandTracker({ numHands: 2, trackFace: true });
    await tracker.init((msg) => (loaderText.textContent = msg));
    await tracker.start((msg) => (loaderText.textContent = msg));
    tracker.addEventListener("results", (e) => onResults(e.detail));
    loader.classList.add("hidden");
    document.body.addEventListener("pointerdown", () => engine.ensure(), { once: true });
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
