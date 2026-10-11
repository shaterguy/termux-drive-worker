#!/data/data/com.termux/files/usr/bin/sh
export HOME=/data/data/com.termux/files/home
mkdir -p "$HOME/.drive-worker"
exec "$HOME/bin/drive-worker-run" >>"$HOME/.drive-worker/worker.log" 2>&1
