import { render } from "preact";
import { App } from "./app";
import { installEmojiFontFallback } from "./lib/fonts";
import { installTextareaHost } from "./lib/workspace";
import "./fonts.css";
import "./styles.css";

// Antes de que exista ningún canvas: parchea cómo Fabric construye la fuente del
// contexto para que los emojis tengan su propia familia de respaldo (ver lib/fonts.ts).
installEmojiFontFallback();

// También antes de que exista ningún canvas: da a Fabric un contenedor propio donde dejar
// su textarea oculto, para que enfocarlo no desplace la interfaz entera (ver lib/workspace.ts).
installTextareaHost();

render(<App />, document.getElementById("app")!);
