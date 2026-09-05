"""Watch the three students run as one chain on a host webcam: detect, align,
anti-spoof, then recognition against faces enrolled from the served page.

Crops go through the same function the training shards were cut with, JPEG round
trip included. A host webcam is not the OV5640, so nothing printed here belongs
in an acceptance table (KEHOACH 1.2).
"""

from __future__ import annotations

import argparse
import io
import sys
import threading
import time
import urllib.request
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from math import ceil
from pathlib import Path
from typing import NamedTuple

import numpy as np
import torch
from PIL import Image

from facepipe.data.prepare.celeba_spoof_parquet import (
    CROP_QUALITY,
    CROP_SCALES,
    crop_sizes,
    fitted_box,
)
from facepipe.tasks.antispoof.data import CROP_SIZE as SPOOF_SIZE
from facepipe.tasks.antispoof.eval import load_run
from facepipe.tasks.antispoof.losses.task_loss import LIVE
from facepipe.tasks.detection.data import letterbox_params
from facepipe.tasks.detection.eval import decode_batch, load_student, to_original
from facepipe.tasks.detection.student.anchors import feature_sizes, pyramid_priors
from facepipe.tasks.detection.student.yunet import STRIDES
from facepipe.tasks.recognition.eval import embed
from facepipe.tasks.recognition.postproc.align import (
    reference_landmarks,
    similarity_transform,
    warp_affine,
)

DETECT_HW = (120, 160)
DETECT_CONF = 0.5
# 0.997355, fitted on CelebA-Spoof, rejects 12.6% of real faces (measurements 12.4).
SPOOF_THRESHOLD = 0.90
VOTE_FRACTION = 0.6
# Cosine on L2-normalised embeddings, near FAR 1e-3 over the three benchmarks
# (measurements 4.3). A0 pairs, not this protocol, so the page lets you move it.
RECOG_THRESHOLD = 0.45
# Largest share of the face box the picture edge may take while a score still
# describes the person (KEHOACH 3, layer 2).
MAX_FACE_CUT = 0.25
# Below this a column carries no picture, so it is padding the capture path added
# rather than a dark room.
LETTERBOX_LEVEL = 12
ENROLL_FRAMES = 20
GALLERY_NAME = "gallery.npz"
SNAP_DIR = "snaps"
WRITER_FPS = 12.0
SERVE_FPS = 15.0
RECONNECT_WAIT_S = 0.5
READ_TIMEOUT_S = 5.0
READ_CHUNK_BYTES = 8192
MAX_BUFFER_BYTES = 4_000_000


def load_recogniser(run: Path, device: str) -> torch.nn.Module:
    """The recognition student from a run directory, EMA weights when it kept them.

    A run stopped before it beat its own best leaves only last.pth, which is the
    case for the arm's final epoch.
    """
    from facepipe.core.config import load_config
    from facepipe.core.registry import MODELS
    from facepipe.tasks.recognition.student import mobilefacenet  # noqa: F401  registers it

    cfg = load_config(run / "config.resolved.yaml", [])
    model = MODELS.build({"name": cfg.model.name, "params": cfg.model.params})
    path = run / "ckpt" / "best.pth"
    if not path.exists():
        path = run / "ckpt" / "last.pth"
    payload = torch.load(path, map_location="cpu", weights_only=False)
    model.load_state_dict(payload["ema"]["module"] if "ema" in payload else payload["model"])
    print(f"recogniser: {path} at epoch {payload.get('epoch')}")
    return model.to(device).eval()


def load_models(detector: Path, spoof_run: Path, recog_run: Path, device: str):
    """The three students and the priors the detector decodes against."""
    model = load_student(detector).to(device).eval()
    priors = torch.cat(pyramid_priors(feature_sizes(DETECT_HW, STRIDES), STRIDES)).to(device)
    _, spoof = load_run(spoof_run)
    return model, priors, spoof.to(device).eval(), load_recogniser(recog_run, device)


def detect(model, priors, frame_rgb: np.ndarray, device: str):
    """Faces in one frame, in that frame's own pixels, or None."""
    height, width = frame_rgb.shape[:2]
    scale, pad_x, pad_y = letterbox_params((height, width), DETECT_HW)
    canvas = Image.new("RGB", (DETECT_HW[1], DETECT_HW[0]))
    canvas.paste(
        Image.fromarray(frame_rgb).resize((round(width * scale), round(height * scale))),
        (pad_x, pad_y),
    )
    tensor = torch.from_numpy(np.asarray(canvas, dtype=np.float32) / 255.0)
    tensor = tensor.permute(2, 0, 1)[None].to(device)
    with torch.no_grad():
        found = decode_batch(model(tensor), priors, conf=DETECT_CONF)[0]
    if not len(found.boxes):
        return None
    return to_original(found, scale, pad_x, pad_y)


def picture_bounds(frame_rgb: np.ndarray) -> tuple[int, int, int, int]:
    """The part of the frame carrying a picture, as x1, y1, x2, y2."""
    height, width = frame_rgb.shape[:2]
    columns = frame_rgb.mean(axis=(0, 2)) >= LETTERBOX_LEVEL
    rows = frame_rgb.mean(axis=(1, 2)) >= LETTERBOX_LEVEL
    if not columns.any() or not rows.any():
        return 0, 0, width, height
    x1, y1 = int(np.argmax(columns)), int(np.argmax(rows))
    x2 = width - int(np.argmax(columns[::-1]))
    y2 = height - int(np.argmax(rows[::-1]))
    return x1, y1, x2, y2


def framed(box: np.ndarray, bounds: tuple[int, int, int, int]) -> bool:
    """Whether enough of the face is inside the picture for a score to mean anything.

    Judged by area taken rather than by touching, since the edge costs the score
    in proportion to how much of the face it eats (KEHOACH 3, layer 2).
    """
    x1, y1, x2, y2 = (float(v) for v in box)
    left, top, right, bottom = bounds
    whole = max(1.0, (x2 - x1) * (y2 - y1))
    width = max(0.0, min(x2, right) - max(x1, left))
    height = max(0.0, min(y2, bottom) - max(y1, top))
    return 1.0 - (width * height) / whole <= MAX_FACE_CUT


def crops_of(frame_rgb: np.ndarray, box: np.ndarray) -> dict[str, np.ndarray]:
    """Both scales, through the JPEG round trip the shards were written with."""
    image = Image.fromarray(frame_rgb)
    views: dict[str, np.ndarray] = {}
    sizes = crop_sizes()
    for name, scale in CROP_SCALES.items():
        crop, _ = fitted_box(tuple(box), scale, image.width, image.height)
        patch = image.crop(crop)
        buffer = io.BytesIO()
        patch.resize((sizes[name], sizes[name]), Image.BILINEAR).save(
            buffer, format="JPEG", quality=CROP_QUALITY
        )
        buffer.seek(0)
        with Image.open(buffer) as handle:
            decoded = handle.convert("RGB").resize((SPOOF_SIZE, SPOOF_SIZE), Image.BILINEAR)
        views[name] = np.array(decoded, dtype=np.uint8)
    return views


def liveness(spoof, views: dict[str, np.ndarray], device: str) -> float:
    """One score for the pair of crops, higher meaning more live."""

    def as_batch(image: np.ndarray) -> torch.Tensor:
        tensor = torch.from_numpy(image).permute(2, 0, 1).float().div_(255.0)
        return tensor[None].to(device)

    with torch.no_grad():
        logits = spoof((as_batch(views["tight"]), as_batch(views["wide"])))
    return float(logits.softmax(dim=1)[0, LIVE])


def embed_face(recog, frame_rgb: np.ndarray, landmarks: np.ndarray, device: str) -> np.ndarray:
    """One L2-normalised embedding from the five landmarks, aligned to 112x112."""
    matrix = similarity_transform(landmarks.reshape(-1, 2), reference_landmarks())
    face = warp_affine(frame_rgb, matrix)
    return embed(recog, face[None], torch.device(device), flip=True)[0]


class Gallery:
    """Enrolled people, one averaged embedding each, kept on disk between runs.

    Averaging several frames is what makes a single blink or a half-turn stop
    deciding who someone is.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()
        self.names: list[str] = []
        self.vectors = np.zeros((0, 0), dtype=np.float32)
        if path.exists():
            stored = np.load(path, allow_pickle=False)
            self.names = [str(name) for name in stored["names"]]
            self.vectors = stored["vectors"].astype(np.float32)

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        np.savez(self.path, names=np.array(self.names, dtype=str), vectors=self.vectors)

    def add(self, name: str, vector: np.ndarray) -> None:
        with self._lock:
            row = (vector / (np.linalg.norm(vector) + 1e-12)).astype(np.float32)[None]
            if name in self.names:
                self.vectors[self.names.index(name)] = row[0]
            else:
                self.names.append(name)
                self.vectors = row if not len(self.vectors) else np.vstack((self.vectors, row))
            self._save()

    def forget(self, name: str) -> bool:
        with self._lock:
            if name not in self.names:
                return False
            index = self.names.index(name)
            del self.names[index]
            self.vectors = np.delete(self.vectors, index, axis=0)
            self._save()
            return True

    def match(self, vector: np.ndarray) -> tuple[str | None, float]:
        """The closest enrolled person and the cosine to them."""
        with self._lock:
            if not len(self.vectors):
                return None, 0.0
            scores = self.vectors @ (vector / (np.linalg.norm(vector) + 1e-12))
            best = int(np.argmax(scores))
            return self.names[best], float(scores[best])

    def listing(self) -> list[str]:
        with self._lock:
            return list(self.names)


class Enrolment:
    """A capture in progress: a name, and the embeddings gathered for it so far."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.name: str | None = None
        self.taken: list[np.ndarray] = []

    def start(self, name: str) -> None:
        with self._lock:
            self.name, self.taken = name, []

    def cancel(self) -> None:
        with self._lock:
            self.name, self.taken = None, []

    def offer(self, vector: np.ndarray, wanted: int) -> tuple[str, np.ndarray] | None:
        """Add one frame, returning the finished average once enough have landed."""
        with self._lock:
            if self.name is None:
                return None
            self.taken.append(vector)
            if len(self.taken) < wanted:
                return None
            name, mean = self.name, np.mean(self.taken, axis=0)
            self.name, self.taken = None, []
            return name, mean

    def progress(self) -> tuple[str | None, int]:
        with self._lock:
            return self.name, len(self.taken)


def annotate(frame, box, label: str, colour: tuple[int, int, int]) -> None:
    """Draw one call onto the frame, in place."""
    import cv2

    x1, y1, x2, y2 = (int(value) for value in box)
    cv2.rectangle(frame, (x1, y1), (x2, y2), colour, 2)
    cv2.putText(frame, label, (x1, max(20, y1 - 8)), cv2.FONT_HERSHEY_SIMPLEX, 0.7, colour, 2)


class Slot:
    """One value, newest wins.

    A queue would hand the reader a backlog of stale frames while the camera has
    already moved on, which is what makes a stream look laggy rather than slow.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._value = None
        self._version = 0

    def put(self, value) -> None:
        with self._lock:
            self._value = value
            self._version += 1

    def get(self):
        with self._lock:
            return self._value

    def take(self) -> tuple[object, int]:
        """The value beside the count of puts, so a reader can skip what it has seen."""
        with self._lock:
            return self._value, self._version


def read_mjpeg(url: str, frames: Slot, stop: threading.Event) -> None:
    """Split an MJPEG stream on its JPEG markers, reconnecting when it ends.

    The capture backend waits a full thirty seconds before admitting a stream
    has ended, which freezes the page on one image every time the board hands a
    connection back. Reading the socket directly reconnects in under a second.
    """
    import cv2

    while not stop.is_set():
        try:
            response = urllib.request.urlopen(url, timeout=READ_TIMEOUT_S)
            buffer = b""
            while not stop.is_set():
                chunk = response.read(READ_CHUNK_BYTES)
                if not chunk:
                    break
                buffer += chunk
                while True:
                    start = buffer.find(b"\xff\xd8")
                    end = buffer.find(b"\xff\xd9", start + 2)
                    if start < 0 or end < 0:
                        break
                    frame = cv2.imdecode(
                        np.frombuffer(buffer[start : end + 2], np.uint8), cv2.IMREAD_COLOR
                    )
                    buffer = buffer[end + 2 :]
                    if frame is not None:
                        frames.put(frame)
                if len(buffer) > MAX_BUFFER_BYTES:
                    buffer = b""
        except Exception:
            pass
        time.sleep(RECONNECT_WAIT_S)


def poll_snapshots(url: str, frames: Slot, stop: threading.Event, every_s: float) -> None:
    """Fetch single frames on a slow beat.

    The board serves one stream at a time, so when a browser is watching, the
    scorer has to take snapshots instead. Reconnecting twice a second exhausts
    the sockets and takes the whole board down with it, so the beat is slow.
    """
    import cv2

    while not stop.is_set():
        try:
            payload = urllib.request.urlopen(url, timeout=READ_TIMEOUT_S).read()
            frame = cv2.imdecode(np.frombuffer(payload, np.uint8), cv2.IMREAD_COLOR)
            if frame is not None:
                frames.put(frame)
        except Exception:
            pass
        time.sleep(every_s)


def read_into(source, frames: Slot, stop: threading.Event, poll_s: float = 0.0) -> None:
    """Pull frames, reopening the source when it drops."""
    import cv2

    if isinstance(source, str) and source.endswith("/jpg"):
        poll_snapshots(source, frames, stop, poll_s or 1.0)
        return
    if isinstance(source, str) and source.startswith("http"):
        read_mjpeg(source, frames, stop)
        return
    while not stop.is_set():
        capture = cv2.VideoCapture(source)
        while not stop.is_set():
            ok, frame = capture.read()
            if not ok:
                break
            frames.put(frame)
        capture.release()
        time.sleep(RECONNECT_WAIT_S)


class Call(NamedTuple):
    """One verdict, carrying the votes behind it rather than a bare number."""

    box: np.ndarray | None
    score: float
    votes: int
    window: int
    live: bool
    elapsed_ms: float
    who: str | None = None
    similarity: float = 0.0
    gated: bool = True
    framed: bool = True


def call_of(recent: deque[float], threshold: float, vote: float) -> tuple[float, int, bool]:
    """The median of the window, how many frames cleared, and the verdict.

    A mean lets one outlying frame drag the call, and a turning head produces
    those; a fraction of the window has to clear the threshold instead.
    """
    votes = sum(1 for value in recent if value >= threshold)
    needed = max(1, ceil(vote * len(recent)))
    return float(np.median(recent)), votes, votes >= needed


def save_snap(scored: Slot, folder: Path, args) -> str | None:
    """Write the frame, the two crops the model was actually fed, and the call.

    The crops are what a low score has to be read against: a face too near the
    camera leaves no room for the wide view, and that alone moves the score
    (measurements 11.1).
    """
    import json

    import cv2

    latest = scored.get()
    if latest is None:
        return None
    frame, views, call = latest
    height, width = frame.shape[:2]
    reached = {
        name: float(fitted_box(tuple(call.box), scale, width, height)[1])
        for name, scale in CROP_SCALES.items()
    }
    folder.mkdir(parents=True, exist_ok=True)
    stem = f"{time.strftime('%H%M%S')}_spoof{call.score:.4f}"
    cv2.imwrite(str(folder / f"{stem}_frame.jpg"), frame)
    for name, view in views.items():
        cv2.imwrite(str(folder / f"{stem}_{name}.png"), cv2.cvtColor(view, cv2.COLOR_RGB2BGR))
    (folder / f"{stem}.json").write_text(
        json.dumps(
            {
                "spoof_score": float(call.score),
                "votes": call.votes,
                "window": call.window,
                "live": call.live,
                "who": call.who,
                "similarity": float(call.similarity),
                "spoof_threshold": args.threshold,
                "recog_threshold": args.recog_threshold,
                "spoof_gate": call.gated,
                "box_xyxy": [int(v) for v in call.box],
                "frame_hw": [height, width],
                "scale_reached": reached,
            },
            indent=1,
        ),
        encoding="utf-8",
    )
    return stem


def infer_into(
    models,
    frames: Slot,
    calls: Slot,
    scored: Slot,
    stop: threading.Event,
    args,
    gallery: Gallery,
    enrolment: Enrolment,
) -> None:
    """Score each new frame once.

    Scoring whatever is in the slot regardless would re-run the same frame at
    full speed on every core between arrivals.
    """
    import cv2

    model, priors, spoof, recog = models
    recent: deque[float] = deque(maxlen=max(1, args.smooth))
    seen = 0
    while not stop.is_set():
        frame, version = frames.take()
        if frame is None or version == seen:
            time.sleep(0.02)
            continue
        seen = version
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        started = time.perf_counter()
        found = detect(model, priors, rgb, args.device)
        if found is None:
            recent.clear()
            calls.put(Call(None, 0.0, 0, 0, False, (time.perf_counter() - started) * 1000.0))
            continue
        best = int(np.argmax(found.scores))
        box = found.boxes[best]
        if not framed(box, picture_bounds(rgb)):
            recent.clear()
            enrolment.cancel()
            elapsed_ms = (time.perf_counter() - started) * 1000.0
            calls.put(Call(box, 0.0, 0, 0, False, elapsed_ms, framed=False))
            continue
        views = crops_of(rgb, box)
        recent.append(liveness(spoof, views, args.device))
        score, votes, live = call_of(recent, args.threshold, args.vote)

        who, similarity = None, 0.0
        # Recognition runs only behind a live call, so a photo can neither be
        # enrolled nor matched unless the gate is deliberately lifted.
        if live or not args.spoof_gate:
            vector = embed_face(recog, rgb, found.landmarks[best], args.device)
            done = enrolment.offer(vector, args.enroll_frames)
            if done is not None:
                gallery.add(*done)
            name, similarity = gallery.match(vector)
            who = name if similarity >= args.recog_threshold else None
        else:
            enrolment.cancel()

        elapsed_ms = (time.perf_counter() - started) * 1000.0
        call = Call(
            box, score, votes, len(recent), live, elapsed_ms, who, similarity, args.spoof_gate
        )
        calls.put(call)
        scored.put((frame, views, call))


def render(frames: Slot, calls: Slot, threshold: float):
    """The newest frame with the newest call drawn on it, encoded as JPEG."""
    import cv2

    frame = frames.get()
    if frame is None:
        return None
    frame = frame.copy()
    call = calls.get()
    if call is not None and call.box is not None:
        colour = (0, 0, 255)
        verdict = "SPOOF"
        if not call.framed:
            colour = (0, 200, 255)
            verdict = "DUA MAT VAO GIUA KHUNG"
        elif call.live or not call.gated:
            verdict = f"{call.who or 'unknown'} {call.similarity:.3f}"
            colour = (0, 200, 0) if call.who else (0, 165, 255)
            if not call.live:
                verdict = f"{verdict}  SPOOF"
                colour = (0, 0, 255)
        caption = verdict
        if call.framed:
            caption = f"{verdict}  spoof {call.score:.4f}  {call.votes}/{call.window}"
        annotate(frame, call.box, caption, colour)
        gate = "" if call.gated else "  GATE OFF"
        cv2.putText(
            frame,
            f"{call.elapsed_ms:5.1f} ms  thr {threshold:.4f}{gate}",
            (10, frame.shape[0] - 12),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.55,
            (255, 255, 255),
            1,
        )
    ok, buffer = cv2.imencode(".jpg", frame)
    return buffer.tobytes() if ok else None


PAGE = """<body style="margin:0;background:#111;color:#eee;font:14px system-ui;text-align:center">
<img src="/stream" style="max-width:100%">
<div style="padding:10px">
  <input id="who" placeholder="tên người đăng ký" style="padding:6px;font-size:14px">
  <button onclick="post('/enroll?name='+encodeURIComponent(who.value))">Đăng ký</button>
  <span id="busy"></span>
  <div style="margin-top:8px">
    ngưỡng nhận diện <b id="thr"></b>
    <input type="range" min="0" max="0.9" step="0.01" id="slider"
           oninput="thr.textContent=this.value; post('/threshold?value='+this.value)">
  </div>
  <div style="margin-top:8px">
    ngưỡng chống giả <b id="sthr"></b>
    <input type="range" min="0.5" max="0.9999" step="0.0001" id="sslider"
           oninput="sthr.textContent=this.value; post('/spoof-threshold?value='+this.value)">
  </div>
  <div style="margin-top:8px">
    <label><input type="checkbox" id="gate"
           onchange="post('/spoof-gate?value='+(this.checked?0:1))">
    bỏ qua chống giả — nhận diện và đăng ký chạy cả trên ảnh</label>
  </div>
  <div style="margin-top:8px">
    <button onclick="post('/snap')" style="padding:6px 16px;font-size:15px">Chụp khung này</button>
    <span id="snaps"></span>
  </div>
  <div id="list" style="margin-top:8px"></div>
</div>
<script>
function post(url) { fetch(url, {method: 'POST'}).then(refresh); }
function refresh() {
  fetch('/state').then(r => r.json()).then(s => {
    thr.textContent = s.threshold.toFixed(2);
    if (document.activeElement !== slider) slider.value = s.threshold;
    sthr.textContent = s.spoof_threshold.toFixed(4);
    if (document.activeElement !== sslider) sslider.value = s.spoof_threshold;
    gate.checked = !s.spoof_gate;
    document.body.style.background = s.spoof_gate ? '#111' : '#3a1111';
    snaps.textContent = s.snaps ? ` đã lưu ${s.snaps} khung` : '';
    busy.textContent = s.enrolling ? ` đang bắt ${s.taken}/${s.wanted} khung…` : '';
    const drop = n => `post('/forget?name='+encodeURIComponent('${n}'))`;
    list.innerHTML = s.names.length
      ? s.names.map(n => `${n} <button onclick="${drop(n)}">xoá</button>`).join(' &nbsp; ')
      : 'chưa có ai được đăng ký';
  });
}
setInterval(refresh, 700); refresh();
</script></body>"""


def serve(
    frames: Slot,
    calls: Slot,
    scored: Slot,
    stop: threading.Event,
    args,
    gallery: Gallery,
    enrolment: Enrolment,
) -> None:
    """Re-serve the annotated frames as MJPEG, which a browser paces on its own."""
    import json
    from urllib.parse import parse_qs, urlparse

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args) -> None:
            return

        def _reply(self, body: bytes, kind: str = "text/html") -> None:
            self.send_response(200)
            self.send_header("Content-Type", f"{kind}; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:
            parsed = urlparse(self.path)
            value = parse_qs(parsed.query).get("name", parse_qs(parsed.query).get("value", [""]))[0]
            if parsed.path == "/enroll" and value:
                enrolment.start(value)
            elif parsed.path == "/forget":
                gallery.forget(value)
            elif parsed.path == "/threshold":
                args.recog_threshold = float(value)
            elif parsed.path == "/spoof-threshold":
                args.threshold = float(value)
            elif parsed.path == "/spoof-gate":
                args.spoof_gate = value == "1"
            elif parsed.path == "/snap" and save_snap(scored, args.snap_dir, args):
                args.snap_count += 1
            self._reply(b"{}", "application/json")

        def do_GET(self) -> None:
            if self.path == "/state":
                name, taken = enrolment.progress()
                self._reply(
                    json.dumps(
                        {
                            "names": gallery.listing(),
                            "enrolling": name,
                            "taken": taken,
                            "wanted": args.enroll_frames,
                            "threshold": args.recog_threshold,
                            "spoof_threshold": args.threshold,
                            "spoof_gate": args.spoof_gate,
                            "snaps": args.snap_count,
                        }
                    ).encode(),
                    "application/json",
                )
                return
            if self.path != "/stream":
                self._reply(PAGE.encode())
                return
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.end_headers()
            sent = 0
            while not stop.is_set():
                # Sending a frame the browser already has only builds a queue it
                # falls further behind on, which reads as lag rather than as low fps.
                _, version = frames.take()
                if version == sent:
                    time.sleep(0.01)
                    continue
                sent = version
                jpeg = render(frames, calls, args.threshold)
                if jpeg is None:
                    time.sleep(0.05)
                    continue
                try:
                    self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\n")
                    self.wfile.write(f"Content-Length: {len(jpeg)}\r\n\r\n".encode())
                    self.wfile.write(jpeg)
                except (BrokenPipeError, ConnectionResetError):
                    return

    server = ThreadingHTTPServer(("0.0.0.0", args.serve), Handler)
    print(f"open http://localhost:{args.serve} in the browser")
    try:
        server.serve_forever()
    finally:
        stop.set()


def parse_args(argv: list[str] | None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        default="0",
        help="camera index, video file, or an MJPEG url such as http://<ip>:81/stream",
    )
    parser.add_argument("--detector", type=Path, required=True)
    parser.add_argument("--spoof-run", type=Path, required=True, help="a run directory")
    parser.add_argument("--recog-run", type=Path, required=True, help="a run directory")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--threshold", type=float, default=SPOOF_THRESHOLD)
    parser.add_argument("--recog-threshold", type=float, default=RECOG_THRESHOLD)
    parser.add_argument(
        "--enroll-frames",
        type=int,
        default=ENROLL_FRAMES,
        help="live frames averaged into one enrolled face",
    )
    parser.add_argument(
        "--gallery",
        type=Path,
        default=Path("artifacts/recognition") / GALLERY_NAME,
        help="where enrolled faces are kept; biometric data, so never commit it",
    )
    parser.add_argument(
        "--snap-dir",
        type=Path,
        default=Path("artifacts/antispoof") / SNAP_DIR,
        help="where the snap button writes; face images, so never commit it",
    )
    parser.add_argument(
        "--no-spoof-gate",
        dest="spoof_gate",
        action="store_false",
        help="run recognition on every face, live or not, to test the branch on its own",
    )
    parser.add_argument("--save", type=Path, default=None, help="also write an annotated mp4")
    parser.add_argument(
        "--smooth",
        type=int,
        default=5,
        help="frames the call is voted over, since one frame near the threshold flips it",
    )
    parser.add_argument(
        "--vote",
        type=float,
        default=VOTE_FRACTION,
        help="fraction of those frames that must clear the threshold to call it live",
    )
    parser.add_argument(
        "--poll-interval",
        type=float,
        default=1.0,
        help="seconds between snapshots when the source is a single-image url",
    )
    parser.add_argument(
        "--serve",
        type=int,
        default=None,
        help="serve the annotated stream on this port rather than opening a window",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    args.snap_count = 0

    import cv2

    models = load_models(args.detector, args.spoof_run, args.recog_run, args.device)
    model, priors, spoof, recog = models
    gallery, enrolment = Gallery(args.gallery), Enrolment()
    source = int(args.source) if args.source.isdigit() else args.source

    if args.serve is not None:
        frames, calls, scored, stop = Slot(), Slot(), Slot(), threading.Event()
        threading.Thread(
            target=read_into, args=(source, frames, stop, args.poll_interval), daemon=True
        ).start()
        threading.Thread(
            target=infer_into,
            args=(models, frames, calls, scored, stop, args, gallery, enrolment),
            daemon=True,
        ).start()
        serve(frames, calls, scored, stop, args, gallery, enrolment)
        return 0

    capture = cv2.VideoCapture(source)
    if not capture.isOpened():
        print(f"cannot open {args.source}", file=sys.stderr)
        return 1

    writer = None
    counts = {"live": 0, "spoof": 0, "no face": 0}
    recent: deque[float] = deque(maxlen=max(1, args.smooth))
    print("q or esc to quit")
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

        started = time.perf_counter()
        found = detect(model, priors, rgb, args.device)
        if found is None:
            recent.clear()
            counts["no face"] += 1
        else:
            best = int(np.argmax(found.scores))
            box = found.boxes[best]
            recent.append(liveness(spoof, crops_of(rgb, box), args.device))
            score, votes, is_live = call_of(recent, args.threshold, args.vote)
            counts["live" if is_live else "spoof"] += 1
            verdict, colour = "SPOOF", (0, 0, 255)
            if is_live or not args.spoof_gate:
                vector = embed_face(recog, rgb, found.landmarks[best], args.device)
                name, similarity = gallery.match(vector)
                who = name if similarity >= args.recog_threshold else "unknown"
                verdict, colour = f"{who} {similarity:.3f}", (0, 200, 0) if name else (0, 165, 255)
                if not is_live:
                    verdict, colour = f"{verdict}  SPOOF", (0, 0, 255)
            annotate(frame, box, f"{verdict}  spoof {score:.4f}  {votes}/{len(recent)}", colour)
        elapsed_ms = (time.perf_counter() - started) * 1000.0

        cv2.putText(
            frame,
            f"{elapsed_ms:5.1f} ms  thr {args.threshold:.4f}  det {DETECT_CONF}",
            (10, frame.shape[0] - 12),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.55,
            (255, 255, 255),
            1,
        )
        if args.save is not None:
            if writer is None:
                writer = cv2.VideoWriter(
                    str(args.save),
                    cv2.VideoWriter_fourcc(*"mp4v"),
                    WRITER_FPS,
                    (frame.shape[1], frame.shape[0]),
                )
            writer.write(frame)
        cv2.imshow("detect + antispoof", frame)
        if cv2.waitKey(1) & 0xFF in (ord("q"), 27):
            break

    capture.release()
    if writer is not None:
        writer.release()
    cv2.destroyAllWindows()
    total = max(sum(counts.values()), 1)
    for name, count in counts.items():
        print(f"{name:8s} {count:5d}  {count / total:5.1%}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
