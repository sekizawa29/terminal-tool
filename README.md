<p align="center">
  <img src="public/logo.svg" alt="tboard" width="360">
</p>

<p align="center">
  Browser-based terminal management on an infinite canvas.<br>
  Manage multiple shell sessions, link terminals together, and orchestrate AI agents — all from one board.
</p>

---

## Features

- **Infinite Canvas** — Pan, zoom, and arrange terminal windows freely on a boundless workspace
- **Multiple Shells** — Spawn unlimited terminal sessions (Bash, Zsh, PowerShell) side by side
- **Inter-Terminal Communication** — Link terminals and send commands between them via the `tt` CLI
- **AI Agent Launchers** — One-click launch for Claude, Codex, and other AI coding agents
- **File Explorer** — Browse, drag-drop, rename, and delete files with a built-in tree view
- **Text Editor** — Open and edit files directly on the canvas
- **Memo Panel** — Quick scratch notes pinned to the board
- **Browser Panel** — Embedded web viewer with navigation
- **Layout Persistence** — Window positions and links are saved automatically
- **Cross-Platform** — Works on macOS, Linux, and Windows (via WSL2)

## Requirements

- **Node.js** 18+ (with npm)
- **macOS** or **Linux** — native support
- **Windows** — requires WSL2 with Node.js installed inside WSL

## Quick Start

### macOS / Linux

```bash
git clone https://github.com/sekizawa29/terminal-tool.git
cd terminal-tool
./start.sh
```

`start.sh` will:
1. Install dependencies if `node_modules/` doesn't exist
2. Start the dev server (frontend + backend)
3. Auto-open your browser in app mode (Chrome, Edge, Brave, Safari, or default)

### Windows (WSL2)

**Prerequisites:** WSL2 installed with a Linux distro, and Node.js installed **inside** WSL (not Windows Node).

1. Clone the repo inside WSL:
   ```bash
   # In WSL terminal
   git clone https://github.com/sekizawa29/terminal-tool.git
   cd terminal-tool
   ```

2. Launch from either:
   - **WSL terminal:** `./start.sh`
   - **Windows Explorer:** double-click `start.bat`
   - **Windows Terminal / CMD:** `start.bat`

   `start.bat` automatically detects the repo's WSL path — no manual configuration needed.

The app will open at `http://127.0.0.1:51730` in your browser.

> **Tip:** If you use nvm inside WSL, `start.sh` automatically detects and loads it.

### Manual Start (any platform)

```bash
npm install
npm run dev
```

This starts the Vite dev server (port 5173) and the backend API server (port 3001). Open `http://127.0.0.1:5173` in your browser.

## Production Build

```bash
npm run build
npm start
```

Builds the frontend with Vite and compiles the server TypeScript, then serves everything from `dist/`.

## Usage

### Canvas Controls

| Action | Shortcut |
|--------|----------|
| New terminal | `Ctrl/Cmd + Shift + N` |
| Pan | Drag background or `Space` + drag |
| Zoom | `Ctrl/Cmd` + scroll |

### Panel Types

Create panels from the sidebar:

- **Terminal** — Full shell session with xterm.js
- **Memo** — Text notepad
- **Explorer** — File tree browser
- **Editor** — Text file editor (double-click a file in Explorer)
- **Browser** — Embedded web viewer

### Linking Terminals

Drag from a terminal's connector button to another terminal to create a link. Linked terminals can communicate via the `tt` CLI.

### `tt` CLI

The `tt` command is automatically available inside every tboard terminal. Use it for inter-terminal communication:

```bash
tt ls                          # List all terminals
tt send <target> <message>     # Send a command to another terminal
tt read <target> [lines]       # Read terminal output
tt ipc <target> <message>      # Send and wait for response
tt peers                       # List linked terminals
tt status                      # Show current terminal status
tt history <target>            # View IPC conversation history
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Backend API server port |
| `VITE_PORT` | `5173` | Vite dev server port |

When launched via `start.sh`, ports are fixed to `51731` (backend) and `51730` (frontend).

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React, TypeScript, xterm.js, Zustand |
| Backend | Express, node-pty, WebSocket |
| Build | Vite |

## License

MIT
