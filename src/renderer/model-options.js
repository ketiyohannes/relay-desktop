import { providerLabel } from './account-controls.js';

/** One catalog per provider; each model routes to an account that actually supports it. */
export function modelGroups(accounts, catalogs, errors, session, search = '') {
  const groups = new Map();
  for (const account of accounts) {
    const provider = providerLabel(account);
    const key = account.engine === 'claude' ? 'anthropic' : account.provider;
    if (!groups.has(key)) groups.set(key, { provider, models: new Map(), unavailable: [] });
    const group = groups.get(key);
    const catalog = catalogs.get(account.id);
    const error = errors.get(account.id) || (catalog?.connected === false ? 'Sign-in needed' : '');
    if (error) group.unavailable.push(`${account.name}: ${error}`);
    if (catalog?.connected === false) continue;
    for (const model of catalog?.models || []) {
      if (!model.authenticated) continue;
      const existing = group.models.get(model.id);
      const preferred = account.id === session?.accountId;
      if (!existing || preferred) group.models.set(model.id, {
        model, accountId: account.id,
        selected: preferred && model.id === (session.models?.[account.id] ?? account.model),
        search: `${existing?.search || ''} ${account.name} ${provider} ${model.name} ${model.id} ${model.description || ''}`.toLowerCase(),
      });
      else existing.search += ` ${account.name.toLowerCase()}`;
    }
  }
  return [...groups.values()].map((group) => ({
    ...group, models: [...group.models.values()].filter((entry) => entry.search.includes(search.toLowerCase())),
  })).filter((group) => group.models.length || group.unavailable.length);
}
