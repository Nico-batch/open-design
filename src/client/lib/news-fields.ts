import type { NewsFields } from "../types";

/**
 * De los campos crudos de una noticia de Twenty al texto que se pinta en el post.
 *
 * Es el equivalente de `event-fields.ts` para las noticias, y sale mucho más corto porque
 * una noticia solo aporta dos cosas al diseño: el titular y la sección. No hay fechas que
 * formatear (el pie no las lleva) ni campos que combinar.
 */

/**
 * Etiqueta del chip para cada valor del enum `categoria`.
 *
 * Son **exactamente cuatro** —comprobado por introspección contra la instancia— y el enum
 * viene sin tildes, así que la tabla no es solo cosmética: `EDUCACION` tiene que salir como
 * «EDUCACIÓN» en el post. Un valor que no esté aquí devuelve `null` y el chip no se crea, en
 * vez de estampar el identificador crudo del enum sobre la imagen.
 *
 * Ojo: **no existe una sección "Sucesos"**, así que el rojo `#b3261e` de la guía de marca no
 * tiene ningún valor al que aplicarse. Si algún día se añade, es una entrada aquí y otra en
 * la tabla de colores del chip (`news-template.ts`).
 */
export const SECTION_LABELS: Record<string, string> = {
  ACTUALIDAD: "ACTUALIDAD",
  DEPORTE: "DEPORTE",
  CULTURA: "CULTURA",
  EDUCACION: "EDUCACIÓN",
};

/**
 * La cuenta del pie. Es una constante del código y no un campo del CRM: es la misma en todos
 * los posts, y el cuadro de texto que la pinta es editable en el lienzo como cualquier otro
 * si algún post necesita otra.
 */
export const ACCOUNT_HANDLE = "@elfarodealicante";

/** Los textos ya listos para el lienzo. `null` = ese bloque no se crea. */
export interface NewsCopy {
  seccion: string | null;
  titular: string;
  /** La cifra destacada. No sale del CRM: la escribe el operador en el panel. */
  dato: string | null;
  datoUnidad: string | null;
}

export function buildNewsCopy(
  fields: NewsFields | null,
  title: string,
  dato?: { valor: string | null; unidad: string | null }
): NewsCopy {
  const seccion = fields?.categoria ? SECTION_LABELS[fields.categoria] ?? null : null;
  const valor = dato?.valor?.trim() || null;
  return {
    seccion,
    // El titular se pinta tal cual viene del CRM: ya está en sentence case, y el diseño
    // prohíbe expresamente los titulares en mayúsculas (al contrario que la plantilla de
    // eventos, donde el titular sí va en caja alta).
    titular: title.trim(),
    dato: valor,
    // La unidad sin cifra no dice nada, así que se descarta con ella.
    datoUnidad: valor ? dato?.unidad?.trim() || null : null,
  };
}
