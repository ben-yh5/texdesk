import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from "solid-js";
import { EditorView } from "@codemirror/view";
import { EditorSelection, EditorState, Extension, Transaction } from "@codemirror/state";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { FileTimes, Host, MenuEntry, MenuSection, WalkEntry, basename, dirname, extname, join, relative } from "../host/types";
import { isolateHistory, redo, undo } from "@codemirror/commands";
import { applySettings, editorState } from "../editor/setup";
import { extractMacros, mathMacros, setMacros } from "../editor/mathpreview";
import { extractEnvironments, setUserEnvironments } from "../editor/latexcomplete";
import { insertFigure, saveFigure } from "../editor/images";
import { openFind } from "../editor/search";
import { parseDictionary, proseWords, rankSuggestions, wordsToCheck } from "../editor/spelling";
import { EXTRA_ACTION, MAX_OPTIONS, openSpellFix, showSpellFix } from "../editor/spellfix";
import { formatKey, matchesKey, toAccelerator } from "./keys";
import { convertLatexSuite } from "../convert/latexSuite";
import { contextAt } from "../scanner/field";
import { SnippetRuntime, SnippetProblem } from "../snippets/runtime";
import { watchSnippets } from "../snippets/watch";
import type { Mode } from "../snippets/types";
import {
  CommandId, GLOBAL_SETTINGS, Raw, WorkspaceConfig, defaultConfig, formatJson, globalDir, loadGlobalConfig, readSettingsFile, setSettingKey, workspaceConfig,
} from "../workspace/config";
import {
  Created, applyStarter, createFile, createFolderOfType, createFromTemplate, ensureSupportFiles, ensureTemplates, fileInfoFor, findWorkspace,
  folderQuestions, readWorkspace, seedWorkspace, workspaceFile, writeStarterBodies,
} from "../workspace/workspace";
import {
  Block, FolderType, Scope, WorkspaceFile, emptyWorkspace, formatWorkspace, foldersOfType, foldersUsingLayout, keyFor as uniqueKey, layoutFor, missingFolders, moveFolderEntries,
  nearestOfType, parseWorkspace, removeFolderEntries, renameField, renameFieldInText, renameType, renameTypeInText, scopeFor,
} from "../workspace/model";
import { STARTERS } from "../workspace/starters";
import { SearchFile, SearchHit, searchFile, searchFiles } from "../workspace/search";
import { applyGlobalMigration, applyMigration, describePlan, hasLegacySetup, mergeSettings, planGlobalMigration, planMigration } from "../workspace/migrate";
import { PaletteView, PickItem, createPalette } from "./Palette";
import { ALL_KINDS, HeaderLink, Kinds, NewAction, Overview, ResolvedBlock } from "./Overview";
import { OverviewInput, filesView, folderMetas as metasOf, subfolderRows } from "../workspace/overview";
import { DebugPanel } from "./DebugPanel";
import { SettingsScope, SettingsView } from "./Settings";
import { Plugin, createPlugin, ensurePluginsFolder, listPlugins, pluginIdFor, snippetFolders as pluginSnippetFolders, NEW_PLUGIN_FILE } from "../plugins/plugins";
import { Tour, tourSteps } from "./Tour";
import { BuildController, BuildStatus, diagnosticsFor } from "../compile/controller";
import { entryPath, exportTo, linkedPdfs, pdfName, readManifest, unlinkPdfs } from "../compile/export";
import type { LinkCandidate } from "../editor/linkcomplete";
import { Backlink, LinkCommand, LinkRef, ResolveContext, isUrl, linkTargetFor, normalize, outgoingLinks, resolveLink, rewriteLinks } from "../workspace/links";
import { followLinkAtCursor, linkAtPos } from "../editor/links";
import { cycleBracketSize } from "../editor/brackets";
import { jumpOut } from "../editor/jumpout";
import { foldAll, unfoldAll } from "@codemirror/language";
import { knownCommandNames } from "../editor/commands";
import { Fix, RuleFix, ruleFix } from "../compile/fixes";
import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { Workbench, DropTarget, TabLabel } from "./Workbench";
import { PdfPane, PdfPaneApi } from "./PdfPane";
import {
  Layout, Tab, TabSpec, activate, activeTab, deserialize, emptyLayout, findSpec, findTab, groupById, keepTab, openPreview, others, place,
  removeTab, renamePaths, resize, retarget, reveal as revealTab, serialize, split, SavedLayout,
} from "./layout";
import { dragging } from "./dnd";
import type { Anchor } from "../preview/viewer";
import { pdfjsViewer, type ViewerFactory } from "../preview/viewer";
import { SyncTex, forwardSearchAll, inverseSearch, parseSynctex } from "../preview/synctex";
import type { MatchLog } from "../snippets/engine";
import { LISTINGS_LANGUAGES, insertCodeBlock, lastLanguage } from "../editor/codeblocks";
import { Sidebar, SidebarApi } from "./Sidebar";
import { ContextItem, ContextMenu } from "./ContextMenu";
import {
  DEFAULT_TEMPLATES, LoadedTemplate, NEW_TEMPLATE, findTemplate, listTemplates, nextNumber, numberPattern, promptsFor, readTemplate, renderName,
  templateLabel, templatesDir,
} from "../workspace/templates";
import * as prefs from "./prefs";

/** Default sidebar width, and its limits while dragging. */
const SIDEBAR_WIDTH = 250;
const clampSidebar = (w: number) => Math.round(Math.min(Math.max(w, 160), Math.max(240, window.innerWidth * 0.6)));
const pdfDefaultWidth = () => Math.round(window.innerWidth * 0.45);
const clampPdf = (w: number) => Math.round(Math.min(Math.max(w, 240), Math.max(320, window.innerWidth * 0.75)));

const MODE_LABEL: Record<Mode, string> = { text: "text", inline: "inline math", display: "display math", code: "code" };

const BINARY_EXT = new Set([
  "pdf", "png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "ico", "svgz", "tiff", "zip", "gz", "tar", "7z", "dmg",
  "mp3", "mp4", "mov", "wav", "m4a", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "key", "pages", "numbers",
  "class", "jar", "o", "so", "dylib", "exe", "db", "sqlite", "pyc", "woff", "woff2", "ttf", "otf",
]);
const TEX_EXT = new Set(["tex", "sty", "cls"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "pdf", "eps"]);

interface Command {
  /** Stable id, used by the menu bar and right-click menus. */
  id: string;
  label: string;
  /** Fixed shortcut (CodeMirror syntax) for commands without a configurable key. */
  accel?: string;
  /** What `when` requires, for "X needs …" when it can't run. */
  needs?: string;
  /** Hidden from the command palette (e.g. Undo). */
  palette?: boolean;
  /** Configurable shortcut (keys in settings). */
  key?: CommandId;
  /** Fixed shortcut shown as a hint. */
  hint?: string;
  when?: () => boolean;
  run: () => unknown;
}

export function App(props: { host: Host; viewerFactory?: ViewerFactory }) {
  const host = props.host;
  const runtime = new SnippetRuntime();
  const palette = createPalette();
  /** The current file's editor (undefined while its tab is hidden behind another). */
  let view: EditorView | undefined;
  let stopWatching: (() => void) | undefined;
  /** Stops watching the enabled plugins' folders. */
  let stopSnippetWatch: (() => void) | undefined;
  /** Stops watching the plugins folders themselves (plugins added or removed). */
  let stopPluginRootsWatch: (() => void) | undefined;
  /** Stops watching the global settings.json. */
  let stopGlobalWatch: (() => void) | undefined;
  /** `~/.config/texdesk/`, once the home folder is known (global settings and plugins). */
  let globalRoot: string | null = null;
  /** Stops the workspace tree watcher (keeps the file tree in step with the disk). */
  let stopTreeWatch: (() => void) | undefined;
  let messageTimer: ReturnType<typeof setTimeout> | undefined;
  /** The open file's figures folder, if settings name one. */
  let figuresDir: string | null = null;

  const [root, setRoot] = createSignal<string | null>(null);
  const [config, setConfig] = createSignal<WorkspaceConfig>(defaultConfig);
  /** `~/.config/texdesk/settings.json` over the defaults; the workspace's settings go on top. */
  const [globalConfig, setGlobalConfig] = createSignal<WorkspaceConfig>(defaultConfig);
  /** The global settings.json as written. */
  let globalRaw: Raw = {};
  /** The open workspace's workspace.json (empty when it has none). */
  const [ws, setWs] = createSignal<WorkspaceFile>(emptyWorkspace());
  const [wsErrors, setWsErrors] = createSignal<string[]>([]);
  const [plugins, setPlugins] = createSignal<Plugin[]>([]);
  const [settingsOpen, setSettingsOpen] = createSignal<string | null>(null);
  const [tour, setTour] = createSignal(false);
  /** When TeXdesk last wrote a settings file (its own reloads aren't announced). */
  let settingsWroteAt = 0;
  const [entries, setEntries] = createSignal<WalkEntry[]>([]);
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [sidebar, setSidebar] = createSignal(prefs.get("sidebar", true));
  const [sidebarWidth, setSidebarWidth] = createSignal(clampSidebar(prefs.get("sidebarWidth", SIDEBAR_WIDTH)));
  /** The PDF pane on the right: shown (⌘⇧P hides it), and its width. */
  const [pdfShown, setPdfShown] = createSignal(prefs.get("preview", true));
  const [pdfWidth, setPdfWidth] = createSignal(clampPdf(prefs.get("pdfWidth", pdfDefaultWidth())));
  const [path, setPath] = createSignal<string | null>(null);
  const [isTex, setIsTex] = createSignal(false);
  const [dirty, setDirty] = createSignal(false);
  const [mode, setMode] = createSignal<Mode>("text");
  const [env, setEnv] = createSignal<string[]>([]);
  /** Status bar breadcrumb: folders with a kind (click for their overview), then the file. */
  const [crumbs, setCrumbs] = createSignal<{ label: string; dir?: string }[]>([]);
  const [snippetInfo, setSnippetInfo] = createSignal({ snippets: 0, keys: 0 });
  const [problems, setProblems] = createSignal<SnippetProblem[]>([]);
  const [showProblems, setShowProblems] = createSignal(false);
  const [message, setMessageSignal] = createSignal<{ text: string; error: boolean } | null>(null);
  const [recents, setRecents] = createSignal<string[]>(prefs.get("recentWorkspaces", []));
  const [hasTexdesk, setHasTexdesk] = createSignal(false);
  const [debug, setDebug] = createSignal(false);
  const [lastLog, setLastLog] = createSignal<MatchLog | null>(null);
  const [build, setBuild] = createSignal<BuildStatus>({ state: "idle", file: null, diagnostics: [] });
  const [showBuild, setShowBuild] = createSignal(false);
  const [generated, setGenerated] = createSignal<Map<string, string>>(new Map());
  /** Generated PDFs (relative paths) that are "Save PDF as…" copies, updated on every build. */
  const [linkedCopies, setLinkedCopies] = createSignal<Set<string>>(new Set());
  /** Target file → links to it from other .tex files. */
  const [linkIndex, setLinkIndex] = createSignal<Map<string, Backlink[]>>(new Map());
  /** Contents of the workspace's .tex files, for the backlinks index. */
  const texCache = new Map<string, string>();
  const [layout, setLayoutSignal] = createSignal<Layout>(emptyLayout());
  const [outputVersion, setOutputVersion] = createSignal(0);
  const [isRootDoc, setIsRootDoc] = createSignal(false);
  let sidebarApi: SidebarApi | null = null;

  /** The document whose PDF the PDF pane shows: the open file if it's a full document, else the last build. */
  const outputSource = () => (isTex() && path() && isRootDoc() ? path() : build().file);
  /** The PDF pane is on screen: shown, and there's a document for it. */
  const pdfVisible = () => pdfShown() && !!outputSource();
  const outputPdf = () => {
    const src = outputSource();
    return src ? join(dirname(src), ".build", basename(src).replace(/\.tex$/, ".pdf")) : null;
  };

  /** Settings and variables in effect in `dir` (null outside a workspace). Problems are shown if `report`. */
  async function scopeAt(dir: string, report = false): Promise<Scope | null> {
    const r = root();
    if (!r) return null;
    const scope = scopeFor(r, config(), ws(), dir);
    if (report && scope.errors.length) say(scope.errors.join("; "), true);
    return scope;
  }

  const builder = new BuildController(host, async (file) => {
    const scope = await scopeAt(dirname(file));
    return { root: root(), config: scope?.config ?? config(), vars: scope?.vars ?? {}, figuresDir: scope?.figuresDir ?? null };
  });
  let lastExportNote = "";
  const unsubBuild = builder.subscribe(() => {
    const st = builder.status;
    setBuild(st);
    applyDiagnostics();
    if (st.state === "ok") { setOutputVersion(outputVersion() + 1); void followEdit(); setFixNote(null); }
    if (st.state === "failed") findRuleFix();
    if (st.state === "ok" || st.state === "failed") {
      const e = st.export;
      const skipped = [e, ...(st.saved ?? [])].filter((x) => x?.status === "skipped") as { reason: string }[];
      const note = skipped.length ? `Built, but the PDF wasn't copied: ${skipped.map((x) => x.reason).join("; ")}` : "";
      if (note && note !== lastExportNote) say(note, true);
      lastExportNote = note;
      if (e?.status === "exported" || st.saved?.some((x) => x.status === "exported")) void refreshFiles();
    }
  });
  onCleanup(() => { unsubBuild(); builder.dispose(); });

  function applyDiagnostics() {
    const p = path();
    if (!view || !p || !isTex()) return;
    const doc = view.state.doc;
    const span = (n: number) => {
      const line = doc.line(Math.min(Math.max(n, 1), doc.lines));
      const indent = /^\s*/.exec(line.text)![0].length;
      return { from: line.from + indent, to: Math.max(line.to, line.from + indent) };
    };
    const note = fixNote();
    const list: Diagnostic[] = diagnosticsFor(builder.status, p).map((d) => {
      const explained = note?.file === p && note.line === d.line && d.severity === "error";
      return {
        ...span(d.line!), severity: d.severity, source: "tectonic",
        message: explained ? `${d.message}\n\n${note.explanation}` : d.message,
        actions: explained ? [fixAction(note)] : undefined,
      };
    });
    // Misspellings from the last spellcheck, wherever those words still are; not the word
    // being typed (the cursor right after it), until the cursor moves on.
    const sp = spelling();
    typing = null;
    if (sp?.file === p && sp.misses.size) {
      const head = view.state.selection.main;
      for (const w of proseWords(doc.toString())) {
        const suggestions = sp.misses.get(w.word);
        if (!suggestions) continue;
        if (head.empty && head.head === w.to && view.hasFocus) { typing = { from: w.from, to: w.to }; continue; }
        list.push({
          from: w.from, to: w.to, severity: "info", source: "spelling", markClass: "cm-spell",
          message: suggestions.length ? `“${w.word}” may be misspelled` : `“${w.word}” may be misspelled (no suggestions)`,
          actions: [
            ...suggestions.slice(0, MAX_OPTIONS).map((x) => ({ name: x, apply: (v: EditorView, from: number, to: number) => v.dispatch({ changes: { from, to, insert: x }, userEvent: "input.spell" }) })),
            { name: "Add to dictionary", markClass: EXTRA_ACTION, apply: () => void addToDictionary(w.word) },
          ],
        });
      }
    }
    view.dispatch(setDiagnostics(view.state, list));
  }

  const say = (text: string, error = false) => {
    setMessageSignal({ text, error });
    clearTimeout(messageTimer);
    messageTimer = setTimeout(() => setMessageSignal(null), error ? 8000 : 4000);
  };
  const fail = (err: unknown) => say(err instanceof Error ? err.message : String(err), true);

  const unsub = runtime.subscribe(() => {
    setSnippetInfo({ snippets: runtime.set.snippets.length, keys: runtime.set.keys.length });
    setProblems([...runtime.loadErrors, ...runtime.runtimeProblems]);
    if (debug()) setLastLog(runtime.lastLog);
  });
  onCleanup(() => { unsub(); stopWatching?.(); stopSnippetWatch?.(); stopPluginRootsWatch?.(); stopGlobalWatch?.(); stopTreeWatch?.(); for (const v of views.values()) v.destroy(); });

  // ---- editor ---------------------------------------------------------------------

  const refreshMode = (v: EditorView) => {
    if (!isTex()) return;
    const c = contextAt(v.state, v.state.selection.main.head);
    setMode(c.mode);
    setEnv(c.envStack);
  };

  function updateTitle() {
    const p = path();
    const r = root();
    const where = r ? basename(r) : "TeXdesk";
    host.setTitle(p ? `${dirty() ? "• " : ""}${basename(p)} — ${where}` : where);
  }

  /** Saves the open file; a .tex/.sty file then builds after `buildDelay` ms. */
  async function save(buildDelay = config().build.debounceMs): Promise<boolean> {
    const p = path();
    if (!p || !view || !dirty()) return true;
    try {
      const text = view.state.doc.toString();
      await host.writeText(p, text);
      setDirty(false);
      if (extname(p) === "tex" && root() && p.startsWith(root()! + "/")) { texCache.set(p, text); reindexLinks(); }
      updateTitle();
      if (TEX_EXT.has(extname(p))) builder.schedule(p, buildDelay);
      if (extname(p) === "sty" || extname(p) === "tex") void refreshMacros();
      return true;
    } catch (err) {
      fail(`Save failed: ${String(err)}`);
      return false;
    }
  }

  async function languageFor(p: string): Promise<Extension[]> {
    const desc = LanguageDescription.matchFilename(languages, basename(p));
    if (!desc) return [];
    try { return [await desc.load()]; } catch { return []; }
  }

  // ---- editor groups ----------------------------------------------------------------
  //
  // Each group has one CodeMirror view showing its active text tab. Other open text files
  // keep their EditorState (undo history, cursor) in `docs`. The "current" file (path(),
  // view) is the text tab last focused: commands, the status bar and builds follow it.

  const views = new Map<string, EditorView>();
  /** Group → file its view shows. */
  const viewDoc = new Map<string, string | null>();
  /** States of open text files that aren't on screen. */
  const docs = new Map<string, EditorState>();
  const pdfAnchors = new Map<string, Anchor>();
  let outputApi: PdfPaneApi | null = null;

  function setLayout(l: Layout) {
    setLayoutSignal(l);
    const r = root();
    if (r) prefs.set(`layout:${r}`, serialize(l, (p) => relative(r, p)));
  }

  const shownIn = (p: string) => [...viewDoc].find(([, d]) => d === p)?.[0] ?? null;
  const hasTab = (p: string) => !!findSpec(layout(), { kind: "text", path: p });

  async function loadState(p: string): Promise<EditorState | null> {
    let text: string;
    try {
      text = await host.readText(p);
    } catch (err) {
      fail(`Could not open ${basename(p)}: ${String(err)}`);
      return null;
    }
    const tex = TEX_EXT.has(extname(p));
    return editorState({
      doc: text,
      tex,
      settings: config().editor,
      extra: tex ? [] : await languageFor(p),
      runtime,
      onUpdate: (v, changed) => {
        if (p !== path() || reloading) return;
        if (changed && !dirty()) { setDirty(true); updateTitle(); }
        if (changed) {
          lastEdit = { file: p, line: v.state.doc.lineAt(v.state.selection.main.head).number };
          scheduleAutoCompile();
          scheduleSpellcheck();
        } else if (typing && v.state.selection.main.head !== typing.to) applyDiagnostics(); // moved off the word being typed
        refreshMode(v);
      },
      onSave: () => void save(),
      onOpenLink: (ref) => void followLink(ref, p),
      linkCandidates: (cmd) => linkCandidatesFor(cmd, p),
    });
  }

  function mountEditor(g: string, el: HTMLElement) {
    const v = new EditorView({ state: EditorState.create(), parent: el });
    v.dom.addEventListener("paste", onPaste, true);
    v.dom.addEventListener("contextmenu", (e) => void onEditorContextMenu(e, g));
    v.dom.addEventListener("focusin", () => void focusText(g));
    // Double-click a line: show it in the PDF (⌘⇧J), quietly if there's nothing built yet; unless the PDF isn't following the editor.
    v.dom.addEventListener("dblclick", () => { if (viewDoc.get(g) === path() && isTex() && config().editor.followEdits) void showInPdf(true); });
    views.set(g, v);
    viewDoc.set(g, null);
    void reconcile();
  }

  function unmountEditor(g: string) {
    const v = views.get(g);
    const d = viewDoc.get(g);
    if (v && d && hasTab(d)) docs.set(d, v.state);
    if (view === v) view = undefined;
    v?.destroy();
    views.delete(g);
    viewDoc.delete(g);
  }

  /** Makes every group's view show its active text tab, then settles which file is current. */
  let reconciling: Promise<void> = Promise.resolve();
  function reconcile(): Promise<void> {
    reconciling = reconciling.then(doReconcile, doReconcile);
    return reconciling;
  }
  async function doReconcile() {
    const wanted = (gid: string) => {
      const g = groupById(layout(), gid);
      const t = g && activeTab(g);
      return t?.kind === "text" ? t.path : null;
    };
    // First take every outgoing file's state off its view (a tab moving between groups
    // carries its unsaved edits and undo history), then give each view its file.
    for (const [gid, have] of viewDoc) {
      if (!have || wanted(gid) === have) continue;
      if (hasTab(have)) docs.set(have, views.get(gid)!.state);
      viewDoc.set(gid, null);
      if (!wanted(gid)) views.get(gid)!.setState(EditorState.create());
    }
    for (const gid of [...views.keys()]) {
      const want = wanted(gid);
      if (viewDoc.get(gid) === want) continue;
      let state: EditorState | null = null;
      if (want) {
        state = docs.get(want) ?? (await loadState(want));
        if (!state || wanted(gid) !== want || !views.has(gid) || shownIn(want)) continue; // changed while loading
        docs.delete(want);
      }
      views.get(gid)!.setState(state ?? EditorState.create());
      viewDoc.set(gid, want);
    }
    for (const d of [...docs.keys()]) if (!hasTab(d)) docs.delete(d);
    // Settle the current file: keep it if it's still open, else take a visible one.
    const cur = path();
    const g = cur ? shownIn(cur) : null;
    if (cur && g) { view = views.get(g); return; }
    if (cur && hasTab(cur)) { view = undefined; return; }
    const ag = layout().activeGroup;
    const next = (viewDoc.get(ag) && ag) || [...viewDoc].find(([, d]) => d)?.[0];
    if (next) await makeCurrent(viewDoc.get(next)!, next);
    else clearCurrent();
  }

  /** The group text files open in by default: where the current file is, else the active group. */
  function textGroup(): string {
    const cur = path();
    const hit = cur ? findSpec(layout(), { kind: "text", path: cur }) : null;
    if (hit) return hit.group.id;
    const withText = layout().groups.find((g) => activeTab(g)?.kind === "text");
    return withText?.id ?? layout().activeGroup;
  }

  /** Where PDFs open by default: in a group already showing one, else with the text. */
  function pdfGroup(): string {
    const text = textGroup();
    return layout().groups.find((g) => g.id !== text && g.tabs.some((t) => t.kind === "pdf"))?.id ?? text;
  }

  type Where = { group: string; index?: number; side?: "left" | "right" | "center" };

  function placeSpec(spec: TabSpec | Tab, where: Where): Layout {
    const l = layout();
    if (where.side === "left" || where.side === "right") return split(l, spec, where.group, where.side).layout;
    return place(l, spec, where.group, where.index).layout;
  }

  /** Opens a text file in a tab (in `where`, or where it's open, or the text group) and makes it current. */
  async function showFile(p: string, cursor?: number, where?: Where) {
    if (p !== path() && !(await save())) return;
    if (!shownIn(p)) {
      const kept = docs.get(p);
      let fresh = !kept;
      if (kept) {
        // A kept state is clean (files are saved when you leave them); reload if the file changed on disk.
        try { fresh = (await host.readText(p)) !== kept.doc.toString(); } catch { fresh = true; }
      }
      if (fresh) {
        const st = await loadState(p);
        if (!st) return;
        docs.set(p, st);
      }
    }
    const spec: TabSpec = { kind: "text", path: p };
    const existing = findSpec(layout(), spec)?.tab;
    if (where) setLayout(placeSpec(existing ?? spec, where));
    else setLayout(revealTab(layout(), spec, textGroup()).layout);
    await reconcile();
    const g = shownIn(p);
    if (!g) return;
    await makeCurrent(p, g);
    if (cursor !== undefined && view) {
      const pos = Math.min(cursor, view.state.doc.length);
      view.dispatch({ selection: EditorSelection.cursor(pos), scrollIntoView: true });
    }
    view?.focus();
    // A document that has never been built builds now, so there's always a PDF to look at.
    if (isRootDoc() && path() === p && !(await host.exists(join(dirname(p), ".build", basename(p).replace(/\.tex$/, ".pdf"))))) builder.schedule(p, 0);
  }

  /** Makes `p` (shown in group `g`) the current file: status bar, tree, snippets, diagnostics. */
  async function makeCurrent(p: string, g: string) {
    const v = views.get(g);
    if (!v) return;
    view = v;
    const tex = TEX_EXT.has(extname(p));
    if (p !== path()) setDirty(false);
    setPath(p);
    setIsTex(tex);
    setIsRootDoc(tex && /^[^%\n]*\\documentclass/m.test(v.state.sliceDoc(0, 20000)));
    if (layout().activeGroup !== g) setLayout({ ...layout(), activeGroup: g });
    refreshMode(v);
    updateTitle();
    applyDiagnostics();
    void refreshMacros();
    scheduleSpellcheck(0);

    const r = root();
    if (r) {
      prefs.set(`lastFile:${r}`, p);
      const rel = relative(r, p);
      // Reveal the file in the tree.
      const next = new Set(expanded());
      const parts = rel.split("/");
      for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join("/"));
      setExpanded(next);
      prefs.set(`expanded:${r}`, [...next]);
      const scope = (await scopeAt(dirname(p), true))!;
      if (path() !== p) return;
      figuresDir = scope.figuresDir;
      setCrumbs([...scope.folders.filter((f) => f.kind).map((f) => ({ label: basename(f.path), dir: f.path })), { label: basename(p) }]);
      runtime.setFileInfo(fileInfoFor(p, r, config(), ws()));
    } else {
      setCrumbs([{ label: basename(p) }]);
      figuresDir = null;
      runtime.setFileInfo(null);
    }
  }

  function clearCurrent() {
    view = undefined;
    setPath(null);
    setIsTex(false);
    setIsRootDoc(false);
    setDirty(false);
    setCrumbs([]);
    updateTitle();
  }

  /** Clicking into another group's editor makes its file current. */
  async function focusText(g: string) {
    const d = viewDoc.get(g);
    if (!d || d === path()) return;
    if (!(await save())) return;
    await makeCurrent(d, g);
  }

  async function activateTab(id: string) {
    const hit = findTab(layout(), (t) => t.id === id);
    if (!hit) return;
    if (hit.tab.kind === "text") return showFile(hit.tab.path!, undefined, undefined);
    if (!(await save())) return;
    setLayout(activate(layout(), id));
    await reconcile();
  }

  async function closeTab(id: string) {
    const hit = findTab(layout(), (t) => t.id === id);
    if (!hit) return;
    if (hit.tab.kind === "text" && hit.tab.path === path() && !(await save())) return;
    setLayout(removeTab(layout(), id));
    await reconcile();
    const g = path() ? shownIn(path()!) : null;
    if (g) views.get(g)?.focus();
  }

  async function closeTabs(ids: string[]) {
    for (const id of ids) await closeTab(id);
  }

  /** A tab, or a file or folder (its overview) from the tree, dropped onto a group. */
  async function onDrop(target: DropTarget) {
    const d = dragging();
    if (!d) return;
    const where: Where = "index" in target ? { group: target.group, index: target.index } : { group: target.group, side: target.side };
    if (d.kind === "tab") {
      const hit = findTab(layout(), (t) => t.id === d.tabId);
      if (!hit) return;
      if (hit.tab.kind === "text") return showFile(hit.tab.path!, undefined, where);
      setLayout(placeSpec(hit.tab, where));
      await reconcile();
      return;
    }
    const r = root();
    const p = r && !d.path.startsWith("/") ? join(r, d.path) : d.path;
    if (await isDirectory(p)) return openOverview(p, { where });
    if (extname(p) === "pdf") return openPdf(p, where);
    if (BINARY_EXT.has(extname(p))) { try { await host.openExternal(p); } catch (err) { fail(err); } return; }
    await showFile(p, undefined, where);
  }

  /** Opens a PDF in a tab: where it's dropped, or beside the text. */
  async function openPdf(p: string, where?: Where) {
    const spec: TabSpec = { kind: "pdf", path: p };
    if (where) setLayout(placeSpec(findSpec(layout(), spec)?.tab ?? spec, where));
    else if (findSpec(layout(), spec)) setLayout(revealTab(layout(), spec, layout().activeGroup).layout);
    else setLayout(place(layout(), spec, pdfGroup()).layout);
    await reconcile();
  }

  /** Shows the PDF pane. */
  function openOutput() {
    setPdfShown(true);
    prefs.set("preview", true);
  }

  /** Opens any path: a folder becomes the workspace; a file opens (switching workspace if needed). */
  async function openPath(p: string, cursor?: number) {
    if (await isDirectory(p)) return openWorkspace(p);
    if (extname(p) === "pdf") return showPdf(p);
    if (BINARY_EXT.has(extname(p))) {
      try { await host.openExternal(p); } catch (err) { fail(err); }
      return;
    }
    if (!(await save())) return;
    const r = root();
    const global = !!globalRoot && p.startsWith(globalRoot + "/");
    if (!global && (!r || !p.startsWith(r + "/"))) {
      const ws = await findWorkspace(host, p);
      if (ws && ws !== r) await openWorkspace(ws, { restoreFile: false });
      else if (!ws && r) closeWorkspace();
    }
    await showFile(p, cursor);
  }

  /** A PDF from the tree/⌘K: the open document's own export shows in the PDF pane; anything else gets a tab. */
  async function showPdf(p: string) {
    const r = root();
    const src = r ? generated().get(relative(r, p)) : undefined;
    if (src && r && join(r, src) === outputSource()) return openOutput();
    await openPdf(p);
  }

  async function isDirectory(p: string): Promise<boolean> {
    try { await host.readDir(p); return true; } catch { return false; }
  }

  // ---- workspace ------------------------------------------------------------------

  async function refreshFiles() {
    const r = root();
    if (!r) return;
    try {
      const list = await host.listFiles(r, config().ignore);
      setEntries(list);
      const gen = new Map<string, string>();
      const linked = new Set<string>();
      const texDirs = new Set(list.filter((e) => !e.isDir && e.path.endsWith(".tex")).map((e) => (e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/")) : "")));
      for (const d of texDirs) {
        const dir = d ? join(r, d) : r;
        const m = await readManifest(host, dir);
        for (const [key, info] of Object.entries(m.exports)) {
          const abs = entryPath(dir, key);
          if (!abs.startsWith(r + "/")) continue;
          const rel = relative(r, abs);
          gen.set(rel, d ? `${d}/${info.source}` : info.source);
          if (info.linked) linked.add(rel);
        }
      }
      setGenerated(gen);
      setLinkedCopies(linked);
      await indexTexFiles(r, list);
      await refreshTemplates();
      await refreshTimes(list);
    } catch (err) {
      fail(err);
    }
  }

  // ---- changes on disk ----------------------------------------------------------------

  let treeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set while the open file is replaced with its new contents from disk (not an edit). */
  let reloading = false;

  /** Files changed on disk (by TeXdesk or anything else): refresh the tree, backlinks and the open file. */
  function onDiskChange(r: string, paths: string[]) {
    if (root() !== r) return;
    for (const p of paths) texCache.delete(p);
    const cur = path();
    if (cur && paths.includes(cur)) void reloadFromDisk(cur);
    clearTimeout(treeTimer);
    treeTimer = setTimeout(() => void refreshFiles(), 150);
  }
  onCleanup(() => clearTimeout(treeTimer));

  /** The open file changed on disk: show the new contents, unless you have unsaved edits. */
  async function reloadFromDisk(p: string) {
    let text: string;
    try { text = await host.readText(p); } catch { return; } // deleted or moved: the tree refresh handles it
    if (!view || path() !== p || dirty()) return;
    const old = view.state.doc.toString();
    if (text === old) return; // our own save
    let a = 0;
    while (a < old.length && old[a] === text[a]) a++;
    let b = 0;
    while (b < Math.min(old.length, text.length) - a && old[old.length - 1 - b] === text[text.length - 1 - b]) b++;
    reloading = true;
    try {
      view.dispatch({ changes: { from: a, to: old.length - b, insert: text.slice(a, text.length - b) }, annotations: Transaction.remote.of(true) });
    } finally { reloading = false; }
    setDirty(false);
    updateTitle();
    say(`${basename(p)} changed on disk — reloaded`);
  }

  // ---- links between files ----------------------------------------------------------

  /** Reads .tex files not seen yet (or all, after a workspace switch) and rebuilds the backlinks. */
  async function indexTexFiles(r: string, list: WalkEntry[]) {
    const tex = new Set(list.filter((e) => !e.isDir && e.path.endsWith(".tex")).map((e) => join(r, e.path)));
    for (const f of texCache.keys()) if (!tex.has(f)) texCache.delete(f);
    for (const f of tex) {
      if (texCache.has(f)) continue;
      try { texCache.set(f, await host.readText(f)); } catch { /* unreadable: skip */ }
      if (root() !== r) return;
    }
    reindexLinks();
  }

  function linkContext(): ResolveContext {
    const r = root();
    return {
      root: r,
      files: new Set(r ? entries().filter((e) => !e.isDir).map((e) => join(r, e.path)) : []),
      dirs: new Set(r ? entries().filter((e) => e.isDir).map((e) => join(r, e.path)) : []),
    };
  }

  function reindexLinks() {
    const ctx = linkContext();
    const index = new Map<string, Backlink[]>();
    for (const [file, text] of texCache) {
      for (const l of outgoingLinks(text, file, ctx)) {
        const list = index.get(l.path) ?? [];
        list.push({ file, line: l.line, text: l.text });
        index.set(l.path, list);
      }
    }
    setLinkIndex(index);
  }

  const backlinks = () => (path() ? linkIndex().get(path()!) ?? [] : []);

  /** Opens what a link points to: a workspace file, a file next to `fromFile`, or a URL. */
  async function followLink(ref: Pick<LinkRef, "command" | "target">, fromFile: string) {
    const ctx = linkContext();
    const figures = (await scopeAt(dirname(fromFile)))?.figuresDir;
    if (figures) ctx.searchDirs = [figures];
    let hit = resolveLink(ref, fromFile, ctx);
    if (!hit && !isUrl(ref.target) && !ref.target.startsWith("/")) {
      // Outside a workspace (or not indexed yet): check next to the file directly.
      for (const ext of ["", ".tex"]) {
        const p = normalize(join(dirname(fromFile), ref.target + ext));
        if (await host.exists(p) && !(await isDirectory(p))) { hit = { kind: "file", path: p }; break; }
      }
    }
    if (!hit) { say(`Nothing found for \\${ref.command}{${ref.target}}`, true); return; }
    if (hit.kind === "folder") { await openOverview(hit.path); return; }
    if (hit.kind === "url") {
      // Links can come from PDFs you didn't write: only hand web and mail links to the system.
      if (!/^(https?|mailto):/i.test(hit.url)) { say(`Not opening ${hit.url} (only web and mail links open from TeXdesk)`, true); return; }
      try { await host.openExternal(hit.url); } catch (err) { fail(err); }
      return;
    }
    await openPath(hit.path);
  }

  /** Workspace files that fit in `command`'s braces, as targets relative to `fromFile`. */
  /** Files and folders a \link can point to (not hidden ones, or generated files). */
  function linkableEntries(): WalkEntry[] {
    const gen = generated();
    return entries().filter((e) => !gen.has(e.path) && !e.path.split("/").some((x) => x.startsWith(".")));
  }

  /**
   * What \link{…} should say to reach `abs` from `fromFile`: like Obsidian, just the name when no
   * other linkable file or folder in the workspace has it (\link finds names anywhere), else a
   * relative path.
   */
  function shortLinkTarget(fromFile: string, abs: string, counts = linkNameCounts()): string {
    const mine = linkName(abs);
    return !mine || (counts.get(mine) ?? 0) > 1 ? linkTargetFor(fromFile, abs) : mine;
  }
  const linkName = (p: string) => basename(p).replace(/\.tex$/, "");
  /** How many linkable files and folders have each name. */
  function linkNameCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const e of linkableEntries()) { const n = linkName(e.path); counts.set(n, (counts.get(n) ?? 0) + 1); }
    return counts;
  }

  function linkCandidatesFor(command: LinkCommand, fromFile: string): LinkCandidate[] {
    const r = root();
    if (!r) return [];
    const gen = generated();
    const out: LinkCandidate[] = [];
    if (command === "link") {
      const counts = linkNameCounts();
      for (const e of linkableEntries()) {
        const abs = join(r, e.path);
        if (abs === fromFile) continue;
        out.push({ target: shortLinkTarget(fromFile, abs, counts), name: basename(e.path) + (e.isDir ? "/" : ""), detail: dirname("/" + e.path).slice(1), path: e.path });
      }
      return out;
    }
    for (const e of entries()) {
      if (e.isDir || gen.has(e.path) || e.path.startsWith(".texdesk/")) continue;
      const abs = join(r, e.path);
      const ext = extname(e.path);
      if (abs === fromFile) continue;
      if ((command === "input" || command === "include") && ext !== "tex") continue;
      if (command === "includegraphics" && !IMAGE_EXT.has(ext)) continue;
      if (command === "lstinputlisting" && (ext === "tex" || BINARY_EXT.has(ext))) continue;
      // Images in the configured figures folder are on the search path, so the name is enough.
      const target = command === "includegraphics" && dirname(abs) === figuresDir ? basename(abs) : linkTargetFor(fromFile, abs);
      out.push({ target, name: basename(e.path), detail: dirname("/" + e.path).slice(1), path: e.path });
    }
    return out;
  }

  /** A link clicked in a PDF: resolved relative to the document it came from. */
  function followPdfLink(target: string, pdf: string) {
    const parts = pdf.split("/");
    const from = parts[parts.length - 2] === ".build"
      ? join(dirname(dirname(pdf)), basename(pdf).replace(/\.pdf$/, ".tex"))
      : pdf;
    void followLink({ command: "link", target }, from);
  }

  function followLinkCommand() {
    if (!view || !isTex()) return;
    if (!followLinkAtCursor(view)) say("Put the cursor on a \\link{…}, \\input{…} or other file path", true);
  }

  /** Picks a workspace file and inserts \link{…} to it (the selection, if any, becomes the label). */
  async function insertLink() {
    const r = root();
    const p = path();
    if (!view || !p || !isTex()) return;
    if (!r) { say("Open a folder to link between its files", true); return; }
    await refreshFiles();
    const target = await palette.pick({
      title: "Insert link",
      placeholder: "File or folder to link to (e.g. 101 lecture3)",
      items: linkableEntries()
        .filter((e) => join(r, e.path) !== p)
        .map((e) => ({ label: basename(e.path) + (e.isDir ? "/" : ""), detail: dirname("/" + e.path).slice(1), key: e.path, value: join(r, e.path) })),
    });
    if (!view || path() !== p) return;
    if (!target) { view.focus(); return; }
    const { from, to } = view.state.selection.main;
    const label = view.state.sliceDoc(from, to);
    const insert = `\\link${label ? `[${label}]` : ""}{${shortLinkTarget(p, target)}}`;
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: "input" });
    view.focus();
  }

  // ---- saved PDFs -------------------------------------------------------------------

  /** The document whose PDF "Save PDF as…" saves: the open file, or the last build if it's an included file. */
  function pdfSource(): string | null {
    return outputSource();
  }

  async function savePdfAs() {
    const src = pdfSource();
    if (!src) { say("Open a document to save its PDF", true); return; }
    const built = join(dirname(src), ".build", basename(src).replace(/\.tex$/, ".pdf"));
    if (!(await host.exists(built))) { say("It hasn't built yet — press ⌘S to build it, then save the PDF", true); return; }
    const scope = await scopeAt(dirname(src));
    const stem = basename(src).replace(/\.tex$/, "");
    const name = pdfName((scope?.config ?? config()).pdfName, { ...scope?.vars, stem });
    let dest: string | null;
    try { dest = await host.pickSavePdf(dirname(src), name); } catch (err) { fail(err); return; }
    if (!dest) return;
    if (!dest.toLowerCase().endsWith(".pdf")) dest += ".pdf";
    if (dest === built) { say("That's the build output itself — pick another place", true); return; }
    try {
      // The save dialog already asked before replacing an existing file.
      await exportTo(host, src, built, dest, { linked: true, force: true });
    } catch (err) { fail(`Couldn't save the PDF: ${String(err)}`); return; }
    say(`Saved ${basename(dest)} — it now updates on every build (“Stop updating saved PDF” to unlink)`);
    await refreshFiles();
    // A copy next to its .tex is listed under it: open that row so you can see it.
    const ws = root();
    if (ws && dest.startsWith(ws + "/")) reveal(dirname(dest) === dirname(src) ? relative(ws, src) : relative(ws, dirname(dest)));
  }

  async function stopUpdatingPdf() {
    const src = pdfSource();
    if (!src) return;
    const saved = await linkedPdfs(host, src);
    if (!saved.length) { say(`No saved PDFs are linked to ${basename(src)}`, true); return; }
    const r = root();
    const show = (p: string) => (r && p.startsWith(r + "/") ? relative(r, p) : p);
    const which = saved.length === 1 ? saved[0] : await palette.pick<string>({
      title: "Stop updating which PDF?",
      placeholder: "Saved PDF",
      items: [...saved.map((p) => ({ label: basename(p), detail: show(dirname(p)), value: p })), { label: "All of them", value: "" }],
    });
    if (which === null) return;
    const removed = await unlinkPdfs(host, src, which || undefined);
    say(`${removed.map(basename).join(", ")} will no longer be updated (the file${removed.length === 1 ? " stays" : "s stay"} where ${removed.length === 1 ? "it is" : "they are"})`);
    await refreshFiles();
  }

  // ---- settings, workspace.json and plugins -----------------------------------------------

  /** The plugins folders: yours, and the open workspace's. */
  const userPluginsDir = () => (globalRoot ? join(globalRoot, "plugins") : null);
  const workspacePluginsDir = () => { const r = root(); return r && hasTexdesk() ? join(r, ".texdesk", "plugins") : null; };

  /** (Re)lists the plugins and loads the enabled ones' snippets, watching them for changes. */
  async function restartSnippets() {
    stopSnippetWatch?.();
    stopSnippetWatch = undefined;
    let list: Plugin[] = [];
    try { list = await listPlugins(host, userPluginsDir(), workspacePluginsDir(), config().plugins, trust() === true); }
    catch (err) { fail(`Plugins unavailable: ${String(err)}`); }
    setPlugins(list);
    try { stopSnippetWatch = await watchSnippets(host, pluginSnippetFolders(list), runtime); }
    catch (err) { fail(`Snippets unavailable: ${String(err)}`); }
  }

  /** Watches the plugins folders, so a plugin added or removed (outside TeXdesk too) loads or goes. */
  async function watchPluginRoots() {
    stopPluginRootsWatch?.();
    stopPluginRootsWatch = undefined;
    const stops: (() => void)[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    for (const dir of [userPluginsDir(), workspacePluginsDir()]) {
      if (!dir || !(await host.exists(dir))) continue;
      try {
        stops.push(await host.watch(dir, () => { clearTimeout(timer); timer = setTimeout(() => void restartSnippets(), 120); }));
      } catch (err) { console.warn("[texdesk] couldn't watch plugins:", err); }
    }
    stopPluginRootsWatch = () => { clearTimeout(timer); for (const s of stops) s(); };
  }

  // ---- workspace trust ------------------------------------------------------------------
  //
  // A workspace's own plugins are code, and its settings can name the program builds run
  // (tectonic). A folder you cloned or downloaded could hold anything, so neither is used
  // until you allow that folder (asked once when it opens; Settings → Plugins changes it).
  // Folders you set up in TeXdesk, or make a workspace plugin in, are allowed by doing so.

  /** Whether code from the open workspace may run: yes, no, or not asked yet (null). */
  const [trust, setTrustSignal] = createSignal<boolean | null>(null);
  const trustKey = (r: string) => `trust:${r}`;

  async function setTrust(on: boolean) {
    const r = root();
    if (!r) return;
    prefs.set(trustKey(r), on);
    if (trust() === on) return;
    setTrustSignal(on);
    applyConfig();
    await restartSnippets();
  }

  /** What in the open workspace needs allowing: its plugins' names, and whether it sets a tectonic path. */
  async function workspaceCode(): Promise<{ plugins: string[]; tectonic: boolean }> {
    const dir = workspacePluginsDir();
    let plugins: string[] = [];
    try { if (dir && (await host.exists(dir))) plugins = (await host.readDir(dir)).filter((e) => e.isDir && !e.name.startsWith(".")).map((e) => e.name); } catch { /* none */ }
    return { plugins, tectonic: typeof ws().settings.tectonic === "string" && !!ws().settings.tectonic };
  }

  /** On opening a workspace that has code you haven't decided about: asks whether to allow it. */
  async function askTrust(r: string) {
    if (trust() !== null) return;
    const code = await workspaceCode();
    if (!code.plugins.length && !code.tectonic) return;
    const what = [
      code.plugins.length ? `snippet plugin${code.plugins.length === 1 ? "" : "s"} (${code.plugins.join(", ")})` : "",
      code.tectonic ? "its own Tectonic path" : "",
    ].filter(Boolean).join(" and ");
    const ok = await palette.pick({
      title: `${basename(r)} comes with ${what}. Plugins are code that runs in TeXdesk and can read and change your files — allow them only for folders you trust.`,
      placeholder: "Allow code from this folder?",
      items: [
        { label: "Allow", detail: "Load its plugins and use its settings", value: true },
        { label: "Don't allow", detail: "You can change this in Settings → Plugins", value: false },
      ],
    });
    if (ok === null || root() !== r) return; // asked again next time
    await setTrust(ok);
  }

  /** The workspace's settings over the global ones, with any problems reported (each set of problems once). */
  let reportedProblems = "";
  function applyConfig(announce = false) {
    const errors: string[] = [];
    // Not allowed (yet): its tectonic path isn't used.
    const { tectonic: _, ...safe } = ws().settings;
    const next = workspaceConfig(globalConfig(), trust() === true ? ws().settings : safe, errors);
    const pluginsChanged = JSON.stringify(next.plugins) !== JSON.stringify(config().plugins);
    setConfig(next);
    const all = [...wsErrors(), ...errors].join("; ");
    if (all && all !== reportedProblems) say(`Settings: ${all}`, true);
    else if (!all && announce && Date.now() - settingsWroteAt > 2000) say("Settings reloaded");
    reportedProblems = all;
    if (pluginsChanged) void restartSnippets();
  }

  /** Rereads the global settings.json. */
  async function reloadGlobal(announce = false) {
    if (!globalRoot) return;
    const g = await loadGlobalConfig(host, globalRoot);
    globalRaw = g.raw;
    setGlobalConfig(g.config);
    if (g.errors.length) say(`Settings: ${g.errors.join("; ")}`, true);
    applyConfig(announce && !g.errors.length);
  }

  /** Rereads the open workspace's workspace.json. */
  async function reloadWorkspace(announce = false) {
    const r = root();
    if (!r || !hasTexdesk()) { setWs(emptyWorkspace()); setWsErrors([]); applyConfig(); return; }
    const { ws: next, errors } = await readWorkspace(host, r);
    if (root() !== r) return;
    setWs(next);
    setWsErrors(errors);
    applyConfig(announce);
  }

  /**
   * Changes workspace.json: reads it fresh (so an edit made elsewhere since isn't lost), applies
   * `fn`, writes it back. One change at a time, in order.
   */
  let wsWrites: Promise<void> = Promise.resolve();
  function updateWorkspace(fn: (w: WorkspaceFile) => WorkspaceFile): Promise<void> {
    const r = root();
    if (!r || !hasTexdesk()) { say("Set up TeXdesk in this folder first", true); return Promise.resolve(); }
    wsWrites = wsWrites.then(async () => {
      try {
        const p = workspaceFile(r);
        const errors: string[] = [];
        const text = (await host.exists(p)) ? await host.readText(p) : "{}";
        let cur: WorkspaceFile;
        try { JSON.parse(text); cur = parseWorkspace(text, errors); }
        catch (err) { fail(`workspace.json isn't valid JSON right now, so the change wasn't saved: ${err instanceof Error ? err.message : String(err)}`); return; }
        const next = fn(cur);
        if (next === cur) return;
        settingsWroteAt = Date.now();
        await writeWorkspaceText(r, next);
        settingsWroteAt = Date.now();
        if (root() !== r) return;
        setWs(next);
        setWsErrors(errors);
        applyConfig();
      } catch (err) { fail(`Couldn't save workspace.json: ${err instanceof Error ? err.message : String(err)}`); }
    });
    return wsWrites.then(() => refreshTemplates()).then(() => { if (settingsOpen()) void refreshExamples(); });
  }
  async function writeWorkspaceText(r: string, w: WorkspaceFile) {
    await host.mkdirAll(join(r, ".texdesk"));
    await host.writeText(workspaceFile(r), formatWorkspace(w));
  }

  /** Saves one setting, globally or for this workspace (undefined removes it). */
  let settingWrites: Promise<void> = Promise.resolve();
  function saveSetting(scope: SettingsScope, table: string, key: string, value: unknown): Promise<void> {
    if (scope === "workspace") return updateWorkspace((w) => ({ ...w, settings: setSettingKey(w.settings, table, key, value) }));
    const dir = globalRoot;
    if (!dir) return Promise.resolve();
    settingWrites = settingWrites.then(async () => {
      try {
        const file = join(dir, GLOBAL_SETTINGS);
        const errors: string[] = [];
        const raw = await readSettingsFile(host, file, errors, GLOBAL_SETTINGS);
        if (errors.length && (await host.exists(file))) { fail(`settings.json isn't valid right now, so the change wasn't saved: ${errors.join("; ")}`); return; }
        settingsWroteAt = Date.now();
        await host.writeText(file, formatJson(setSettingKey(raw, table, key, value)));
        settingsWroteAt = Date.now();
        await reloadGlobal();
      } catch (err) { fail(`Couldn't save the setting: ${String(err)}`); }
    });
    return settingWrites;
  }

  /** Where a quick toggle (View → PDF Follows Edits) saves: this workspace if it sets its own, else everywhere. */
  const scopeOf = (table: string, key: string): SettingsScope => {
    const t = table ? ws().settings[table] : ws().settings;
    return t && typeof t === "object" && Object.hasOwn(t, key) ? "workspace" : "global";
  };

  /** Sets up ~/.config/texdesk/ (global settings and plugins), moving the old files over, and watches settings.json. */
  async function startGlobal() {
    try {
      const dir = globalDir(await host.homeDir());
      globalRoot = dir;
      const m = await planGlobalMigration(host, dir);
      if (m.settings || m.moves.length || m.trash.length) {
        const errors: string[] = [];
        await applyGlobalMigration(host, dir, m, await readSettingsFile(host, join(dir, GLOBAL_SETTINGS), errors, GLOBAL_SETTINGS));
        const moved = [m.settings ? "your settings are now in settings.json" : "", m.moves.length ? "your snippets are now the LaTeX snippets plugin" : ""].filter(Boolean);
        if (moved.length || m.notes.length) say(`Updated ~/.config/texdesk: ${[...moved, ...m.notes].join("; ")}`);
      }
    } catch (err) { console.warn("[texdesk] no global settings folder:", err); globalRoot = null; return; }
    try { await ensurePluginsFolder(host, join(globalRoot, "plugins")); }
    catch (err) { console.warn("[texdesk] couldn't write the plugins folder's support files:", err); }
    await reloadGlobal();
    await restartSnippets();
    await watchPluginRoots();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const stop = await host.watch(globalRoot, (paths) => {
        if (!paths.some((x) => x.endsWith("/" + GLOBAL_SETTINGS))) return;
        clearTimeout(timer);
        timer = setTimeout(() => void reloadGlobal(true), 100);
      });
      stopGlobalWatch = () => { clearTimeout(timer); stop(); };
    } catch (err) { console.warn("[texdesk] couldn't watch the global settings:", err); }
  }

  function closeWorkspace() {
    stopWatching?.();
    stopWatching = undefined;
    stopTreeWatch?.();
    stopTreeWatch = undefined;
    resetLayout(emptyLayout());
    setRoot(null);
    setEntries([]);
    texCache.clear();
    setLinkIndex(new Map());
    setHasTexdesk(false);
    setWs(emptyWorkspace());
    setWsErrors([]);
    applyConfig();
    void restartSnippets().then(watchPluginRoots);
    prefs.set("lastWorkspace", null);
    updateTitle();
  }

  /** Asks which starter to set a folder up with; null if cancelled, "plain" to open it without. */
  async function pickStarter(name: string, allowPlain: boolean): Promise<string | null> {
    return palette.pick({
      title: `Set up ${name} for TeXdesk — this adds a .texdesk folder and preamble.sty; nothing else changes`,
      placeholder: "Start with…",
      items: [
        ...STARTERS.map((st) => ({ label: st.label, detail: st.detail, value: st.id })),
        ...(allowPlain ? [{ label: "Open without setting up", detail: "the file tree and ⌘K work; templates, folder types and workspace settings don't", value: "plain" }] : []),
      ],
    });
  }

  /** Offers to upgrade a workspace still set up with the old files (config.toml, .texdesk.toml). */
  async function offerUpgrade(r: string) {
    const plan = await planMigration(host, r, entries(), globalRaw);
    const choice = await palette.pick({
      title: `${basename(r)} uses the old setup files (.texdesk.toml, config.toml). Upgrade to one workspace.json?`,
      placeholder: "Choose…",
      items: [
        { label: "Upgrade now", detail: `keeps ${describePlan(plan)}; the old files go to the Trash`, value: "yes" },
        { label: "Not now", detail: "folder types and templates won't work until you upgrade (File → Upgrade workspace)", value: "no" },
      ],
    });
    if (choice !== "yes") return;
    try {
      await applyMigration(host, r, plan, async (add) => {
        if (!globalRoot) return;
        const file = join(globalRoot, GLOBAL_SETTINGS);
        await host.writeText(file, formatJson(mergeSettings(await readSettingsFile(host, file, [], GLOBAL_SETTINGS), add)));
      });
    } catch (err) { fail(`The upgrade stopped partway: ${err instanceof Error ? err.message : String(err)}`); return; }
    await reloadGlobal();
    await reloadWorkspace();
    await refreshFiles();
    await restartSnippets();
    say(`Upgraded ${basename(r)} to workspace.json${plan.notes.length ? ` — note: ${plan.notes.join("; ")}` : ""}`, plan.notes.length > 0);
  }

  /** Entries in workspace.json for folders that are gone (renamed or moved outside TeXdesk): fix or remove them. */
  async function checkMissingFolders(r: string) {
    const dirs = new Set(entries().filter((e) => e.isDir).map((e) => e.path));
    const missing = missingFolders(ws(), dirs);
    if (!missing.length) return;
    const typed = (p: string) => { const t = ws().folders[p]?.type; return t ? `${ws().folderTypes[t]?.label ?? t} ` : ""; };
    const choice = await palette.pick({
      title: `${missing.length} folder${missing.length === 1 ? "" : "s"} in workspace.json ${missing.length === 1 ? "is" : "are"} gone — moved or renamed outside TeXdesk? (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""})`,
      placeholder: "Choose…",
      items: [
        { label: "Find where they went", detail: "pick the new folder for each", value: "fix" },
        { label: "Forget them", detail: "removes their type and fields from workspace.json", value: "remove" },
        { label: "Later", value: "later" },
      ],
    });
    if (choice === "remove") { await updateWorkspace((w) => missing.reduce((acc, p) => removeFolderEntries(acc, p), w)); return; }
    if (choice !== "fix") return;
    for (const p of missing) {
      if (root() !== r) return;
      const free = [...dirs].filter((d) => !ws().folders[d] && !d.split("/").some((x) => x.startsWith("."))).sort();
      const to = await palette.pick<string>({
        title: `Where did the ${typed(p)}folder “${p}” go?`,
        placeholder: "Folder",
        items: [...free.map((d) => ({ label: basename(d), detail: dirname("/" + d).slice(1), key: d, value: d })), { label: "Forget it", value: "" }],
      });
      if (to === null) return;
      await updateWorkspace((w) => (to ? moveFolderEntries(w, p, to) : removeFolderEntries(w, p)));
    }
  }

  async function openWorkspace(r: string, opts: { restoreFile?: boolean } = {}) {
    if (!(await save())) return;
    let texdesk = await host.exists(join(r, ".texdesk"));
    if (!texdesk) {
      const choice = await pickStarter(basename(r), true);
      if (choice === null) return;
      if (choice !== "plain") {
        try {
          const created = await seedWorkspace(host, r, choice);
          prefs.set(trustKey(r), true); // you set it up here
          say(`Set up TeXdesk: created ${created.map((c) => relative(r, c)).filter((c) => !c.startsWith(".texdesk/templates/")).join(", ") || "nothing (already present)"}`);
          texdesk = true;
        } catch (err) { fail(err); return; }
      }
    }

    stopWatching?.();
    stopWatching = undefined;
    stopTreeWatch?.();
    stopTreeWatch = undefined;
    if (r !== root()) texCache.clear();
    resetLayout(emptyLayout());
    setRoot(r);
    setHasTexdesk(texdesk);
    setTrustSignal(prefs.get<boolean | null>(trustKey(r), null));
    await reloadWorkspace();
    setExpanded(new Set(prefs.get<string[]>(`expanded:${r}`, [])));
    setPinned(prefs.get<string[]>(`pinned:${r}`, []));
    await refreshFiles();
    try { stopTreeWatch = await host.watchTree(r, config().ignore, (paths) => onDiskChange(r, paths)); }
    catch (err) { console.warn("[texdesk] couldn't watch the folder:", err); }

    const rec = [r, ...recents().filter((x) => x !== r)].slice(0, 8);
    setRecents(rec);
    prefs.set("recentWorkspaces", rec);
    prefs.set("lastWorkspace", r);
    updateTitle();

    if (texdesk) {
      try {
        await ensureSupportFiles(host, r);
        await ensureTemplates(host, r);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const stopConfig = await host.watch(join(r, ".texdesk"), (paths) => {
          if (!paths.some((x) => x.endsWith("/workspace.json"))) return;
          clearTimeout(timer);
          timer = setTimeout(async () => {
            if (root() !== r) return;
            await reloadWorkspace(true);
            void refreshFiles();
          }, 100);
        });
        stopWatching = () => { stopConfig(); clearTimeout(timer); };
      } catch (err) { fail(`Couldn't set up .texdesk: ${String(err)}`); }
    }
    await restartSnippets();
    await watchPluginRoots();
    void askTrust(r);

    // Tabs and groups as you left them; or, the first time, the last file with its output beside it.
    const saved = prefs.get<SavedLayout | null>(`layout:${r}`, null);
    const files = new Set(entries().filter((e) => !e.isDir).map((e) => e.path));
    if (opts.restoreFile !== false && saved) {
      const dirs = new Set(entries().filter((e) => e.isDir).map((e) => e.path));
      setLayout(deserialize(saved, (t) => {
        if (t.path === null) return null;
        if (t.kind === "overview") return t.path === "" ? r : dirs.has(t.path) ? join(r, t.path) : null;
        return files.has(t.path) ? join(r, t.path) : null;
      }));
      await reconcile();
      const ag = groupById(layout(), layout().activeGroup);
      const g = ag && viewDoc.get(ag.id) ? ag.id : [...viewDoc].find(([, d]) => d)?.[0];
      if (g) await makeCurrent(viewDoc.get(g)!, g);
    } else if (opts.restoreFile !== false) {
      const last = prefs.get<string | null>(`lastFile:${r}`, null);
      if (last && last.startsWith(r + "/") && (await host.exists(last))) await showFile(last);
    }

    if (texdesk && hasLegacySetup(entries()) && !(await readWorkspace(host, r)).exists) await offerUpgrade(r);
    else if (texdesk) await checkMissingFolders(r);
    if (!prefs.get("tourDone", false) && root() === r) setTour(true);
  }

  /** Closes every tab (without saving to the old layout's prefs) and starts from `l`. */
  function resetLayout(l: Layout) {
    for (const [g] of viewDoc) { viewDoc.set(g, null); views.get(g)?.setState(EditorState.create()); }
    docs.clear();
    setLayoutSignal(l);
    clearCurrent();
  }

  // ---- commands -------------------------------------------------------------------

  async function openFolderDialog() {
    const p = await host.pickFolder();
    if (p) await openWorkspace(p);
  }

  async function openFileDialog() {
    const p = await host.pickFile();
    if (p) await openPath(p);
  }

  async function findFile() {
    const r = root();
    if (!r) return openFileDialog();
    await refreshFiles();
    const gen = generated();
    const all: PickItem<string>[] = entries()
      .filter((e) => !e.isDir)
      .map((e) => ({ label: basename(e.path), detail: dirname("/" + e.path).slice(1), key: e.path, value: join(r, e.path) }));
    // Typed folders (classes, terms…) open as overviews; found by name or their fields.
    const overviews: PickItem<string>[] = [...folderMetas()].filter(([rel, m]) => m.kind && rel).map(([rel, m]) => ({
      label: basename(rel), detail: `Overview · ${typeLabel(m.kind!)}${rel.includes("/") ? ` · ${dirname("/" + rel).slice(1)}` : ""}`,
      key: [rel, ...Object.values(m.vars ?? {})].join(" "), value: `overview:${join(r, rel)}`,
    }));
    const plain = [...overviews, ...all.filter((i) => !gen.has(i.key!))];
    const p = await palette.pick({
      placeholder: "Find a file or folder (e.g. 101 hw3)",
      items: plain,
      itemsFor: (q) => (q.trim().toLowerCase().endsWith(".pdf") ? [...overviews, ...all] : plain),
    });
    if (p?.startsWith("overview:")) await openOverview(p.slice("overview:".length));
    else if (p) await openPath(p);
  }

  /** Parsed .tex files for search, reused while a file's text is unchanged. */
  const searchCache = new Map<string, SearchFile & { text: string }>();
  /**
   * The file whose matches come first: the one open when the query was typed. Kept while the
   * query stays the same, so opening a result doesn't reorder the list under the pointer.
   */
  let searchFirst: { query: string; file: string | null } | null = null;

  /** Matches in every .tex file in the workspace, unsaved edits included; the open file's first. Reruns when the files change. */
  function searchWorkspace(query: string, limit: number): SearchHit[] {
    linkIndex(); // updated whenever texCache is
    const r = root();
    if (!r) return [];
    const texts = new Map(texCache);
    for (const [p, st] of docs) texts.set(p, st.doc.toString());
    for (const [g, p] of viewDoc) { const v = views.get(g); if (p && v) texts.set(p, v.state.doc.toString()); }
    if (searchFirst?.query !== query) searchFirst = { query, file: untrack(path) };
    const here = searchFirst.file;
    const files: SearchFile[] = [];
    for (const [p, text] of texts) {
      if (extname(p) !== "tex" || !p.startsWith(r + "/")) continue;
      let f = searchCache.get(p);
      if (f?.text !== text) searchCache.set(p, (f = { ...searchFile(p, text), text }));
      files.push(f);
    }
    for (const p of searchCache.keys()) if (!texts.has(p)) searchCache.delete(p);
    files.sort((a, b) => (a.path === here ? -1 : b.path === here ? 1 : a.path.localeCompare(b.path)));
    return searchFiles(files, query, limit);
  }

  /** The sidebar was hidden until search showed it: closing the search hides it again. */
  let sidebarForSearch = false;

  /** Search in files: the sidebar's search view, with the selection (one line of it) as the query. Again from the search box, closes it. */
  async function findInFiles() {
    if (!requireWorkspace()) return;
    if (sidebar() && sidebarApi?.searchFocused()) return closeSearch();
    if (!sidebar()) { setSidebar(true); sidebarForSearch = true; } // just for now: not saved
    const sel = view?.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to) ?? "";
    queueMicrotask(() => sidebarApi?.search(sel && !sel.includes("\n") ? sel : undefined));
  }

  function closeSearch() {
    if (sidebarForSearch) setSidebar(false); else sidebarApi?.showFiles();
    sidebarForSearch = false;
    view?.focus();
  }

  async function openSearchHit(hit: SearchHit, focus: boolean) {
    if (hit.path !== path()) await openPath(hit.path);
    if (view && path() === hit.path) {
      const l = view.state.doc.line(Math.min(hit.line, view.state.doc.lines));
      const from = Math.min(l.from + hit.from, l.to), to = Math.min(l.from + hit.to, l.to);
      view.dispatch({ selection: EditorSelection.range(from, to), effects: EditorView.scrollIntoView(from, { y: "center" }) });
      if (focus) view.focus();
    }
  }

  async function opened(c: Created) {
    await refreshFiles();
    await openPath(c.path, c.cursor);
    // A new document builds right away, with its PDF beside it.
    if (!c.isDir && path() === c.path && isRootDoc()) {
      openOutput();
      void builder.build(c.path);
      view?.focus();
    }
  }

  const requireWorkspace = (): string | null => {
    const r = root();
    if (!r) { say("Open a folder first (⌘⇧O)", true); return null; }
    return r;
  };

  /** Where new things go by default: the open file's folder, or the workspace root. */
  const currentDir = (r: string) => { const p = path(); return p && p.startsWith(r + "/") ? dirname(p) : r; };

  /** Templates with a "New …" command (those with a label). */
  const [templateCommands, setTemplateCommands] = createSignal<LoadedTemplate[]>([]);

  async function refreshTemplates() {
    const r = root();
    if (!r || !hasTexdesk()) { setTemplateCommands([]); return; }
    const out: LoadedTemplate[] = [];
    for (const t of await listTemplates(host, r, ws())) {
      if (!t.header.label) continue;
      try { out.push(await readTemplate(host, t)); } catch { /* unreadable: left out */ }
    }
    if (root() === r) setTemplateCommands(out);
  }

  /** A folder type's label ("Class"), or its key if it's unknown. */
  const typeLabel = (key: string) => ws().folderTypes[key]?.label ?? key;
  /** Folder types no other type lists as a child: made anywhere (Term, Project). */
  const topLevelTypes = () => Object.keys(ws().folderTypes).filter((k) => !Object.values(ws().folderTypes).some((t) => t.children?.includes(k)));
  const dirSet = () => new Set(entries().filter((e) => e.isDir).map((e) => e.path));

  /** Asks for the variables `t` needs that aren't in `known`; null if cancelled. */
  async function askVariables(t: LoadedTemplate, known: Record<string, string>, name?: string): Promise<Record<string, string> | null> {
    const vars = { ...known };
    for (const q of promptsFor(t, known, name)) {
      const v = await palette.prompt({ title: `New ${templateLabel(t)}`, placeholder: q.question, validate: (x) => (x.trim() ? null : "Required") });
      if (v === null) return null;
      vars[q.name] = v.trim();
    }
    return vars;
  }

  /** Picks a folder of `type` (absolute path), the nearest one above `here` if there is one; null if cancelled or none. */
  async function folderOfType(type: string, here: string, title: string): Promise<string | null> {
    const r = root()!;
    const near = nearestOfType((await scopeAt(here, true))!, type);
    if (near) return near;
    const all = foldersOfType(ws(), type, dirSet()).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map((p) => join(r, p));
    if (!all.length) { say(`No ${typeLabel(type)} folder yet — make one first (New ${typeLabel(type)})`, true); return null; }
    return all.length === 1 ? all[0] : palette.pick({
      title, placeholder: typeLabel(type),
      items: all.map((f) => ({ label: basename(f), detail: relative(r, dirname(f)) || basename(r), key: relative(r, f), value: f })),
    });
  }

  /**
   * "New <label>": creates a file from a template where its entry says (in the nearest folder
   * of its type, or one picked from the workspace), and opens it. `from` is the folder to start
   * from (an overview's), else the open file's.
   */
  async function newFromTemplate(key: string, from?: string) {
    const r = requireWorkspace();
    if (!r) return;
    const here = from ?? currentDir(r);
    let t: LoadedTemplate;
    try { t = await findTemplate(host, r, ws(), key); } catch (err) { fail(err); return; }
    let base = here;
    if (t.header.in) {
      const anchor = await folderOfType(t.header.in, here, `New ${templateLabel(t)} in which ${typeLabel(t.header.in)}?`);
      if (!anchor) return;
      base = anchor;
    }
    const dir = t.header.dir ? join(base, t.header.dir) : base;
    const vars = await askVariables(t, (await scopeAt(dir, true))!.vars);
    if (!vars) return;
    try { await opened(await createFromTemplate(host, t, dir, vars)); } catch (err) { fail(err); }
  }

  /**
   * "New <Type>": makes a folder of a type — inside `parent` (absolute), else inside the nearest
   * folder of a type that can contain it, else at the top of the workspace — asking for its fields.
   */
  async function newFolderOfType(type: string, parent?: string) {
    const r = requireWorkspace();
    if (!r) return;
    const t = ws().folderTypes[type];
    if (!t) { say(`There's no folder type “${type}”`, true); return; }
    let where = parent;
    if (!where) {
      const parents = Object.entries(ws().folderTypes).filter(([, x]) => x.children?.includes(type)).map(([k]) => k);
      if (!parents.length) where = r;
      else {
        const scope = (await scopeAt(currentDir(r)))!;
        where = parents.map((k) => nearestOfType(scope, k)).find(Boolean) ?? undefined;
        if (!where) {
          const all = parents.flatMap((k) => foldersOfType(ws(), k, dirSet())).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
          if (!all.length) { say(`A ${t.label} goes inside a ${parents.map(typeLabel).join(" or ")} — make one of those first`, true); return; }
          where = all.length === 1 ? join(r, all[0]) : (await palette.pick({
            title: `New ${t.label} in which ${parents.map(typeLabel).join(" or ")}?`, placeholder: "Folder",
            items: all.map((p) => ({ label: basename(p), detail: dirname("/" + p).slice(1) || basename(r), key: p, value: join(r, p) })),
          })) ?? undefined;
          if (!where) return;
        }
      }
    }
    const answers: Record<string, string> = {};
    for (const q of folderQuestions(t)) {
      const v = await palette.prompt({ title: `New ${t.label} in ${relative(r, where) || basename(r)}`, placeholder: q.label, validate: (x) => (q.required && !x.trim() ? "Required" : null) });
      if (v === null) return;
      answers[q.key] = v.trim();
    }
    try {
      const made = await createFolderOfType(host, r, ws(), where, type, answers, {
        config: config(),
        templateBody: async (k) => { try { return (await findTemplate(host, r, ws(), k)).body; } catch { return null; } },
      });
      await updateWorkspace((w) => ({ ...w, folders: { ...w.folders, [made.rel]: made.entry } }));
      await refreshFiles();
      reveal(made.rel);
      await openOverview(made.path);
      say(`Made the ${t.label} ${made.rel}`);
    } catch (err) { fail(err); }
  }

  /** Right-click → Set Folder Type…: gives a folder a type (or none), then asks for its fields. */
  async function setFolderType(rel: string) {
    const cur = ws().folders[rel]?.type ?? null;
    const types = Object.entries(ws().folderTypes);
    if (!types.length) {
      const go = await palette.pick({ title: "This workspace has no folder types yet", placeholder: "Choose…", items: [{ label: "Set up folder types…", detail: "Settings → Workspace", value: true }, { label: "Cancel", value: false }] });
      if (go) openSettings("workspace");
      return;
    }
    const choice = await palette.pick<string>({
      title: `Folder type of ${basename(rel)}`,
      placeholder: "Type",
      items: [
        ...types.map(([k, t]) => ({ label: t.label, detail: k === cur ? "its type now" : (t.fields ?? []).map((f) => f.key).join(", ") || undefined, value: k })),
        { label: "No type", detail: "a plain folder", value: "" },
      ],
    });
    if (choice === null || choice === (cur ?? "")) return;
    await updateWorkspace((w) => {
      const entry = { ...w.folders[rel] };
      if (choice) entry.type = choice; else delete entry.type;
      const folders = { ...w.folders };
      if (Object.keys(entry).length) folders[rel] = entry; else delete folders[rel];
      return { ...w, folders };
    });
    await refreshFiles();
    if (choice && ws().folderTypes[choice]?.fields?.length) await editFields(rel);
    else say(choice ? `${basename(rel)} is a ${typeLabel(choice)} now` : `${basename(rel)} is a plain folder now`);
  }

  /** Right-click → Edit Fields…: a typed folder's field values, one question at a time. */
  async function editFields(rel: string) {
    const entry = ws().folders[rel];
    const t = entry?.type ? ws().folderTypes[entry.type] : undefined;
    if (!t?.fields?.length) { say(`${basename(rel)} has no fields to fill in`, true); return; }
    const values = { ...entry.fields };
    for (const f of t.fields) {
      const v = await palette.prompt({ title: `${basename(rel)} (${t.label}) — Enter keeps it, empty clears it`, placeholder: f.label, value: values[f.key] ?? "", validate: (x) => (f.required && !x.trim() ? "Required" : null) });
      if (v === null) return;
      if (v.trim()) values[f.key] = v.trim(); else delete values[f.key];
    }
    await updateWorkspace((w) => ({ ...w, folders: { ...w.folders, [rel]: { ...w.folders[rel], fields: Object.keys(values).length ? values : undefined } } }));
    await refreshFiles();
    say(`Saved ${basename(rel)}'s fields`);
  }

  /** The tree's right-click items for a folder: New <child type>…, Set Folder Type…, Edit Fields…. */
  function folderItems(dir: string): { create: ContextItem[]; manage: ContextItem[] } {
    const r = root();
    if (!r || !hasTexdesk()) return { create: [], manage: [] };
    const entry = ws().folders[dir];
    const type = entry?.type ? ws().folderTypes[entry.type] : undefined;
    // Top-level types (a term) go in plain folders that aren't inside a typed one.
    const insideTyped = Object.entries(ws().folders).some(([p, f]) => f.type && dir.startsWith(p + "/"));
    const kinds = type ? type.children ?? [] : insideTyped ? [] : topLevelTypes();
    return {
      create: kinds.filter((k) => ws().folderTypes[k]).map((k) => ({ label: `New ${typeLabel(k)}…`, run: () => newFolderOfType(k, dir ? join(r, dir) : r) })),
      manage: [
        { label: "Set Folder Type…", run: () => setFolderType(dir) },
        ...(type?.fields?.length ? [{ label: "Edit Fields…", run: () => editFields(dir) }] : []),
      ],
    };
  }

  /**
   * "New folder…": named in place in the sidebar, next to the open file. Where a typed folder
   * can go (a class in a term), it offers that first.
   */
  async function newFolder() {
    const r = requireWorkspace();
    if (!r) return;
    const p = path();
    const dir = p && p.startsWith(r + "/") ? relative(r, dirname(p)) : "";
    const typed = folderItems(dir).create;
    if (typed.length) {
      const pick = await palette.pick<ContextItem | "plain">({
        title: `New folder in ${dir || basename(r)}`,
        placeholder: "Kind of folder",
        items: [
          ...typed.map((c) => ({ label: (c as { label: string }).label.replace(/…$/, ""), detail: "asks for its fields and makes its subfolders", value: c })),
          { label: "Plain folder", detail: "named in the sidebar", value: "plain" as const },
        ],
      });
      if (pick === null) return;
      if (pick !== "plain") { (pick as { run: () => unknown }).run(); return; }
    }
    if (!sidebar()) toggleSidebar();
    queueMicrotask(() => sidebarApi?.newEntry("folder", dir));
  }

  /** "New file…" (⌘N): one box for the name, with the template list under it for .tex files. */
  async function newFile(dirRel?: string) {
    const r = requireWorkspace();
    if (!r) return;
    const p = path();
    const dir = dirRel ?? (p && p.startsWith(r + "/") ? relative(r, dirname(p)) : "");
    const existing = new Set(entries().map((e) => e.path));
    // No extension means a LaTeX file.
    const named = (v: string) => { const n = v.trim(); return /\.[^/.]+$/.test(n.slice(n.lastIndexOf("/") + 1)) ? n : `${n}.tex`; };
    const rel = (v: string) => (dir ? `${dir}/${named(v)}` : named(v));
    const items = await templateChoices(dir ? join(r, dir) : r);
    const res = await palette.promptWithChoice<string>({
      title: `New file in ${dir || basename(r)}`,
      placeholder: "Name, e.g. hw4 or notes/week2 — .tex is added if there's no extension",
      validate: (v) => badName(v.trim()) ?? (existing.has(rel(v)) ? `${named(v)} already exists` : null),
      choicesTitle: "Start from (↑↓)",
      choices: (v) => (!v.trim() || named(v).endsWith(".tex") ? items : []),
      initialChoice: items[0]?.value,
    });
    if (!res) return;
    const name = named(res.value);
    if (!name.endsWith(".tex") || res.choice === null) {
      const err = await createEntry(dir, name, false);
      if (err) say(err, true);
      return;
    }
    const bad = badName(name);
    if (bad) { say(bad, true); return; }
    const target = join(r, dir, name);
    if (await host.exists(target)) { say(`${name} already exists`, true); return; }
    await createTexFile(target, res.choice);
  }

  function badName(name: string): string | null {
    if (!name.trim() || name.endsWith("/")) return "Enter a name";
    if (name.startsWith("/") || name.split("/").some((part) => part === ".." || part === "." || !part)) return "Use a plain name (or folder/name)";
    return null;
  }

  /** Expands every folder above (and including) `rel`. */
  function reveal(rel: string) {
    const next = new Set(expanded());
    const parts = rel.split("/");
    for (let i = 1; i <= parts.length; i++) next.add(parts.slice(0, i).join("/"));
    setExpanded(next);
    prefs.set(`expanded:${root()}`, [...next]);
  }

  async function createEntry(dirRel: string, name: string, isDir: boolean): Promise<string | null> {
    const r = root();
    if (!r) return "No folder is open";
    const bad = badName(name);
    if (bad) return bad;
    const p = join(r, dirRel, name);
    if (await host.exists(p)) return `${basename(p)} already exists`;
    try {
      if (isDir) {
        await host.mkdirAll(p);
        await refreshFiles();
        reveal(relative(r, p));
        return null;
      }
      await opened(await createFile(host, p));
      return null;
    } catch (err) { return err instanceof Error ? err.message : String(err); }
  }

  /**
   * Templates for a new .tex file in `dir`: first the one whose entry puts its files in this
   * folder (e.g. homework in a class's hw/), else the last one used.
   */
  async function templateChoices(dir: string): Promise<PickItem<string>[]> {
    const r = root()!;
    const scope = (await scopeAt(dir))!;
    const templates = hasTexdesk() ? await listTemplates(host, r, ws()) : [];
    const fits = (t: (typeof templates)[number]) => {
      const base = t.header.in ? nearestOfType(scope, t.header.in) : null;
      return !!base && join(base, t.header.dir) === dir;
    };
    const preferred = templates.find(fits)?.key ?? prefs.get<string | null>("lastTemplate", null);
    const order = (n: string) => (n === preferred ? 0 : 1);
    return [
      ...[...templates].sort((a, b) => order(a.key) - order(b.key)).map((t) => ({ label: templateLabel(t), detail: t.scope === "built-in" ? "built-in" : t.file, value: t.key })),
      { label: "Blank file", detail: "empty", value: "" },
    ];
  }

  /** Creates the .tex file `p` from `template` (a template file name, or "" for blank) and opens it. */
  async function createTexFile(p: string, template: string) {
    const r = root();
    if (!r) return;
    try {
      if (!template) { await opened(await createFile(host, p)); return; }
      prefs.set("lastTemplate", template);
      const t = await findTemplate(host, r, ws(), template);
      const name = basename(p);
      const vars = await askVariables(t, { ...(await scopeAt(dirname(p), true))!.vars, title: name.replace(/\.tex$/, "") }, name);
      if (!vars) return;
      await opened(await createFromTemplate(host, t, dirname(p), vars, { name }));
    } catch (err) { fail(err); }
  }

  async function renameEntry(rel: string, name: string): Promise<string | null> {
    const r = root();
    if (!r) return "No folder is open";
    const bad = badName(name);
    if (bad) return bad;
    const res = await relocate(join(r, rel), join(r, dirname("/" + rel).slice(1), name));
    if (typeof res === "string") return res;
    if (res.links) say(`Renamed to ${name}${linkNote(res)}`);
    return null;
  }

  const linkNote = (u: { links: number; files: number }) =>
    u.links ? ` — updated ${u.links} link${u.links === 1 ? "" : "s"} in ${u.files} file${u.files === 1 ? "" : "s"}` : "";

  async function moveEntry(rel: string, destDir: string) {
    const r = root();
    if (!r) return;
    const res = await relocate(join(r, rel), join(r, destDir, basename(rel)));
    if (typeof res === "string") { say(res, true); return; }
    if (destDir) reveal(destDir);
    say(`Moved ${basename(rel)} to ${destDir || basename(r)}${linkNote(res)}`);
  }

  /**
   * Moves/renames a file or folder, keeping the open file, tree state and preview pointed at
   * it, and fixing links the move broke. Returns an error message, or how many links changed.
   */
  async function relocate(from: string, to: string): Promise<string | { links: number; files: number }> {
    const r = root()!;
    if (from === to) return { links: 0, files: 0 };
    const before = new Set(entries().filter((e) => !e.isDir).map((e) => join(r, e.path)));
    if (await host.exists(to) && from.toLowerCase() !== to.toLowerCase()) return `${basename(to)} already exists`;
    if (!(await save())) return "Couldn't save the open file first";
    try { await host.mkdirAll(dirname(to)); await host.move(from, to); } catch (err) { return err instanceof Error ? err.message : String(err); }
    const moved = (p: string | null) => (p && (p === from || p.startsWith(from + "/")) ? to + p.slice(from.length) : null);
    const fromRel = relative(r, from);
    const toRel = relative(r, to);
    const exp = new Set([...expanded()].map((e) => (e === fromRel || e.startsWith(fromRel + "/") ? toRel + e.slice(fromRel.length) : e)));
    setExpanded(exp);
    prefs.set(`expanded:${r}`, [...exp]);
    for (const f of [...texCache.keys()]) if (moved(f)) texCache.delete(f);
    if (moved(builder.lastRoot)) builder.lastRoot = moved(builder.lastRoot);
    // Tabs follow; their editors reload from the new path (the old states point at the old one).
    const open = moved(path());
    const cursor = open && view ? view.state.selection.main.head : undefined;
    for (const d of [...docs.keys()]) if (moved(d)) docs.delete(d);
    for (const [g, d] of viewDoc) if (d && moved(d)) viewDoc.set(g, null);
    setLayout(renamePaths(layout(), moved));
    if (hasTexdesk()) {
      // A template's body renamed in .texdesk/templates: the templates using it follow.
      const tdir = templatesDir(r);
      const body = dirname(from) === tdir && dirname(to) === tdir && basename(from) !== basename(to) ? [basename(from), basename(to)] : null;
      await updateWorkspace((w) => {
        const next = moveFolderEntries(w, fromRel, toRel);
        if (!body || !Object.values(next.templates).some((t) => t.body === body[0])) return next;
        return { ...next, templates: Object.fromEntries(Object.entries(next.templates).map(([k, t]) => [k, t.body === body[0] ? { ...t, body: body[1] } : t])) };
      });
    }
    if (pinned().some((p) => p === fromRel || p.startsWith(fromRel + "/"))) setPins(pinned().map((p) => (p === fromRel || p.startsWith(fromRel + "/") ? toRel + p.slice(fromRel.length) : p)));
    await refreshFiles();
    await reconcile();
    if (open) await showFile(open, cursor);
    return updateLinksAfterMove(from, to, before);
  }

  /** Rewrites links that moving `from` → `to` broke, in every .tex file in the workspace. */
  async function updateLinksAfterMove(from: string, to: string, before: Set<string>) {
    const r = root()!;
    const after = new Set(entries().filter((e) => !e.isDir).map((e) => join(r, e.path)));
    const inside = (p: string, dir: string) => p === dir || p.startsWith(dir + "/");
    const moved = (p: string) => (inside(p, from) ? to + p.slice(from.length) : null);
    const back = (p: string) => (inside(p, to) ? from + p.slice(to.length) : p);
    const ctx = async (file: string, files: Set<string>): Promise<ResolveContext> => {
      const figures = (await scopeAt(dirname(file)))?.figuresDir;
      return { root: r, files, searchDirs: figures ? [figures] : [] };
    };
    // A link into what moved has to mention its name somewhere; skip files that can't.
    const name = basename(from).replace(/\.tex$/, "");
    let links = 0;
    let files = 0;
    for (const f of after) {
      if (extname(f) !== "tex") continue;
      const cached = texCache.get(f);
      if (!inside(f, to) && cached !== undefined && !cached.includes(name)) continue;
      const isOpen = f === path() && !!view;
      let text: string;
      try { text = isOpen ? view!.state.doc.toString() : await host.readText(f); } catch { continue; }
      const res = rewriteLinks(text, { oldFile: back(f), newFile: f, before: await ctx(back(f), before), after: await ctx(f, after), moved });
      if (!res.count) continue;
      try {
        if (isOpen) {
          // Replace only the changed span, so the cursor and undo history stay sensible.
          let a = 0;
          while (a < text.length && text[a] === res.text[a]) a++;
          let b = 0;
          while (b < Math.min(text.length, res.text.length) - a && text[text.length - 1 - b] === res.text[res.text.length - 1 - b]) b++;
          view!.dispatch({ changes: { from: a, to: text.length - b, insert: res.text.slice(a, res.text.length - b) } });
          await save();
        } else {
          await host.writeText(f, res.text);
        }
      } catch (err) { fail(`Couldn't update links in ${basename(f)}: ${String(err)}`); continue; }
      texCache.set(f, res.text);
      links += res.count;
      files++;
    }
    if (files) reindexLinks();
    return { links, files };
  }

  async function deleteEntry(rel: string) {
    const r = root();
    if (!r) return;
    const abs = join(r, rel);
    const isDir = entries().some((e) => e.isDir && e.path === rel);
    const count = isDir ? entries().filter((e) => !e.isDir && e.path.startsWith(rel + "/")).length : 0;
    const ok = await palette.pick<boolean>({
      title: `Move “${basename(rel)}” to the Trash?`,
      placeholder: "You can restore it from the Trash in Finder",
      items: [
        { label: "Move to Trash", detail: isDir ? `folder with ${count} file${count === 1 ? "" : "s"}` : undefined, value: true },
        { label: "Cancel", value: false },
      ],
    });
    if (!ok) return;
    const p = path();
    if (p && (p === abs || p.startsWith(abs + "/"))) setDirty(false); // it's going to the Trash; don't save it back
    try { await host.trash(abs); } catch (err) { fail(`Couldn't move ${basename(rel)} to the Trash: ${err instanceof Error ? err.message : String(err)}`); return; }
    // Close its tabs (and any tabs for files inside a deleted folder).
    let l = layout();
    for (const g of l.groups) for (const t of g.tabs) if (t.path && (t.path === abs || t.path.startsWith(abs + "/"))) l = removeTab(l, t.id);
    for (const [g, d] of viewDoc) if (d && (d === abs || d.startsWith(abs + "/"))) viewDoc.set(g, null);
    setLayout(l);
    await reconcile();
    if (isDir && hasTexdesk() && Object.keys(ws().folders).some((p) => p === rel || p.startsWith(rel + "/"))) await updateWorkspace((w) => removeFolderEntries(w, rel));
    if (isDir) setPins(pinned().filter((p) => p !== rel && !p.startsWith(rel + "/")));
    await refreshFiles();
    say(`Moved ${basename(rel)} to the Trash`);
  }

  async function revealInFinder(rel: string) {
    const r = root();
    if (!r) return;
    const abs = join(r, rel);
    const isDir = entries().some((e) => e.isDir && e.path === rel);
    try { await host.openExternal(isDir ? abs : dirname(abs)); } catch (err) { fail(err); }
  }

  /** "Apply a starter…": adds a starter's folder types, templates and layouts to this workspace. */
  async function applyStarterCommand() {
    const r = root();
    if (!r || !hasTexdesk()) { say("Set up TeXdesk in this folder first", true); return; }
    const id = await palette.pick({ title: "Add a starter's folder types and templates to this workspace", placeholder: "Starter", items: STARTERS.map((st) => ({ label: st.label, detail: st.detail, value: st.id })) });
    const starter = STARTERS.find((st) => st.id === id);
    if (!starter) return;
    const { conflicts } = applyStarter(ws(), starter);
    let replace = new Set<string>();
    if (conflicts.length) {
      const how = await palette.pick({
        title: `This workspace already has ${conflicts.join(", ")}`,
        placeholder: "Choose…",
        items: [
          { label: "Keep mine", detail: "add only what's missing", value: "keep" },
          { label: "Replace them with the starter's", detail: "template files too", value: "replace" },
        ],
      });
      if (how === null) return;
      if (how === "replace") replace = new Set(conflicts);
    }
    try {
      await writeStarterBodies(host, r, starter, replace.size > 0);
      await updateWorkspace((w) => applyStarter(w, starter, replace).ws);
      await refreshFiles();
    } catch (err) { fail(err); return; }
    const types = Object.values(starter.folderTypes).map((t) => t.label);
    say(`Added the ${starter.label} starter${types.length ? ` — right-click a folder → New ${types[0]}…, or Set Folder Type…` : ""}`);
  }

  async function setUpHere() {
    const r = root();
    if (!r) return;
    const starter = await pickStarter(basename(r), false);
    if (!starter) return;
    try {
      const created = await seedWorkspace(host, r, starter);
      say(`Set up TeXdesk: created ${created.map((c) => relative(r, c)).filter((c) => !c.startsWith(".texdesk/templates/")).join(", ")}`);
      await openWorkspace(r);
    } catch (err) { fail(err); }
  }

  async function pasteAsCode() {
    if (!view || !isTex()) return;
    let code: string;
    try { code = await host.readClipboardText(); } catch (err) { fail(`Couldn't read the clipboard: ${String(err)}`); return; }
    if (!code.trim()) { say("The clipboard is empty", true); return; }
    const last = lastLanguage(view.state);
    const names = [...new Set([...(last ? [last] : []), ...LISTINGS_LANGUAGES])];
    const lang = await palette.pick<string>({
      title: "Paste as code — language",
      placeholder: last ? `Enter for ${last}` : "Language",
      items: [
        ...names.map((n) => ({ label: n, detail: n === last ? "last used in this file" : undefined, value: n })),
        { label: "(no language)", value: "" },
      ],
    });
    if (lang === null) return view.focus();
    insertCodeBlock(view, code, lang || null);
    view.focus();
  }

  // ---- auto compile ---------------------------------------------------------------

  let autoTimer: ReturnType<typeof setTimeout> | undefined;

  /** Once typing pauses, save (Tectonic reads the file), which builds. */
  function scheduleAutoCompile() {
    if (!isTex()) return;
    clearTimeout(autoTimer);
    // The pause was the wait: build as soon as it's saved.
    autoTimer = setTimeout(() => { if (path() && dirty()) void save(0); }, config().build.autoCompileDelayMs);
  }
  onCleanup(() => clearTimeout(autoTimer));

  /** View → PDF Follows Editor (or the switch on the PDF): flips editor.follow_edits (here if this workspace sets it, else everywhere). */
  async function toggleFollowEdits() {
    const cfg = config();
    const on = !cfg.editor.followEdits;
    setConfig({ ...cfg, editor: { ...cfg.editor, followEdits: on } });
    await saveSetting(scopeOf("editor", "follow_edits"), "editor", "follow_edits", on);
    say(on ? "The PDF follows the editor: double-clicking a line, and each build after an edit, scroll it there" : "The PDF no longer follows the editor (⌘⇧J still shows the cursor's line)");
  }

  // ---- fixes for common build errors --------------------------------------------------

  /** The built-in fix for the open file's first build error, if it's a common one (see compile/fixes.ts). */
  const [fixNote, setFixNote] = createSignal<(RuleFix & { file: string }) | null>(null);

  function findRuleFix() {
    const p = path();
    if (!view || !p || !isTex()) return;
    const d = diagnosticsFor(builder.status, p).find((x) => x.severity === "error" && x.line);
    if (!d || !d.line) { setFixNote(null); return; }
    const doc = view.state.doc;
    const n = Math.min(Math.max(d.line, 1), doc.lines);
    const commands = knownCommandNames(Object.keys(view.state.facet(mathMacros)).map((m) => m.replace(/^\\/, "")));
    const rule = ruleFix(d.message, n, doc.toString().split("\n"), commands, d.hint);
    setFixNote(rule ? { ...rule, file: p } : null);
    applyDiagnostics();
  }

  // ---- spelling ---------------------------------------------------------------------
  //
  // The prose of the open .tex file is checked as you type (the macOS spellchecker), and
  // misspellings are underlined. ⌘L goes to the last one before the cursor and numbers its
  // suggestions (1–6 picks one and comes back), after Gilles Castel's Vim mapping (inoremap <C-l> <c-g>u<Esc>[s1z=`]a<c-g>u).

  /** Misspelled words (→ suggestions) in a file, from its last spellcheck. */
  const [spelling, setSpelling] = createSignal<{ file: string; misses: Map<string, string[]> } | null>(null);
  /** Word → suggestions if it's misspelled, null if it's fine; so each word is asked about once. */
  const spellCache = new Map<string, string[] | null>();
  /** The misspelled word being typed (not underlined until the cursor leaves it). */
  let typing: { from: number; to: number } | null = null;
  /** Words added to the dictionary outside a workspace (kept until TeXdesk quits). */
  const sessionWords = new Set<string>();
  const dictionaryPath = () => (root() && hasTexdesk() ? join(root()!, ".texdesk", "words.txt") : null);
  let dictionary: { path: string | null; words: Set<string> } | null = null;

  async function readDictionary(): Promise<Set<string>> {
    const p = dictionaryPath();
    if (dictionary?.path === p) return dictionary.words;
    const words = new Set(sessionWords);
    try { if (p && (await host.exists(p))) for (const w of parseDictionary(await host.readText(p))) words.add(w); } catch { /* unreadable: none */ }
    dictionary = { path: p, words };
    return words;
  }

  let spellTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleSpellcheck(ms = 300) {
    clearTimeout(spellTimer);
    if (!config().editor.spellcheck) { if (spelling()) { setSpelling(null); applyDiagnostics(); } return; }
    spellTimer = setTimeout(() => void spellcheck(), ms);
  }

  /**
   * Spellchecks the prose in the open file (not math, code, commands or the preamble) and
   * underlines what's misspelled. Returns how many misspellings, or null if it couldn't check.
   */
  async function spellcheck(): Promise<number | null> {
    const p = path(), v = view;
    if (!v || !p || !isTex()) return null;
    const doc = v.state.doc;
    const words = proseWords(doc.toString());
    const unknown = wordsToCheck(words, await readDictionary()).filter((w) => !spellCache.has(w));
    if (unknown.length) {
      let misses;
      try { misses = await host.checkSpelling(unknown); } catch { return null; }
      if (misses === null) return null;
      for (const w of unknown) spellCache.set(w, null);
      for (const m of misses) spellCache.set(m.word, rankSuggestions(m.suggestions, m.correction));
    }
    if (path() !== p || view !== v) return null;
    const dict = await readDictionary();
    const map = new Map<string, string[]>();
    for (const w of words) { const sug = spellCache.get(w.word); if (sug && !dict.has(w.word)) map.set(w.word, sug); }
    setSpelling({ file: p, misses: map });
    applyDiagnostics();
    return words.filter((w) => map.has(w.word)).length;
  }

  /** "Add to dictionary": `.texdesk/words.txt` in a workspace (made on first use), else this session only. */
  async function addToDictionary(word: string) {
    const p = dictionaryPath();
    if (p) {
      try {
        if (await host.exists(p)) {
          const text = await host.readText(p);
          if (!parseDictionary(text).has(word)) await host.writeText(p, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${word}\n`);
        } else {
          await host.createText(p, `# Words the spellchecker accepts in this workspace, one per line.\n${word}\n`);
        }
      } catch (err) { fail(`Couldn't save to the dictionary: ${String(err)}`); return; }
    } else sessionWords.add(word);
    dictionary = null;
    const sp = spelling();
    if (sp) { const misses = new Map(sp.misses); misses.delete(word); setSpelling({ ...sp, misses }); }
    applyDiagnostics();
    say(p ? `Added “${word}” to .texdesk/words.txt` : `“${word}” is accepted until TeXdesk quits (open a TeXdesk folder to keep a dictionary)`);
  }

  // Turning spellchecking on or off in Settings.
  createEffect(on(() => config().editor.spellcheck, () => scheduleSpellcheck(0), { defer: true }));

  /**
   * ⌘L: moves the cursor to the last misspelling before it (or the one it's in) and shows its
   * suggestions, best first: 1–6 replaces the word and puts the cursor back where it was (one
   * undo step), Esc goes back without a change. Press ⌘L again for the misspelling before that.
   */
  async function fixPreviousMisspelling() {
    const p = path();
    if (!view || !p || !isTex()) return;
    clearTimeout(spellTimer);
    if ((await spellcheck()) === null) { say("Spellchecking isn't available here (it uses the macOS spellchecker)", true); return; }
    const v = view;
    if (!v || path() !== p) return;
    const misses = spelling()?.misses ?? new Map<string, string[]>();
    const open = openSpellFix(v);
    const head = v.state.selection.main.head;
    const before = proseWords(v.state.doc.toString()).filter((w) => misses.has(w.word) && w.from < head);
    const w = before[before.length - 1];
    if (!w) { say("No misspellings before the cursor"); return; }
    v.dispatch({
      selection: EditorSelection.cursor(w.from),
      effects: showSpellFix.of({ from: w.from, to: w.to, word: w.word, options: misses.get(w.word)!.slice(0, MAX_OPTIONS), home: open?.home ?? head, selected: 0 }),
      scrollIntoView: true,
    });
    v.focus();
  }

  /** Replaces a line with a fix, if the line is still what it was. */
  function applyFix(fix: Fix): boolean {
    const v = view;
    if (!v || fix.line > v.state.doc.lines || v.state.doc.line(fix.line).text !== fix.original) {
      say("That line has changed since — not applied", true);
      return false;
    }
    const l = v.state.doc.line(fix.line);
    v.dispatch({ changes: { from: l.from, to: l.to, insert: fix.replacement }, userEvent: "input.fix", scrollIntoView: true });
    v.focus();
    return true;
  }

  const fixAction = (fix: Fix) => ({ name: "Apply fix", apply: () => applyFix(fix) });

  // ---- PDF follows edits --------------------------------------------------------------

  /** The line last edited, for scrolling the output there after the next build. */
  let lastEdit: { file: string; line: number } | null = null;

  /** After a build: scroll the PDF pane (if it's showing) to the last edited line, quietly. */
  async function followEdit() {
    const edit = lastEdit;
    const src = outputSource();
    if (!edit || !src || !config().editor.followEdits) return;
    if (!pdfShown()) return;
    // An edit in the preamble has no place of its own in the PDF.
    const text = view && path() === edit.file ? view.state.doc.toString() : texCache.get(edit.file);
    const begin = text ? text.split("\n").findIndex((l) => /^[^%]*\\begin\{document\}/.test(l)) + 1 : 0;
    if (begin && edit.line <= begin) return;
    const sync = await loadSync(src);
    // Only where the line itself (or one close by) is: a line with no output of its own (a
    // definition, a blank line) can map far away.
    const locs = (sync ? forwardSearchAll(sync, edit.file, edit.line, dirname(src)) : []).filter((l) => Math.abs((l.line ?? edit.line) - edit.line) <= 5);
    if (locs.length) outputApi?.reveal(locs, { quiet: true, afterLoad: true });
  }

  /** ⌘S: saves (which builds); on an unchanged .tex file, rebuilds it, e.g. to retry after a failed build. */
  async function saveCommand() {
    const p = path();
    if (p && TEX_EXT.has(extname(p)) && !dirty()) { builder.schedule(p, 0); return; }
    await save();
  }


  function builtPdfFor(): string | null {
    const st = builder.status;
    if (!st.file) return null;
    if (st.export?.status === "exported") return st.export.path;
    return st.pdf ?? null;
  }

  async function openPdfExternally() {
    // A PDF tab in front in the focused group: that one.
    const ag = groupById(layout(), layout().activeGroup);
    const front = ag && activeTab(ag);
    if (front?.kind === "pdf" && front.path) {
      try { await host.openExternal(front.path); } catch (err) { fail(err); }
      return;
    }
    let pdf = builtPdfFor();
    const p = path();
    if (p && isTex() && (!builder.status.file || builder.status.file !== p)) {
      const stem = basename(p).replace(/\.tex$/, "");
      const candidate = join(dirname(p), ".build", `${stem}.pdf`);
      pdf = (await host.exists(candidate)) ? candidate : pdf;
    }
    if (!pdf) { say("No PDF yet — press ⌘S to build it", true); return; }
    try { await host.openExternal(pdf); } catch (err) { fail(err); }
  }

  async function showBuildLog() {
    const f = builder.status.file;
    if (!f) { say("Nothing has been built yet", true); return; }
    await openPath(join(dirname(f), ".build", basename(f).replace(/\.tex$/, ".log")));
  }

  async function openAtLine(file: string, line: number) {
    if (file !== path()) await openPath(file);
    if (view && path() === file) {
      const l = view.state.doc.line(Math.min(Math.max(line, 1), view.state.doc.lines));
      view.dispatch({ selection: EditorSelection.cursor(l.from), scrollIntoView: true });
      view.focus();
    }
  }

  async function jumpTo(file: string | null, line: number | null) {
    const st = builder.status;
    if (!st.file) return;
    const target = file ? (file.startsWith("/") ? file : join(dirname(st.file), file.replace(/^\.\//, ""))) : st.file;
    if (target !== path()) await openPath(target);
    if (view && line) {
      const l = view.state.doc.line(Math.min(Math.max(line, 1), view.state.doc.lines));
      view.dispatch({ selection: EditorSelection.cursor(l.from), scrollIntoView: true });
      view.focus();
    }
  }

  /** Opens the Settings window (at a section: "plugins", "workspace", …). */
  function openSettings(section = "editor") {
    palette.close(null);
    setSettingsOpen(section);
    void refreshExamples();
  }

  /** Opens a template's body in the editor; a built-in one is copied into the workspace first. */
  async function editTemplateBody(key: string) {
    const r = root();
    if (!r) return;
    try {
      const t = (await listTemplates(host, r, ws())).find((x) => x.key === key);
      if (!t) { say(`There's no template “${key}”`, true); return; }
      let file = t.path;
      if (!file) {
        file = join(templatesDir(r), t.file);
        await host.createText(file, DEFAULT_TEMPLATES[t.file] ?? NEW_TEMPLATE);
        await refreshFiles();
      }
      setSettingsOpen(null);
      await openPath(file);
    } catch (err) { fail(err); }
  }

  /** A new template: an entry in workspace.json and an empty-ish body in .texdesk/templates. */
  async function newTemplate(label: string): Promise<string | null> {
    const r = root();
    if (!r) return null;
    const key = uniqueKey(label, Object.keys(ws().templates));
    let file = `${key}.tex`;
    for (let i = 2; await host.exists(join(templatesDir(r), file)); i++) file = `${key}-${i}.tex`;
    try { await host.createText(join(templatesDir(r), file), NEW_TEMPLATE); } catch (err) { fail(err); return null; }
    await updateWorkspace((w) => ({ ...w, templates: { ...w.templates, [key]: { label, body: file, name: "{{title}}.tex" } } }));
    return key;
  }

  /** Renames a template's body file in .texdesk/templates (for every template using it). An error message, or null. */
  async function renameTemplateBody(key: string, name: string): Promise<string | null> {
    const r = root();
    const t = ws().templates[key];
    if (!r || !t) return null;
    const file = /\.tex$/i.test(name.trim()) ? name.trim() : `${name.trim()}.tex`;
    if (file === t.body) return null;
    if (file === ".tex" || file.includes("/") || file.startsWith(".")) return "Use a plain file name, e.g. problem.tex";
    const from = join(templatesDir(r), t.body);
    if (await host.exists(from)) {
      // Moving the file updates the templates that use it.
      const res = await relocate(from, join(templatesDir(r), file));
      return typeof res === "string" ? res : null;
    }
    if (await host.exists(join(templatesDir(r), file))) return `${file} already exists`;
    await updateWorkspace((w) => ({
      ...w,
      templates: Object.fromEntries(Object.entries(w.templates).map(([k, x]) => [k, x.body === t.body ? { ...x, body: file } : x])),
    }));
    return null;
  }

  /** Renames a folder type's key everywhere, template bodies included. An error message, or null. */
  async function renameTypeEverywhere(from: string, to: string): Promise<string | null> {
    if (from === to) return null;
    try { renameType(ws(), from, to); } catch (err) { return err instanceof Error ? err.message : String(err); }
    await rewriteTemplateBodies((text) => renameTypeInText(text, from, to));
    await updateWorkspace((w) => renameType(w, from, to));
    say(`Renamed the folder type ${from} to ${to}`);
    return null;
  }
  async function renameFieldEverywhere(type: string, from: string, to: string): Promise<string | null> {
    if (from === to) return null;
    try { renameField(ws(), type, from, to); } catch (err) { return err instanceof Error ? err.message : String(err); }
    await rewriteTemplateBodies((text) => renameFieldInText(text, type, from, to));
    await updateWorkspace((w) => renameField(w, type, from, to));
    return null;
  }
  /** Applies `fn` to every template body in the workspace (only files that change are written). */
  async function rewriteTemplateBodies(fn: (text: string) => string) {
    const r = root();
    if (!r) return;
    for (const t of await listTemplates(host, r, ws())) {
      if (!t.path) continue;
      try {
        const text = await host.readText(t.path);
        const next = fn(text);
        if (next !== text) await host.writeText(t.path, next);
      } catch (err) { fail(`Couldn't update ${t.file}: ${String(err)}`); }
    }
  }

  /** A made-up folder name from a type's pattern ("{{code}}" → "CODE"). */
  function exampleName(t: FolderType): string {
    const vars: Record<string, string> = {};
    for (const f of t.fields ?? []) vars[f.key] = f.key.toUpperCase();
    try { return renderName(t.name ?? "{{name}}", { ...vars, n: "1", name: "Name" }); } catch { return t.name ?? ""; }
  }

  /** Where a template's next file would go, from the open file (e.g. "Fa30/CS150/hw/hw5.tex"). */
  const [examples, setExamples] = createSignal<Record<string, string | null>>({});
  async function refreshExamples() {
    const r = root();
    if (!r) return;
    const out: Record<string, string | null> = {};
    for (const [key, t] of Object.entries(ws().templates)) {
      const here = currentDir(r);
      const base = t.in ? nearestOfType((await scopeAt(here))!, t.in) ?? (foldersOfType(ws(), t.in, dirSet())[0] ? join(r, foldersOfType(ws(), t.in, dirSet())[0]) : null) : here;
      if (!base) { out[key] = null; continue; }
      const dir = t.dir ? join(base, t.dir) : base;
      try {
        const pattern = t.name ?? "{{title}}.tex";
        const n = numberPattern(pattern) ? String(await nextNumber(host, dir, pattern, false)) : "1";
        out[key] = relative(r, join(dir, renderName(pattern, { n, title: "Title" })));
      } catch { out[key] = null; }
    }
    setExamples(out);
  }

  function toggleMathPreview() {
    const cfg = config();
    setConfig({ ...cfg, editor: { ...cfg.editor, mathPreview: !cfg.editor.mathPreview } });
    say(`Math preview ${config().editor.mathPreview ? "on" : "off"} (Settings → Editor → Math preview keeps it)`);
  }

  // Apply editor settings and theme whenever the config changes.
  createEffect(() => {
    const e = config().editor;
    if (e.theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = e.theme;
    if (view) applySettings(view, e, isTex());
  });

  /**
   * Macros for the math preview: \newcommand etc. from the open document's preamble and the
   * workspace's own packages it loads (e.g. preamble.sty at the workspace root).
   */
  async function refreshMacros() {
    const p = path();
    if (!view || !p || !isTex()) return;
    const doc = view.state.doc.toString();
    const begin = doc.indexOf("\\begin{document}");
    const preamble = begin >= 0 ? doc.slice(0, begin) : extname(p) === "sty" ? doc : "";
    let text = "";
    const r = root();
    if (r) {
      const used = [...preamble.replace(/(^|[^\\])%.*$/gm, "$1").matchAll(/\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{([^}]*)\}/g)]
        .flatMap((m) => m[1].split(",").map((x) => x.trim())).filter(Boolean);
      for (const name of used) {
        for (const dir of [dirname(p), r]) {
          const sty = join(dir, `${name}.sty`);
          try { if (await host.exists(sty)) { text += await host.readText(sty) + "\n"; break; } } catch { /* ignore */ }
        }
      }
    }
    text += preamble;
    if (view && path() === p) {
      setMacros(view, extractMacros(text));
      setUserEnvironments(view, extractEnvironments(text));
    }
  }

  async function pasteImageData(png: ArrayBuffer) {
    const p = path();
    const r = root();
    if (!view || !p) return;
    const figures = (await scopeAt(dirname(p)))?.figuresDir ?? null;
    try {
      const saved = await saveFigure(host, p, figures, png);
      insertFigure(view, saved.include);
      view.focus();
      say(`Saved ${r ? relative(r, saved.path) : saved.path}`);
      void refreshFiles();
    } catch (err) { fail(err); }
  }

  async function pasteImageCommand() {
    let png: ArrayBuffer | null = null;
    try { png = await host.readClipboardImage(); } catch (err) { fail(`Couldn't read the clipboard: ${String(err)}`); return; }
    if (!png) { say("There's no image on the clipboard", true); return; }
    await pasteImageData(png);
  }

  /** ⌘V with an image on the clipboard (e.g. a screenshot) pastes it as a figure. */
  function onPaste(e: ClipboardEvent) {
    if (!isTex()) return;
    const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
    if (!file) return;
    e.preventDefault();
    e.stopPropagation();
    void (async () => {
      let data = await file.arrayBuffer();
      if (file.type !== "image/png") {
        const bmp = await createImageBitmap(file);
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        c.getContext("2d")!.drawImage(bmp, 0, 0);
        data = await (await c.convertToBlob({ type: "image/png" })).arrayBuffer();
      }
      await pasteImageData(data);
    })();
  }

  /** Converts a LaTeX Suite data.json (read only) into a new plugin with your other plugins. */
  async function importLatexSuite() {
    const dir = userPluginsDir();
    if (!dir) { say("The global plugins folder isn't available", true); return; }
    const src = await host.pickFile();
    if (!src) return;
    let result;
    try {
      const id = await pluginIdFor(host, dir, "imported-latex-suite");
      result = convertLatexSuite(await host.readText(src), { sourcePath: src, functionsModule: `${id}-functions` });
      const files = [{ name: `${id}.ts`, code: result.code }, ...(result.functionsCode ? [{ name: `${id}-functions.ts`, code: result.functionsCode }] : [])];
      const pdir = await createPlugin(host, dir, id, { name: "Imported LaTeX Suite snippets", description: `From ${basename(src)}` }, files);
      await restartSnippets();
      setSettingsOpen(null);
      await openPath(join(pdir, `${id}.ts`));
    } catch (err) { fail(`Couldn't import: ${err instanceof Error ? err.message : String(err)}`); return; }
    const t = result.summary.todo.length;
    say(`Imported ${result.summary.converted} snippets as a new plugin${t ? ` — ${t} left as TODO comments` : ""}`);
  }

  // ---- plugins ----------------------------------------------------------------------------

  /** The files of a plugin's folder that load (its .ts files). */
  async function pluginFiles(p: Plugin): Promise<string[]> {
    if (!p.dir) return [];
    return (await host.readDir(p.dir)).filter((e) => !e.isDir && e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")).map((e) => join(p.dir!, e.name)).sort();
  }

  /**
   * Opens a plugin's main file: one named after the plugin, else the biggest one that isn't a
   * helper (an imported LaTeX Suite's "-functions" file only holds its JavaScript functions).
   */
  async function openPlugin(p: Plugin, file?: string) {
    if (root() && !sidebar()) toggleSidebar(); // its files are listed there
    if (file) { setSettingsOpen(null); await openPath(join(p.dir!, file)); return; }
    const files = await pluginFiles(p);
    const named = files.find((f) => basename(f) === `${p.id}.ts`);
    let main = named;
    if (!main) {
      const sized = await Promise.all(files.map(async (f) => ({ f, n: (await host.readText(f).catch(() => "")).length, helper: /-functions\.ts$/.test(f) })));
      main = sized.sort((a, b) => Number(a.helper) - Number(b.helper) || b.n - a.n)[0]?.f;
    }
    setSettingsOpen(null);
    await openPath(main ?? join(p.dir!, "plugin.json"));
  }

  /** "Duplicate to edit" (built-in → yours) or "Copy to this workspace" (yours → the workspace's). */
  async function duplicatePlugin(p: Plugin) {
    const to = p.source === "built-in" ? userPluginsDir() : workspacePluginsDir();
    if (!to) { say(p.source === "built-in" ? "The global plugins folder isn't available" : "Set up TeXdesk in this folder first", true); return; }
    try {
      const files = p.files ?? await Promise.all((await pluginFiles(p)).map(async (f) => ({ name: basename(f), code: await host.readText(f) })));
      // Same id: the copy replaces the original there (yours over built-in, the workspace's over yours).
      const id = (await host.exists(join(to, p.id))) ? await pluginIdFor(host, to, p.id) : p.id;
      const forkedFrom = p.source === "built-in" ? p.id : p.forkedFrom;
      if (to === workspacePluginsDir()) await setTrust(true); // you're putting your own code there
      const pdir = await createPlugin(host, to, id, { name: p.name, description: p.description, forkedFrom }, files);
      await restartSnippets();
      await watchPluginRoots();
      say(`Copied ${p.name} to ${p.source === "built-in" ? "your plugins" : "this workspace"} — it's yours to edit`);
      setSettingsOpen(null);
      await openPath(join(pdir, files[0]?.name ?? "plugin.json"));
    } catch (err) { fail(err); }
  }

  // ---- the open file's plugin (shown above the tree: plugins live outside it) -------------

  /** The plugin the open file is in, if any. */
  const currentPlugin = createMemo(() => {
    const p = path();
    return p ? plugins().find((x) => x.dir && p.startsWith(x.dir + "/")) ?? null : null;
  });
  const [pluginFileNames, setPluginFileNames] = createSignal<string[]>([]);
  createEffect(() => {
    const pl = currentPlugin();
    path(); // a file added from the panel shows up
    if (!pl?.dir) { setPluginFileNames([]); return; }
    void host.readDir(pl.dir).then((list) => {
      if (currentPlugin() === pl) setPluginFileNames(list.filter((e) => !e.isDir && !e.name.startsWith(".") && e.name !== ".keep").map((e) => e.name).sort((a, b) => (a === "plugin.json" ? 1 : b === "plugin.json" ? -1 : a.localeCompare(b))));
    }).catch(() => setPluginFileNames([]));
  });
  const pluginPanel = () => {
    const pl = currentPlugin();
    if (!pl?.dir) return null;
    snippetInfo(); // counts follow reloads
    const set = runtime.set;
    return {
      name: pl.name,
      where: pl.source === "workspace" ? "this workspace's plugin" : "your plugin, in every workspace",
      enabled: pl.enabled,
      files: pluginFileNames().map((name) => {
        const key = `${pl.id}/${name}`;
        const n = set.snippets.filter((x) => x.file === key).length;
        const k = set.keys.filter((x) => x.file === key).length;
        const err = problems().filter((x) => x.file === key && x.kind !== "slow");
        const detail = err.length ? "error" : name === "plugin.json" ? "name, description" : n || k ? [n ? `${n} snippet${n === 1 ? "" : "s"}` : "", k ? `${k} key${k === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ") : name.endsWith(".ts") ? "helpers" : "";
        return { name, path: join(pl.dir!, name), active: path() === join(pl.dir!, name), detail, error: err.length > 0 };
      }),
      onOpen: (p: string) => void openPath(p),
      onNewFile: () => void newPluginFile(pl),
      onSettings: () => openSettings("plugins"),
    };
  };

  /** A new snippet file in a plugin: asked for its name, started from the snippet skeleton, opened. */
  async function newPluginFile(pl: Plugin) {
    if (!pl.dir) return;
    const name = await palette.prompt({ title: `New snippet file in ${pl.name}`, placeholder: "Name, e.g. greek — .ts is added", validate: (v) => (!v.trim() || /[/\\]/.test(v) ? "Enter a plain name" : null) });
    if (!name) return;
    const file = join(pl.dir, name.trim().replace(/\.ts$/, "") + ".ts");
    try {
      if (await host.exists(file)) { await openPath(file); return; }
      await host.createText(file, NEW_PLUGIN_FILE);
      await openPath(file);
    } catch (err) { fail(err); }
  }

  async function deletePlugin(p: Plugin) {
    if (!p.dir) return;
    const ok = await palette.pick({ title: `Move the plugin “${p.name}” to the Trash?`, placeholder: "You can restore it from the Trash in Finder", items: [{ label: "Move to Trash", value: true }, { label: "Cancel", value: false }] });
    if (!ok) return;
    try { await host.trash(p.dir); } catch (err) { fail(err); return; }
    await restartSnippets();
    say(`Moved ${p.name} to the Trash`);
  }

  async function newPluginCommand(where: "user" | "workspace") {
    const dir = where === "user" ? userPluginsDir() : workspacePluginsDir();
    if (!dir) { say(where === "user" ? "The global plugins folder isn't available" : "Set up TeXdesk in this folder first", true); return; }
    const name = await palette.prompt({ title: where === "user" ? "New plugin (in every workspace)" : "New plugin for this workspace", placeholder: "Name, e.g. Greek letters", validate: (v) => (v.trim() ? null : "Enter a name") });
    if (!name) return;
    try {
      const id = await pluginIdFor(host, dir, name);
      if (where === "workspace") await setTrust(true); // your own code
      const pdir = await createPlugin(host, dir, id, { name: name.trim() }, [{ name: "snippets.ts", code: NEW_PLUGIN_FILE }]);
      if (where === "workspace") await ensurePluginsFolder(host, dir);
      await restartSnippets();
      await watchPluginRoots();
      setSettingsOpen(null);
      await openPath(join(pdir, "snippets.ts"));
      say(`Made the plugin ${name.trim()} — snippets you write here load as you save`);
    } catch (err) { fail(err); }
  }

  /** Shows or hides the PDF pane. */
  function togglePreview() {
    const shown = !pdfShown();
    setPdfShown(shown);
    prefs.set("preview", shown);
  }

  /** Dragging the PDF pane's left edge resizes it; the width is remembered. */
  function startPdfResize(e: MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const start = pdfWidth();
    const move = (ev: MouseEvent) => setPdfWidth(clampPdf(start - (ev.clientX - startX)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing");
      prefs.set("pdfWidth", pdfWidth());
    };
    document.body.classList.add("resizing");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  let syncCache: { key: string; sync: SyncTex } | null = null;
  async function loadSync(source: string): Promise<SyncTex | null> {
    const key = `${source}#${outputVersion()}`;
    if (syncCache?.key === key) return syncCache.sync;
    const f = join(dirname(source), ".build", basename(source).replace(/\.tex$/, ".synctex.gz"));
    try {
      const sync = parseSynctex(await host.readGzipText(f));
      syncCache = { key, sync };
      return sync;
    } catch {
      return null;
    }
  }

  /** ⌘⇧J: show the cursor's line in the PDF. */
  async function showInPdf(fromDoubleClick = false) {
    const src = outputSource();
    const p = path();
    const complain = (m: string) => { if (!fromDoubleClick) say(m, true); };
    if (!src || !p || !view) { complain("Nothing built yet — press ⌘S to build it"); return; }
    const sync = await loadSync(src);
    if (!sync) { complain("No SyncTeX data yet — press ⌘S to build it"); return; }
    const line = view.state.doc.lineAt(view.state.selection.main.head).number;
    const locs = forwardSearchAll(sync, p, line, dirname(src));
    if (!locs.length) { complain("That line isn't in the PDF"); return; }
    openOutput();
    queueMicrotask(() => outputApi?.reveal(locs));
  }

  /** ⌘-click / double-click in the PDF: jump to the source line. */
  async function syncFromPdf(page: number, x: number, y: number) {
    const src = outputSource();
    if (!src) return;
    const sync = await loadSync(src);
    const hit = sync && inverseSearch(sync, page, x, y);
    if (!hit) return;
    let file = hit.file.startsWith("/") ? hit.file : join(dirname(src), hit.file.replace(/^\.\//, ""));
    if (file.startsWith("/private/") && !(await host.exists(file))) file = file.slice(8);
    if (file.startsWith("/private/") && (await host.exists(file.slice(8)))) file = file.slice(8);
    if (file !== path()) await openPath(file);
    if (view) {
      const l = view.state.doc.line(Math.min(Math.max(hit.line, 1), view.state.doc.lines));
      view.dispatch({ selection: EditorSelection.cursor(l.from), effects: EditorView.scrollIntoView(l.from, { y: "center" }) });
      view.focus();
    }
  }

  function toggleDebug() {
    const v = !debug();
    setDebug(v);
    if (v) setLastLog(runtime.lastLog);
  }

  function toggleSidebar() {
    const v = !sidebar();
    sidebarForSearch = false;
    setSidebar(v);
    prefs.set("sidebar", v);
  }

  const hasFile = () => !!path();
  const texFile = () => isTex() && !!path();
  const OPEN_FOLDER = "an open folder";
  const GLOBAL = "the global settings folder (~/.config/texdesk)";
  const TEX = "an open .tex file";

  function renameOpenFile() {
    const r = root(), p = path();
    if (!r || !p) return;
    if (!sidebar()) toggleSidebar();
    queueMicrotask(() => sidebarApi?.rename(relative(r, p)));
  }

  /** Undo/redo in the editor, or in whatever text field has focus (palette, tree). */
  function editHistory(which: "undo" | "redo") {
    const el = document.activeElement;
    if (view && (view.hasFocus || !el || el === document.body)) (which === "undo" ? undo : redo)(view);
    else document.execCommand(which);
  }

  // ---- folder overview ----------------------------------------------------------------

  /** Each folder's overview settings (its own, else its type's), by relative path. */
  const folderMetas = createMemo(() => metasOf(ws()));
  /** File times (relative path → created/modified), loaded while an overview is open. */
  const [fileTimes, setFileTimes] = createSignal<Map<string, FileTimes>>(new Map());
  const overviewOpen = () => layout().groups.some((g) => g.tabs.some((t) => t.kind === "overview"));

  async function refreshTimes(list: WalkEntry[], force = false) {
    const r = root();
    if (!r || (!force && !overviewOpen())) return;
    const paths = list.filter((e) => !e.path.split("/").some((x) => x.startsWith(".")));
    const times = await host.fileTimes(paths.map((e) => join(r, e.path)));
    if (root() !== r) return;
    setFileTimes(new Map(paths.flatMap((e, i) => (times[i] ? [[e.path, times[i]!] as const] : []))));
  }

  /** How many \links each document makes (absolute path → count). */
  const outgoing = createMemo(() => {
    const out = new Map<string, number>();
    for (const list of linkIndex().values()) for (const b of list) out.set(b.file, (out.get(b.file) ?? 0) + 1);
    return out;
  });

  /**
   * Opens `dir` (absolute; the workspace root is its home page) as an overview tab, in the
   * group text files open in. `preview`: as that group's preview tab, which the next preview
   * replaces (a click in the file tree); otherwise a tab that stays. `where`: where it was
   * dropped. `replace`: in that tab's place (going to another folder from an overview), unless
   * it's open already.
   */
  async function openOverview(dir: string, opts: { preview?: boolean; where?: Where; replace?: string } = {}) {
    const r = root();
    if (!r || (dir !== r && !dir.startsWith(r + "/"))) return;
    // Times first, so the list doesn't open in one order and then jump to another.
    await refreshTimes(entries(), true);
    const spec: TabSpec = { kind: "overview", path: dir };
    const hit = findSpec(layout(), spec);
    let next: Layout;
    if (opts.where) next = placeSpec(hit?.tab ?? spec, opts.where);
    else if (opts.replace && !hit && findTab(layout(), (t) => t.id === opts.replace)) next = retarget(layout(), opts.replace, spec);
    else if (hit) {
      next = revealTab(layout(), spec, layout().activeGroup).layout;
      if (!opts.preview) next = keepTab(next, hit.tab.id);
    } else next = (opts.preview ? openPreview : place)(layout(), spec, textGroup()).layout;
    setLayout(next);
    await reconcile();
  }

  /** Keeps a preview tab open (double-clicked, or worked in: reordered, layout edited). */
  function keepOpen(tabId: string | undefined) {
    if (tabId && findTab(layout(), (t) => t.id === tabId)?.tab.preview) setLayout(keepTab(layout(), tabId));
  }

  /** ⌥⌘O: the overview of the open file's nearest typed folder (else its folder; else the home page). */
  async function folderOverviewCommand() {
    const r = requireWorkspace();
    if (!r) return;
    const front = frontTab();
    const p = path();
    // From an overview: one level up, to the nearest typed folder above it.
    const from = front?.kind === "overview" && front.path ? (front.path === r ? null : dirname(front.path)) : p && p.startsWith(r + "/") ? dirname(p) : null;
    if (!from) return openOverview(r);
    const typed = [...(await scopeAt(from))!.folders].reverse().find((f) => f.kind);
    // Up from an overview goes in its tab.
    await openOverview(typed?.path ?? (front?.kind === "overview" ? r : from), front?.kind === "overview" ? { replace: front.id } : {});
  }

  // ---- pinned folders (per workspace, in this Mac's preferences) --------------------------

  const [pinned, setPinned] = createSignal<string[]>([]);
  function setPins(list: string[]) {
    setPinned(list);
    const r = root();
    if (r) prefs.set(`pinned:${r}`, list);
  }
  const pinFolder = (rel: string, on: boolean) => {
    setPins(on ? [...pinned().filter((x) => x !== rel), rel] : pinned().filter((x) => x !== rel));
    say(on ? `Pinned ${basename(rel) || basename(root()!)} to the sidebar` : `Unpinned ${basename(rel)}`);
  };

  /** "Go to overview…": a typed folder (a class, a term…). */
  async function goToOverview() {
    const r = requireWorkspace();
    if (!r) return;
    const typed = [...folderMetas()].filter(([rel, m]) => m.kind && rel && dirSet().has(rel)).map(([rel, m]) => ({ rel, kind: m.kind! })).sort((a, b) => b.rel.localeCompare(a.rel));
    if (!typed.length) { say("No folders have a type yet — right-click a folder → Set Folder Type…", true); return; }
    const rel = await palette.pick({
      title: "Overview of…",
      placeholder: "Folder, e.g. 101",
      items: typed.map((k) => ({ label: basename(k.rel), detail: `${typeLabel(k.kind)} · ${dirname("/" + k.rel).slice(1) || basename(r)}`, key: [k.rel, ...Object.values(ws().folders[k.rel]?.fields ?? {})].join(" "), value: k.rel })),
    });
    if (rel !== null) await openOverview(join(r, rel));
  }

  /** Saves a folder's order (names, in order) in workspace.json. */
  async function saveOrder(folderRel: string, names: string[]) {
    await updateWorkspace((w) => ({ ...w, folders: { ...w.folders, [folderRel]: { ...w.folders[folderRel], order: names } } }));
  }

  /** "New …" buttons for a folder of `type` (absolute `dir` from relative `rel`): its templates, then folder types made inside it. */
  function newActions(type: string | null, rel: string, block?: { templates?: string[]; folders?: string[] }): NewAction[] {
    const r = root()!;
    const abs = rel ? join(r, rel) : r;
    const w = ws();
    const tKeys = block?.templates ?? (type ? templateCommands().filter((t) => t.header.in === type).map((t) => t.key) : []);
    const fKeys = block?.folders ?? (type ? w.folderTypes[type]?.children ?? [] : []);
    return [
      ...tKeys.map((k) => templateCommands().find((t) => t.key === k)).filter((t): t is LoadedTemplate => !!t)
        .map((t) => ({ id: `template:${t.key}`, label: templateLabel(t), run: () => void newFromTemplate(t.key, abs) })),
      ...fKeys.filter((k) => w.folderTypes[k]).map((k) => ({ id: `folder:${k}`, label: typeLabel(k), run: () => void newFolderOfType(k, abs) })),
    ];
  }

  function overviewInput(): OverviewInput {
    const r = root()!;
    linkIndex(); // titles come from texCache, which is current whenever the link index is
    return { folder: "", entries: entries(), generated: generated(), folders: folderMetas(), times: fileTimes(), text: (p) => texCache.get(join(r, p)) };
  }

  /** A Header block's links from folder `rel`: "./x" is relative to it, anything else to the workspace. */
  function headerLinks(rel: string, links: string[]): HeaderLink[] {
    const kinds = new Map(entries().map((e) => [e.path, e.isDir]));
    return links.map((l) => {
      const path = normalize(l.startsWith("./") ? join(rel || ".", l) : l).slice(1);
      const folder = kinds.get(path);
      return { name: basename(path).replace(/\.tex$/, ""), path, folder: !!folder, missing: folder === undefined };
    });
  }

  /** An overview's blocks for folder `rel`, as its layout says, with what each one shows. */
  function resolveBlocks(rel: string): ResolvedBlock[] {
    const w = ws();
    const input = { ...overviewInput(), folder: rel };
    const entry = w.folders[rel];
    const typeKey = entry?.type ?? null;
    const type = typeKey ? w.folderTypes[typeKey] : undefined;
    return layoutFor(w, rel).layout.blocks.map((b): ResolvedBlock => {
      switch (b.type) {
        case "header": {
          let up: { name: string; path: string; label: string } | null = null;
          if (b.up !== false) {
            for (let d = dirname("/" + rel).slice(1); d; d = dirname("/" + d).slice(1)) {
              const k = w.folders[d]?.type;
              if (k) { up = { name: basename(d), path: d, label: typeLabel(k) }; break; }
            }
          }
          const values = entry?.fields ?? {};
          // All fields by default, except one that's just the folder's name again (a class's code).
          const keys = b.fields ?? (type?.fields?.map((f) => f.key) ?? Object.keys(values)).filter((k) => values[k] !== basename(rel));
          const fields = keys.filter((k) => values[k]).map((k) => ({ label: type?.fields?.find((f) => f.key === k)?.label ?? k, value: values[k] }));
          return { type: "header", name: rel ? basename(rel) : basename(root()!), path: rel, typeLabel: typeKey ? typeLabel(typeKey) : null, fields, up, links: headerLinks(rel, b.links ?? []) };
        }
        case "templates":
          return { type: "templates", actions: newActions(typeKey, rel, b) };
        case "files":
          return {
            type: "files", title: b.title, model: filesView(input, b),
            reorderable: (b.sort ?? "order") === "order" && (b.groupBy ?? "subfolder") === "subfolder",
            show: { title: b.showTitle !== false, date: b.showDate !== false, links: b.showLinks !== false, pdf: b.showPdf !== false },
          };
        case "subfolders":
          return {
            type: "subfolders", title: b.title, display: b.display ?? "compact",
            rows: subfolderRows(input, w, b).map((row) => ({ ...row, label: row.kind ? typeLabel(row.kind) : null, actions: row.kind ? newActions(row.kind, row.path) : [] })),
          };
      }
    });
  }

  /** Changes a folder's overview blocks: in the layout it uses, or a new one for its type (or for it alone). */
  function saveLayout(rel: string, change: (blocks: Block[]) => Block[]) {
    void updateWorkspace((w) => {
      const { key, layout: current } = layoutFor(w, rel);
      const blocks = change(current.blocks);
      if (key) return { ...w, overviews: { ...w.overviews, [key]: { blocks } } };
      const entry = w.folders[rel];
      const k = uniqueKey(entry?.type ?? (rel ? basename(rel) : "workspace"), Object.keys(w.overviews));
      const overviews = { ...w.overviews, [k]: { blocks } };
      if (entry?.type && w.folderTypes[entry.type]) return { ...w, overviews, folderTypes: { ...w.folderTypes, [entry.type]: { ...w.folderTypes[entry.type], overview: k } } };
      return { ...w, overviews, folders: { ...w.folders, [rel]: { ...entry, overview: k } } };
    });
  }

  /** "Customize for this folder only": a copy of the layout, used by this folder alone. */
  function customizeLayout(rel: string) {
    void updateWorkspace((w) => {
      const k = uniqueKey(rel ? basename(rel) : "workspace", Object.keys(w.overviews));
      return { ...w, overviews: { ...w.overviews, [k]: { blocks: layoutFor(w, rel).layout.blocks } }, folders: { ...w.folders, [rel]: { ...w.folders[rel], overview: k } } };
    });
  }

  /** Back to the type's layout: the folder's own goes (and is deleted if nothing else uses it). */
  function useTypeLayout(rel: string) {
    void updateWorkspace((w) => {
      const entry = w.folders[rel];
      if (!entry?.overview) return w;
      const own = entry.overview;
      const { overview: _, ...rest } = entry;
      const next = { ...w, folders: { ...w.folders, [rel]: rest } };
      if (!foldersUsingLayout(next, own).length && !Object.values(next.folderTypes).some((t) => t.overview === own)) {
        const overviews = { ...next.overviews };
        delete overviews[own];
        return { ...next, overviews };
      }
      return next;
    });
  }

  function renderOverview(t: () => Tab | null, visible: () => boolean) {
    const r = root()!;
    const rel = () => { const p = t()?.path; return p ? relative(r, p) : ""; };
    const blocks = createMemo(() => (root() === r && t()?.path ? resolveBlocks(rel()) : null));
    const kindsKey = () => `kinds:${r}:${rel()}`;
    const [kinds, setKinds] = createSignal<Kinds>(prefs.get(kindsKey(), ALL_KINDS));
    return (
      <Overview
        folder={rel}
        blocks={blocks}
        resolve={resolveBlocks}
        errors={wsErrors}
        visible={visible}
        typeLabel={typeLabel}
        actionsFor={(kind, folder) => newActions(kind, folder)}
        links={(p) => ({ in: linkIndex().get(join(r, p))?.length ?? 0, out: outgoing().get(join(r, p)) ?? 0 })}
        onOpen={(p) => void openPath(join(r, p))}
        onOverview={(p, newTab) => void openOverview(join(r, p), newTab ? {} : { replace: t()?.id })}
        onReorder={(folder, names) => { keepOpen(t()?.id); void saveOrder(folder, names); }}
        onEditing={() => keepOpen(t()?.id)}
        pinned={() => pinned().includes(rel())}
        onPin={rel() ? (on) => pinFolder(rel(), on) : undefined}
        layout={() => {
          const w = ws();
          const { key, layout } = layoutFor(w, rel());
          const type = w.folders[rel()]?.type;
          return { blocks: layout.blocks, key, usedBy: key ? foldersUsingLayout(w, key) : [], own: !!w.folders[rel()]?.overview, typeLabel: type ? typeLabel(type) : null };
        }}
        layoutOptions={() => {
          const w = ws();
          const type = w.folders[rel()]?.type;
          const prefix = rel() ? rel() + "/" : "";
          return {
            types: Object.entries(w.folderTypes).map(([key, x]) => ({ key, label: x.label })),
            templates: Object.entries(w.templates).map(([key, x]) => ({ key, label: x.label ?? key })),
            fields: (type ? w.folderTypes[type]?.fields ?? [] : []).map((f) => ({ key: f.key, label: f.label })),
            subfolders: entries().filter((e) => e.isDir && e.path.startsWith(prefix) && !e.path.slice(prefix.length).includes("/") && !basename(e.path).startsWith(".")).map((e) => basename(e.path)),
            pickPath: () => palette.pick<string>({
              title: "Link to a file or folder",
              placeholder: "File or folder (e.g. 201 notes)",
              items: entries()
                .filter((e) => !e.path.split("/").some((x) => x.startsWith(".")) && !generated().has(e.path))
                .map((e) => ({ label: basename(e.path) + (e.isDir ? "/" : ""), detail: dirname("/" + e.path).slice(1) || undefined, key: e.path, value: e.path })),
            }),
          };
        }}
        onLayoutChange={(b) => { keepOpen(t()?.id); saveLayout(rel(), b); }}
        onCustomize={() => { keepOpen(t()?.id); customizeLayout(rel()); }}
        onUseTypeLayout={() => useTypeLayout(rel())}
        kinds={kinds}
        onKinds={(k) => { setKinds(k); prefs.set(kindsKey(), Object.values(k).every(Boolean) ? null : k); }}
      />
    );
  }

  /** Dragging the sidebar's right edge resizes it; the width is remembered. */
  function startSidebarResize(e: MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const start = sidebarWidth();
    const move = (ev: MouseEvent) => setSidebarWidth(clampSidebar(start + ev.clientX - startX));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing");
      prefs.set("sidebarWidth", sidebarWidth());
    };
    document.body.classList.add("resizing");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  const commands: Command[] = [
    { id: "new_file", label: "New file…", key: "new_file", run: () => newFile(), when: () => !!root(), needs: OPEN_FOLDER },
    { id: "go_overview", label: "Go to overview…", run: goToOverview, when: () => !!root(), needs: OPEN_FOLDER },
    { id: "folder_overview", label: "Overview of this folder", key: "folder_overview", run: folderOverviewCommand, when: () => !!root(), needs: OPEN_FOLDER },
    { id: "go_home", label: "Workspace home page", run: () => openOverview(root()!), when: () => !!root(), needs: OPEN_FOLDER },
    { id: "new_folder", label: "New folder…", run: newFolder, when: () => !!root(), needs: OPEN_FOLDER },
    { id: "rename_file", label: "Rename file…", run: renameOpenFile, when: () => !!root() && hasFile(), needs: "an open file" },
    { id: "trash_file", label: "Move file to Trash", run: () => { const r = root(), p = path(); if (r && p) void deleteEntry(relative(r, p)); }, when: () => !!root() && hasFile(), needs: "an open file" },
    { id: "reveal_file", label: "Reveal in Finder", run: () => { const r = root(), p = path(); if (r && p) void revealInFinder(relative(r, p)); }, when: () => !!root() && hasFile(), needs: "an open file" },
    { id: "find_file", label: "Find file", key: "find_file", run: findFile },
    { id: "find_in_files", label: "Search in files…", key: "find_in_files", run: findInFiles, when: () => !!root(), needs: OPEN_FOLDER },
    { id: "open_folder", label: "Open folder…", key: "open_folder", run: openFolderDialog },
    { id: "open_file", label: "Open file…", key: "open_file", run: openFileDialog },
    { id: "save", label: "Save", hint: "⌘S", accel: "Mod-s", run: saveCommand, when: hasFile, needs: "an open file" },
    { id: "undo", label: "Undo", accel: "Mod-z", run: () => editHistory("undo"), palette: false },
    { id: "redo", label: "Redo", accel: "Mod-Shift-z", run: () => editHistory("redo"), palette: false },
    { id: "find", label: "Find", hint: "⌘F", accel: "Mod-f", run: () => { if (view) openFind(view); }, when: hasFile, needs: "an open file" },
    { id: "replace", label: "Find and replace", hint: "⌥⌘F", accel: "Mod-Alt-f", run: () => { if (view) openFind(view, true); }, when: hasFile, needs: "an open file" },
    { id: "follow_edits", label: "Toggle PDF follows editor", run: toggleFollowEdits },
    { id: "toggle_pdf", label: "Toggle PDF", key: "toggle_pdf", run: togglePreview },
    { id: "close_tab", label: "Close tab", key: "close_tab", run: () => { const t = frontTab(); if (t) void closeTab(t.id); }, when: () => !!frontTab(), needs: "an open tab" },
    { id: "split_right", label: "Split editor right", key: "split_right", run: () => { const t = frontTab(); if (t) void splitTab(t.id, "right"); }, when: () => !!frontTab(), needs: "an open tab" },
    { id: "show_in_pdf", label: "Show in PDF", key: "show_in_pdf", run: () => showInPdf(), when: texFile, needs: TEX },
    { id: "save_pdf", label: "Save PDF as…", run: savePdfAs, when: () => !!pdfSource(), needs: "an open document" },
    { id: "unlink_pdf", label: "Stop updating saved PDF", run: stopUpdatingPdf, when: () => !!pdfSource(), needs: "an open document" },
    { id: "follow_link", label: "Follow link", key: "follow_link", run: followLinkCommand, when: texFile, needs: TEX },
    { id: "insert_link", label: "Insert link…", key: "insert_link", run: insertLink, when: () => texFile() && !!root(), needs: TEX },
    { id: "open_pdf", label: "Open PDF externally", run: openPdfExternally, when: () => hasFile() || !!builder.status.file || frontTab()?.kind === "pdf", needs: "a PDF" },
    { id: "fix_spelling", label: "Fix previous misspelling", key: "fix_spelling", run: fixPreviousMisspelling, when: texFile, needs: TEX },
    { id: "build_log", label: "Show build log", run: showBuildLog, when: () => !!builder.status.file, needs: "a build" },
    { id: "bracket_size", label: "Cycle bracket size", key: "bracket_size", run: () => { if (view && !cycleBracketSize(view)) say("Put the cursor inside a pair of brackets", true); else view?.focus(); }, when: texFile, needs: TEX },
    { id: "fold_all", label: "Fold all sections and list items", run: () => { if (view) { foldAll(view); view.focus(); } }, when: texFile, needs: TEX },
    { id: "unfold_all", label: "Unfold all sections and list items", run: () => { if (view) { unfoldAll(view); view.focus(); } }, when: texFile, needs: TEX },
    { id: "jump_out", label: "Jump out", key: "jump_out", run: () => { if (view && !jumpOut(view)) say("Nothing to jump out of here", true); else view?.focus(); }, when: texFile, needs: TEX },
    { id: "paste_as_code", label: "Paste as code", key: "paste_as_code", run: pasteAsCode, when: texFile, needs: TEX },
    { id: "paste_image", label: "Paste image", key: "paste_image", run: pasteImageCommand, when: texFile, needs: TEX },
    { id: "toggle_math_preview", label: "Toggle math preview", key: "toggle_math_preview", run: toggleMathPreview, when: texFile, needs: TEX },
    { id: "snippet_debug", label: "Snippet debug view", run: toggleDebug, when: texFile, needs: TEX },
    { id: "toggle_sidebar", label: "Toggle sidebar", key: "toggle_sidebar", run: toggleSidebar, when: () => !!root(), needs: OPEN_FOLDER },
    { id: "command_palette", label: "Command palette…", key: "command_palette", run: () => commandPalette(), palette: false },
    { id: "reload_snippets", label: "Reload plugins", run: () => restartSnippets().then(() => say("Plugins reloaded")) },
    { id: "plugins", label: "Plugins…", run: () => openSettings("plugins") },
    { id: "new_plugin", label: "New plugin…", run: () => newPluginCommand("user"), when: () => !!globalRoot, needs: GLOBAL },
    { id: "import_latex_suite", label: "Import LaTeX Suite snippets…", run: importLatexSuite, when: () => !!globalRoot, needs: GLOBAL },
    { id: "settings", label: "Settings", key: "settings", run: () => openSettings() },
    { id: "workspace_setup", label: "Folder types and templates…", run: () => openSettings("workspace"), when: () => hasTexdesk(), needs: "a TeXdesk folder" },
    { id: "apply_starter", label: "Apply a starter…", run: applyStarterCommand, when: () => hasTexdesk(), needs: "a TeXdesk folder" },
    { id: "upgrade_workspace", label: "Upgrade workspace", run: () => offerUpgrade(root()!), when: () => hasTexdesk() && hasLegacySetup(entries()), needs: "a workspace with the old setup files" },
    { id: "show_tour", label: "Show the welcome tour", run: () => setTour(true), when: () => !!root(), needs: OPEN_FOLDER },
    { id: "set_up", label: "Set up TeXdesk in this folder", run: setUpHere, when: () => !!root() && !hasTexdesk(), needs: "a folder that isn't set up yet" },
    { id: "open_default_app", label: "Open in default app", run: () => host.openExternal(path()!).catch(fail), when: hasFile, needs: "an open file" },
    { id: "close_folder", label: "Close folder", run: closeWorkspace, when: () => !!root(), needs: OPEN_FOLDER },
  ];
  const commandById = new Map(commands.map((c) => [c.id, c]));
  /** "New <label>" for each template that has a label, and "New <Type>" for each folder type. */
  const templateCommandList = (): Command[] => [
    ...templateCommands().map((t) => ({
      id: `template:${t.key}`, label: `New ${templateLabel(t)}`, run: () => newFromTemplate(t.key), when: () => !!root(), needs: OPEN_FOLDER,
    })),
    ...Object.entries(ws().folderTypes).map(([k, t]) => ({
      id: `folder:${k}`, label: `New ${t.label}`, run: () => newFolderOfType(k), when: () => !!root(), needs: OPEN_FOLDER,
    })),
  ];
  const commandFor = (id: string): Command | undefined => commandById.get(id) ?? templateCommandList().find((c) => c.id === id);

  const keyFor = (c: Command) => (c.key ? config().keys[c.key] : c.accel ?? "");

  /**
   * A native menu item fired. If the page just handled the same keystroke itself (the
   * editor's ⌘Z, a configured shortcut), the menu's copy of it is ignored so it can't run twice.
   */
  let lastKey: { e: KeyboardEvent; at: number } | null = null;
  const noteKey = (e: KeyboardEvent) => { lastKey = { e, at: Date.now() }; };
  // Keys the editor handled (its keymaps preventDefault); the app's own shortcuts call noteKey.
  const noteHandledKey = (e: KeyboardEvent) => { if (e.defaultPrevented) noteKey(e); };
  window.addEventListener("keydown", noteHandledKey);
  onCleanup(() => window.removeEventListener("keydown", noteHandledKey));
  function onMenu(id: string) {
    const c = commandFor(id);
    const spec = c ? keyFor(c) : "";
    if (spec && lastKey && Date.now() - lastKey.at < 300 && matchesKey(spec, lastKey.e)) return;
    runCommand(id);
  }

  /** Runs a command by id (menu bar, toolbar, right-click menus), explaining when it can't run here. */
  function runCommand(id: string) {
    if (id.startsWith("recent:")) return void openWorkspace(id.slice(7));
    const c = commandFor(id);
    if (!c) return;
    if (c.when && !c.when()) { say(`${c.label.replace(/…$/, "")} needs ${c.needs ?? "something open"}`, true); return; }
    void c.run();
  }

  const shortcut = (id: string) => {
    const c = commandFor(id);
    return c?.key ? formatKey(config().keys[c.key]) : c?.hint;
  };

  /** The native menu bar. Every item runs a command above; shortcuts follow the keys settings. */
  function menuSections(): MenuSection[] {
    const item = (id: string, label?: string): MenuEntry => {
      const c = commandFor(id)!;
      return { id, label: label ?? c.label, accelerator: toAccelerator(keyFor(c)) };
    };
    const recent: MenuEntry[] = recents().map((r) => ({ id: `recent:${r}`, label: r.replace(/^\/Users\/[^/]+/, "~") }));
    return [
      { label: "TeXdesk", items: [
        { native: "about" }, "separator",
        item("settings", "Settings…"), "separator",
        { native: "services" }, "separator",
        { native: "hide" }, { native: "hideOthers" }, { native: "showAll" }, "separator",
        { native: "quit" },
      ] },
      { label: "File", items: [
        item("new_file", "New File…"), item("new_folder", "New Folder…"), "separator",
        ...templateCommandList().map((c) => item(c.id)), ...(templateCommandList().length ? ["separator" as const] : []),
        item("open_folder", "Open Folder…"), item("open_file", "Open File…"), item("find_file", "Go to File…"),
        ...(recent.length ? [{ label: "Open Recent", submenu: recent }] : []), "separator",
        item("save"), "separator",
        item("rename_file", "Rename…"), item("trash_file", "Move to Trash"), item("reveal_file"), item("open_default_app", "Open in Default App"), "separator",
        item("close_tab", "Close Tab"), "separator",
        item("set_up", "Set Up TeXdesk in This Folder"), item("workspace_setup", "Folder Types and Templates…"), item("apply_starter", "Apply a Starter…"),
        item("upgrade_workspace", "Upgrade Workspace"), item("close_folder", "Close Folder"),
      ] },
      { label: "Edit", items: [
        item("undo"), item("redo"), "separator",
        { native: "cut" }, { native: "copy" }, { native: "paste" }, { native: "selectAll" }, "separator",
        item("find", "Find…"), item("replace", "Find and Replace…"), "separator",
        item("paste_as_code", "Paste as Code…"), item("paste_image", "Paste Image"), item("insert_link", "Insert Link…"),
        "separator", item("jump_out", "Jump Out"), item("bracket_size", "Cycle Bracket Size"),
      ] },
      { label: "View", items: [
        item("command_palette", "Command Palette…"), "separator",
        item("toggle_sidebar", "Show/Hide Sidebar"), item("toggle_pdf", "Show/Hide PDF"), item("split_right", "Split Editor Right"), "separator",
        item("toggle_math_preview", "Math Preview"), item("follow_edits", config().editor.followEdits ? "Stop PDF Following Editor" : "PDF Follows Editor"),
        item("snippet_debug", "Snippet Debug View"), "separator",
        { native: "fullscreen" },
      ] },
      { label: "Build", items: [
        item("show_in_pdf", "Show Cursor in PDF"), item("open_pdf", "Open PDF Externally"), "separator",
        item("save_pdf", "Save PDF As…"), item("unlink_pdf", "Stop Updating Saved PDF"), "separator",
        item("build_log", "Show Build Log"), "separator",
        item("fix_spelling", "Fix Previous Misspelling"),
      ] },
      { label: "Go", items: [item("find_file", "Go to File…"), item("find_in_files", "Search in Files…"), item("go_overview", "Go to Overview…"), item("folder_overview", "Overview of This Folder"), item("go_home", "Workspace Home Page"), item("follow_link", "Follow Link")] },
      { label: "Window", items: [{ native: "minimize" }, "separator", { native: "bringAllToFront" }] },
      { label: "Help", items: [item("show_tour", "Welcome Tour")] },
    ];
  }

  createEffect(() => {
    const sections = menuSections(); // re-runs when shortcuts or recent folders change
    host.setMenu(sections, onMenu).catch((err) => console.warn("[texdesk] menu:", err));
  });

  // ---- right-click menus ----------------------------------------------------------

  const [ctxMenu, setCtxMenu] = createSignal<{ x: number; y: number; items: ContextItem[] } | null>(null);

  /** A right-click menu entry for a command, disabled when it can't run here. */
  const cmdItem = (id: string, label?: string): ContextItem => {
    const c = commandFor(id)!;
    return { label: label ?? c.label, hint: shortcut(id), disabled: !!c.when && !c.when(), run: () => runCommand(id) };
  };

  async function copySelection(cut: boolean) {
    if (!view) return;
    const text = view.state.selection.ranges.filter((r) => !r.empty).map((r) => view!.state.sliceDoc(r.from, r.to)).join("\n");
    if (!text) return;
    try { await host.writeClipboardText(text); } catch (err) { fail(`Couldn't copy: ${String(err)}`); return; }
    if (cut) view.dispatch(view.state.replaceSelection(""), { userEvent: "delete.cut" });
    view.focus();
  }

  async function pasteText() {
    if (!view) return;
    let text = "";
    try { text = await host.readClipboardText(); } catch { /* maybe an image */ }
    if (!text) {
      if (isTex()) return pasteImageCommand();
      say("The clipboard is empty", true);
      return;
    }
    // "input.paste", so auto snippets don't fire on pasted text.
    view.dispatch(view.state.replaceSelection(text), { userEvent: "input.paste", scrollIntoView: true });
    view.focus();
  }

  async function onEditorContextMenu(e: MouseEvent, g: string) {
    e.preventDefault();
    if (viewDoc.get(g) !== path()) await focusText(g);
    const p = path();
    if (!view || !p || viewDoc.get(g) !== p) return;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    const sel = view.state.selection.main;
    // Like VS Code: right-clicking outside the selection moves the cursor there first.
    if (pos !== null && (sel.empty || pos < sel.from || pos > sel.to)) view.dispatch({ selection: { anchor: pos } });
    view.focus();
    const hasSelection = view.state.selection.ranges.some((r) => !r.empty);
    const link = isTex() && pos !== null ? linkAtPos(view, pos) : null;
    setCtxMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: "Cut", hint: "⌘X", disabled: !hasSelection, run: () => copySelection(true) },
        { label: "Copy", hint: "⌘C", disabled: !hasSelection, run: () => copySelection(false) },
        { label: "Paste", hint: "⌘V", run: pasteText },
        "separator",
        ...(isTex() ? [
          ...(link ? [{ label: `Follow Link (${link.target})`, hint: shortcut("follow_link"), run: () => followLink(link, p) }] : []),
          cmdItem("insert_link", "Insert Link…"),
          "separator" as const,
          cmdItem("paste_as_code", "Paste as Code…"),
          cmdItem("paste_image", "Paste Image"),
          "separator" as const,
          cmdItem("show_in_pdf", "Show in PDF"),
          "separator" as const,
        ] : []),
        cmdItem("command_palette", "Command Palette…"),
      ],
    });
  }

  /** Right-click inside a PDF tab. */
  /** Right-click inside a PDF tab, or (`tab` null) the PDF pane. */
  function onPdfMenu(tab: Tab | null, point: { page: number; x: number; y: number } | null, x: number, y: number) {
    const items: ContextItem[] = !tab ? [
      { label: "Jump to Source Here", hint: "⌘-click", disabled: !point || !outputPdf(), run: () => point && syncFromPdf(point.page, point.x, point.y) },
      cmdItem("show_in_pdf", "Show Cursor in PDF"),
      "separator",
      { label: "Open PDF Externally", run: openPdfExternally },
      cmdItem("save_pdf", "Save PDF As…"),
      "separator",
      cmdItem("toggle_pdf", "Hide PDF"),
    ] : [
      { label: "Open Externally", run: () => host.openExternal(tab.path!).catch(fail) },
      { label: "Reveal in Finder", run: () => host.openExternal(dirname(tab.path!)).catch(fail) },
      "separator",
      { label: "Close Tab", hint: shortcut("close_tab"), run: () => closeTab(tab.id) },
    ];
    setCtxMenu({ x, y, items });
  }

  /** Right-click on a tab. */
  function onTabMenu(tab: Tab, x: number, y: number) {
    const hit = findTab(layout(), (t) => t.id === tab.id);
    const group = hit?.group;
    setCtxMenu({
      x, y,
      items: [
        { label: "Close", hint: shortcut("close_tab"), run: () => closeTab(tab.id) },
        { label: "Close Others", disabled: !group || group.tabs.length < 2, run: () => closeTabs(others(layout(), tab.id, "others").map((t) => t.id)) },
        { label: "Close to the Right", disabled: !others(layout(), tab.id, "right").length, run: () => closeTabs(others(layout(), tab.id, "right").map((t) => t.id)) },
        "separator",
        { label: "Split Right", hint: shortcut("split_right"), disabled: !group || group.tabs.length < 2, run: () => splitTab(tab.id, "right") },
        { label: "Split Left", disabled: !group || group.tabs.length < 2, run: () => splitTab(tab.id, "left") },
        ...(tab.path ? [
          "separator" as const,
          { label: "Reveal in Finder", run: () => host.openExternal(dirname(tab.path!)).catch(fail) },
          { label: "Copy Path", run: () => host.writeClipboardText(tab.path!).catch(fail) },
        ] : []),
      ],
    });
  }

  /** Moves a tab into a new group beside its own. */
  async function splitTab(id: string, side: "left" | "right") {
    const hit = findTab(layout(), (t) => t.id === id);
    if (!hit) return;
    const where: Where = { group: hit.group.id, side };
    if (hit.tab.kind === "text") return showFile(hit.tab.path!, undefined, where);
    setLayout(placeSpec(hit.tab, where));
    await reconcile();
  }

  /** Saved ("linked") copies of the current document's PDF, as workspace-relative paths. */
  const savedCopies = () => {
    const r = root();
    const src = outputSource();
    if (!r || !src) return [];
    const rel = relative(r, src);
    return [...linkedCopies()].filter((pdf) => generated().get(pdf) === rel);
  };

  /** The group whose tab bar holds the build buttons: the current file's, else the focused one. */
  const actionGroup = () => {
    const cur = path();
    return (cur && findSpec(layout(), { kind: "text", path: cur })?.group.id) || layout().activeGroup;
  };

  /** The tab in front of the focused group (for ⌘W and Split). */
  const frontTab = () => { const g = groupById(layout(), layout().activeGroup); return g ? activeTab(g) : null; };

  function tabLabel(t: Tab): TabLabel {
    const r = root();
    const rel = (p: string) => (r && p.startsWith(r + "/") ? relative(r, p) : p);
    if (t.kind === "overview") {
      const home = t.path === r;
      return { name: basename(t.path!), detail: home ? "Home" : "Overview", title: home ? `${basename(r!)}: the workspace's home page` : `Overview of ${rel(t.path!)}` };
    }
    return { name: basename(t.path!), title: rel(t.path!), dirty: t.kind === "text" && t.path === path() && dirty() };
  }

  function renderPdf(tab: () => Tab | null, visible: () => boolean) {
    const t = tab();
    if (!t) return null;
    if (t.kind === "overview") return renderOverview(tab, visible);
    return (
      <PdfPane
        host={host}
        factory={props.viewerFactory ?? pdfjsViewer}
        pdf={tab()?.path ?? null}
        visible={visible()}
        anchors={pdfAnchors}
        emptyMessage="Couldn't open this PDF"
        onLink={followPdfLink}
        onContextMenu={(pt, x, y) => { const cur = tab(); if (cur) onPdfMenu(cur, pt, x, y); }}
      />
    );
  }

  async function commandPalette() {
    const cmd = await palette.pick({
      placeholder: "Run a command",
      items: [...commands, ...templateCommandList()].filter((c) => c.palette !== false && (!c.when || c.when())).map((c) => ({
        label: c.label, hint: c.key ? formatKey(config().keys[c.key]) : c.hint, key: c.label, value: c,
      })),
    });
    if (cmd) await cmd.run();
  }

  // ---- startup & shortcuts --------------------------------------------------------

  onMount(async () => {
    const handlers: [CommandId, () => unknown, () => boolean][] = [
      ["find_file", findFile, () => true],
      ["find_in_files", findInFiles, () => !!root()],
      ["command_palette", commandPalette, () => true],
      ["open_folder", openFolderDialog, () => true],
      ["open_file", openFileDialog, () => true],
      ["toggle_sidebar", toggleSidebar, () => true],
      ["toggle_pdf", togglePreview, () => true],
      ["show_in_pdf", showInPdf, () => true],
      ["paste_as_code", pasteAsCode, () => isTex() && !!view?.hasFocus],
      ["paste_image", pasteImageCommand, () => isTex() && !!view?.hasFocus],
      ["toggle_math_preview", toggleMathPreview, () => isTex()],
      ["settings", () => openSettings(), () => true],
      ["close_tab", () => runCommand("close_tab"), () => !!frontTab()],
      ["new_file", () => runCommand("new_file"), () => true],
      ["bracket_size", () => runCommand("bracket_size"), () => isTex() && !!view?.hasFocus],
      ["jump_out", () => runCommand("jump_out"), () => isTex() && !!view?.hasFocus],
      ["fix_spelling", () => runCommand("fix_spelling"), () => isTex()],
      ["split_right", () => runCommand("split_right"), () => !!frontTab()],
      ["follow_link", followLinkCommand, () => isTex() && !!view?.hasFocus],
      ["insert_link", insertLink, () => isTex() && !!view?.hasFocus],
      ["folder_overview", () => runCommand("folder_overview"), () => !!root()],
    ];
    const onKey = (e: KeyboardEvent) => {
      if (palette.state() || settingsOpen() || tour()) return; // the palette, Settings and the tour handle their own keys
      const keys = config().keys;
      for (const [id, fn, ok] of handlers) {
        if (keys[id] && matchesKey(keys[id], e) && ok()) {
          e.preventDefault();
          e.stopPropagation();
          noteKey(e);
          void fn();
          return;
        }
      }
      if (e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s" && !view?.hasFocus) { e.preventDefault(); void save(); }
    };
    window.addEventListener("keydown", onKey, true);
    const onBlur = () => void save();
    window.addEventListener("blur", onBlur);
    onCleanup(() => { window.removeEventListener("keydown", onKey, true); window.removeEventListener("blur", onBlur); });

    await startGlobal();
    try {
      const first = await host.initialFile();
      if (first) return await openPath(first);
      const last = prefs.get<string | null>("lastWorkspace", null);
      if (last && (await host.exists(last))) await openWorkspace(last);
    } catch (err) { fail(err); }
  });

  const buildLabel = () => {
    const b = build();
    const errors = b.diagnostics.filter((d) => d.severity === "error").length;
    const warnings = b.diagnostics.filter((d) => d.severity === "warning").length;
    const secs = b.durationMs !== undefined ? `${(b.durationMs / 1000).toFixed(1)}s` : "";
    const warn = warnings ? ` · ${warnings} warning${warnings === 1 ? "" : "s"}` : "";
    if (b.state === "running") return "Building…";
    if (b.state === "ok") return `✓ Built ${secs}${warn}`;
    return errors ? `✗ ${errors} error${errors === 1 ? "" : "s"}${warn}` : "✗ Build failed";
  };

  const snippetLabel = () => {
    const i = snippetInfo();
    return `${i.snippets} snippet${i.snippets === 1 ? "" : "s"}${i.keys ? ` · ${i.keys} key${i.keys === 1 ? "" : "s"}` : ""}`;
  };

  return (
    <div class="app">
      <div class="body">
        <Show when={root() && sidebar()}>
          <Sidebar
            width={sidebarWidth()}
            name={basename(root()!)}
            entries={entries()}
            active={path() && root() ? relative(root()!, path()!) : null}
            expanded={expanded()}
            generated={generated()}
            linked={linkedCopies()}
            backlinks={backlinks().map((b) => ({ ...b, rel: relative(root()!, b.file) }))}
            onOpenBacklink={(file, line) => void openAtLine(file, line)}
            onToggle={(p) => {
              const next = new Set(expanded());
              if (next.has(p)) next.delete(p); else next.add(p);
              setExpanded(next);
              prefs.set(`expanded:${root()}`, [...next]);
            }}
            onExpand={(p) => reveal(p)}
            onOpen={(p) => void openPath(join(root()!, p))}
            onCreate={createEntry}
            onNewFile={(dir) => void newFile(dir)}
            onRename={renameEntry}
            onMove={(p, dir) => void moveEntry(p, dir)}
            onDelete={(p) => void deleteEntry(p)}
            onReveal={(p) => void revealInFinder(p)}
            folderItems={folderItems}
            onOverview={(dir, preview) => void openOverview(dir ? join(root()!, dir) : root()!, { preview })}
            folderClick={config().folderClick}
            onHome={() => void openOverview(root()!)}
            pinned={pinned().filter((p) => dirSet().has(p))}
            onPin={pinFolder}
            plugin={pluginPanel()}
            search={{ search: searchWorkspace, rel: (p) => relative(root()!, p), onOpen: (h, focus) => void openSearchHit(h, focus) }}
            onCloseSearch={closeSearch}
            ref={(api) => (sidebarApi = api)}
          />
          <div
            class="sidebar-splitter" title="Drag to resize; double-click to reset"
            onMouseDown={startSidebarResize}
            onDblClick={() => { setSidebarWidth(SIDEBAR_WIDTH); prefs.set("sidebarWidth", SIDEBAR_WIDTH); }}
          />
        </Show>
        <main class="editor-pane">
          <Workbench
            layout={layout()}
            label={tabLabel}
            renderPdf={renderPdf}
            mountEditor={mountEditor}
            unmountEditor={unmountEditor}
            onActivate={(id) => void activateTab(id)}
            onClose={(id) => void closeTab(id)}
            onKeep={keepOpen}
            onFocusGroup={(g) => { if (layout().activeGroup !== g) setLayout({ ...layout(), activeGroup: g }); }}
            onDrop={(t) => void onDrop(t)}
            onTabMenu={onTabMenu}
            onResize={(sizes) => setLayout(resize(layout(), sizes))}
            leading={(g) => (
              <Show when={root() && g === layout().groups[0]?.id}>
                <button class={`tb-btn ${sidebar() ? "on" : ""}`} title={`Show/hide sidebar (${shortcut("toggle_sidebar")})`} onClick={() => runCommand("toggle_sidebar")}>
                  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><path d="M6 2.5v11" /></svg>
                </button>
              </Show>
            )}
            actions={(g) => (
              // Build actions sit at the end of the tab bar of the group with the current file.
              <Show when={g === actionGroup()}>
                <Show when={isTex() && path()}>
                  <button
                    class={`tb-btn tb-save-pdf ${savedCopies().length ? "on" : ""}`}
                    title={savedCopies().length
                      ? `Save PDF as… — already saved to ${savedCopies().join(", ")} (updated on every build)`
                      : "Save PDF as… — a copy that updates on every build"}
                    onClick={() => runCommand("save_pdf")}
                  >
                    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M8 2v8M4.5 6.5 8 10l3.5-3.5" /><path d="M2.5 11v2.5h11V11" /></svg>
                  </button>
                  <button class="tb-btn" title={`Show the cursor's line in the PDF (${shortcut("show_in_pdf")})`} onClick={() => runCommand("show_in_pdf")}>
                    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="1.6" fill="currentColor" /></svg>
                  </button>
                </Show>
                <Show when={root()}>
                  <button class="tb-btn tb-overview" title={`Overview of this folder (${shortcut("folder_overview")}) — the nearest class, project…`} onClick={() => runCommand("folder_overview")}>
                    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M2.5 3.5h11M2.5 7h7M2.5 10h7M2.5 13h7" /></svg>
                  </button>
                </Show>
                <button class={`tb-btn tb-pdf ${pdfShown() ? "on" : ""}`} title={`Show/hide the PDF (${shortcut("toggle_pdf")})`} onClick={() => runCommand("toggle_pdf")}>
                  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><path d="M10 2.5v11" /></svg>
                  <span>PDF</span>
                </button>
              </Show>
            )}
            empty={() => (
              <Show
                when={root()}
                fallback={
                  <div class="welcome">
                    <h1>TeXdesk</h1>
                    <p class="welcome-text">Write LaTeX in plain files, in folders on your Mac, with the PDF beside you. Open a folder to start — TeXdesk can set it up for you, and nothing in it changes unless you ask.</p>
                    <div class="welcome-actions">
                      <button class="primary" onClick={openFolderDialog}>Open folder… <kbd>⌘⇧O</kbd></button>
                      <button onClick={openFileDialog}>Open file… <kbd>⌘O</kbd></button>
                    </div>
                    <Show when={recents().length}>
                      <div class="recents">
                        <div class="recents-title">Recent</div>
                        <For each={recents()}>
                          {(r) => (
                            <button class="recent" onClick={() => void openWorkspace(r)} title={r}>
                              <span>{basename(r)}</span><span class="recent-path">{dirname(r)}</span>
                            </button>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                }
              >
                <div class="hints">
                  <div><kbd>{shortcut("new_file")}</kbd> new file — from a template, or blank</div>
                  <div><kbd>{shortcut("find_file")}</kbd> find a file or folder</div>
                  <div><kbd>{shortcut("command_palette")}</kbd> commands — including “New …” for your templates and folder types</div>
                  <div><kbd>⌘S</kbd> save — a full document (with \documentclass) also builds</div>
                  <div><kbd>{shortcut("toggle_pdf")}</kbd> show/hide the PDF</div>
                  <div><kbd>{shortcut("settings")}</kbd> settings — Workspace sets up folder types and templates; Plugins adds snippets</div>
                  <div>Drag files from the sidebar here; drag tabs to the edge of a group to split it</div>
                  <div><button class="set-link" onClick={() => setTour(true)}>Take the welcome tour</button></div>
                </div>
              </Show>
            )}
          />
        </main>
        {/* The open document's PDF. Hidden, not removed, so it keeps its place. */}
        <div
          class="pdf-splitter" title="Drag to resize; double-click to reset"
          style={{ display: pdfVisible() ? "" : "none" }}
          onMouseDown={startPdfResize}
          onDblClick={() => { setPdfWidth(clampPdf(pdfDefaultWidth())); prefs.set("pdfWidth", pdfWidth()); }}
        />
        <aside class="pdf-side" style={{ width: `${pdfWidth()}px`, display: pdfVisible() ? "" : "none" }}>
          <PdfPane
            host={host}
            factory={props.viewerFactory ?? pdfjsViewer}
            pdf={outputPdf()}
            version={outputVersion()}
            visible={pdfVisible()}
            anchors={pdfAnchors}
            emptyMessage="The PDF shows here once the document builds"
            onSync={(p, x, y) => void syncFromPdf(p, x, y)}
            onLink={followPdfLink}
            onContextMenu={(pt, x, y) => onPdfMenu(null, pt, x, y)}
            api={(a) => (outputApi = a)}
            follow={{ on: config().editor.followEdits, toggle: () => void toggleFollowEdits() }}
          />
        </aside>
      </div>

      <Show when={debug() && isTex() && path()}>
        <DebugPanel mode={mode()} env={env()} log={lastLog()} onClose={() => setDebug(false)} />
      </Show>

      <Show when={showBuild() && build().file}>
        <div class="buildpanel">
          <div class="debug-head">
            <span class="debug-title">Build</span>
            <span>{build().file ? relative(root() ?? "", build().file!) : ""}</span>
            <span class="spacer" />
            <button class="debug-close" onClick={() => void showBuildLog()} title="Open the full log">log</button>
            <button class="debug-close" onClick={() => setShowBuild(false)} title="Close">×</button>
          </div>
          <div class="debug-body">
            <Show when={build().summary}><div class="build-summary">{build().summary}</div></Show>
            <Show when={build().state === "failed" && fixNote()}>
              {(f) => (
                <div class="fix-note">
                  <span class="fix-label">Fix</span>
                  <span class="fix-text">{f().explanation}</span>
                  <div class="fix-row">
                    <div class="fix-diff"><span class="fix-old">{f().line}: {f().original.trim()}</span><span class="fix-new">{f().line}: {f().replacement.trim()}</span></div>
                    <button class="fix-apply" onClick={() => applyFix(f())}>Apply fix</button>
                  </div>
                </div>
              )}
            </Show>
            <Show when={!build().diagnostics.length && !build().summary}><div class="debug-empty">No errors or warnings.</div></Show>
            <For each={build().diagnostics}>
              {(d) => (
                <div class={`build-diag diag-${d.severity}`} onClick={() => void jumpTo(d.file, d.line)}>
                  <span class="diag-loc">{d.file ?? ""}{d.line ? `:${d.line}` : ""}</span>
                  <span class="diag-msg">{d.message}</span>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      <Show when={showProblems() && problems().length}>
        <div class="problems">
          <For each={problems()}>
            {(p) => (
              <div class={`problem problem-${p.kind}`}>
                <span class="problem-file">{p.file}</span>
                <Show when={p.label}><span class="problem-label">{p.label}</span></Show>
                <span class="problem-msg">{p.message}</span>
              </div>
            )}
          </For>
        </div>
      </Show>

      <footer class="status">
        <span class="status-file" title={path() ?? root() ?? ""}>
          <Show when={crumbs().length} fallback={root() ? basename(root()!) : "TeXdesk"}>
            <For each={crumbs()}>
              {(c, i) => (
                <>
                  {i() > 0 ? " / " : ""}
                  {c.dir
                    ? <button class="status-crumb" title={`Overview of ${c.label}`} onClick={() => void openOverview(c.dir!)}>{c.label}</button>
                    : c.label}
                </>
              )}
            </For>
          </Show>
          <Show when={dirty()}><span class="dirty" title="Unsaved changes">●</span></Show>
        </span>
        <Show when={message()}>
          {(m) => <span class={`status-msg ${m().error ? "error" : ""}`}>{m().text}</span>}
        </Show>
        <span class="spacer" />
        <Show when={build().state !== "idle"}>
          <button class={`buildstatus build-${build().state}`} onClick={() => setShowBuild(!showBuild())} title="Build output">
            {buildLabel()}
          </button>
        </Show>
        <Show when={isTex() && path()}>
          <span class={`mode mode-${mode()}`} title={env().join(" › ") || "no environment"}>
            {MODE_LABEL[mode()]}
            <Show when={env().length}><span class="env">{env()[env().length - 1]}</span></Show>
          </span>
          <button
            class={`snippets ${problems().some((p) => p.kind !== "slow") ? "has-errors" : problems().length ? "has-warnings" : ""}`}
            onClick={() => setShowProblems(!showProblems())}
            title={`Snippets from ${plugins().filter((p) => p.enabled).map((p) => p.name).join(", ") || "no plugins"} — Settings → Plugins`}
          >
            {snippetLabel()}
            <Show when={problems().length}><span class="count">⚠ {problems().length}</span></Show>
          </button>
        </Show>
      </footer>

      <Show when={ctxMenu()}>
        {(m) => <ContextMenu x={m().x} y={m().y} items={m().items} onClose={() => setCtxMenu(null)} />}
      </Show>

      <Show when={settingsOpen()}>
        {(section) => (
          <SettingsView
            config={config}
            globalConfig={globalConfig}
            workspaceSettings={() => (root() && hasTexdesk() ? ws().settings : null)}
            canSaveGlobal={() => !!globalRoot}
            initialSection={section()}
            onChange={(scope, table, key, value) => void saveSetting(scope, table, key, value)}
            commands={commands.filter((c) => c.key).map((c) => ({ id: c.key!, label: c.label }))}
            plugins={{
              plugins,
              problems,
              counts: (id) => {
                const set = runtime.set;
                snippetInfo(); // re-read when snippets reload
                const mine = (x: { file: string }) => x.file.startsWith(`${id}/`);
                return { snippets: set.snippets.filter(mine).length, keys: set.keys.filter(mine).length };
              },
              workspaceSetting: (id) => (root() && hasTexdesk() ? ((ws().settings.plugins ?? {}) as Record<string, boolean>)[id] : undefined),
              globalSetting: (id) => globalConfig().plugins[id],
              hasWorkspace: () => !!root() && hasTexdesk(),
              trust,
              onTrust: (on) => void setTrust(on),
              onToggle: (id, on, scope) => void saveSetting(scope, "plugins", id, on),
              onOpen: (p, file) => void openPlugin(p, file),
              onReveal: (p) => void host.openExternal(p.dir!).catch(fail),
              onDuplicate: (p) => void duplicatePlugin(p),
              onDelete: (p) => void deletePlugin(p),
              onNew: (where) => void newPluginCommand(where),
              onImport: () => void importLatexSuite(),
              onReload: () => void restartSnippets().then(() => say("Plugins reloaded")),
            }}
            workspace={() => (root() && hasTexdesk() ? {
              ws, errors: wsErrors,
              update: updateWorkspace,
              renameType: renameTypeEverywhere,
              renameField: renameFieldEverywhere,
              folderCount: (k) => foldersOfType(ws(), k).length,
              editBody: (k) => void editTemplateBody(k),
              newTemplate,
              renameBody: renameTemplateBody,
              examplePath: (k) => { void examples(); return examples()[k] ?? null; },
              exampleName,
              applyStarter: () => void applyStarterCommand(),
              openFile: () => { setSettingsOpen(null); void openPath(workspaceFile(root()!)); },
              confirm: async (title, yes) => !!(await palette.pick({ title, placeholder: "Choose…", items: [{ label: yes, value: true }, { label: "Cancel", value: false }] })),
            } : null)}
            onOpenSettingsFile={(scope) => {
              setSettingsOpen(null);
              if (scope === "workspace" && root()) void openPath(workspaceFile(root()!));
              else if (globalRoot) {
                const f = join(globalRoot, GLOBAL_SETTINGS);
                void (async () => { if (!(await host.exists(f))) await host.createText(f, "{}\n"); await openPath(f); })();
              }
            }}
            onClose={() => { setSettingsOpen(null); view?.focus(); }}
          />
        )}
      </Show>
      <Show when={tour()}>
        <Tour
          steps={tourSteps({ hasTypes: Object.keys(ws().folderTypes).length > 0, shortcut: (id) => shortcut(id) ?? "" })}
          onDone={() => { setTour(false); prefs.set("tourDone", true); view?.focus(); }}
        />
      </Show>
      <PaletteView palette={palette} />
    </div>
  );
}
