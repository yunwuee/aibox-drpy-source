const GROUP_SEPARATOR = '$$$';
const ITEM_SEPARATOR = '#';
const NAME_URL_SEPARATOR = '$';

export function parsePlayCatalog(vod = {}) {
  const rawFrom = String(vod?.vod_play_from ?? vod?.play_from ?? '');
  const rawUrl = String(vod?.vod_play_url ?? vod?.play_url ?? '');
  const flags = rawFrom.trim()
    ? rawFrom.split(GROUP_SEPARATOR).map((item) => item.trim())
    : [];
  const groups = rawUrl.trim() ? rawUrl.split(GROUP_SEPARATOR) : [];
  const visibleSourceCount = Math.min(flags.length, groups.length);
  const sources = [];
  const errors = [];
  const warnings = [];

  if (!rawFrom.trim()) {
    errors.push('详情缺少 vod_play_from，App 无法建立目录线路');
  }
  if (!rawUrl.trim()) {
    errors.push('详情缺少 vod_play_url，App 无法建立章节目录');
  }
  if (rawFrom.trim() && rawUrl.trim() && flags.length !== groups.length) {
    errors.push(`目录线路数不一致: vod_play_from=${flags.length}, vod_play_url=${groups.length}`);
  }

  for (let index = 0; index < visibleSourceCount; index += 1) {
    const name = flags[index];
    const episodes = groups[index]
      .split(ITEM_SEPARATOR)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item, episodeIndex) => parseCatalogEpisode(item, index, episodeIndex));
    if (!name) {
      errors.push(`第 ${index + 1} 条目录线路名称为空`);
    }
    if (episodes.length === 0) {
      errors.push(`目录线路“${name || index + 1}”没有章节`);
    }
    for (const episode of episodes) {
      if (!episode.name) {
        warnings.push(`目录线路“${name || index + 1}”存在无标题章节`);
      }
      if (!episode.url) {
        errors.push(`章节“${episode.name || episode.raw || episode.episodeIndex + 1}”缺少 $ 后的章节地址`);
      }
    }
    sources.push({ index, name, episodes });
  }

  const flatEpisodes = sources.flatMap((source) => source.episodes.map((episode) => ({
    ...episode,
    flag: source.name,
    sourceIndex: source.index,
  })));

  return {
    rawFrom,
    rawUrl,
    flags,
    groupCount: groups.length,
    sourceCount: sources.length,
    episodeCount: flatEpisodes.length,
    sources,
    firstEpisode: flatEpisodes[0] || null,
    lastEpisode: flatEpisodes[flatEpisodes.length - 1] || null,
    errors: uniqueStrings(errors),
    warnings: uniqueStrings(warnings),
  };
}

export function parseNovelReaderPayload(url) {
  const value = String(url || '').trim();
  if (!value) {
    return invalidPayload('empty', '小说章节结果为空');
  }

  if (/^novel:\/\//i.test(value)) {
    const raw = value.slice('novel://'.length);
    if (!raw.trim()) {
      return invalidPayload('novel', 'novel:// 后没有正文内容', { raw });
    }

    const encodedJson = decodePercentEncodedJson(raw);
    if (encodedJson) {
      return invalidPayload(
        'novel',
        'novel:// 后使用了 encodeURIComponent；Aibox 阅读器不会自动 decodeURIComponent',
        { raw, encodedJson: true },
      );
    }

    try {
      const payload = JSON.parse(raw);
      const title = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? String(payload.title || '')
        : '';
      const content = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? String(payload.content ?? '')
        : String(payload ?? '');
      return novelPayloadResult({ mode: 'novel-json', title, content, raw });
    } catch (_) {
      if (/^[\[{]/.test(raw.trim())) {
        return invalidPayload('novel', 'novel:// 后的 JSON 结构无法解析', { raw });
      }
      return novelPayloadResult({ mode: 'novel-text', title: '', content: raw, raw });
    }
  }

  if (/^https?:\/\//i.test(value) || value.startsWith('//')) {
    return {
      mode: 'http',
      status: 'pending',
      url: value.startsWith('//') ? `https:${value}` : value,
      title: '',
      content: '',
      contentLength: 0,
      error: '',
    };
  }

  return novelPayloadResult({ mode: 'text', title: '', content: value, raw: value });
}

export function parseComicReaderPayload(url) {
  const value = String(url || '').trim();
  if (!value) {
    return {
      mode: 'comic',
      status: 'invalid',
      images: [],
      imageCount: 0,
      error: '漫画章节结果为空',
    };
  }

  let raw = value.replace(/^pics:\/\//i, '').trim();
  let images = [];
  let format = value.startsWith('pics://') ? 'pics' : 'plain';

  if (raw.includes('&&')) {
    images = raw.split('&&');
    format += '-and';
  } else if (raw.includes('|||')) {
    images = raw.split('|||');
    format += '-pipe';
  } else if (raw.includes('\n')) {
    images = raw.split(/\r?\n/).filter((item) => /^(https?:)?\/\//i.test(item.trim()) || item.trim().startsWith('/'));
    format += '-lines';
  } else if (raw.startsWith('[')) {
    try {
      const decoded = JSON.parse(raw);
      if (Array.isArray(decoded)) {
        images = decoded;
        format += '-json';
      }
    } catch (_) {
      const inner = raw.endsWith(']') ? raw.slice(1, -1) : raw;
      images = inner.split(',').map((item) => item.replace(/^['"]|['"]$/g, ''));
      format += '-array-text';
    }
  } else if (/^(https?:)?\/\//i.test(raw) || raw.startsWith('/')) {
    images = [raw];
    format += '-single';
  }

  images = uniqueStrings(images.map((item) => normalizeImageUrl(item)).filter(Boolean));
  return {
    mode: 'comic',
    status: images.length > 0 ? 'ok' : 'invalid',
    format,
    images,
    imageCount: images.length,
    error: images.length > 0 ? '' : '漫画章节结果不符合 Aibox 支持的图片列表格式',
  };
}

function parseCatalogEpisode(raw, sourceIndex, episodeIndex) {
  const separatorIndex = raw.indexOf(NAME_URL_SEPARATOR);
  const name = separatorIndex >= 0 ? raw.slice(0, separatorIndex).trim() : raw.trim();
  const url = separatorIndex >= 0 ? raw.slice(separatorIndex + 1).trim() : '';
  return {
    sourceIndex,
    episodeIndex,
    raw,
    name,
    url,
  };
}

function novelPayloadResult({ mode, title, content, raw }) {
  const text = String(content || '');
  return {
    mode,
    status: text.trim() ? 'ok' : 'invalid',
    url: '',
    title: String(title || ''),
    content: text,
    contentLength: text.length,
    raw,
    error: text.trim() ? '' : '小说章节正文为空',
  };
}

function invalidPayload(mode, error, extra = {}) {
  return {
    mode,
    status: 'invalid',
    url: '',
    title: '',
    content: '',
    contentLength: 0,
    error,
    ...extra,
  };
}

function decodePercentEncodedJson(raw) {
  if (!/%(?:7B|7b|5B|5b|22|27)/.test(raw)) {
    return null;
  }
  try {
    const decoded = decodeURIComponent(raw);
    return JSON.parse(decoded);
  } catch (_) {
    return null;
  }
}

function normalizeImageUrl(value) {
  const url = String(value || '').trim().replace(/^['"]|['"]$/g, '');
  if (url.startsWith('//')) {
    return `https:${url}`;
  }
  return url;
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((item) => String(item || '').trim()).filter(Boolean))];
}
