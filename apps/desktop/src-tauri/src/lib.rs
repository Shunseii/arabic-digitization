// Tauri entry point shared by the desktop binary and (on mobile) the
// generated wrapper. The HTTP plugin lets the webview's `fetch` reach the
// Cloudflare Worker from the Rust side, bypassing the browser CORS check.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
