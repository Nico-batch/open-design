import { render } from "preact";
import { App } from "./app";
import { installEmojiFontFallback } from "./lib/fonts";
import "./fonts.css";
import "./styles.css";

// Antes de que exista ningún canvas: parchea cómo Fabric construye la fuente del
// contexto para que los emojis tengan su propia familia de respaldo (ver lib/fonts.ts).
installEmojiFontFallback();

render(<App />, document.getElementById("app")!);
