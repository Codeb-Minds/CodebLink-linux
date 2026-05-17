# Codeb Link — Desktop Client (Linux/Electron)

Codeb Link is a background synchronization suite designed to seamlessly bridge your Linux desktop clipboard and files with your Android device. Engineered with Electron, React, TypeScript, and Vite, it handles real-time data transfers over local network tunnels.

> 📱 **Mobile Companion**: This desktop client pairs with the Android companion application. The source code and instructions for the mobile app can be found at [CodebLink-app](https://github.com/Codeb-Minds/CodebLink-app).

---

## 🎯 Purpose & Problem Solver

Codeb Link is built to resolve key user experience and system issues common to cross-device utility tools:

1. **Clipboard Sync Failures on Linux**: Standard Electron and Node APIs often fail to write directly to Linux system clipboard registers under different display environments. Codeb Link integrates active fallbacks to native command-line clipboards on both Wayland and X11.
2. **Electron Event Loop Hanging**: When users select text inside an Electron window, the event loop can freeze or delay clipboard-read operations. Codeb Link implements an auto-reset mechanism that clears selections after 1 second, restoring normal clipboard event cycles.
3. **Inconsistent Drag-and-Drop Catching**: Traditional drag zones fail if files are dropped on inner text/icons or if inside-browser components (like QR images) are dragged. Codeb Link uses pointer event mitigation and a dynamic link parser to download and sync dragged assets automatically.

---

## 🚀 Core Features

- **Dual-Channel Synchronization**: Seamlessly shifts between dynamic active sockets (foreground sync) and power-efficient background long-polling ("Ghost" channel).
- **Universal Drag-and-Drop Zone**: Dropping any local file or dragging in-app graphic elements initiates background transfers.
- **End-to-End Encryption**: Encrypts clipboard contents client-side using **AES-256** (via CryptoJS) matched to a shared key synced via QR Code.
- **Collapsible System Telemetry**: Offers a toggleable telemetry panel to inspect network connections, data logs, and system pulses.
- **Wayland & X11 Compatibility**: Features a dedicated clipboard writer pipeline targeting multiple display-server backends.

---

## 🛠️ System Requirements & Fallbacks

To ensure reliable clipboard synchronization across all Linux display environments, make sure the following command-line tools are installed:

- **For Wayland Display Servers**: `wl-clipboard` (`wl-copy` and `wl-paste` commands)
- **For X11 Display Servers**: `xclip` and/or `xsel`

Install them via your package manager:
```bash
# Ubuntu/Debian
sudo apt update && sudo apt install wl-clipboard xclip xsel

# Fedora/RHEL
sudo dnf install wl-clipboard xclip xsel

# Arch Linux
sudo pacman -S wl-clipboard xclip xsel
```

---

## ⚙️ Setup & Development

Follow these instructions to run and build the desktop client:

### 1. Install Dependencies
Install the required npm packages directly from the repository root:
```bash
npm install
```

### 2. Run in Development Mode
Launches the Vite server and the Electron runtime concurrently:
```bash
npm run dev
```

### 3. Compile Main TypeScript Code
Compiles `electron/main.ts` into Node-executable `main.js`:
```bash
npm run build:main
```
