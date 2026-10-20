//! Claude API requests for the diagram editor. The API key is the user's own, kept in the
//! macOS Keychain; only this module reads it, and requests only ever go to api.anthropic.com
//! (the frontend chooses the request body, never where it's sent).

use std::sync::Mutex;
use std::time::Duration;

const URL: &str = "https://api.anthropic.com/v1/messages";

/// What reading the key from the Keychain gave.
#[derive(Clone, Debug, PartialEq)]
pub enum Read {
    Key(String),
    None,
    /// TeXdesk wasn't allowed to read it (Deny on the Keychain's password prompt).
    Denied,
}

#[cfg(target_os = "macos")]
mod keychain {
    use super::Read;
    use security_framework::passwords::{delete_generic_password, get_generic_password, set_generic_password};

    const SERVICE: &str = "TeXdesk";
    const ACCOUNT: &str = "anthropic-api-key";
    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
    /// Deny, or Cancel on the password prompt.
    const ERR_SEC_USER_CANCELED: i32 = -128;
    const ERR_SEC_AUTH_FAILED: i32 = -25293;

    pub fn read() -> Read {
        match get_generic_password(SERVICE, ACCOUNT) {
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(k) if !k.is_empty() => Read::Key(k),
                _ => Read::None,
            },
            Err(e) if e.code() == ERR_SEC_USER_CANCELED || e.code() == ERR_SEC_AUTH_FAILED => Read::Denied,
            Err(_) => Read::None,
        }
    }

    pub fn set(key: &str) -> Result<(), String> {
        set_generic_password(SERVICE, ACCOUNT, key.as_bytes()).map_err(|e| e.to_string())
    }

    pub fn delete() -> Result<(), String> {
        match delete_generic_password(SERVICE, ACCOUNT) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod keychain {
    use super::Read;
    pub fn read() -> Read {
        Read::None
    }
    pub fn set(_key: &str) -> Result<(), String> {
        Err("API keys are stored in the macOS Keychain, which this system doesn't have".into())
    }
    pub fn delete() -> Result<(), String> {
        Ok(())
    }
}

/// The last read. Each read of a key the app isn't allowed to (to the Keychain, every new build
/// is a new app) shows the password prompt, so a key is read once per launch, and after Deny the
/// Keychain isn't asked again until `retry`.
static LAST: Mutex<Option<Read>> = Mutex::new(None);

fn lookup(last: &mut Option<Read>, retry: bool, read: impl FnOnce() -> Read) -> Read {
    match last {
        Some(Read::Key(_)) => {}
        Some(Read::Denied) if !retry => {}
        _ => *last = Some(read()),
    }
    last.clone().unwrap()
}

fn key(retry: bool) -> Read {
    lookup(&mut LAST.lock().unwrap(), retry, keychain::read)
}

/// "saved", "none" or "denied"; `retry` asks the Keychain again after a Deny.
#[tauri::command]
pub fn ai_key_status(retry: bool) -> &'static str {
    match key(retry) {
        Read::Key(_) => "saved",
        Read::None => "none",
        Read::Denied => "denied",
    }
}

/// Saves the key in the Keychain; an empty key removes it.
#[tauri::command]
pub fn ai_set_key(key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        keychain::delete()?;
        *LAST.lock().unwrap() = None;
    } else {
        keychain::set(key)?;
        *LAST.lock().unwrap() = Some(Read::Key(key.to_string()));
    }
    Ok(())
}

/// The text of an API error response, e.g. "invalid x-api-key (401)".
fn error_message(status: u16, body: &str) -> String {
    let msg = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(String::from))
        .unwrap_or_else(|| body.chars().take(300).collect());
    format!("{msg} ({status})")
}

/// Sends a Messages API request (`body` as the API takes it) and returns the response.
#[tauri::command]
pub async fn ai_messages(body: serde_json::Value) -> Result<serde_json::Value, String> {
    let key = match key(false) {
        Read::Key(k) => k,
        Read::None => return Err("No API key yet: add yours in Settings → AI".into()),
        Read::Denied => return Err("TeXdesk isn't allowed to read your API key from the Keychain: allow it in Settings → AI".into()),
    };
    let client = reqwest::Client::builder().timeout(Duration::from_secs(180)).build().map_err(|e| e.to_string())?;
    let res = client
        .post(URL)
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("couldn't reach the Claude API: {e}"))?;
    let status = res.status().as_u16();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !(200..300).contains(&status) {
        return Err(error_message(status, &text));
    }
    serde_json::from_str(&text).map_err(|e| format!("unexpected response from the Claude API: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_errors_read_as_their_message() {
        let body = r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#;
        assert_eq!(error_message(401, body), "invalid x-api-key (401)");
        assert_eq!(error_message(502, "Bad Gateway"), "Bad Gateway (502)");
    }

    #[test]
    fn the_keychain_is_asked_once_and_not_again_after_deny_until_retry() {
        let mut last = None;
        let mut asked = 0;
        let mut read = |r: Read| { asked += 1; move || r };
        assert_eq!(lookup(&mut last, false, read(Read::Denied)), Read::Denied);
        assert_eq!(lookup(&mut last, false, || unreachable!()), Read::Denied);
        assert_eq!(lookup(&mut last, true, read(Read::Key("k".into()))), Read::Key("k".into()));
        assert_eq!(lookup(&mut last, true, || unreachable!()), Read::Key("k".into()));
        assert_eq!(asked, 2);
        // No key yet isn't remembered: one added meanwhile is found (and reading it doesn't prompt).
        let mut last = None;
        assert_eq!(lookup(&mut last, false, || Read::None), Read::None);
        assert_eq!(lookup(&mut last, false, || Read::Key("k".into())), Read::Key("k".into()));
    }
}
