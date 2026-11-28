# Running under a supervisor

`start --foreground` runs the daemon in the CLI process instead of detaching it, so a supervisor such as `systemd --user` tracks the real runtime as its main process. Use it for one service per data directory. Keep using plain `start` for interactive work.

```sh
node dist/src/cli.js --account example start --foreground
```

It accepts the same `--offline` and `--allow-jid EXACT_JID` options as `start` and keeps the same guarantees:

- The process takes the data directory's writer lock before any connection or socket cleanup. If another runtime holds it, startup is refused with exit status 69 and nothing in the directory changes. Foreground mode never returns an existing daemon as `alreadyRunning`.
- `SIGTERM` and `SIGINT` run the ordered shutdown described in [runtime and recovery](runtime.md#shutdown-and-upgrades): SDK cleanup, database closure and lock release finish before the process exits. A repeated signal during cleanup is logged as `ignored` and does not interrupt it; only `SIGKILL` aborts it. The `stop` command does the same.
- Other CLI commands, including `status` and `stop`, reach it through the private control socket as usual.

## Output and readiness

While running, foreground mode writes nothing to stdout. The [lifecycle and diagnostic lines](runtime.md#daemon-log) go to stderr, one JSON object per line, where the journal captures them. It does not create or append to `daemon.log`.

The runtime is ready when stderr carries the lifecycle line with `"event":"ready"`:

```json
{"at":"2026-01-02T03:04:05.006Z","level":"lifecycle","event":"ready","pid":4242}
```

At that point the control socket is listening and `status` responds with `running: true`. WhatsApp connects afterwards; follow `recovery.state` for the connection.

When the process exits on its own (not by `SIGKILL`, an out-of-memory kill or a crash), it writes exactly one JSON result to stdout. After an orderly stop, `data.reason` is `SIGTERM`, `SIGINT` or `stop-command`:

```json
{"ok":true,"running":false,"data":{"running":false,"foreground":true,"reason":"SIGTERM"}}
```

A failure writes the usual [error envelope](../user/output.md) instead. A startup failure also writes the same error line to stderr that the background daemon writes to `daemon.log`.

The runtime does not send `sd_notify` messages. Node.js has no Unix datagram sockets and this project adds no dependency for it, so use `Type=exec`. To delay dependent units until the control socket answers, poll `status` in `ExecStartPost=`, as in the example below.

## Exit status

| Status | Meaning                                                                                                                                          | Restart?                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| 0      | Orderly stop after `SIGTERM`, `SIGINT` or `stop`.                                                                                                | No (a clean exit).      |
| 1      | Unclassified startup failure, cleanup failure (`shutdown-failed`) or crash.                                                                      | Yes, after a delay.     |
| 64     | Invalid options or configuration, such as an unknown option, an invalid `--allow-jid` or a socket path that is too long.                         | No: fix the unit.       |
| 69     | Another runtime holds this data directory (writer lock or an active control socket).                                                             | No: find the other one. |
| 77     | Startup needs intervention: unsafe ownership or permissions, a foreign file at the control path, an unresponsive socket or unsupported platform. | No: inspect and fix.    |

A process killed by a signal, for example `SIGKILL` after the stop timeout, has no exit status and no `exit` lifecycle line.

These statuses apply whenever `--foreground` is given. Without it, every CLI failure keeps exit status 1, and so does the background daemon in its `daemon.log` `exit` line.

Automatic recovery stopping in `intervention-required` (for example after a logout) does not end the process. The service stays active; check `status` and the `connection` lifecycle lines.

## systemd user unit

A fictional unit for the account `example`, with the checkout in `/opt/whatscli-next`:

```ini
# ~/.config/systemd/user/whatscli-example.service
[Unit]
Description=whatscli-next runtime (example)
# Give up after repeated failures instead of restarting forever.
StartLimitIntervalSec=10min
StartLimitBurst=5

[Service]
Type=exec
UMask=0077
ExecStart=/usr/bin/node /opt/whatscli-next/dist/src/cli.js --account example start --foreground
# Optional: become active only once the control socket answers.
ExecStartPost=/bin/sh -c 'until /usr/bin/node /opt/whatscli-next/dist/src/cli.js --account example status | grep -q "pid.:$MAINPID[,}]"; do sleep 0.2; done'
TimeoutStartSec=30
# SIGTERM to the runtime only; anything left gets SIGKILL after the timeout.
KillMode=mixed
TimeoutStopSec=30
Restart=on-failure
RestartSec=5
# systemd 254 or later: back off between restarts up to five minutes.
RestartSteps=5
RestartMaxDelaySec=5min
RestartPreventExitStatus=64 69 77

[Install]
WantedBy=default.target
```

- `TimeoutStopSec` must cover SDK cleanup. A `SIGKILL` skips the ordered shutdown: the OS releases the lock, and an interrupted send stays an uncertain intent that is never resent automatically.
- `Restart=on-failure` does not restart after exit status 0, so `whatscli stop` also stops the service until the next `systemctl --user start`. Prefer `systemctl --user stop` and `restart`.
- `systemctl --user restart` waits for the old process to exit, and the lock is released before it exits, so the new runtime never overlaps it.
- Without the start limit above, a persistent failure such as a newer schema or a crash after `ready` would restart every few seconds forever, reconnecting to WhatsApp each time. After the limit, inspect the journal and run `systemctl --user reset-failed` before starting again.
- `TimeoutStartSec` also bounds the `ExecStartPost` poll; raise it after an upgrade if store work delays `ready` on a large database.
- For a unit-managed account, start it with `systemctl --user start`, never plain `start`: between restarts, or after `whatscli stop`, plain `start` would launch a detached runtime outside the unit, and the unit's next start would then exit 69 and stay failed.
- While the service runs, plain `start` returns the service's process with `alreadyRunning: true`. Never start a second runtime on the same data directory under another unit or path.

To upgrade, follow [builds and upgrades](release.md), restart the unit, and compare `status.data.build.fingerprint` with the intended build.
