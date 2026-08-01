import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, "..", "..", "data.db");

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec(readFileSync(join(__dirname, "schema.sql"), "utf8"));

// ── Migraciones de bases de datos ya existentes ─────────────────────
//
// schema.sql es idempotente (CREATE ... IF NOT EXISTS), lo que sirve para crear la base
// desde cero pero NO para cambiar algo que ya existe: una columna nueva no aparece en una
// tabla ya creada, y un índice que cambia de definición se ignora en silencio porque su
// nombre ya está tomado. Estas dos migraciones cubren justo eso para el soporte
// multi-objeto de Twenty (News + Events).
function migrate() {
  const columns = db.prepare("PRAGMA table_info(designs)").all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === "twenty_object_type")) {
    db.exec("ALTER TABLE designs ADD COLUMN twenty_object_type TEXT");
  }

  // El índice antiguo era único solo por twenty_record_id; ahora la clave es
  // (objeto, registro). Se detecta por su SQL en lugar de por un número de versión: si no
  // menciona la columna nueva, es el viejo y hay que rehacerlo.
  const idx = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_designs_twenty_record'")
    .get() as { sql: string | null } | undefined;
  if (idx && !(idx.sql ?? "").includes("twenty_object_type")) {
    db.exec("DROP INDEX idx_designs_twenty_record");
    db.exec(
      "CREATE UNIQUE INDEX idx_designs_twenty_record " +
        "ON designs(COALESCE(twenty_object_type, 'news'), twenty_record_id) " +
        "WHERE twenty_record_id IS NOT NULL"
    );
  }
}
migrate();

export async function query<T>(sql: string, params: any[] = []): Promise<T[]> {
  return db.prepare(sql).all(...params) as T[];
}

export async function get<T>(sql: string, params: any[] = []): Promise<T | undefined> {
  return db.prepare(sql).get(...params) as T | undefined;
}

export async function run(
  sql: string,
  params: any[] = []
): Promise<{ changes: number; lastInsertRowid: number }> {
  const info = db.prepare(sql).run(...params);
  return { changes: Number(info.changes), lastInsertRowid: Number(info.lastInsertRowid) };
}
