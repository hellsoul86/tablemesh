import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, normalized_name TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, account_id TEXT NOT NULL REFERENCES accounts(id),
        kind TEXT NOT NULL CHECK(kind IN ('web','game')), label TEXT NOT NULL,
        expires_at INTEGER NOT NULL, revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS wallets (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id),
        available INTEGER NOT NULL CHECK(available>=0), held INTEGER NOT NULL CHECK(held>=0)
      );
      CREATE TABLE IF NOT EXISTS ledger (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
        delta INTEGER NOT NULL, held_delta INTEGER NOT NULL, reason TEXT NOT NULL,
        source_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_account_id TEXT NOT NULL REFERENCES accounts(id),
        engine_json TEXT NOT NULL, state_version INTEGER NOT NULL, event_cursor INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS room_events (
        room_id TEXT NOT NULL REFERENCES rooms(id), cursor INTEGER NOT NULL,
        state_version INTEGER NOT NULL, type TEXT NOT NULL, public_payload_json TEXT NOT NULL,
        PRIMARY KEY(room_id,cursor)
      );
      CREATE TABLE IF NOT EXISTS hand_settlements (
        room_id TEXT NOT NULL REFERENCES rooms(id), hand_id TEXT NOT NULL,
        result_json TEXT NOT NULL, participants_json TEXT NOT NULL,
        published INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        PRIMARY KEY(room_id,hand_id)
      );
      CREATE TABLE IF NOT EXISTS room_round_actions (
        room_id TEXT PRIMARY KEY REFERENCES rooms(id), hand_id TEXT, state_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hand_replays (
        hand_id TEXT PRIMARY KEY, sequence INTEGER UNIQUE,
        room_id TEXT NOT NULL REFERENCES rooms(id), room_name TEXT NOT NULL,
        config_json TEXT, started_at INTEGER, finished_at INTEGER,
        availability TEXT NOT NULL CHECK(availability IN ('full','summary_only')),
        participants_json TEXT NOT NULL, settlement_json TEXT, step_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS hand_replay_players (
        hand_id TEXT NOT NULL REFERENCES hand_replays(hand_id), account_id TEXT NOT NULL REFERENCES accounts(id),
        seat INTEGER NOT NULL, own_cards_json TEXT, PRIMARY KEY(hand_id,account_id)
      );
      CREATE INDEX IF NOT EXISTS replay_players_account ON hand_replay_players(account_id,hand_id);
      CREATE TABLE IF NOT EXISTS hand_replay_frames (
        hand_id TEXT NOT NULL REFERENCES hand_replays(hand_id), step_index INTEGER NOT NULL,
        frame_json TEXT NOT NULL, PRIMARY KEY(hand_id,step_index)
      );
      CREATE TABLE IF NOT EXISTS requests (
        account_id TEXT NOT NULL, operation TEXT NOT NULL, resource_id TEXT NOT NULL,
        request_id TEXT NOT NULL, body_hash TEXT NOT NULL, result_json TEXT NOT NULL,
        PRIMARY KEY(account_id,operation,resource_id,request_id)
      );
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, points_cost INTEGER NOT NULL CHECK(points_cost>0),
        sandbox INTEGER NOT NULL CHECK(sandbox IN (0,1)), enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS redemptions (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), product_id TEXT NOT NULL REFERENCES products(id),
        points_cost INTEGER NOT NULL, status TEXT NOT NULL, sandbox INTEGER NOT NULL,
        request_id TEXT NOT NULL, body_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
        UNIQUE(account_id,request_id)
      );
      CREATE TABLE IF NOT EXISTS inventory (
        id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id), code_ciphertext TEXT NOT NULL,
        code_fingerprint TEXT NOT NULL UNIQUE, key_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('available','fulfilled','disabled')),
        redemption_id TEXT UNIQUE REFERENCES redemptions(id)
      );
      CREATE TABLE IF NOT EXISTS admin_audit (
        id TEXT PRIMARY KEY, action TEXT NOT NULL, target TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fair_play (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id), reputation INTEGER NOT NULL DEFAULT 100 CHECK(reputation BETWEEN 0 AND 100),
        cooldown_until INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS room_abandons (
        room_id TEXT NOT NULL REFERENCES rooms(id), hand_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id),
        seat INTEGER NOT NULL, created_at INTEGER NOT NULL, reputation_delta INTEGER NOT NULL, cooldown_until INTEGER NOT NULL,
        PRIMARY KEY(room_id,hand_id,account_id)
      );
      INSERT OR IGNORE INTO fair_play(account_id) SELECT id FROM accounts;
      CREATE TRIGGER IF NOT EXISTS account_fair_play AFTER INSERT ON accounts
      BEGIN INSERT INTO fair_play(account_id) VALUES(NEW.id); END;
    `);
  }
  one<T>(sql: string, ...args: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...args) as T | undefined;
  }
  all<T>(sql: string, ...args: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...args) as T[];
  }
  run(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).run(...args); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() { this.db.close(); }
}
