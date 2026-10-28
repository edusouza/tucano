# Tucano on Windows

Tucano was built for macOS. This document covers running it on Windows: what you need, how to run and package it, how it behaves differently from the Mac, and **every change** made to get there, file by file.

Status: **runs on Windows 10/11 (x64)**, in development (`npm run dev`) and as a packaged app (`npm run dist:win`). Typecheck and the full test suite pass on Windows, including the Docker tests. A real agent turn through Claude Code works end to end. The Windows build is **not code-signed**.

## What you need

| | |
|---|---|
| Windows 10 or 11, x64 | Tested on Windows 10 Home 22H2 (19045) |
| [Node.js](https://nodejs.org) 24+ | For `npm install` and the tests |
| [Git for Windows](https://git-scm.com/download/win) | Its **Git Bash** is the shell agents' commands run in when an agent's computer is *This PC* (Claude Code on Windows needs it too). Without it, those commands fall back to `cmd.exe` |
| At least one harness, signed in | Claude Code is the quickest: `irm https://claude.ai/install.ps1 \| iex`, then `claude auth login`. Codex, OpenCode and Pi install with npm (`npm install -g @openai/codex`, `npm install -g opencode-ai`, `npm install -g @earendil-works/pi-coding-agent`) |
| Optional: [Docker Desktop](https://www.docker.com/products/docker-desktop/) | For the isolated Linux computer. The first use pulls `node:22-bookworm` |
| Optional: Google Chrome | For an agent's browser; it is found in `Program Files`, `Program Files (x86)` or `%LOCALAPPDATA%` |

## Running it

```powershell
git clone https://github.com/eduwxyz/tucano.git
cd tucano
npm install
npm run dev
```

- **Electron's binary.** Electron 44 downloads its binary the first time it runs, not at `npm install`. If `npm run dev` stops on that (offline, proxy), run `node node_modules/electron/install.js` once.
- **Data folder.** `npm run dev` keeps its data in `%APPDATA%\Tucano Dev`; the installed app uses `%APPDATA%\Tucano`. `TUCANO_DATA`, `TUCANO_FAKE_ENGINES=1` and `TUCANO_SEED` work as on the Mac (in PowerShell: `$env:TUCANO_FAKE_ENGINES = '1'; npm run dev`).
- **Checks:** `npm run typecheck` and `npm test`. The Docker tests run when Docker Desktop is running and `node:22-bookworm` is pulled; otherwise they are skipped.
- **Screenshots:** `node scripts/screens.mjs <folder>` works as on the Mac.

### Packaging

```powershell
npm run dist:win
```

This builds `dist\tucano-win-x64.exe`, a one-click per-user NSIS installer, with no admin rights needed. `npx electron-builder --win --dir --x64` builds just the unpacked app, in `dist\win-unpacked\Tucano.exe`. Neither is code-signed, so SmartScreen warns on first open. `npm run dist`, `npm run install-app`, `npm run release` and `install.sh` remain macOS-only (Apple signing, notarization, `/Applications`).

## How it behaves differently from the Mac

| | macOS | Windows |
|---|---|---|
| Finding harness CLIs | The login shell's `PATH` (apps opened from Finder get a minimal one) | The process `PATH` as is (Windows gives every app the full one), trying each `PATHEXT` extension: `claude.exe`, `codex.cmd`… |
| Running a CLI | Spawned directly | `.exe` spawned directly; npm's `.cmd` shims through `cmd.exe`, with every argument escaped for it (Node refuses to spawn a `.cmd` directly) |
| Stopping a CLI or command | `SIGTERM`/`SIGKILL` to the process group | `taskkill /t /f` on the process tree, plus the MSYS process group (see below) |
| *This Mac / This PC* computer | `/bin/bash`, the login shell's environment | Git's MSYS `bash.exe` (with `MSYSTEM` and the Git tools on `PATH`, as Git Bash's launcher sets them), the app's environment minus `TUCANO_*`, `ELECTRON_*`, `VITE_*` and `NODE_OPTIONS`; `cmd.exe` if Git isn't installed. The agent's tool description and system prompt say which shell it is |
| Folders that can't be lent | `~/Library`, dot folders | Also `%USERPROFILE%\AppData` |
| Signing in to a harness | Opens Terminal.app via `osascript` | Opens a console window running a small `login.cmd` in the data folder |
| `apiKeyHelper` (Claude Code on a gateway) | Runs in the login shell (`$SHELL -lc`) | Runs in Git Bash, or `cmd.exe` |
| Sounds | `afplay` | PowerShell's `Media.SoundPlayer` |
| Notifications | Native | Native toasts (needs the app id `dev.tucano.app`, set at start) |
| Menu | App menu (About, Services, Hide, Quit), Edit, View, Window | File (About, Exit), Edit, View, Window |
| Shortcuts | ⌘K, ⌘N, ⌘1…9, ⌘, | Ctrl+K, Ctrl+N, Ctrl+1…9, Ctrl+, (and the labels say so) |
| Install hints for missing harnesses | `curl … \| bash` in Terminal | `irm … \| iex` / `npm install -g …` in PowerShell |
| Moving data from *agent-desk* | On first open of the installed app | Skipped: agent-desk never shipped for Windows, and the key lived in the macOS Keychain |
| Secrets | Keychain (Electron `safeStorage`) | DPAPI (Electron `safeStorage`), no change needed |

### Why Git Bash runs without its launcher, and the MSYS process group

`C:\Program Files\Git\bin\bash.exe` is a small launcher that starts the real shell, `usr\bin\bash.exe`. Tucano starts the real one directly, with the environment the launcher would set: `MSYSTEM` is `UCRT64` on recent Git installs (or `MINGW64`), and `<git>\ucrt64\bin` (or `mingw64\bin`) and `<git>\usr\bin` go first on `PATH`. That way the pid Tucano holds is the shell's own.

That matters for stopping commands. Git Bash emulates `fork`, so a job sent to the background (`npm run dev &`, `sleep 30 & …`) ends up with a Windows parent that has already exited. `taskkill /t` can't find it from the shell, and the orphan keeps the output pipe open, so a timed-out command would never return. MSYS still keeps its own process groups, so before calling `taskkill`, Tucano runs Git's `ps` and adds the Windows pid of every process in the shell's group. `test/mac.test.ts` ("stops a command at its time limit, with its children") covers this, and no `sleep` is left behind afterwards.

### Docker on Windows

The Linux computer works unchanged, including lending a Windows folder (`-v C:\Users\…\project:/projetos/project`) and `host.docker.internal`. The one difference is a Docker CLI bug: on Windows, `docker cp -L` resolves an absolute link target (`/etc/hostname`) against the link's own folder (`/work/etc/hostname`), so showing a file through a symlink failed. On Windows, Tucano resolves the path inside the container first (`readlink -f`, which still can't reach the host) and copies the plain file.

## Every change

### New files

| File | What and why |
|---|---|
| `src/core/platform.ts` | The core's OS differences in one place. `executableNames` (`PATHEXT` names of a command, keeping only `.exe`, `.cmd`, `.bat` and `.com`, never `.js`/`.vbs`/`.py`); `pathDirs` (`PATH` split on `;`, whatever its spelling); `spawnable` (how to spawn a CLI: `.cmd`/`.bat` through `cmd.exe /d /s /c` with cross-spawn's escaping, doubled for npm shims); `killTree` (process group on POSIX; `taskkill /t /f` plus the MSYS process group on Windows); `gitRoot` (finds Git for Windows from `CLAUDE_CODE_GIT_BASH_PATH`, `PATH` or the usual install folders, never WSL's bash); `shellCommand` (the shell for an agent's command and the environment it needs); `chromePath` (Chrome's location per OS) |
| `src/shared/os.ts` | What the window and the core both need to know: `onWindows` (from `navigator.platform`, which Node and the sandboxed page both have), `mod` (`⌘` or `Ctrl+`) and `modDown` for shortcuts, `MACHINE` (`Mac` or `PC`) for the "This Mac / This PC" copy |
| `test/platform.test.ts` | Tests for `platform.ts`. On Windows: a real npm-style `.cmd` shim receives awkward arguments intact (quotes, `&`, `%PATH%`, `^`, `( ) \| < >`, trailing backslashes, spaces, the empty string, Codex's `-c` TOML values), `PATHEXT` lookup, and Git's bash starts with the right `MSYSTEM` and `PATH`. On macOS: a CLI is spawned as is, and the shell is `/bin/bash` |
| `.gitattributes` | LF for every text file regardless of `core.autocrlf`. A Windows checkout with CRLF breaks `install.sh` and `scripts/*.sh` in bash and makes diffs noisy |
| `docs/windows.md` | This document |

### Core (`src/core`)

| File | Change | Why |
|---|---|---|
| `engines/detect.ts` | `adoptLoginShellPath` does nothing on Windows; `which` uses `pathDirs()` and `executableNames()`; `run` goes through `spawnable` with `windowsHide` | The login-shell trick (`$SHELL -ilc`) has no Windows equivalent and isn't needed; `PATH` is `;`-separated there; the CLIs are `claude.exe`, `codex.cmd`…; `execFile` can't run a `.cmd` |
| `engines/cli.ts` | `runCli` spawns through `spawnable` with `windowsHide`; a stop on Windows kills the tree | An npm CLI on Windows sits behind `cmd.exe`: `child.kill()` would end only `cmd.exe` and leave the CLI running |
| `mac.ts` | Commands and services run through `shellCommand` and stop through `killTree`; `detached` only on POSIX (on Windows it opens a console window); `loginEnv` on Windows is the app's environment without its own variables, with `HOME` added; `~\` paths resolve to the home folder; the `bash` tool's description names the Windows shell; a service's log tail splits on `\r?\n` | `/bin/bash`, negative-pid process groups and a login shell don't exist on Windows; the model has to know it is in Git Bash or `cmd.exe`, not macOS |
| `context.ts` | When the agent's computer is this PC, the system prompt's "Your computer" intro says Windows and which shell (`C:\Users` is `/c/Users` in Git Bash) | Same reason: the model writes the commands |
| `computer.ts` | `checkFolder` also refuses `AppData`; on Windows `keep` resolves a container path with `readlink -f` before `docker cp` | `AppData` is Windows' `Library` (settings, credentials). The `docker cp -L` bug is described above |
| `connectors.ts` | Not Windows-specific, found while testing here: a remote connector added with OAuth whose server has no dynamic client registration (GitHub's `api.githubcopilot.com/mcp/`) now says to add it again with a token, instead of the SDK's "Incompatible auth server: does not support dynamic client registration". Test: `test/connectors.test.ts` | GitHub's OAuth only serves apps registered ahead of time, so a personal access token is the way in; the raw SDK message didn't say what to do |
| `chrome.ts` | `CHROME` comes from `chromePath()`; headless Chrome's user-agent metadata says Windows / x86 on Windows instead of always macOS / arm | Chrome lives in `Program Files` on Windows; sites compare the client hints with the user agent string, which says Windows there |
| `mac.ts`, `computer.ts`, `context.ts`, `team.ts` | Every message and tool description that named the user's machine says `MACHINE` (*PC* on Windows): `read_file`, `write_file`, `start_service`, `screenshot`, `show_file`, a port in use, a port not published, Docker not running, a service bound to localhost, the `AppData`/`Library` refusal, lent folders and the Linux computer's `node_modules` in the prompt, a webhook routine in the team export. The export header says "another computer" | The model was told it was on a Mac, and the person read "Mac" on a PC |
| `skills.ts` | A linked skill's folder uses `dirname(source)`, and its name `basename(dirname(source))` | `source.lastIndexOf('/')` / `split('/')` broke on `C:\…\SKILL.md`: the support files weren't listed and the fallback name was wrong |
| `local-skills.ts` | Support files are listed with `/` | So the listing the model reads (`refs/a.md`) is the same on both systems; reading it back works with either separator |
| `index.ts` | `runHelper` (`apiKeyHelper`) uses `shellCommand` on Windows; `loginEngine` on Windows writes `login.cmd` in the data folder and opens it in a new console (`start "Tucano" cmd.exe /k`), setting `HOME` and `CODEX_HOME` for Codex | `osascript` and Terminal.app don't exist; a script avoids `cmd.exe`'s quoting rules for paths with spaces |

### Main process (`src/main/index.ts`)

| Change | Why |
|---|---|
| `app.setAppUserModelId('dev.tucano.app')` on Windows | Windows shows toast notifications only for an app with an id; it matches the installer's `appId` |
| The agent-desk migration runs only on macOS | It calls `/usr/bin/security` and moves a macOS Keychain key; agent-desk never existed on Windows |
| `chirp` plays the sounds on Windows through PowerShell's `Media.SoundPlayer` | `afplay` is macOS-only; this needs nothing installed |
| On Windows the menu is File (About, Exit), Edit, View, Window | The macOS app menu's Services, Hide and Hide Others don't exist there |

### Window (`src/renderer`)

| File | Change |
|---|---|
| `App.tsx` | Shortcuts use `modDown(e)`: Ctrl on Windows, ⌘ on the Mac. Before, they only listened for `metaKey`, the Windows key |
| `components/Dialogs.tsx`, `components/Sidebar.tsx` | The "New channel" shortcut label shows `Ctrl+N` on Windows |
| `components/Harness.tsx` | "Opens a console window" and "paste in PowerShell" on Windows, instead of Terminal |
| `components/Pages.tsx`, `components/Onboarding.tsx` | The computer picker says *This PC* on Windows, along with its warning and the labels next to it ("on your PC", "Folders from your PC", "Give it the PC"), and "Open when the PC starts" |
| `components/Onboarding.tsx`, `Pages.tsx`, `Conversation.tsx`, `Sidebar.tsx`, `Skills.tsx`, `Routines.tsx` | The rest of the copy that named the Mac says *PC* on Windows: onboarding's title, privacy note and harness lead, the "runs commands on your PC" warning and the *Your PC* chip on the agent card, the Linux computer's hint, the vault for tokens (it was "the Mac's Keychain"), the "on your PC" tag in a conversation and the sidebar, skills with scripts, webhook routines and the routine time hint. The webhook help drops the Xcode build phase on Windows; the team backup says "another computer" |
| `components/Splash.tsx` | Not Windows-specific, found while running here: in dev, StrictMode runs the splash effect twice, and the second run couldn't parse the leaves' `translate(…)` after GSAP had rewritten it, which crashed the window. Each leaf's position is now kept in a `data-at` attribute the first time it's read |
| `src/shared/types.ts` | `ENGINES[…].install` shows the Windows install commands for Claude Code (`irm https://claude.ai/install.ps1 \| iex`) and OpenCode (`npm install -g opencode-ai`) |

### Tests (`test`)

| File | Change |
|---|---|
| `mac.test.ts` | Platform-aware where the platform really differs: `pwd -W` in Git Bash prints `C:/…`; a Windows absolute path for the "absolute path" case; the injected environment carries Windows' `PATH` and `SystemRoot`; the service test serves with `node` (on Windows `python3` is often the Store's placeholder); the tool description and prompt checks expect *Windows* / *PC*, and on Windows no tool description or prompt line may say *Mac*; `PATH` is looked up whatever its spelling. On macOS every expectation is the same as before |
| `engines.test.ts` | `CODEX_HOME` is compared with `join(…)` instead of a hard-coded `/` path |
| `computer.test.ts` | The `.venv` existence stub matches with `join(…)` |

### Build and repo

| File | Change |
|---|---|
| `package.json` | `build.win` (NSIS, `build/icon.png`, `tucano-win-${arch}.${ext}`), `build.nsis` (one-click, per user) and the `dist:win` script |
| `README.md`, `README.pt-BR.md` | A `npm run dist:win` row, and a "On Windows?" note pointing here |
| `CONTRIBUTING.md` | Windows in Setup (and its dev data folder), and a convention: OS differences live in `platform.ts`/`os.ts`, paths go through `path`, commands through `spawnable`/`shellCommand` |

## What was verified, on Windows 10 (19045), Node 24.20, Electron 44.8

- `npm run typecheck`: clean.
- `npm test`: every test passes, including the 17 Docker tests with Docker Desktop 29.6 running. Without Docker running, those are skipped, as on the Mac.
- `npm run build`, then `scripts/screens.mjs` with the fake engines, through screen 24 of 27: channels, router, handoffs, `ask_user`, connectors with the demo MCP server, grants, approvals, memory, summaries, and the Linux computer in Docker with a lent command, a service on port 8000, a screenshot and the side panel. The last steps (routines) fail on every system: their selectors (`.routine-example`, `.routine-form`) predate the calendar redesign of the Routines page. The routine engine is covered by `test/routines.test.ts`.
- One real turn with Claude Code 2.x (`claude.exe`): detected and signed in, the agent replied through the per-turn MCP gateway, receipt included.
- The packaged app (`electron-builder --win --dir`): starts, finds its bundled sounds, has the Windows menu, and Ctrl+K opens *Go to*.

And on macOS, to check nothing changed there: the same branch on GitHub Actions' `macos-latest` (macOS 26.6, Apple silicon, Node 24.21). `npm run typecheck` is clean. `npm test` reports 227 passed and 11 skipped: the Docker tests (no Docker on that runner) and the three Windows-only ones in `platform.test.ts`. `mac.test.ts` runs in full there, with the real `/bin/bash`. `electron-builder --mac --dir` packages an ad-hoc signed `Tucano.app` that passes `codesign --verify --deep --strict` and keeps running. `scripts/screens.mjs` (with `TUCANO_LOCALE=pt-BR`, since its selectors are in Portuguese) gets through 19 screens, up to the Linux computer, which needs Docker.

## Known limitations

- **Closing the window quits the app.** On the Mac, the app keeps running (and its routines with it) with no window. Windows has no Dock to bring it back, and there's no tray icon yet, so `window-all-closed` quits, which also stops routines. Keep the window minimized while routines should run.
- **Not code-signed.** SmartScreen warns on the first open of the installer.
- **Two macOS-only dialogs** in `src/main/index.ts` (⌘Q, the macOS Keychain) still name the Mac: they belong to the agent-desk migration, which never runs on Windows.
- **Without Git for Windows**, agents on *This PC* get `cmd.exe`, and the model is told so. Claude Code itself needs Git Bash on Windows anyway.
- **WSL isn't used.** Agents' commands on this PC run in Git Bash, not in a WSL distribution. The isolated Linux computer is Docker's.
- **macOS-only scripts:** `install.sh`, `scripts/dist.sh`, `scripts/install-app.sh` and `scripts/release.sh` stay as they were.
