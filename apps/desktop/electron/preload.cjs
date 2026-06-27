// No native bridge is needed yet — the renderer reaches the Worker over fetch.
// This file exists so contextIsolation has a preload boundary to grow into
// (e.g. exposing a typed IPC surface via contextBridge) without reconfiguring
// the window.
