# <a href="https://github.com/vishwas-r/Google-Chat-Exporter/"><img src="images/icon.svg" width="32" height="32" alt="Icon"></a> Google Chat Exporter

[![Version](https://img.shields.io/badge/version-2.2.1-green.svg)](https://github.com/vishwas-r/Google-Chat-Exporter)
[![License: GPL v3](https://img.shields.io/badge/License-GPL%20v3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0.en.html)
[![Maintenance](https://img.shields.io/badge/Maintained%3F-yes-green.svg)](https://github.com/vishwas-r/google-chat-exporter/graphs/commit-activity)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/vishwas-r/google-chat-exporter/pulls)
[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Extension-Available-blue.svg)](https://chromewebstore.google.com/detail/google-chat-exporter/epemodmmmilflmhgojgonhfcjfjnflgc)
[![Firefox Add-on](https://img.shields.io/badge/Firefox%20Add--on-Available-orange.svg)](https://addons.mozilla.org/en-US/firefox/addon/google-chat-exporter/)

The ultimate, privacy-first browser extension for exporting Google Chat conversations to **Plain Text (TXT)** or **rich HTML with full media attachments (packaged in a ZIP)**.

Works across **Google Chrome, Mozilla Firefox, Brave, Microsoft Edge**, standalone PWA windows, and Gmail-embedded Chat.

---

## ✨ Features

- **Dual Export Formats**:
  - **Plain Text (`.txt`)**: Clean, formatted chronological transcript with senders, timestamps, and multi-line formatting preserved.
  - **Structured HTML (`.html + .zip`)**: Complete conversational archive with sender avatars, speech bubbles, embedded images, GIFs, audio notes, video chips, documents, and Google Meet call links.
- **Full Media Extraction**: Automatically downloads photos, GIFs, file attachments, and video previews into a neat `media/` folder inside the ZIP.
- **Adaptive History Loading**: Loads history batch-by-batch and continues as soon as Google Chat adds the next batch.
- **Very Long Histories**: Tens of thousands of messages stay fast by removing already-collected messages from the page while scanning and by continuing long scans in a fresh page every 4000 messages. Both can be turned off under **Advanced Scan Options**.
- **Large Media Archives**: HTML exports with many attachments are split into several ZIP parts (`…_part1of3.zip`, …); extract them all into one folder.
- **Safe Retries**: A failed export keeps its scanned messages and downloaded media, so exporting again skips the rescan. Long scans also save a JSON backup that can be exported later.
- **Optional Date Cutoff**: Stop loading once the export reaches a selected “messages since” date.
- **New Since Last Export**: Optional per-conversation checkpoints for TXT, HTML, and HTML with attachments. Each run saves a separate file; the first run establishes a baseline. Checkpoints advance after a completed download. Turn the option off for a full re-export.
- **Auto-Export on Open**: Turn it on in the popup, then open each channel you want; every channel is exported once with your current settings as soon as it loads. Switching away mid-export cancels that export so it retries on your next visit. The mode turns off after 10 minutes without a channel switch and whenever the browser restarts; an `AUTO` badge shows while it is on.
- **Concurrent Media Downloads**: Downloads up to four attachments at a time.
- **Bot & Card Message Support**: Extracts card notifications, webhooks, and bot messages (e.g., alert cards) seamlessly.
- **Universal Compatibility**:
  - Standalone Google Chat (`chat.google.com`)
  - Gmail-integrated Google Chat (`mail.google.com`)
  - Progressive Web App (PWA) / standalone window mode (fully tested and working in Brave & Chrome)
- **Two Easy Export Methods**:
  - **Popup UI**: Modern toolbar popup with live conversation detection, format selection, and progress monitoring.
  - **Context Menu**: Right-click anywhere inside a conversation to export as TXT or HTML with media.
- **Live Animated HUD**: Real-time progress indicator showing message count, scroll progress, and media download status.
- **100% Private & Client-Side**: All parsing and ZIP generation happen inside your browser. No external servers, no tracking, zero telemetry.

---

## 📸 Screenshots

| Feature Overview & Popup | Exported HTML Chat View |
| :---: | :---: |
| ![Features & Popup](images/screenshot-1-features.jpg) | ![HTML Export](images/screenshot-2-html-export.jpg) |

---

## 📥 Installation

### Official Web Stores
Install directly from your browser's official store:

- 🌐 **Google Chrome, Brave, Microsoft Edge**:  
  👉 **[Google Chat Exporter on Chrome Web Store](https://chromewebstore.google.com/detail/google-chat-exporter/epemodmmmilflmhgojgonhfcjfjnflgc)**
- 🦊 **Mozilla Firefox (Desktop & Android)**:  
  👉 **[Google Chat Exporter on Firefox Add-ons (AMO)](https://addons.mozilla.org/en-US/firefox/addon/google-chat-exporter/)**

### Manual Installation (Developer Mode)

#### For Google Chrome, Brave, and Microsoft Edge:
1. Open your browser and go to `chrome://extensions/` (or `brave://extensions/`, `edge://extensions/`).
2. Toggle **Developer mode** on in the top right.
3. Click **Load unpacked** and select the [`chrome/`](chrome) folder.

#### For Mozilla Firefox:
1. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...**.
3. Select the `manifest.json` file inside the [`firefox/`](firefox) folder.

---

## 🛠️ Development & Building

- **Run Tests:** `npm test`
- **Run Benchmarks:** `npm run benchmark`
- **Build Extension Packages:**
  - `npm run build` (builds both Chrome and Firefox ZIP archives in `dist/`)
  - `npm run build:chrome`
  - `npm run build:firefox`

## 🚀 How to Use

1. Navigate to [Google Chat](https://chat.google.com) or Gmail Chat.
2. Click into any direct message or space.
3. Choose either method:
   - **Toolbar Popup**: Click the extension icon in your browser toolbar, select **HTML (with media)** or **TXT**, and click **Export Current Conversation**.
   - **Right-Click**: Right-click anywhere within the chat message area and select **"📄 Export Chat as TXT"** or **"🌐 Export Chat as HTML (with media)"**.
4. The animated status HUD will appear in the bottom-right corner as it scrolls history, extracts messages, and bundles media.
5. Your export file (`.txt` or `.zip`) will download automatically to your Downloads folder.

### Export options

- **Load Full History** traverses the conversation before exporting. Turn it off to export only currently rendered messages.
- **Messages Since** stops history loading after reaching the selected date.
- **New Since Last Export** saves a per-conversation checkpoint and exports only newer messages on subsequent runs. The first run establishes a baseline; TXT, HTML, and HTML-with-media modes use separate checkpoints.
- **Include Media** downloads attachments when HTML is selected.

Each incremental run creates a new file. Keep earlier files to retain the complete archive. Checkpoints are local to the browser profile and advance only after Chrome reports a completed download.

### Stopping and cancelling

Clicking **×** on the progress box while history is loading stops the scan and exports the messages collected so far; the file notes that older messages are missing. Clicking **×** again, or during media download, aborts the export without saving anything.

### Advanced scan options

All options are on by default except diagnostic logging. Options marked ⚠️ change the Chat page itself: the conversation may look garbled or stay at an old position after the export, so reload the Chat tab once the export has finished. Your data and the export are not affected.

| Option | What it does | Turn it off if… |
|---|---|---|
| ⚠️ **Free Memory While Scanning** | Temporarily removes already-collected messages from the page during the scan and puts them back afterwards, keeping long scans fast. Chat can redraw parts of the list in the meantime, so the conversation may look garbled or incomplete until you reload the tab. | You want the page left untouched while scanning. |
| ⚠️ **Segmented Scanning** | Every 4000 messages, stores what was collected and reopens Chat at the oldest message, because Chat slows down with every message it has loaded. The tab navigates on its own and ends at an old message; reload the chat afterwards. If Chat does not open the link, the export finishes with what was collected. | Your workspace does not allow opening message links. |
| **Nudge History Loading** | Sends a scroll-up event as soon as the top is reached so Chat loads older messages sooner. | History loading misbehaves in your workspace. |
| **Reuse Scan After a Failure** | A failed export keeps its messages and downloaded media; exporting again skips the rescan (the file notes when the scan was made). | You always want a fresh scan. |
| **Save Scan Backup** | Downloads one zipped JSON copy (`…_scan-backup_….zip`) of scans with 1000+ messages when the export ends, whether it finished, failed or was cancelled. Segmented scans keep their segments in local storage in the meantime, so a long scan is never interrupted by downloads. | You don't want the extra file. |
| **Diagnostic Logging** | Logs scan timing, history-load latency and memory use to the page console. | — |

### Disaster recovery from the console

Open DevTools on the Chat tab and switch the Console context (the `top` dropdown) to **Google Chat Exporter**. Then:

| Command | What it does |
|---|---|
| `gceSaveBackup()` | Downloads a zipped backup JSON of the messages available right now: a kept scan from a failed export, else the stored segments of an interrupted segmented scan, else the messages currently on the page. Works even with **Save Scan Backup** turned off. |
| `gceExportFromMemory()` | Exports those same messages as HTML with media, without scrolling. |
| `gceExportBackupFile()` | Opens a file picker; choose a backup (`…_scan-backup_….zip`, or the `.json` inside it) to export it as HTML with media, without scrolling. Pass `{ format: 'txt' }` for a text export. |

If a packaging step fails after the media download, run `gceExportFromMemory()` again: it reuses the downloaded media and continues with the ZIP part that failed.

## ⚡ Performance benchmark

Run `npm run benchmark` to compare repeated message extraction with upstream v2 commit `005a22f`. The synthetic workload uses 250 rendered message groups, 160 overlapping collections, alternates execution order, and reports the median of seven rounds.

| Workload | Upstream v2 | v2.2.0 | Speedup | Group parses (old/new) |
|---|---:|---:|---:|---:|
| Stable overlapping viewport | 16.1 ms | 6.4 ms | **2.50×** | 40,000 / 250 |
| 10% of groups changed each pass | 16.0 ms | 8.0 ms | **1.99×** | 40,000 / 4,225 |

Results are representative rather than universal and vary by machine. This benchmark isolates local DOM extraction; Google history-fetch/render latency and attachment downloads are excluded.

---

## 🔒 Privacy & Permissions

- **Zero Data Collection**: No user messages, media, or analytics are collected or sent over the internet.
- **Local Packaging**: HTML and ZIP archives are generated client-side using an offline bundling engine (`jszip`).
- **Minimal Permissions**:
  - `activeTab` & `scripting`: To read the chat DOM when initiated by you.
  - `contextMenus`: For convenient right-click options.
  - `downloads`: To save the exported file to your computer.
  - `storage`: To remember your format preferences locally.
  - `unlimitedStorage`: To keep the messages of a segmented scan locally while Chat is reopened; they are deleted after the export.

---

## 📄 License

This project is licensed under the GNU General Public License v3.0 - see the [LICENSE](LICENSE) file for details.
