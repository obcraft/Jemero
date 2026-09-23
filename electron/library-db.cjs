// The component library, in SQLite (node:sqlite, built into Electron's Node).
//
//   items     one row per component, block or section
//   versions  every saved version of it
//   files     every file of every version
//   turns     the conversation that shaped it
//   drafts    files as the model writes them, saved live, so a crash, a
//             cut-off answer or a quit mid-generation never loses what was
//             already written. Cleared when the version is saved.
//
// WAL mode: each write is durable as soon as it returns, and a reader never
// waits on a writer. The renderer still sees one library object (lib/
// library.ts); save() stores it in one transaction.
const fs = require('node:fs')
const path = require('node:path')

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS versions (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  entry TEXT NOT NULL,
  kit TEXT NOT NULL,
  packs_json TEXT,
  plan TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, n)
);
CREATE TABLE IF NOT EXISTS files (
  item_id TEXT NOT NULL,
  version_n INTEGER NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  PRIMARY KEY (item_id, version_n, path),
  FOREIGN KEY (item_id, version_n) REFERENCES versions(item_id, n) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS turns (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  role TEXT NOT NULL,
  mode TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  plan TEXT,
  review_json TEXT,
  version INTEGER,
  error TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (item_id, seq)
);
CREATE TABLE IF NOT EXISTS drafts (
  item_id TEXT NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  complete INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, path)
);
`

function openLibrary(dir) {
  const { DatabaseSync } = require('node:sqlite')
  fs.mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(path.join(dir, 'jemero.db'))
  db.exec(SCHEMA)

  const q = {
    items: db.prepare('SELECT * FROM items ORDER BY position'),
    versions: db.prepare('SELECT * FROM versions WHERE item_id = ? ORDER BY n'),
    files: db.prepare('SELECT path, content FROM files WHERE item_id = ? AND version_n = ? ORDER BY rowid'),
    turns: db.prepare('SELECT * FROM turns WHERE item_id = ? ORDER BY seq'),
    upsertItem: db.prepare(
      `INSERT INTO items (id, name, kind, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, position = excluded.position,
         updated_at = excluded.updated_at`,
    ),
    upsertVersion: db.prepare(
      `INSERT INTO versions (item_id, n, entry, kit, packs_json, plan, prompt, mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(item_id, n) DO UPDATE SET entry = excluded.entry, kit = excluded.kit, packs_json = excluded.packs_json,
         plan = excluded.plan, prompt = excluded.prompt, mode = excluded.mode`,
    ),
    upsertFile: db.prepare(
      `INSERT INTO files (item_id, version_n, path, content) VALUES (?, ?, ?, ?)
       ON CONFLICT(item_id, version_n, path) DO UPDATE SET content = excluded.content WHERE content <> excluded.content`,
    ),
    upsertTurn: db.prepare(
      `INSERT INTO turns (item_id, seq, id, role, mode, text, plan, review_json, version, error, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(item_id, seq) DO UPDATE SET id = excluded.id, role = excluded.role, mode = excluded.mode, text = excluded.text,
         plan = excluded.plan, review_json = excluded.review_json, version = excluded.version, error = excluded.error, at = excluded.at`,
    ),
    itemIds: db.prepare('SELECT id FROM items'),
    deleteItem: db.prepare('DELETE FROM items WHERE id = ?'),
    deleteVersionsFrom: db.prepare('DELETE FROM versions WHERE item_id = ? AND n > ?'),
    deleteTurnsFrom: db.prepare('DELETE FROM turns WHERE item_id = ? AND seq >= ?'),
    filePaths: db.prepare('SELECT path FROM files WHERE item_id = ? AND version_n = ?'),
    deleteFile: db.prepare('DELETE FROM files WHERE item_id = ? AND version_n = ? AND path = ?'),
    upsertDraft: db.prepare(
      `INSERT INTO drafts (item_id, path, content, complete, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(item_id, path) DO UPDATE SET content = excluded.content, complete = excluded.complete, updated_at = excluded.updated_at`,
    ),
    drafts: db.prepare('SELECT path, content, complete, updated_at FROM drafts WHERE item_id = ? ORDER BY rowid'),
    allDrafts: db.prepare('SELECT DISTINCT item_id FROM drafts'),
    clearDraft: db.prepare('DELETE FROM drafts WHERE item_id = ?'),
    count: db.prepare('SELECT count(*) AS c FROM items'),
  }

  const tx = (fn) => {
    db.exec('BEGIN')
    try {
      const out = fn()
      db.exec('COMMIT')
      return out
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  /** The whole library, in the shape lib/library.ts uses. */
  function load() {
    const items = q.items.all().map((it) => ({
      id: it.id,
      name: it.name,
      kind: it.kind,
      createdAt: it.created_at,
      updatedAt: it.updated_at,
      versions: q.versions.all(it.id).map((v) => ({
        files: Object.fromEntries(q.files.all(it.id, v.n).map((f) => [f.path, f.content])),
        entry: v.entry,
        kit: v.kit,
        ...(v.packs_json ? { packs: JSON.parse(v.packs_json) } : {}),
        plan: v.plan,
        prompt: v.prompt,
        mode: v.mode,
        createdAt: v.created_at,
      })),
      turns: q.turns.all(it.id).map((t) => ({
        id: t.id,
        role: t.role,
        mode: t.mode,
        text: t.text,
        ...(t.plan != null ? { plan: t.plan } : {}),
        ...(t.review_json != null ? { review: JSON.parse(t.review_json) } : {}),
        ...(t.version != null ? { version: t.version } : {}),
        ...(t.error != null ? { error: t.error } : {}),
        at: t.at,
      })),
    }))
    return { version: 1, items }
  }

  /** Store the library as given: upserts, and deletes whatever it no longer has. */
  function save(library) {
    const items = Array.isArray(library?.items) ? library.items : []
    tx(() => {
      const keep = new Set(items.map((i) => i.id))
      for (const { id } of q.itemIds.all()) if (!keep.has(id)) q.deleteItem.run(id)
      items.forEach((it, position) => {
        q.upsertItem.run(it.id, it.name ?? '', it.kind ?? 'component', position, it.createdAt ?? Date.now(), it.updatedAt ?? Date.now())
        const versions = it.versions ?? []
        versions.forEach((v, i) => {
          const n = i + 1
          q.upsertVersion.run(it.id, n, v.entry ?? '', v.kit ?? 'shadcn', v.packs ? JSON.stringify(v.packs) : null, v.plan ?? '', v.prompt ?? '', v.mode ?? 'build', v.createdAt ?? Date.now())
          const files = v.files ?? {}
          for (const [p, content] of Object.entries(files)) q.upsertFile.run(it.id, n, p, String(content))
          for (const { path: p } of q.filePaths.all(it.id, n)) if (!(p in files)) q.deleteFile.run(it.id, n, p)
        })
        q.deleteVersionsFrom.run(it.id, versions.length)
        const turns = it.turns ?? []
        turns.forEach((t, seq) =>
          q.upsertTurn.run(
            it.id,
            seq,
            t.id ?? `${it.id}-${seq}`,
            t.role,
            t.mode ?? 'build',
            t.text ?? '',
            t.plan ?? null,
            t.review ? JSON.stringify(t.review) : null,
            t.version ?? null,
            t.error ?? null,
            t.at ?? Date.now(),
          ),
        )
        q.deleteTurnsFrom.run(it.id, turns.length)
      })
    })
  }

  /** Files as they're being written, one row per file, replaced on every update. */
  function saveDraft(itemId, files) {
    const now = Date.now()
    tx(() => {
      for (const f of files) q.upsertDraft.run(itemId, f.path, f.content ?? '', f.complete ? 1 : 0, now)
    })
  }

  function draft(itemId) {
    return q.drafts.all(itemId).map((d) => ({ path: d.path, content: d.content, complete: !!d.complete, updatedAt: d.updated_at }))
  }

  /** Every item with an unfinished draft, for "continue where it stopped". */
  function drafts() {
    return Object.fromEntries(q.allDrafts.all().map(({ item_id }) => [item_id, draft(item_id)]))
  }

  function clearDraft(itemId) {
    q.clearDraft.run(itemId)
  }

  /**
   * First launch with SQLite: bring the old library.json across once, and keep
   * the file (renamed) as a backup.
   */
  function migrateFromJson(file) {
    if (q.count.get().c > 0 || !fs.existsSync(file)) return false
    const library = JSON.parse(fs.readFileSync(file, 'utf8'))
    save(library)
    fs.renameSync(file, `${file}.migrated`)
    return true
  }

  return { load, save, saveDraft, draft, drafts, clearDraft, migrateFromJson, close: () => db.close() }
}

module.exports = { openLibrary }
