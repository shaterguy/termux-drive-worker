#!/data/data/com.termux/files/usr/bin/bash
"/data/data/com.termux/files/home/bin/termux-google-auth-start.sh" || exit 1
set -eu
export HOME=/data/data/com.termux/files/home
export PREFIX=/data/data/com.termux/files/usr
export PATH=$PREFIX/bin:$HOME/bin:$PATH

export DRIVE_WORKER_COMMANDS_FOLDER_ID=140w0cEXYwi4m_80d7xuL0Nnyl2TwO8Pq
export DRIVE_WORKER_RESULTS_FOLDER_ID=16U9nUq1ChFY4Ge8jNZiNKOh8mAAcLdD1
export DRIVE_WORKER_STATE_FOLDER_ID=1lzCYSw-fbON8D_-3YEqMzDJOFQef1yiZ
export DRIVE_WORKER_SKILLS_FOLDER_ID=1q339kJzixW1ebPwB4xYahtEDucb55jRH
export DRIVE_WORKER_POLL_MS=5000
export DRIVE_WORKER_MAX_CONCURRENCY=0
export DRIVE_WORKER_AUTO_MIN_CONCURRENCY=1
export DRIVE_WORKER_AUTO_BASE_CONCURRENCY=6
export DRIVE_WORKER_AUTO_MAX_CONCURRENCY=12
export DRIVE_WORKER_AUTO_MEMORY_RESERVE_MB=1024
export DRIVE_WORKER_AUTO_MEMORY_PER_JOB_MB=512
export DRIVE_WORKER_HEARTBEAT_MS=30000
export DRIVE_WORKER_HEALTH_PORT=17841
export DRIVE_WORKER_CAPABILITIES_REFRESH_MS=300000
export DRIVE_WORKER_DATA=$HOME/.drive-worker
export DRIVE_WORKER_PROFILE_SYNC_COORDINATION_DOCUMENT_ID=1fHCpUYEu7zld9PZmtll4E3wfWA13M9qy4PR_ZCq1MxY
export DRIVE_WORKER_OAUTH_CLIENT_FILE=$HOME/.selfrun-server/drive-auth-client.json
export DRIVE_WORKER_OAUTH_TOKEN_FILE=$HOME/.selfrun-server/drive-auth-token.json

mkdir -p "$DRIVE_WORKER_DATA"
cd "$HOME/work/drive-worker"
exec node "/data/data/com.termux/files/home/.drive-worker/releases/v0.2.18-dev11-nonblocking-20261026/worker.mjs"
