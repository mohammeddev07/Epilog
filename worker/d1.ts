// The subset of Cloudflare's D1 API that the Worker uses.
export type D1Value = string | number | boolean | null | ArrayBuffer

export interface D1Result<T = Record<string, unknown>> {
  results: T[]
  success: boolean
}

export interface D1PreparedStatement {
  bind(...values: D1Value[]): D1PreparedStatement
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>
}
