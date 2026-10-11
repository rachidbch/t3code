#!/usr/bin/env bash
# Deploy a built release to production with a health check and auto-rollback.
#
# Safe to run from an agent session: it re-executes itself as an independent
# systemd user unit, so it survives the T3 server restart it performs (which
# would otherwise kill the agent that started it). Procedure: back up the unit
# file and database (server stopped, so the SQLite copy is clean), swap the
# unit to the new release, restart, health-check HTTP 200 + the release sha in
# serverVersion. On failure it restores the previous release automatically.
# Manual rollback runbook: ROLLBACK.md at the repository root.
#
# Usage: scripts/fork/deploy-release.sh <release-sha>
set -u
NEW="${1:?usage: deploy-release.sh <release-sha>}"

REL=/home/t3/.local/share/t3-source/releases
UNIT=$HOME/.config/systemd/user/t3code-custom.service
URL=http://127.0.0.1:3773/.well-known/t3/environment
MIG=/home/t3/.cache/t3-source-migration
LOG="$MIG/deploy-$NEW.log"

if [ "${2:-}" != "child" ]; then
  systemd-run --user --unit="t3code-deploy-$NEW" --on-active=10s \
    /bin/bash "$(readlink -f "$0")" "$NEW" child
  echo "deploy of $NEW scheduled in 10s (independent of this shell)"
  echo "log: $LOG"
  exit 0
fi

log(){ echo "[$(date -u +%FT%TZ)] $*" >> "$LOG"; }
PREV=$(grep -o 'releases/[^/]*/bin.mjs' "$UNIT" | head -1 | cut -d/ -f2)
BK="$MIG/production-backups/pre-$NEW-$(date -u +%Y%m%dT%H%M%SZ)"

log "=== deploy start ($PREV -> $NEW) ==="
[ -f "$REL/$NEW/bin.mjs" ] || { log "FATAL: release $NEW not built"; exit 1; }
[ -f "$REL/$PREV/bin.mjs" ] || { log "FATAL: previous release $PREV missing"; exit 1; }
[ "$NEW" = "$PREV" ] && { log "already deployed"; exit 0; }

mkdir -p "$BK"
cp "$UNIT" "$BK/t3code-custom.service.before"
systemctl --user stop t3code-custom.service
for i in $(seq 1 30); do systemctl --user is-active --quiet t3code-custom.service 2>/dev/null || break; sleep 1; done
DB=/home/t3/.local/share/t3-source/prod-home/userdata/statev2.sqlite
cp "$DB" "$BK/" 2>/dev/null || true
cp "${DB}-wal" "$BK/" 2>/dev/null || true
cp "${DB}-shm" "$BK/" 2>/dev/null || true
log "stopped; unit + database backed up to $BK"

sed -i "s|releases/$PREV/bin.mjs|releases/$NEW/bin.mjs|" "$UNIT"
systemctl --user daemon-reload
systemctl --user start t3code-custom.service
log "unit now points at: $(grep -o 'releases/[^/]*/bin.mjs' "$UNIT")"

ok=""
for i in $(seq 1 60); do
  sleep 2
  code=$(curl -s -o /tmp/deploy-env.json -w '%{http_code}' --max-time 4 "$URL" 2>/dev/null || echo 000)
  if [ "$code" = "200" ] && grep -q "$NEW" /tmp/deploy-env.json 2>/dev/null; then ok=1; break; fi
done
if [ -n "$ok" ]; then
  log "HEALTH OK: $NEW serving"
  log "=== deploy success ==="
  exit 0
fi

log "HEALTH FAILED; rolling back to $PREV"
cp "$BK/t3code-custom.service.before" "$UNIT"
systemctl --user daemon-reload
systemctl --user restart t3code-custom.service
ok2=""
for i in $(seq 1 60); do
  sleep 2
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "$URL" 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then ok2=1; break; fi
done
[ -n "$ok2" ] && log "ROLLBACK OK: $PREV restored and healthy" \
              || log "ROLLBACK FAILED: follow ROLLBACK.md at the repository root"
exit 1
