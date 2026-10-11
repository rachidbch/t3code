# ROLLBACK.md — putting production back on a known-good build

Written for an agent with no prior context. Plain `systemctl`, `cp`, and `git`
only. All commands run on the production machine as user `t3`.

## What production is

- systemd **user** unit `t3code-custom.service` (always `systemctl --user …`)
- Home (database, settings): `/home/t3/.local/share/t3-source/prod-home`
- Listens on `127.0.0.1:3773`; public origin `https://t3.komodo-everest.ts.net`
- Releases live in `/home/t3/.local/share/t3-source/releases/<commit-short-sha>/`;
  the directory name is the exact git commit the release was built from
- Deploy log for a release: `/home/t3/.cache/t3-source-migration/deploy-<sha>.log`
- Per-deploy backups (unit file + database): `/home/t3/.cache/t3-source-migration/production-backups/pre-<sha>-<timestamp>/`

## Health check (run this after every change)

```bash
curl -s http://127.0.0.1:3773/.well-known/t3/environment | head -c 200; echo
systemctl --user is-active t3code-custom.service
```

Healthy = `active` and JSON containing `"serverVersion":"…"`.

## Roll back to the previous build (the common case)

Pick the release to return to (the one named in the deploy log line
`ROLLBACK OK: <sha>`, or `ls /home/t3/.local/share/t3-source/releases`), then:

```bash
cp ~/.config/systemd/user/t3code-custom.service ~/unit.$(date -u +%Y%m%dT%H%M%SZ).bak
sed -i 's|releases/<current-sha>/bin.mjs|releases/<previous-sha>/bin.mjs|' \
  ~/.config/systemd/user/t3code-custom.service
systemctl --user daemon-reload
systemctl --user restart t3code-custom.service
```

Then run the health check. `serverVersion` must contain the sha you rolled
back to.

Note: `scripts/fork/deploy-release.sh` performs this automatically when a new
release fails its health check — only do it by hand if a deploy log ends with
`ROLLBACK FAILED`, or the problem appeared later.

## Roll back the database (only if corruption is suspected)

The server must be stopped while copying, or the copy will be torn:

```bash
systemctl --user stop t3code-custom.service
BK=$(ls -d /home/t3/.cache/t3-source-migration/production-backups/pre-* | tail -1)
cp "$BK"/statev2.sqlite* /home/t3/.local/share/t3-source/prod-home/userdata/
systemctl --user start t3code-custom.service
```

Everything after that backup's timestamp is lost. Health-check afterwards.

## Last resort: the installed vendor nightly

The original install still exists, inactive:

```bash
systemctl --user stop t3code-custom.service
systemctl --user start t3code.service   # ~/.t3 runtime nightly, home ~/.t3
```

It serves the ORIGINAL home (`~/.t3`) — a different database. Use it only to
keep something alive while investigating. Never write to `~/.t3`.

## Roll back the source / rebuild an old release (git only)

Checkout lives at `/home/t3/PROJECTS/PROD/t3`, branch `feat/web-push-notifications`,
fork remote `rachidbch/t3code`, upstream `pingdotgg/t3code`.

```bash
cd /home/t3/PROJECTS/PROD/t3
git fetch origin                       # make sure you see all commits
git log --oneline -10                  # pick the last commit you trusted
git checkout <that-sha>                # detached HEAD is fine for a rebuild
scripts/fork/build-release.sh          # builds releases/<that-sha> (stamped)
scripts/fork/deploy-release.sh <that-sha>
git checkout feat/web-push-notifications   # back to normal afterwards
```

`build-release.sh` refuses to run over uncommitted source changes, so a
release directory name always matches the commit it was built from.

## Rules

- Never edit anything under `~/.t3` or start a server against it.
- Never build a release with a dirty checkout.
- One deploy at a time; check `systemctl --user list-timers | grep t3code-deploy`
  before scheduling another.
