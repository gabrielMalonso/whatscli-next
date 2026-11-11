# Terminal monitor

The optional `whatscli-tui` is a read-only view of the same runtime used by agents. It runs on Linux and can be accessed from a Mac over SSH. It never starts a WhatsApp connection, sends messages, downloads media, or changes read/archive state. Closing it leaves the runtime and agents running. The existing `whatscli` continues to produce JSON.

Build the project, start your selected account through the CLI if it is not already running, then open the monitor on the Linux machine:

```sh
pnpm build
pnpm verify:build
node dist/src/cli.js --account example start
node dist/src/tui-cli.js --account example
```

`pnpm tui --account example` is a shortcut after building. The package also defines a `whatscli-tui` executable for installations that expose package binaries. Use the same `--account NAME` or `--data-dir PATH` as your agents; omitting both selects the original default session.

From the Mac, allocate an interactive terminal and use absolute paths on Linux:

```sh
ssh -t linux-host 'node /path/to/whatscli-next/dist/src/tui-cli.js --account example'
```

Node must be available in the remote shell's `PATH`; otherwise use its absolute path too. The interface is in Portuguese and inherits the terminal font and base colors. `NO_COLOR=1` disables color accents. It requires at least 48 columns and 12 rows; at 94 columns it shows conversations and messages side by side. In narrower terminals, Enter opens the selected conversation and Esc returns to the list.

## Navigation

| Key                 | Action                                                         |
| ------------------- | -------------------------------------------------------------- |
| Up/Down or j/k      | Navigate the focused conversation list or message history.     |
| Tab, Left, Right    | Switch focus between conversations and messages.               |
| Enter               | Open the conversation in a narrow terminal.                    |
| /                   | Filter names or exact JIDs on the current conversation page.   |
| Enter / Esc         | Finish entering the filter; Esc again clears it.               |
| u                   | Toggle the observed unread filter.                             |
| [ / ]               | Previous/next conversation page (100 per page).                |
| Page Up / Page Down | Scroll messages in the message area. Scrolling up pauses them. |
| Home                | Go to the top of the current message window and pause.         |
| b / f               | Older/newer message page (50 per page), in the message area.   |
| End                 | Return to recent messages and resume following.                |
| r                   | Refresh the current pages manually.                            |
| ?                   | Toggle keyboard help.                                          |
| q / Ctrl+C          | Close only the monitor.                                        |

## What the screen establishes

The monitor polls local observations every two seconds. It keeps selection by exact JID as conversations reorder. Incoming messages do not interrupt reading: while history is paused, the conversation list and connection status continue updating, but the displayed messages stay frozen until a manual refresh, page change, or End. The pause indicator is explicit. Failed refreshes retain the last available data with a warning and retry automatically; they never reconnect or restart the runtime.

History is **local and partial**, including when the connection is open. Empty pages do not prove that remote messages are absent. Offset pages can shift as new observations arrive; manual refreshes and page changes are fresh queries rather than a stable history snapshot. Filtering searches only the loaded conversation page; use the JSON CLI `search` command for message text search.

The unread marker is `●` for observed unread and `?` for unknown. Counts are not invented. Opening a conversation does not send a read receipt. Messages labeled “Esta conta” belong to the shared account and may have been sent by an agent or another client; the monitor does not attribute them to a particular person or imply delivery/read confirmation. PN and LID histories stay separate, and LIDs are never displayed as telephone numbers.

Contact names use metadata already captured by the runtime. Saved address-book names take precedence over the chat title; without either, the monitor falls back to business/profile names, then the exact identifier. Group authors show their captured name alongside their identifier. Names also participate in the conversation filter. Only unambiguous PN/LID associations can supply another identity's name; conflicts use only the exact identifier's metadata and show a “vínculo ambíguo” warning. These are historical display labels, not verified identities. Missing names are never guessed or fetched remotely. Local contact queries run in the background with at most four concurrent lookups, a bounded in-memory cache and a one-minute refresh; `r` also refreshes cached names. Failures leave the message feed available with its normal fallback labels.

Audio, images, videos, stickers and documents appear as text placeholders; the existing public projection does not include audio duration. Open WhatsApp in your Mac browser for playback, viewing or other interaction. Deleted and uncertain deletion content remains hidden, and received terminal control sequences are removed before display.

## Offline preview for development

After building, this fixture opens the real TUI with fictional data and injected I/O, without any session or network access:

```sh
node dist/test/fixtures/tui-demo.js
```
