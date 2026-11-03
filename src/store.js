import { DatabaseSync } from 'node:sqlite';

const MIN_BIN_LENGTH = 6;
const HISTORY_LIMIT = 100;
const QUOTA_KEY = 'quota';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS bins (
    key TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    cached_at INTEGER NOT NULL,
    viewed_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS bins_viewed_at ON bins (viewed_at);
  CREATE TABLE IF NOT EXISTS bin_aliases (
    input TEXT PRIMARY KEY,
    key TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

// The API can answer a longer input with a shorter BIN. That data is stored once under the shorter
// BIN, and the input becomes an alias so repeating it needs no API request.
function binKey(digits, bin) {
  const resolved = String(bin?.number ?? '');
  return resolved.length >= MIN_BIN_LENGTH && digits.startsWith(resolved) ? resolved : digits;
}

function toEntry(row) {
  return {
    key: row.key,
    bin: JSON.parse(row.data),
    cachedAt: new Date(row.cached_at).toISOString(),
    viewedAt: new Date(row.viewed_at).toISOString(),
    note: row.note,
  };
}

export function createStore(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  const binColumns = db.prepare('PRAGMA table_info(bins)').all();
  if (!binColumns.some((column) => column.name === 'note')) {
    db.exec("ALTER TABLE bins ADD COLUMN note TEXT NOT NULL DEFAULT ''");
  }

  const selectBin = db.prepare('SELECT * FROM bins WHERE key = ?');
  const upsertBin = db.prepare(`
    INSERT INTO bins (key, data, cached_at, viewed_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET
      data = excluded.data, cached_at = excluded.cached_at, viewed_at = excluded.viewed_at
  `);
  const touchBin = db.prepare('UPDATE bins SET viewed_at = ? WHERE key = ?');
  const selectHistory = db.prepare('SELECT * FROM bins ORDER BY viewed_at DESC, key LIMIT ?');
  const countBins = db.prepare('SELECT COUNT(*) AS total FROM bins');
  const deleteBins = db.prepare('DELETE FROM bins');
  const deleteBin = db.prepare('DELETE FROM bins WHERE key = ?');
  const updateNote = db.prepare('UPDATE bins SET note = ? WHERE key = ?');

  const selectAliasedBin = db.prepare(`
    SELECT bins.* FROM bin_aliases JOIN bins ON bins.key = bin_aliases.key
    WHERE bin_aliases.input = ?
  `);
  const upsertAlias = db.prepare(`
    INSERT INTO bin_aliases (input, key) VALUES (?, ?)
    ON CONFLICT (input) DO UPDATE SET key = excluded.key
  `);
  const deleteAlias = db.prepare('DELETE FROM bin_aliases WHERE input = ?');
  const deleteAliasesOf = db.prepare('DELETE FROM bin_aliases WHERE key = ?');
  const deleteAliases = db.prepare('DELETE FROM bin_aliases');

  const insertSession = db.prepare('INSERT INTO sessions (id, expires_at) VALUES (?, ?)');
  const selectSession = db.prepare('SELECT expires_at FROM sessions WHERE id = ?');
  const deleteSession = db.prepare('DELETE FROM sessions WHERE id = ?');
  const deleteExpiredSessions = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');

  const selectSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const upsertSetting = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `);

  return {
    findBin(digits) {
      const row = selectBin.get(digits) ?? selectAliasedBin.get(digits);
      return row ? toEntry(row) : null;
    },

    saveBin(digits, bin, now = Date.now()) {
      const key = binKey(digits, bin);
      upsertBin.run(key, JSON.stringify(bin), now, now);
      if (key === digits) {
        deleteAlias.run(digits);
      } else {
        upsertAlias.run(digits, key);
      }
      return toEntry(selectBin.get(key));
    },

    markBinViewed(key, now = Date.now()) {
      touchBin.run(now, key);
    },

    history() {
      return {
        entries: selectHistory.all(HISTORY_LIMIT).map(toEntry),
        total: countBins.get().total,
      };
    },

    setBinNote(key, note) {
      return updateNote.run(note, key).changes > 0;
    },

    removeBin(key) {
      deleteAliasesOf.run(key);
      deleteBin.run(key);
    },

    clearHistory() {
      deleteAliases.run();
      deleteBins.run();
    },

    addSession(id, expiresAt) {
      insertSession.run(id, expiresAt);
    },

    hasSession(id, now = Date.now()) {
      const row = selectSession.get(id);
      if (!row) return false;
      if (row.expires_at <= now) {
        deleteSession.run(id);
        return false;
      }
      return true;
    },

    removeSession(id) {
      deleteSession.run(id);
    },

    pruneSessions(now = Date.now()) {
      deleteExpiredSessions.run(now);
    },

    saveQuota({ limit, remaining, resetSeconds }, now = Date.now()) {
      const resetAt = resetSeconds === null ? null : now + resetSeconds * 1000;
      upsertSetting.run(QUOTA_KEY, JSON.stringify({ limit, remaining, resetAt }));
    },

    // The API reports no quota between lookups, so a finished period is assumed to start full.
    loadQuota(now = Date.now()) {
      const row = selectSetting.get(QUOTA_KEY);
      if (!row) return null;
      const { limit, remaining, resetAt } = JSON.parse(row.value);
      if (resetAt !== null && resetAt <= now) {
        return { limit, remaining: limit, resetSeconds: null, estimated: true };
      }
      const resetSeconds = resetAt === null ? null : Math.ceil((resetAt - now) / 1000);
      return { limit, remaining, resetSeconds };
    },

    close() {
      db.close();
    },
  };
}
