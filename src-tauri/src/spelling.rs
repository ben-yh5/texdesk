//! Spelling, using the macOS spellchecker (the system dictionary and its languages, offline).

use serde::Serialize;

#[derive(Serialize, Debug, PartialEq)]
pub struct Misspelling {
    word: String,
    suggestions: Vec<String>,
    /// What macOS would autocorrect the word to, when it's confident (else `None`).
    correction: Option<String>,
}

/// The misspelled words among `words` (each checked on its own), with up to five suggestions
/// each and the system's autocorrection, if it has one. `None` where there's no system spellchecker. Not `async`: Tauri runs sync commands
/// on the main thread, which AppKit requires.
#[tauri::command]
pub fn check_spelling(words: Vec<String>) -> Option<Vec<Misspelling>> {
    imp::check(&words)
}

#[cfg(target_os = "macos")]
mod imp {
    use super::Misspelling;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::{NSArray, NSRange, NSString};

    pub fn check(words: &[String]) -> Option<Vec<Misspelling>> {
        // SAFETY: plain NSSpellChecker calls with valid NSString arguments, on the main thread.
        unsafe {
            let checker: Option<Retained<AnyObject>> = msg_send![class!(NSSpellChecker), sharedSpellChecker];
            let checker = checker?;
            let lang: Option<Retained<NSString>> = msg_send![&*checker, language];
            let mut out = Vec::new();
            for word in words {
                let s = NSString::from_str(word);
                let r: NSRange = msg_send![&*checker, checkSpellingOfString: &*s, startingAt: 0isize];
                if r.length == 0 {
                    continue;
                }
                let none: Option<&NSString> = None;
                let guesses: Option<Retained<NSArray<NSString>>> =
                    msg_send![&*checker, guessesForWordRange: r, inString: &*s, language: none, inSpellDocumentWithTag: 0isize];
                let suggestions = guesses.map(|g| g.iter().take(5).map(|x| x.to_string()).collect()).unwrap_or_default();
                let correction: Option<Retained<NSString>> = match &lang {
                    Some(l) => msg_send![&*checker, correctionForWordRange: r, inString: &*s, language: &**l, inSpellDocumentWithTag: 0isize],
                    None => None,
                };
                let correction = correction.map(|c| c.to_string()).filter(|c| c != word);
                out.push(Misspelling { word: word.clone(), suggestions, correction });
            }
            Some(out)
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub fn check(_words: &[String]) -> Option<Vec<super::Misspelling>> {
        None
    }
}
