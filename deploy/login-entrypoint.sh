#!/usr/bin/env bash
# Bring up a throwaway desktop, then run the hand-driven login against it.
set -euo pipefail

Xvfb :99 -screen 0 1440x900x24 -nolisten tcp &
sleep 2

# -localhost keeps VNC off the network; noVNC bridges it, and compose binds that
# to 127.0.0.1 only. Reach it over an SSH tunnel, never directly.
x11vnc -display :99 -nopw -forever -shared -localhost -quiet &
sleep 1

websockify --web=/usr/share/novnc 7900 localhost:5900 &

echo
echo "Open an SSH tunnel from your machine:"
echo "    ssh -L 7900:localhost:7900 <user>@<server>"
echo "then browse to  http://localhost:7900/vnc.html"
echo
echo "A LinkedIn sign-in window is opening. Sign in by hand, including any"
echo "verification LinkedIn asks for - a datacenter IP is unfamiliar to it, so"
echo "expect a code. Nothing here will type or solve anything for you."
echo

exec npx tsx src/worker/main.ts --login
