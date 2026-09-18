# Cecil Orchestrel deploy files

Source of truth for the `cecil` Orchestrel instance. Created by
`docs/plans/2026-06-19-cecil-orchestrel-instance.md`.

Cecil runs a separate clone at `/home/cecil/Code/orchestrel` as user `cecil`.
`orchestrel-cecil-sync.timer` keeps that clone on `origin/main`.

## Install

```bash
sudo install -m 755 deploy/cecil/sync-orchestrel-cecil /usr/local/bin/sync-orchestrel-cecil
sudo install -m 644 deploy/cecil/orchestrel-cecil-sync.service /etc/systemd/system/
sudo install -m 644 deploy/cecil/orchestrel-cecil-sync.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now orchestrel-cecil-sync.timer
```

`/etc/sudoers.d/orchestrel-cecil` grants the restart the script needs:

```
cecil ALL=(root) NOPASSWD: /usr/bin/systemctl restart orcd-cecil orchestrel-cecil
```

## Behavior

- Every 15 minutes: fetch `origin/main`. If Cecil is already current, exit.
- If a newer commit exists and no card is in `running`, reset the clone,
  `bun install`, `bun run build`, and restart `orcd-cecil` + `orchestrel-cecil`.
- If a card is `running`, defer to the next tick so a live session is not killed.
