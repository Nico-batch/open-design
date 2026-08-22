CREATE TABLE IF NOT EXISTS designs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6)))),
  name TEXT DEFAULT 'Untitled Design',
  canvas_json TEXT DEFAULT '{}',
  width INTEGER DEFAULT 1080,
  height INTEGER DEFAULT 1350,
  thumbnail_url TEXT,
  twenty_record_id TEXT,
  twenty_object_type TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Un diseño por registro de Twenty, pero la clave es (objeto, registro): el mismo editor
-- sirve a varios objetos del CRM (News, Events) y la unicidad tiene que ser por par, no
-- solo por id. COALESCE porque los diseños creados antes del soporte multi-objeto tienen
-- el tipo a NULL y son, por definición, de News.
CREATE UNIQUE INDEX IF NOT EXISTS idx_designs_twenty_record
  ON designs(COALESCE(twenty_object_type, 'news'), twenty_record_id)
  WHERE twenty_record_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  canvas_json TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  thumbnail_url TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6)))),
  design_id TEXT NOT NULL,
  title TEXT DEFAULT 'Page 1',
  canvas_json TEXT DEFAULT '{}',
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (design_id) REFERENCES designs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pages_design ON pages(design_id);

CREATE INDEX IF NOT EXISTS idx_templates_category ON templates(category);
