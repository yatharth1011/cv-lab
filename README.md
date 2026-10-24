# CV Lab

Three real-time, on-device computer-vision apps built on [MediaPipe HandLandmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker) (+ a lightweight face detector for Air Keys). Everything runs locally in the browser via WASM/GPU — no video is ever uploaded anywhere.

- **Frame** (`finger-frame/`) — bring your thumbs and index fingers together to draw a live quadrilateral "viewfinder" and drop one of eight filters inside it (Noir, Invert, Thermal, Cyberpunk, VHS, Pixelate, Dreamy, Classic). Tap the shutter to save a PNG.
- **Air Keys** (`air-piano/`) — a theremin for your hands, spatialized in true 3D. Each hand is an independent, continuously-gliding voice: how high you hold it sets the pitch, which side it's on (relative to your own detected head, not the camera) sets the register, and how open it is sets the tone's fullness. Audio is rendered with a binaural HRTF panner positioned relative to your head, so reaching a hand behind your head genuinely pans the sound behind you on headphones — not just left/right.
- **Slash** (`slash/`) — a two-hand slicing game. Swipe through flying orbs for points, dodge bombs, chase combo multipliers, and watch for linked "twin" orbs — those only pay their big bonus if a *different* hand slices each one within the time window. Score, lives, and a persisted high score.

## Run it

Camera access requires a secure context, so open these over `localhost` (not `file://`):

```bash
cd "cv"
python3 -m http.server 8000
```

Then open `http://localhost:8000` and pick an app. Allow camera access when prompted.

## Notes

- Requires a recent Chrome, Edge, or Safari with WebGPU/WebGL support for best performance.
- The hand-tracking model and WASM runtime load from a CDN on first run (~10MB), then everything runs locally.
- No build step, no dependencies to install — plain ES modules.
