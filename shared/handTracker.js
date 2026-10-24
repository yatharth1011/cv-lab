// Thin wrapper around MediaPipe Tasks Vision HandLandmarker (+ optional FaceDetector).
// Runs entirely on-device (WASM/GPU) — no video ever leaves the machine.

export const LM = {
  WRIST: 0,
  THUMB_TIP: 4,
  INDEX_TIP: 8,
  MIDDLE_TIP: 12,
  RING_TIP: 16,
  PINKY_TIP: 20,
};

const VISION_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const HAND_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const FACE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";

export class HandTracker extends EventTarget {
  constructor({ numHands = 2, trackFace = false } = {}) {
    super();
    this.numHands = numHands;
    this.trackFace = trackFace;
    this.video = document.createElement("video");
    this.video.playsInline = true;
    this.video.muted = true;
    this.landmarker = null;
    this.faceDetector = null;
    this.running = false;
    this._raf = null;
  }

  async init(onProgress) {
    onProgress?.("Loading vision engine…");
    const { HandLandmarker, FaceDetector, FilesetResolver } = await import(
      /* webpackIgnore: true */ `${VISION_CDN}/vision_bundle.mjs`
    );
    const vision = await FilesetResolver.forVisionTasks(`${VISION_CDN}/wasm`);
    onProgress?.("Loading hand-landmark model…");
    this.landmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate: "GPU" },
      runningMode: "VIDEO",
      numHands: this.numHands,
      // Lower than the SDK defaults: fast strikes/swipes cause motion blur, which
      // tanks landmark confidence right when apps like Slash/Beat most need a
      // detection. Staying locked on through blur matters more here than precision.
      minHandDetectionConfidence: 0.4,
      minHandPresenceConfidence: 0.4,
      minTrackingConfidence: 0.4,
    });

    if (this.trackFace) {
      onProgress?.("Loading face-tracking model…");
      this.faceDetector = await FaceDetector.createFromOptions(vision, {
        baseOptions: { modelAssetPath: FACE_MODEL_URL, delegate: "GPU" },
        runningMode: "VIDEO",
        minDetectionConfidence: 0.5,
      });
    }
  }

  async start(onProgress) {
    onProgress?.("Requesting camera access…");
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    this.video.srcObject = stream;
    await this.video.play();
    await new Promise((resolve) => {
      if (this.video.readyState >= 2) resolve();
      else this.video.onloadeddata = () => resolve();
    });
    this.running = true;
    this._loop();
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    const stream = this.video.srcObject;
    stream?.getTracks().forEach((t) => t.stop());
  }

  _loop = () => {
    if (!this.running) return;
    if (this.video.readyState >= 2 && this.landmarker) {
      const ts = performance.now();
      const result = this.landmarker.detectForVideo(this.video, ts);

      let face = null;
      if (this.faceDetector) {
        const faceResult = this.faceDetector.detectForVideo(this.video, ts);
        const d = faceResult.detections && faceResult.detections[0];
        if (d) {
          const box = d.boundingBox;
          const vw = this.video.videoWidth;
          const vh = this.video.videoHeight;
          face = {
            x: (box.originX + box.width / 2) / vw,
            y: (box.originY + box.height / 2) / vh,
            size: (box.width / vw + box.height / vh) / 2,
          };
        }
      }

      this.dispatchEvent(
        new CustomEvent("results", {
          detail: {
            hands: result.landmarks || [],
            face,
            width: this.video.videoWidth,
            height: this.video.videoHeight,
            video: this.video,
            t: ts,
          },
        })
      );
    }
    this._raf = requestAnimationFrame(this._loop);
  };
}
