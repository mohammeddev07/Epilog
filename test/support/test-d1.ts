// Tests only: a node:sqlite D1 stand-in. Never import this from Worker code.
import { readdirSync, readFileSync } from 'node:fs'
import type { SQLInputValue } from 'node:sqlite'
import type { D1Database, D1PreparedStatement, D1Value } from '../../worker/d1'

// node:sqlite warns that it's experimental when first loaded; drop only that warning.
const emitWarning = process.emitWarning
process.emitWarning = ((warning: string | Error, ...rest: never[]) => {
  if (String(warning).includes('SQLite is an experimental feature')) return
  emitWarning.call(process, warning, ...rest)
}) as typeof process.emitWarning
const { DatabaseSync } = await import('node:sqlite')
process.emitWarning = emitWarning

const migrations = new URL('../../worker/migrations/', import.meta.url)
const migration = readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()
  .map((name) => readFileSync(new URL(name, migrations), 'utf8')).join('\n')

export function createTestD1() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(migration)

  const statement = (query: string, values: D1Value[] = []) => {
    const execute = <T>() => ({ results: sqlite.prepare(query).all(...values as SQLInputValue[]) as T[], success: true })
    const prepared: D1PreparedStatement & { execute: typeof execute } = {
      bind: (...next) => statement(query, next),
      first: async <T>() => execute<T>().results[0] ?? null,
      all: async <T>() => execute<T>(),
      run: async <T>() => execute<T>(),
      execute,
    }
    return prepared
  }

  const db: D1Database & { dump(table: 'users' | 'sessions' | 'records' | 'aliases'): Record<string, unknown>[] } = {
    prepare: (query) => statement(query),
    async batch<T>(statements: D1PreparedStatement[]) {
      sqlite.exec('BEGIN')
      try {
        const results = statements.map((item) => (item as ReturnType<typeof statement>).execute<T>())
        sqlite.exec('COMMIT')
        return results
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
    dump: (table) => sqlite.prepare(`SELECT * FROM ${table}`).all().map((row) => ({ ...row })),
  }
  return db
}
