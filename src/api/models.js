export function handleModelsApi(req, res, ctx) {
  if (ctx.pathname !== '/api/models' || req.method !== 'GET') return false;
  ctx.send(res, 200, ctx.loadModels().kinds);
  return true;
}
