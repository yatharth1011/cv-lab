// Small shared math/canvas helpers used by both CV apps.

/** Computes a "background-size: cover" style transform so a video of
 * size (vw,vh) fully fills a canvas of size (cw,ch), centered & cropped. */
export function coverTransform(vw, vh, cw, ch) {
  const scale = Math.max(cw / vw, ch / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  return { dx: (cw - dw) / 2, dy: (ch - dh) / 2, dw, dh };
}

/** Maps a normalized (0..1) landmark point through a cover transform
 * into canvas pixel space. */
export function mapPoint(lm, t) {
  return { x: t.dx + lm.x * t.dw, y: t.dy + lm.y * t.dh };
}

/** Same as mapPoint, but horizontally mirrored — for canvases that mirror
 * the video via drawing math instead of a CSS transform (so that text/emoji
 * drawn on the same canvas stay right-reading instead of flipping too). */
export function mapMirroredPoint(lm, t, canvasWidth) {
  return { x: canvasWidth - (t.dx + lm.x * t.dw), y: t.dy + lm.y * t.dh };
}

export function lerp(a, b, k) {
  return a + (b - a) * k;
}

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/** Cheap exponential smoothing for jitter-free landmark motion. */
export class SmoothedPoint {
  constructor(factor = 0.5) {
    this.factor = factor;
    this.x = null;
    this.y = null;
  }
  update(x, y) {
    if (this.x === null) {
      this.x = x;
      this.y = y;
    } else {
      this.x = lerp(this.x, x, this.factor);
      this.y = lerp(this.y, y, this.factor);
    }
    return this;
  }
}

export function fmtFps(dtMs) {
  if (!dtMs) return "--";
  return Math.round(1000 / dtMs);
}

/** Does the segment p0->p1 pass through circle (cx,cy,r)? Used for fast-motion
 * hit detection (slicing/striking) — checking only the endpoint's distance to
 * the circle misses hits where the tracked point "jumps" past the target
 * between two frames, which happens constantly at real swing/strike speeds. */
export function segmentHitsCircle(p0, p1, cx, cy, r) {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const fx = p0.x - cx;
  const fy = p0.y - cy;
  const a = dx * dx + dy * dy;
  if (a < 1e-6) return Math.hypot(fx, fy) <= r;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return false;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  const t2 = (-b + sq) / (2 * a);
  return (t1 >= 0 && t1 <= 1) || (t2 >= 0 && t2 <= 1) || (t1 < 0 && t2 > 1);
}
