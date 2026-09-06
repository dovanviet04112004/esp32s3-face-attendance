"""Publish a Windows camera as MJPEG so a Linux host can read it.

A virtual camera is a Windows software device, not a USB one, so it cannot be
passed into WSL. The url WSL reaches it on is the default gateway, not
localhost: `ip route | awk '/^default/{print $3}'`.
"""

import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2

JPEG_QUALITY = 80
PROBE_LIMIT = 5
# Below this a column carries no picture, so it is padding the virtual camera
# added rather than a dark room.
PAD_LEVEL = 12
# Frames read to find the padding, since the first one off a camera is often dark.
PAD_SAMPLES = 5


def probe() -> None:
    """Report which indices open, since a virtual camera moves between them."""
    for index in range(PROBE_LIMIT):
        capture = cv2.VideoCapture(index, cv2.CAP_DSHOW)
        if not capture.isOpened():
            print(f"  index {index}: khong mo duoc")
            continue
        ok, frame = capture.read()
        print(f"  index {index}: {frame.shape if ok else 'mo duoc, khong doc duoc'}")
        capture.release()


TURNS = {90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_COUNTERCLOCKWISE}


def padding_box(capture, lock: threading.Lock):
    """Where the picture sits inside a frame the camera padded, as x, y, w, h.

    A phone filming upright reaches a landscape virtual camera inside black
    columns. Those columns are not a dark room: they reach the anti-spoof branch
    as a quarter of the context crop, a thing no training frame contains.
    """
    import numpy as np

    stack = []
    for _ in range(PAD_SAMPLES):
        with lock:
            ok, frame = capture.read()
        if ok:
            stack.append(frame)
    if not stack:
        return None
    lit = np.maximum.reduce(stack).mean(axis=2)
    columns = lit.mean(axis=0) >= PAD_LEVEL
    rows = lit.mean(axis=1) >= PAD_LEVEL
    if not columns.any() or not rows.any():
        return None
    x1, y1 = int(np.argmax(columns)), int(np.argmax(rows))
    x2 = len(columns) - int(np.argmax(columns[::-1]))
    y2 = len(rows) - int(np.argmax(rows[::-1]))
    return x1, y1, x2 - x1, y2 - y1


def handler_for(capture, lock: threading.Lock, turn: int = 0, mirror: bool = False, crop=None):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args) -> None:
            return

        def do_GET(self) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            while True:
                with lock:
                    ok, frame = capture.read()
                if not ok:
                    return
                if crop is not None:
                    x, y, width, height = crop
                    frame = frame[y : y + height, x : x + width]
                # A phone held upright reaches Windows on its side, and both
                # students read a face the way a person stands.
                if turn in TURNS:
                    frame = cv2.rotate(frame, TURNS[turn])
                # Cosmetic only: training flips horizontally half the time.
                if mirror:
                    frame = cv2.flip(frame, 1)
                ok, buffer = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
                if not ok:
                    continue
                try:
                    self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\n")
                    self.wfile.write(f"Content-Length: {len(buffer)}\r\n\r\n".encode())
                    self.wfile.write(buffer.tobytes())
                except Exception:
                    return

    return Handler


def main() -> int:
    print("cam_bridge.py [index] [port] [turn_degrees] [mirror] [keep_padding]")
    index = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8091
    turn = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    mirror = bool(int(sys.argv[4])) if len(sys.argv) > 4 else False
    keep_padding = bool(int(sys.argv[5])) if len(sys.argv) > 5 else False

    capture = cv2.VideoCapture(index, cv2.CAP_DSHOW)
    if not capture.isOpened():
        print(f"khong mo duoc camera index {index}")
        probe()
        return 1

    ok, frame = capture.read()
    print(f"camera {index}: {frame.shape if ok else '?'}")
    lock = threading.Lock()
    crop = None if keep_padding else padding_box(capture, lock)
    if crop is not None and (crop[2], crop[3]) != (frame.shape[1], frame.shape[0]):
        print(f"cat vien den: x={crop[0]} y={crop[1]} -> {crop[2]}x{crop[3]}")
    else:
        crop = None
        print("khong thay vien den")
    print(f"phat tai http://0.0.0.0:{port}/  (Ctrl+C de dung)")
    server = ThreadingHTTPServer(("0.0.0.0", port), handler_for(capture, lock, turn, mirror, crop))
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
