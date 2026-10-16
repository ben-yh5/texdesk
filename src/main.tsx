import { render } from "solid-js/web";
import { App } from "./app/App";
import { devHost } from "./host/dev";
import { tauriHost } from "./host/tauri";
import "./app/styles.css";

const inTauri = "__TAURI_INTERNALS__" in window;
render(() => <App host={inTauri ? tauriHost() : devHost()} />, document.getElementById("root")!);
