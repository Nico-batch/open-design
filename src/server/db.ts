import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, "..", "..", "data.db");

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec(readFileSync(join(__dirname, "schema.sql"), "utf8"));

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
