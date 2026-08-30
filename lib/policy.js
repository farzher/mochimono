const VALID_TYPES = new Set(['image', 'video', 'audio', 'text', 'application', 'other']);

export function normalizePolicy(policy) {
  if (!policy || policy.all === true) return { all: true, types: [] };
  const types = [...new Set((policy.types || []).map(String).filter(type => VALID_TYPES.has(type)))];
  return types.length ? { all: false, types } : { all: true, types: [] };
}

export function policySql(policy, alias = 'o') {
  const normalized = normalizePolicy(policy);
  if (normalized.all) return { sql: '1=1', params: [] };

  const clauses = [];
  const params = [];
  for (const type of normalized.types) {
    if (type === 'other') {
      clauses.push(`(${alias}.mime NOT LIKE 'image/%' AND ${alias}.mime NOT LIKE 'video/%' AND ${alias}.mime NOT LIKE 'audio/%' AND ${alias}.mime NOT LIKE 'text/%' AND ${alias}.mime NOT LIKE 'application/%')`);
    } else {
      clauses.push(`${alias}.mime LIKE ?`);
      params.push(`${type}/%`);
    }
  }
  return { sql: `(${clauses.join(' OR ')})`, params };
}
