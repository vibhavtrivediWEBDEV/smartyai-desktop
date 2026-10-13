# Jarvis

Standalone desktop assistant in development. Local commands, scoped filename search and opening found files in their default app, permission-gated macOS app launches and Downloads-folder opening, HTTPS website opening, approved Chrome web research, a limited VS Code handoff, and GLM-5 text requests with reviewed Python proposals are available. File-content tools, voice, and general workflows are not implemented.

## Run

Requires Node.js 24+ and npm. From this directory:

```sh
npm install
npm run dev
```

The desktop app opens with Vite at `http://127.0.0.1:5173` (loopback only). Closing the window hides it; use the tray/menu-bar item or `Cmd+Shift+J` on macOS (`Ctrl+Shift+J` on Windows) to reopen. Use the tray's **Quit Jarvis** item to exit. Run `npm run build`, `npm test`, and `npm run lint` for checks. `npm start` loads the last production build after `npm run build`. This is an unpackaged development application, not a signed installer.

Try `help`, `show status`, `show time`, or `wait 5 seconds` (cancel the wait in the task list). On macOS, submit `open photos`, `open <installed app name>`, or a direct request such as `can you open the terminal`. Jarvis asks before the first launch, saves a grant for that app alone, and lets you revoke it in Permissions. `open vscode`, `kholo vscode`, and `vs code open krdo be` launch VS Code with the same app-specific grant. Allowing Terminal to launch does not authorize running shell commands. macOS must be able to find the named app. Submit `find report`, `can you find report on my desktop`, or `resume kaha h` to search filenames in Desktop, Documents, then Downloads step by step.

Submit `open my Downloads folder` to open Downloads in Finder; if it has not already been approved for file search, select that exact folder in the native picker first. This grants filename-search access to Downloads until revoked. Submit `open https://example.com` or `open this website https://example.com/report` to open an HTTPS URL in the default browser. Jarvis asks for an origin-specific browser grant, revocable in Permissions. Other URL schemes, credentials in URLs, and requests phrased as questions do not trigger desktop opening. These actions do not read webpage or file contents.

Submit `search for VS Code on Google` or `search the web for VS Code` to open Google results in your default browser. `open Safari search VS Code` opens those results in Safari after both a Google website grant and a Safari app grant. A plain `search for report.txt` remains a filename search. Opening search results does not read the page or return an answer in Jarvis; inspect the browser yourself. Phone-number lookups such as `search for 6388056383 on google` instead use the approved research flow and check for the exact number on inspected pages. Search terms are sent to Google when the browser loads the URL.

On macOS with Google Chrome installed and your own GLM-5 key configured, submit `research: OLED vs mini LED monitors` to compare public web pages, or `research https://bhavishya.site` to inspect that exact website. Requests such as `delhi weather` and `delhi police phone number` also trigger source-backed research; `delhi todays time` uses the local clock in the Asia/Kolkata time zone. For a URL, Jarvis reads the requested HTTPS page directly and does not substitute similarly named search results; if it cannot read the page, it returns an error instead of answering from other sites. For a topic, Jarvis opens a temporary Chrome session and collects public results from Google, DuckDuckGo, and Brave when each is readable; it interleaves their links, visits up to four readable pages, and attempts a follow-up search within one source site. DuckDuckGo may present a challenge instead of results. Public Instagram pages can be discovered through these engines, but login-gated pages cannot be read. A native dialog asks before reading each new HTTPS origin (including each search provider); the separate `browser.read` grant persists until revoked in Permissions. Skipped sites are not read. Only public page text from inspected sources is sent to GLM-5; task results include the source URLs. Phone-number lookups search the exact digits, use only pages showing that complete number, and can report a single public business listing if the source supports it; they do not establish the owner of a private number. Google AI Mode is not integrated or read by Jarvis; GLM-5 drafts the source-grounded answer. Source pages run without scripts; their non-document requests, downloads, non-HTTPS pages, and local/private network addresses are blocked. Search and page visits are visible to those websites. Google may block automated sessions with an unusual-traffic verification page; results depend on website availability and approval. Sites requiring sign-in or JavaScript may be unreadable; fewer than two readable pages for other topic searches produces an error rather than a comparison. Results are limited to four sources and about 4,500 characters per page, so they are not exhaustive, and source claims still need verification. Cancellation closes the temporary Chrome session. Ordinary Google/Safari search continues to open results without reading them.

`open vscode` also lists active VS Code window names. Projects found under already approved read folders can be selected directly; for other projects, choose the exact folder in the native picker. Jarvis opens the chosen folder in VS Code, then offers a separate chat prompt with a confirmation before handing it to VS Code's agent chat via its CLI. Keep the chosen project as the last active VS Code window: the CLI's `--reuse-window` flag targets that window, not a folder path, so Jarvis cannot guarantee the prompt goes to the chosen project. Selecting a folder does not grant Jarvis permission to read its files. A successful CLI handoff does not mean the agent completed the request: Jarvis cannot observe VS Code chat progress or verify its result. Review the target window, progress, and any proposed edits in VS Code. This handoff depends on the installed VS Code `code` CLI and an available chat provider in VS Code.

`open vs code smartyai project` routes to project selection, never to an app named "vs code smartyai project". If the project is not uniquely found among approved active projects, choose the folder named `smartyai` in the native picker. Opening a project falls back to macOS `open` if the `code` CLI is not installed; listing open projects then shows no detected windows, and sending a chat prompt still requires the `code` CLI.

Screenshot requests such as `todays screenshot`, `yesterday's screenshots`, `show screenshots from 2026-10-12 between 09:00 and 11:00`, and `last screenshot` search approved folders for images from the requested local calendar day and optional 24-hour local time window. A follow-up such as `between 09:00 and 11:00` reuses the preceding result's date. The screenshot filename capture timestamp takes precedence over modification time, which is used when the filename has no date. With GLM-5 configured, Jarvis can extract a date from less explicit screenshot requests; otherwise specify today, yesterday, last, or an ISO date. GLM-5 only extracts the date and never reads the images. The last-screenshot request shows every matching image from the newest screenshot's date. Results are ordered newest-first with in-app thumbnails generated for approved images up to 25 MiB, plus a Show in Finder button. The Photos app library is not connected: to search its images, export them to Desktop, Documents, or Downloads first, then search the exported screenshot files.

For each ungranted folder, Jarvis shows a permission dialog: allow that named folder to start searching it immediately, or skip it. It continues through the remaining approved folders even after a match, ranking exact filenames in shallow folders first for ordinary searches so a Downloads copy is not missed behind a deep project asset. A search result has separate Open with default app and Show in Finder buttons; both work only while the file exists, remains in the latest search results, and its folder grant remains active. Opening a spreadsheet starts its associated application; Jarvis does not read or edit its cells. The Permissions page accepts absolute folder paths, then requires selecting the same folder in the picker. On macOS, search checks Spotlight's index within each approved folder first, verifying each result is an existing file inside that folder. If the index has no usable match or is unavailable, a filesystem fallback checks up to 5,000 entries for ordinary searches or 100,000 for screenshot searches, and four nested levels per folder; incomplete searches are reported. Ordinary results are limited to 20 matches; screenshot results to the newest 200, with a warning if truncated. Search does not read ordinary file contents; screenshot previews read only validated approved image results. macOS can still deny access independently; a Jarvis grant cannot override System Settings > Privacy & Security > Files and Folders or grant Full Disk Access.

For an action request such as `python: print 2 + 3` or `create a file using Python`, GLM-5 proposes Python code in the assistant view. Nothing runs until you review the full code and choose **Approve and run once**. Denial or expiry prevents execution; the approval is not a persistent grant. Proposals target the Python 3.9 standard library: Jarvis runs `/usr/bin/python3 -I`, so installed third-party packages such as `requests` may be unavailable; HTTP code should use `urllib.request`. Python runs with your user account and is **not sandboxed**: approved code can access files and the network, so only approve code you understand. Execution is limited to 10 seconds and 32 KiB of output. This is a preview-and-approve workflow, not an autonomous agent or a general-purpose safe automation sandbox. The microphone button is disabled. Task history lasts only while this process is running; Python results appear in the assistant view, not task history.

Research uses a fresh temporary Chrome profile for each task and does not offer a sign-in flow. Source pages are read in a separate script-disabled context with per-origin approval. If one search engine blocks the session, Jarvis still tries the other approved engines. This does not integrate Google AI Mode or guarantee an answer for unlisted/private phone numbers.

## GLM-5 setup

The key is **not** included in the app. Open the project-root `.env` file and put your own Bedrock Mantle key after the equals sign:

```dotenv
BEDROCK_MANTLE_API_KEY=your-own-key
```

Restart Jarvis after editing `.env`. Electron main loads this file on startup; it is ignored by Git and is never included in the renderer. An already set shell environment variable takes precedence. No `JARVIS_GLM_PROVIDER` setting is needed for Bedrock Mantle.

Jarvis uses the same direct provider path as invisible-overlay: `https://bedrock-mantle.ap-south-1.api.aws/v1/chat/completions` with model `zai.glm-5`. Your key must be an **Amazon Bedrock API key** authorized for this model and region. A key issued by the overlay's local backend is not interchangeable with a Bedrock API key. Direct app-launch and filename-search requests are recognized locally. For other task requests, GLM-5 may propose structured calls to open an app, Downloads, or an HTTPS website. Each call requires an existing scoped grant **and** a fresh Open once confirmation; malformed arguments and more than three actions are rejected. Neither model prose nor a saved grant alone triggers an action. Python proposals and screenshot-date extraction remain text-only. File and spreadsheet content access is not implemented.

For a personal [Z.AI API key](https://z.ai/manage-apikey/apikey-list) instead, explicitly set `JARVIS_GLM_PROVIDER=zai` and `JARVIS_GLM_API_KEY` in `.env`. Do not paste any key into Jarvis chat, commit it, or put it into frontend environment variables. This setup is not persistent keychain storage.

Ask a text question to make a real request to the selected provider. **Show status** reports whether a key is configured, not whether it is valid. A successful response confirms this session can use it; 401/403 indicates rejected key or account access, and 429 indicates rate limit or quota. Check billing and model access with the selected provider. Task chat sends your submitted question and the three action tool definitions; when approved, action results are returned to the provider. It does not send folders or task history. No free-tier or unlimited-usage claim is made.

## Architecture and security

- `electron/main.mts`: lifecycle, native tray/shortcut, narrow IPC handlers, renderer navigation blocking.
- `electron/preload.cts`: isolated bridge. Renderer has no direct Node.js or shell access.
- `electron/tasks.mts`: bounded in-process task queue, result states and cancellation.
- `electron/glm.mts`: main-process authenticated GLM-5 requests with bounded timeout and validated, bounded client-side tool calls.
- `electron/permissions.mts`: persisted scoped read-folder, named-app launch, and separate HTTPS-origin open/read permissions with revocation.
- `electron/browser-research.mts`: temporary Chrome session, per-origin approval, bounded public page inspection and evidence collection.
- `electron/file-search.mts`: sequential, scoped filename search with explicit per-folder decisions, validated Spotlight results, bounded fallback and macOS access error reporting.
- `electron/python-actions.mts`: ephemeral GLM-5 Python proposals and one-time approvals; no unattended execution.
- `src/bridge.ts`: typed renderer contract; `src/App.tsx`: command view and session history.
- Renderer sandbox and context isolation are enabled, Node integration disabled, and a CSP limits loaded resources. Dev CSP permits Vite's local websocket. No unauthenticated server, startup service, bundled credentials, or file-content tools are enabled. Configured GLM-5 requests go from Electron main to the selected provider.

## Roadmap

| Milestone | Status | Acceptance criterion |
| --- | --- | --- |
| 1. Foundation | Implemented; tray/shortcut manual check pending | Build and unit tests pass; secure Electron window and basic local commands operate. |
| 2. Permissions | Implemented | Validated persisted scoped grants, revocation, permission UI and denial tests. |
| 3. Local tools | Filename search and opening found files implemented; file-content tools planned | Scoped sequential filename lookup skips symlinks and surfaces access errors; content and modification tools remain planned. |
| 4. GLM-5 | Text, confirmed app/folder/website tool calls and reviewed Python proposals implemented; keychain storage planned | Z.AI and Bedrock Mantle endpoints, user-owned environment key, mock-tested responses and failures. Tool actions require scoped permission and confirmation; Python runs only after one-time code approval. |
| 5. Context | Planned | User-selected company/personal folders and inspectable, deletable memory. |
| 6. Reliability | Planned | Persistent task states, restart recovery and safe deduplication. |
| 7. Voice | Planned | Consent-based push-to-talk with visible mic state and native permissions. |
| 8. Workflows | Planned | Validated reusable plans and durable time-zone-aware schedules. |

GLM-5 endpoint, model identifier and bearer authentication were checked against official documentation and the overlay's direct provider request. No real account key was used during development, so live credentials, model access and quota remain unverified. No shared key is shipped. App launching is currently macOS-only; Windows behavior and macOS native shortcut/tray behavior need manual verification. Packaging, signing, durable task history and restart recovery remain future work.

## Manual checks

1. Run `npm run dev`; verify the assistant window loads and `show time` produces a result.
2. Submit `wait 20 seconds`, cancel it, and confirm the state becomes cancelled without freezing input.
3. Close the window, reopen from the tray and shortcut; use the tray Quit action to exit.
4. Run `npm run build && npm start` and confirm assets also load from disk.
5. Run `open photos`; allow its launch in the prompt and confirm Photos opens. Revoke the Photos grant and confirm another request prompts again. Repeat with `open vscode` and `open terminal`; a grant for one app must not authorize another. Deny a prompt and confirm the app does not launch. Try `open my Downloads folder` and select Downloads in the picker; confirm Finder opens it. Try `open https://example.com`, approve its origin and confirm your default browser opens it; revoke the website grant and confirm Jarvis asks again.
6. Run `can you find report on my desktop`; allow Desktop in the permission dialog, then skip Documents and allow Downloads when prompted. Confirm only approved folders are searched. Add an absolute folder path in Permissions; verify the native picker requires the same folder and invalid paths are rejected. If macOS denies access, verify the distinct system-access error.
7. With your own `BEDROCK_MANTLE_API_KEY` in `.env`, restart Jarvis and ask a question; confirm a response or inspect the reported HTTP status. Without a key, confirm the missing-key message. Request `python: print 2 + 3`, inspect the code, deny it, then request it again and approve once; verify the result.

These manual checks are instructions, not claims of completed verification.
