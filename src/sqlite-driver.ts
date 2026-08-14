/**
 * Thin SQLite driver seam: the ONLY module that touches the SQLite engine.
 * `better-sqlite3` is the single release driver — there is no experimental
 * fallback and no silent driver selection. (node:sqlite served as a
 * dev-time validation reference; those checks live in the tmp/ spikes.)
 * @module dsh-negative-ledger/sqlite-driver
 */

import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'

/** Minimal synchronous database handle. */
export interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close(): void
}

/** Minimal synchronous prepared statement. */
export interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  get(...params: unknown[]): Record<string, unknown> | undefined
  all(...params: unknown[]): Array<Record<string, unknown>>
}

export function openDatabase(path: string): SqliteDatabase {
  const db: BetterSqlite3.Database = new Database(path)
  return {
    exec(sql) {
      db.exec(sql)
    },
    prepare(sql) {
      const statement = db.prepare(sql)
      return {
        run(...params: unknown[]) {
          return statement.run(...params)
        },
        get(...params: unknown[]) {
          return statement.get(...params) as Record<string, unknown> | undefined
        },
        all(...params: unknown[]) {
          return statement.all(...params) as Array<Record<string, unknown>>
        },
      }
    },
    close() {
      db.close()
    },
  }
}
