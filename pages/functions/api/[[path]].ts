interface CatalogContext {
  request: Request
  env: { CATALOG: { fetch(request: Request): Promise<Response> } }
}

export function onRequest({ request, env }: CatalogContext) {
  return env.CATALOG.fetch(request)
}
