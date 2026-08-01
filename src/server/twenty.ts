const TWENTY_API_URL = process.env.TWENTY_API_URL;
const TWENTY_TOKEN = process.env.TWENTY_TOKEN;

async function twentyGraphQL<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  if (!TWENTY_API_URL || !TWENTY_TOKEN) {
    throw new Error("TWENTY_API_URL/TWENTY_TOKEN no configurados en el servidor");
  }
  let res: Response;
  try {
    res = await fetch(`${TWENTY_API_URL}/graphql`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TWENTY_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      // Sin esto, una Twenty lenta/caída deja la request del navegador colgada
      // indefinidamente (nuestro handler nunca responde) en vez de fallar rápido con un
      // 502 explicable — un timeout intermedio (proxy de Vite en dev, Traefik en prod)
      // acabaría cortando la conexión igualmente, pero como un fallo de red genérico
      // ("Failed to fetch" en el cliente) sin ninguna pista de la causa real.
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") {
      throw new Error("Twenty no respondió a tiempo (timeout de 15s)");
    }
    throw new Error(`No se pudo conectar con Twenty: ${e instanceof Error ? e.message : String(e)}`);
  }
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(`Twenty GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  return json.data as T;
}

export interface TwentyNews {
  id: string;
  title: string | null;
  imageUrl: string | null;
}

const GET_NEWS_QUERY = `
  query GetNews($id: UUID!) {
    news(filter: { id: { eq: $id } }) {
      id
      title { markdown }
      imagen { fileId label url }
    }
  }
`;

export async function fetchNews(id: string): Promise<TwentyNews | null> {
  const data = await twentyGraphQL<{
    news: {
      id: string;
      title: { markdown: string | null } | null;
      imagen: Array<{ fileId: string; label: string; url: string | null }> | null;
    } | null;
  }>(GET_NEWS_QUERY, { id });

  if (!data.news) return null;
  return {
    id: data.news.id,
    title: data.news.title?.markdown?.trim() || null,
    imageUrl: data.news.imagen?.[0]?.url || null,
  };
}

const SET_IMAGEN_EDITADA_MUTATION = `
  mutation SetImagenEditada($id: UUID!, $url: String!, $label: String!) {
    updateNews(id: $id, data: { imagenEditada: { primaryLinkUrl: $url, primaryLinkLabel: $label } }) {
      id
    }
  }
`;

export async function setNewsEditedImage(id: string, publicUrl: string, label: string): Promise<void> {
  await twentyGraphQL(SET_IMAGEN_EDITADA_MUTATION, { id, url: publicUrl, label });
}
