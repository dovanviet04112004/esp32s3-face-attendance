"""Watch the detection student feed the anti-spoof student on a host webcam.

Crops are cut the way the training shards were cut, JPEG round trip included, so
what the model sees here is what it was trained on, and the liveness score is
read at the threshold the run fitted on its own validation split rather than at
one half.

A host webcam is not the OV5640, so this shows whether the pipeline works, not
how well it works: nothing it prints belongs in an acceptance table (KEHOACH 1.2).

Usage:
    python -m bench.live_demo \\
        --detector artifacts/detection/runs/<run>/ckpt/best.pth \\
        --spoof-run artifacts/antispoof/runs/<run>
"""

from __future__ import annotations

import argparse
import io
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import torch
from PIL import Image

from facepipe.data.prepare.celeba_spoof_parquet import (
    CROP_QUALITY,
    CROP_SCALES,
    CROP_SIZE,
    scaled_box,
)
from facepipe.tasks.antispoof.data import CROP_SIZE as SPOOF_SIZE
from facepipe.tasks.antispoof.eval import load_run
from facepipe.tasks.antispoof.losses.task_loss import LIVE
from facepipe.tasks.detection.data import letterbox_params
from facepipe.tasks.detection.eval import decode_batch, load_student, to_original
from facepipe.tasks.detection.student.anchors import feature_sizes, pyramid_priors
from facepipe.tasks.detection.student.yunet import STRIDES

DETECT_HW = (120, 160)
DETECT_CONF = 0.5
# A0 fitted this on test:0:10, then read test:10: at it without refitting (measurements 5).
SPOOF_THRESHOLD = 0.997355
WRITER_FPS = 12.0
SERVE_FPS = 15.0
RECONNECT_WAIT_S = 0.5


def load_models(detector: Path, spoof_run: Path, device: str):
    """The two students and the priors the detector decodes against."""
    model = load_student(detector).to(device).eval()
    priors = torch.cat(pyramid_priors(feature_sizes(DETECT_HW, STRIDES), STRIDES)).to(device)
    _, spoof = load_run(spoof_run)
    return model, priors, spoof.to(device).eval()


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


def crops_of(frame_rgb: np.ndarray, box: np.ndarray) -> dict[str, np.ndarray]:
    """Both scales, through the JPEG round trip the shards were written with."""
    image = Image.fromarray(frame_rgb)
    views: dict[str, np.ndarray] = {}
    for name, scale in CROP_SCALES.items():
        patch = image.crop(scaled_box(tuple(box), scale, image.width, image.height))
        buffer = io.BytesIO()
        patch.resize((CROP_SIZE, CROP_SIZE), Image.BILINEAR).save(
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


def read_into(source, frames: Slot, stop: threading.Event) -> None:
    """Pull frames, reopening the source when it drops.

    A board on wifi ends its stream often enough that giving up on the first
    failed read leaves the page black for the rest of the session.
    """
    import cv2

    while not stop.is_set():
        capture = cv2.VideoCapture(source)
        while not stop.is_set():
            ok, frame = capture.read()
            if not ok:
                break
            frames.put(frame)
        capture.release()
        time.sleep(RECONNECT_WAIT_S)


def infer_into(models, frames: Slot, calls: Slot, stop: threading.Event, args) -> None:
    """Score each new frame once.

    Scoring whatever is in the slot regardless would re-run the same frame at
    full speed on every core between arrivals. The reported score is a mean over
    the last few frames, since one frame either side of the threshold flips the
    call while the face has not moved.
    """
    import cv2

    model, priors, spoof = models
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
            calls.put((None, 0.0, (time.perf_counter() - started) * 1000.0))
            continue
        box = found.boxes[int(np.argmax(found.scores))]
        recent.append(liveness(spoof, crops_of(rgb, box), args.device))
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        calls.put((box, sum(recent) / len(recent), elapsed_ms))


def render(frames: Slot, calls: Slot, threshold: float):
    """The newest frame with the newest call drawn on it, encoded as JPEG."""
    import cv2

    frame = frames.get()
    if frame is None:
        return None
    frame = frame.copy()
    call = calls.get()
    if call is not None and call[0] is not None:
        box, score, elapsed_ms = call
        is_live = score >= threshold
        colour = (0, 200, 0) if is_live else (0, 0, 255)
        annotate(frame, box, f"{'LIVE' if is_live else 'SPOOF'} {score:.4f}", colour)
        cv2.putText(
            frame,
            f"{elapsed_ms:5.1f} ms",
            (10, frame.shape[0] - 12),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.55,
            (255, 255, 255),
            1,
        )
    ok, buffer = cv2.imencode(".jpg", frame)
    return buffer.tobytes() if ok else None


def serve(frames: Slot, calls: Slot, stop: threading.Event, args) -> None:
    """Re-serve the annotated frames as MJPEG, which a browser paces on its own."""
    page = (
        b"<body style='margin:0;background:#111;display:flex;justify-content:center'>"
        b"<img src='/stream' style='max-width:100%'></body>"
    )

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args) -> None:
            return

        def do_GET(self) -> None:
            if self.path != "/stream":
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(page)
                return
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.end_headers()
            while not stop.is_set():
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
                time.sleep(1.0 / SERVE_FPS)

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
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--threshold", type=float, default=SPOOF_THRESHOLD)
    parser.add_argument("--save", type=Path, default=None, help="also write an annotated mp4")
    parser.add_argument(
        "--smooth",
        type=int,
        default=5,
        help="frames averaged before a call, since one frame near the threshold flips it",
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

    import cv2

    model, priors, spoof = load_models(args.detector, args.spoof_run, args.device)
    source = int(args.source) if args.source.isdigit() else args.source

    if args.serve is not None:
        frames, calls, stop = Slot(), Slot(), threading.Event()
        threading.Thread(target=read_into, args=(source, frames, stop), daemon=True).start()
        threading.Thread(
            target=infer_into,
            args=((model, priors, spoof), frames, calls, stop, args),
            daemon=True,
        ).start()
        serve(frames, calls, stop, args)
        return 0

    capture = cv2.VideoCapture(source)
    if not capture.isOpened():
        print(f"cannot open {args.source}", file=sys.stderr)
        return 1

    writer = None
    counts = {"live": 0, "spoof": 0, "no face": 0}
    print("q or esc to quit")
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

        started = time.perf_counter()
        found = detect(model, priors, rgb, args.device)
        if found is None:
            counts["no face"] += 1
        else:
            box = found.boxes[int(np.argmax(found.scores))]
            score = liveness(spoof, crops_of(rgb, box), args.device)
            is_live = score >= args.threshold
            counts["live" if is_live else "spoof"] += 1
            colour = (0, 200, 0) if is_live else (0, 0, 255)
            annotate(frame, box, f"{'LIVE' if is_live else 'SPOOF'} {score:.4f}", colour)
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
