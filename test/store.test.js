import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { createStore } from '../src/store.js';

const bin = (number) => ({ number, length: String(number).length, scheme: 'VISA' });

describe('createStore', () => {
  it('keeps data after the database is reopened', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'bincheck-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'test.db');

    const first = createStore(path);
    first.saveBin('448590', bin(448590));
    first.addSession('session-id', Date.now() + 60_000);
    first.saveQuota({ limit: 100, remaining: 90, resetSeconds: 3600 });
    first.close();

    const second = createStore(path);
    assert.equal(second.findBin('448590').bin.number, 448590);
    assert.equal(second.hasSession('session-id'), true);
    assert.equal(second.loadQuota().remaining, 90);
    second.close();
  });

  it('matches BINs exactly, without borrowing a shorter entry', () => {
    const store = createStore(':memory:');
    store.saveBin('448590', bin(448590));
    assert.equal(store.findBin('448590').key, '448590');
    assert.equal(store.findBin('44859012'), null);
    assert.equal(store.findBin('448591'), null);
  });

  it('remembers a longer input that resolved to a shorter BIN', () => {
    const store = createStore(':memory:');
    assert.equal(store.saveBin('44859012', bin(448590)).key, '448590');
    assert.equal(store.findBin('44859012').key, '448590');
    assert.equal(store.findBin('448590').key, '448590');
    assert.equal(store.findBin('44859013'), null);
    assert.equal(store.history().total, 1);
  });

  it('keeps a real longer BIN separate and drops its old alias', () => {
    const store = createStore(':memory:');
    store.saveBin('44859012', bin(448590));
    store.saveBin('44859012', bin(44859012));
    assert.equal(store.findBin('44859012').key, '44859012');
    assert.equal(store.findBin('448590').key, '448590');
    assert.equal(store.history().total, 2);
  });

  it('keeps notes when a BIN is cached again and clears them on request', () => {
    const store = createStore(':memory:');
    store.saveBin('448590', bin(448590));
    assert.equal(store.findBin('448590').note, '');
    assert.equal(store.setBinNote('448590', 'corporate card'), true);
    store.saveBin('448590', bin(448590));
    assert.equal(store.findBin('448590').note, 'corporate card');
    assert.equal(store.history().entries[0].note, 'corporate card');
    assert.equal(store.setBinNote('448590', ''), true);
    assert.equal(store.findBin('448590').note, '');
    assert.equal(store.setBinNote('999999', 'missing'), false);
  });

  it('removes one BIN along with its aliases', () => {
    const store = createStore(':memory:');
    store.saveBin('44859012', bin(448590));
    store.saveBin('411111', bin(411111));
    store.removeBin('448590');
    assert.equal(store.findBin('448590'), null);
    assert.equal(store.findBin('44859012'), null);
    assert.equal(store.findBin('411111').key, '411111');

    store.saveBin('448590', bin(448590));
    assert.equal(store.findBin('44859012'), null);
  });

  it('adds notes to a database created before they existed', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'bincheck-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'old.db');

    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE bins (
      key TEXT PRIMARY KEY, data TEXT NOT NULL, cached_at INTEGER NOT NULL, viewed_at INTEGER NOT NULL
    )`);
    old.prepare('INSERT INTO bins VALUES (?, ?, 1000, 1000)').run('448590', JSON.stringify(bin(448590)));
    old.close();

    const store = createStore(path);
    assert.equal(store.findBin('448590').note, '');
    assert.equal(store.setBinNote('448590', 'kept'), true);
    store.close();

    const reopened = createStore(path);
    assert.equal(reopened.findBin('448590').note, 'kept');
    reopened.close();
  });

  it('keeps one entry per BIN, most recently viewed first', () => {
    const store = createStore(':memory:');
    store.saveBin('411111', bin(411111), 1000);
    store.saveBin('522222', bin(522222), 2000);
    assert.deepEqual(store.history().entries.map((entry) => entry.key), ['522222', '411111']);

    store.markBinViewed('411111', 3000);
    assert.deepEqual(store.history().entries.map((entry) => entry.key), ['411111', '522222']);
    assert.equal(store.findBin('411111').cachedAt, new Date(1000).toISOString());

    store.saveBin('411111', bin(411111), 4000);
    assert.equal(store.history().total, 2);
    assert.equal(store.findBin('411111').cachedAt, new Date(4000).toISOString());
  });

  it('caps the history list but reports the full total', () => {
    const store = createStore(':memory:');
    for (let i = 0; i < 105; i += 1) store.saveBin(String(400000 + i), bin(400000 + i), i);
    const { entries, total } = store.history();
    assert.equal(entries.length, 100);
    assert.equal(total, 105);
    assert.ok(store.findBin('400000'));
  });

  it('clears the cached BINs and history', () => {
    const store = createStore(':memory:');
    store.saveBin('448590', bin(448590));
    store.clearHistory();
    assert.equal(store.findBin('448590'), null);
    assert.deepEqual(store.history(), { entries: [], total: 0 });
  });

  it('expires sessions', () => {
    const store = createStore(':memory:');
    store.addSession('live', 2000);
    store.addSession('stale', 500);
    assert.equal(store.hasSession('live', 1000), true);
    assert.equal(store.hasSession('stale', 1000), false);
    assert.equal(store.hasSession('missing', 1000), false);

    store.pruneSessions(3000);
    assert.equal(store.hasSession('live', 1000), false);

    store.addSession('gone', 2000);
    store.removeSession('gone');
    assert.equal(store.hasSession('gone', 1000), false);
  });

  it('counts the quota reset down and assumes a full quota once the period ends', () => {
    const store = createStore(':memory:');
    assert.equal(store.loadQuota(), null);

    store.saveQuota({ limit: 100, remaining: 94, resetSeconds: 100 }, 0);
    assert.deepEqual(store.loadQuota(40_000), { limit: 100, remaining: 94, resetSeconds: 60 });
    assert.deepEqual(store.loadQuota(100_000), {
      limit: 100,
      remaining: 100,
      resetSeconds: null,
      estimated: true,
    });

    store.saveQuota({ limit: 100, remaining: 99, resetSeconds: 100 }, 100_000);
    assert.equal(store.loadQuota(100_000).remaining, 99);
    assert.equal(store.loadQuota(100_000).estimated, undefined);

    store.saveQuota({ limit: 100, remaining: 93, resetSeconds: null }, 0);
    assert.deepEqual(store.loadQuota(1e12), { limit: 100, remaining: 93, resetSeconds: null });
  });
});
