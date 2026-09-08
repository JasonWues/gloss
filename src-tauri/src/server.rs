use crate::config::{get, set};
use crate::window::*;
use crate::APP;
use log::{error, info, warn};
use std::panic::AssertUnwindSafe;
use std::thread;
use tauri_plugin_notification::NotificationExt;
use tiny_http::{Method, Request, Response, Server};

pub const DEFAULT_SERVER_PORT: i64 = 60828;

/// Whether this request is one the server should act on.
///
/// Binding to 127.0.0.1 keeps the network out, but not the browser: any page the
/// user visits may issue a cross-origin request to localhost. It cannot read the
/// reply -- every handler below answers a constant string and no CORS header is
/// ever sent -- but the side effect still happens, and every endpoint here is a
/// side effect. Two of them, `/ocr_recognize` and `/ocr_translate`, take a
/// screenshot: before this, a page could have the user's screen captured and
/// pushed through whichever OCR service they had configured, by loading an
/// `<img>` pointed at this port.
///
/// Three checks, each closing a route the others leave open. None of them costs
/// a legitimate caller anything -- curl, PowerShell and the app's own Recognize
/// window all POST and send none of these headers.
fn vet(request: &Request) -> Result<(), (u16, &'static str)> {
    // 1. POST only. Every endpoint acts, so none of them was ever a legal GET,
    //    and requiring the method a browser cannot reach from markup rules out
    //    `<img src>`, `<script src>`, `<link>`, prefetch and the address bar in
    //    one go. It also stops an OPTIONS preflight running a handler: the match
    //    below is on the url alone, so before this a preflight for `/translate`
    //    executed the translation it was supposed to be asking permission for.
    if *request.method() != Method::Post {
        return Err((405, "this endpoint takes POST"));
    }

    for header in request.headers() {
        let value = header.value.as_str();
        // 2. No `Origin`. Browsers attach it to every cross-origin request that
        //    is not a simple GET -- so to every form submission and every fetch,
        //    including the `no-cors` ones whose replies they will not show the
        //    caller. Nothing that legitimately drives this server sends one.
        if header.field.equiv("origin") {
            warn!("Rejected a request carrying Origin: {value}");
            return Err((403, "cross-origin requests are not accepted"));
        }
        // 3. Fetch Metadata. Current browsers label who started a request, which
        //    catches the cross-site case even where no Origin is attached, and
        //    is the check that still holds if a future markup element learns to
        //    POST. `none` is a user typing the address; `same-origin` cannot
        //    arise, since this server serves no pages -- both are harmless.
        if header.field.equiv("sec-fetch-site") && value != "same-origin" && value != "none" {
            warn!("Rejected a request with Sec-Fetch-Site: {value}");
            return Err((403, "cross-site requests are not accepted"));
        }
        // 4. The Host has to be the loopback the socket is bound to. Without
        //    this, a name the attacker controls can be pointed at 127.0.0.1
        //    after the page has loaded -- DNS rebinding -- and the request then
        //    counts as same-origin, which would satisfy both checks above.
        if header.field.equiv("host") {
            let host = value.rsplit_once(':').map_or(value, |(name, _)| name);
            if host != "127.0.0.1" && host != "localhost" && host != "[::1]" && host != "::1" {
                warn!("Rejected a request for host {value}");
                return Err((403, "unexpected Host"));
            }
        }
    }
    Ok(())
}

pub fn start_server() {
    // Off is a real answer here. The server exists for the PopClip and SnipDo
    // extensions in `.scripts/`, and someone who does not use them was still
    // getting a listener they never asked for -- one that, until `vet` above,
    // any web page could reach. Bound at startup, so like the port it takes a
    // restart to change; Settings says so.
    let enabled = match get("server_enable").and_then(|v| v.as_bool()) {
        Some(v) => v,
        None => {
            set("server_enable", true);
            true
        }
    };
    if !enabled {
        info!("Local server disabled by setting");
        return;
    }

    // `server_port` comes out of config.json, which the user can edit by hand, so
    // a value of the wrong JSON type is ordinary input rather than a bug. It used
    // to be `as_i64().unwrap()`, which panicked here -- above the spawn, and so
    // above the `catch_unwind` below that exists to keep exactly this server
    // alive. A string in that key took the whole local server down before it
    // started, and the PopClip and SnipDo extensions in `.scripts/` silently did
    // nothing for the rest of the session. A key that is missing and a key that
    // does not parse now get the same treatment: default, and write it back.
    let port = match get("server_port").and_then(|v| v.as_i64()) {
        Some(v) => v,
        None => {
            set("server_port", DEFAULT_SERVER_PORT);
            DEFAULT_SERVER_PORT
        }
    };
    thread::spawn(move || {
        let server = match Server::http(format!("127.0.0.1:{port}")) {
            Ok(v) => v,
            Err(e) => {
                let _ = APP
                    .get()
                    .unwrap()
                    .notification()
                    .builder()
                    .title("Server start failed")
                    .body("Please Change Server Port and restart the application")
                    .show();
                warn!("Server start failed: {}", e);
                return;
            }
        };
        for request in server.incoming_requests() {
            // A panic in a handler used to unwind out of this loop, which drops
            // the `Server` and closes the listener with it: one bad request and
            // the port was gone for the rest of the session, with the PopClip and
            // SnipDo extensions in `.scripts/` silently doing nothing from then
            // on. Isolating each request keeps the failure to that request.
            //
            // `AssertUnwindSafe` because `Request` is not `UnwindSafe`. Nothing is
            // observed after a panic here -- the request is dropped, and tiny_http
            // answers a dropped request with a 500 -- so there is no half-updated
            // state for the next iteration to see.
            let url = request.url().to_string();
            if std::panic::catch_unwind(AssertUnwindSafe(|| http_handle(request))).is_err() {
                error!("Handler for {url} panicked; server still listening");
            }
        }
    });
}

fn http_handle(request: Request) {
    info!("Handle {} {} request", request.method(), request.url());
    if let Err((status, reason)) = vet(&request) {
        respond(request, status, reason);
        return;
    }
    match request.url() {
        "/" => handle_translate(request),
        "/config" => handle_config(request),
        "/translate" => handle_translate(request),
        "/selection_translate" => handle_selection_translate(request),
        "/input_translate" => handle_input_translate(request),
        "/ocr_recognize" => handle_ocr_recognize(request),
        "/ocr_translate" => handle_ocr_translate(request),
        "/ocr_recognize?screenshot=false" => handle_ocr_recognize(request),
        "/ocr_translate?screenshot=false" => handle_ocr_translate(request),
        "/ocr_recognize?screenshot=true" => handle_ocr_recognize(request),
        "/ocr_translate?screenshot=true" => handle_ocr_translate(request),
        _ => {
            // Answered rather than dropped. A dropped request still gets a
            // response -- tiny_http sends 500 -- so an unknown path used to look
            // to the caller exactly like the server falling over.
            warn!("Unknown request url: {}", request.url());
            respond(request, 404, "unknown path");
        }
    }
}

fn handle_config(request: Request) {
    config_window();
    response_ok(request);
}

fn handle_translate(mut request: Request) {
    let mut body = Vec::new();
    if let Err(e) = request.as_reader().read_to_end(&mut body) {
        warn!("Failed to read request body: {e}");
        respond(request, 400, "could not read request body");
        return;
    }
    // Lossy, where this used to be `read_to_string().unwrap()`. The body is text
    // someone wants translated, and a single stray byte -- a selection that
    // clipped a multi-byte character in half, say -- used to panic the handler
    // and, before the catch above, take the whole server down with it.
    let content = String::from_utf8_lossy(&body).into_owned();
    text_translate(content);
    response_ok(request);
}

fn handle_selection_translate(request: Request) {
    selection_translate();
    response_ok(request);
}

fn handle_input_translate(request: Request) {
    input_translate();
    response_ok(request);
}

fn handle_ocr_recognize(request: Request) {
    if request.url().ends_with("false") {
        recognize_window();
    } else {
        ocr_recognize();
    }
    response_ok(request);
}

fn handle_ocr_translate(request: Request) {
    if request.url().ends_with("false") {
        image_translate();
    } else {
        ocr_translate();
    }
    response_ok(request);
}

fn response_ok(request: Request) {
    respond(request, 200, "ok");
}

// Not `unwrap`: writing the response fails whenever the caller has already hung
// up, which is entirely its prerogative and not worth a panic.
fn respond(request: Request, status: u16, body: &str) {
    let response = Response::from_string(body).with_status_code(status);
    if let Err(e) = request.respond(response) {
        warn!("Failed to send response: {e}");
    }
}
