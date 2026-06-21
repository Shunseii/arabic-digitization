// Tauri entry point shared by the desktop binary and (on mobile) the
// generated wrapper. The frontend talks to the Cloudflare Worker with the
// webview's native fetch (the Worker sends CORS headers), so no HTTP plugin
// is needed.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
