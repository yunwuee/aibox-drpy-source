const NO_DATA_NAME_RE = /^无数据[，,]防无限请求$/;

export function isNativeNoDataSentinel(item) {
  if (!item || typeof item !== 'object') return false;
  const id = String(item.vod_id ?? item.url ?? item.id ?? '').trim().toLowerCase();
  const name = String(item.vod_name ?? item.title ?? item.name ?? '').trim();
  return id === 'no_data' || NO_DATA_NAME_RE.test(name);
}

export function extractNativeList(value) {
  const list = Array.isArray(value)
    ? value
    : (Array.isArray(value?.list) ? value.list : []);
  return list.filter((item) => !isNativeNoDataSentinel(item));
}

export function hasNativeStageData(stage, value) {
  const normalizedStage = String(stage || '').trim().toLowerCase();
  if (['homevod', 'category', 'detail', 'search'].includes(normalizedStage)) {
    return extractNativeList(value).length > 0;
  }
  if (normalizedStage === 'home') {
    return (Array.isArray(value?.class) && value.class.length > 0)
      || extractNativeList(value).length > 0;
  }
  if (normalizedStage === 'getruleobject') {
    return Boolean(value && typeof value === 'object' && Object.keys(value).length > 0);
  }
  if (normalizedStage === 'play') {
    return Boolean(String(value?.url ?? value ?? '').trim());
  }
  if (Array.isArray(value) || Array.isArray(value?.list)) {
    return extractNativeList(value).length > 0;
  }
  if (typeof value === 'string') return value.trim().length > 0;
  return value !== null && value !== undefined;
}
