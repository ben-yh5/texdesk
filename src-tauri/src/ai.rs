//! Claude API requests for the diagram editor. The API key is the user's own, kept in the
//! macOS Keychain; only this module reads it, and requests only ever go to api.anthropic.com
//! (the frontend chooses the request body, never where it's sent).

use std::time::Duration;

const URL: &str = "https://api.anthropic.com/v1/messages";

#[cfg(target_os = "macos")]
mod keychain {
    use security_framework::passwords::{delete_generic_password, get_generic_password, set_generic_password};

    const SERVICE: &str = "TeXdesk";
    const ACCOUNT: &str = "anthropic-api-key";
    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

    pub fn get() -> Option<String> {
        let bytes = get_generic_password(SERVICE, ACCOUNT).ok()?;
        String::from_utf8(bytes).ok().filter(|k| !k.is_empty())
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
    pub fn get() -> Option<String> {
        None
    }
    pub fn set(_key: &str) -> Result<(), String> {
        Err("API keys are stored in the macOS Keychain, which this system doesn't have".into())
    }
    pub fn delete() -> Result<(), String> {
        Ok(())
    }
}

#[tauri::command]
pub fn ai_has_key() -> bool {
    keychain::get().is_some()
}

/// Saves the key in the Keychain; an empty key removes it.
#[tauri::command]
pub fn ai_set_key(key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() { keychain::delete() } else { keychain::set(key) }
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
    let key = keychain::get().ok_or("No API key yet: add yours in Settings → AI")?;
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
}
