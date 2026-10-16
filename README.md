# TeXdesk

A lightweight LaTeX editor for macOS, for writing homework and notes directly in `.tex` files as fast as you'd type them in Markdown.

> **Preview.** TeXdesk is early software. It works for daily use, but expect rough edges, and keep your files in version control or a synced folder. Please report problems in [Issues](../../issues).

- **Snippets written in TypeScript.** Short ones are one-liners. Any snippet can also be a function that reads the editor context, so things like auto-fractions, generated matrices and environment-aware keys are ordinary code. Snippet files hot-reload on save.
- **Gilles Castel's snippets built in.** The [setup from his lecture-notes post](https://castel.dev/post/lecture-notes-1/) ships as a plugin: turn it on in Settings → Plugins, or Duplicate it to make your own fork.
- **Expansion happens while you type.** No pre-compiler: the file on disk is always plain, portable LaTeX.
- **Automatic builds** with Tectonic on save and whenever you pause typing. Errors and warnings show inline. The PDF preview keeps your scroll position, zooms, and SyncTeX jumps between the PDF and the source in both directions.
- **Workspaces you organize yourself.** Define folder types, templates and overview pages in the app. Nothing about classes or homework is built in, though a *Coursework* starter is included.
- **Inline math preview** (KaTeX), paste images as figures, Vim mode, search across files, and a LaTeX Suite (Obsidian) snippet importer.
- **Spellchecking as you type** (the macOS spellchecker, prose only). ⌘L fixes the last misspelling before the cursor.

## Install

1. Install [Tectonic](https://tectonic-typesetting.github.io/), which TeXdesk builds with: `brew install tectonic`.
2. Download `TeXdesk.dmg` from the [latest release](../../releases) and drag TeXdesk to Applications. It runs on Apple Silicon and Intel Macs.
3. The preview builds aren't signed with an Apple Developer ID yet, so macOS blocks the first launch ("TeXdesk is damaged" or "can't be opened"). Allow it once with:

   ```sh
   xattr -dr com.apple.quarantine /Applications/TeXdesk.app
   ```

   or right-click TeXdesk in Applications → Open → Open.

TeXdesk looks for Tectonic on `PATH`, in `/opt/homebrew/bin`, `/usr/local/bin` and `~/.cargo/bin`, or at the path set in Settings → Tectonic path. Tectonic downloads the LaTeX packages it needs on first use, so the first build that uses a new package needs an internet connection.

## Plugins and safety

Snippet plugins are TypeScript that runs inside TeXdesk, with the same access to your files as the app. Yours live in `~/.config/texdesk/plugins/`. A workspace can also bring its own in `.texdesk/plugins/`, and its settings can name a different Tectonic program. So when you open a folder that comes with either, TeXdesk asks first, and uses neither until you allow that folder. You can change your answer in Settings → Plugins. Only allow folders whose contents you trust.

## Build from source

You need:

- **Node.js 22** (see `.nvmrc`; `nvm use` picks it up). The test runner doesn't start on Node 21 or older.
- **Rust** 1.77 or newer, via [rustup](https://rustup.rs/).
- **Xcode Command Line Tools**: `xcode-select --install`.
- Tectonic, as above, to compile documents and to run the compile tests.

```sh
npm install
npm run tauri build -- --bundles app
cp -R src-tauri/target/release/bundle/macos/TeXdesk.app /Applications/
```

A build you make yourself isn't quarantined, so it opens without the step above. To update it, rebuild and copy it again.

## Development

```sh
npm run tauri dev   # the desktop app, with hot reload of the frontend
npm run dev         # the frontend alone in a browser, on http://localhost:1420
npm test            # frontend tests (vitest)
npm run typecheck
cd src-tauri && cargo test
```

In browser-only mode (`npm run dev`), a small Vite plugin stands in for the Rust backend. It only gets access to `./dev-workspace` (created on first run and gitignored; set `TEXDESK_DEV_ROOT` to use another folder) and `~/.config/texdesk`.

The installed app and `npm run tauri dev` can run side by side.

### Releasing

Push a version tag (for example `git tag v0.1.0-preview.1 && git push --tags`). The Release workflow builds a universal macOS app and attaches it to a draft pre-release; check it on GitHub, then publish it.

## Where things live

- `~/.config/texdesk/settings.json`: your settings, for every workspace.
- `~/.config/texdesk/plugins/<id>/`: your snippet plugins (`.ts` files plus a `plugin.json`).
- `<workspace>/.texdesk/`: a workspace's setup (`workspace.json`), templates and its own plugins.
- Build output goes in a `.build/` folder next to each `.tex` file.

## License

MIT, see [LICENSE](LICENSE). The built-in Castel snippets are ported from [gillescastel/latex-snippets](https://github.com/gillescastel/latex-snippets), © 2019 Gilles Castel, MIT License.
