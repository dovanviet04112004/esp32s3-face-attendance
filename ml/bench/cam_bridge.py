"""Publish a Windows camera as MJPEG so a Linux host can read it.

A virtual camera is a Windows software device rather than a USB one, so it
cannot be passed into WSL the way a real webcam can. This runs on the Windows
side and serves frames over HTTP; the models stay where their dependencies are.

Usage, on Windows, from a shell that has opencv:

    python cam_bridge.py            list the cameras, then serve index 0 on 8091
    python cam_bridge.py 1 8091     serve camera 1 on port 8091
    python cam_bridge.py 1 8091 90  turn each frame 90 degrees clockwise first

From WSL the url is the default gateway, `ip route | awk '/^default/{print $3}'`,
so `--source http://172.27.224.1:8091/` for bench/live_demo.py.
"""

import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2

JPEG_QUALITY = 80
PROBE_LIMIT = 5


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


def handler_for(capture, lock: threading.Lock, turn: int = 0):
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
                # A phone held upright reaches Windows on its side, and both
                # students read a face the way a person stands.
                if turn in TURNS:
                    frame = cv2.rotate(frame, TURNS[turn])
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
    index = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8091
    turn = int(sys.argv[3]) if len(sys.argv) > 3 else 0

    capture = cv2.VideoCapture(index, cv2.CAP_DSHOW)
    if not capture.isOpened():
        print(f"khong mo duoc camera index {index}")
        probe()
        return 1

    ok, frame = capture.read()
    print(f"camera {index}: {frame.shape if ok else '?'}")
    print(f"phat tai http://0.0.0.0:{port}/  (Ctrl+C de dung)")
    server = ThreadingHTTPServer(("0.0.0.0", port), handler_for(capture, threading.Lock(), turn))
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
