/**
 * Los colores de El Faro, en un solo sitio.
 *
 * Estaban duplicados como constantes locales en las dos plantillas (`news-template.ts` y
 * `event-template.ts`), que es exactamente el tipo de dato que no puede vivir en dos ficheros:
 * un retoque de marca tendría que acordarse de los dos. Desde aquí los usan además las muestras
 * de los selectores de color del editor, así que el operador puede aplicar el ámbar a una
 * palabra sin teclear el hexadecimal.
 */

export const BRAND = {
  /** Azul noche. Fondo de franja, tinta sobre crema. */
  navy: "#0a2540",
  /** Ámbar. Chip, cifra destacada. **Nunca sobre crema**: se queda en ~2.5:1 de contraste. */
  amber: "#f4a825",
  /** Crema. Tinta sobre azul noche, franja de la variante clara. */
  cream: "#fbf7f0",
} as const;

/**
 * Las muestras que acompañan a cada selector de color del editor.
 *
 * Los tres primeros son la marca; blanco y negro son los extremos que siempre hacen falta; y
 * los tres últimos son colores de **marcado** —para destacar una palabra dentro de un titular—
 * elegidos con la saturación apagada del azul noche para que no desentonen con él. El rojo es
 * el `#b3261e` que la guía reservaba para una sección "Sucesos" que el CRM nunca llegó a tener.
 */
export const COLOR_PRESETS: { hex: string; label: string }[] = [
  { hex: BRAND.navy, label: "Azul noche (marca)" },
  { hex: BRAND.amber, label: "Ámbar (marca)" },
  { hex: BRAND.cream, label: "Crema (marca)" },
  { hex: "#ffffff", label: "Blanco" },
  { hex: "#000000", label: "Negro" },
  { hex: "#b3261e", label: "Rojo de marcado" },
  { hex: "#1e7d4f", label: "Verde de marcado" },
  { hex: "#2f6d9e", label: "Azul de marcado" },
];
