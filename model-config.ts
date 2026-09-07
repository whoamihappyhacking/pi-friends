// Model policy belongs to the caller/configuration, never to a provider branch.
export function resolveModel(request = {}, config = {}, current) {
  const explicit = request.provider !== undefined || request.model !== undefined;
  const source = explicit ? request : (config.provider || config.model ? config : current || {});
  const provider = source.provider;
  const model = source.model || source.id;
  if (!provider || !model) throw new Error('请同时指定 provider 和 model，或配置默认模型；也可继承主会话当前模型。');
  const defaults = config.modelDefaults?.[provider]?.[model] || {};
  const thinking = request.thinking ?? defaults.thinking ?? (!explicit ? config.thinking : undefined);
  return { provider, model, ...(thinking !== undefined ? { thinking } : {}) };
}
