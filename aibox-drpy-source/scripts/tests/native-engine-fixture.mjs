import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export async function createLocalComicSite({
  emptyCategory = false,
  emptyHome = false,
  emptySearch = false,
  coverModes = {},
  requiredCoverHeader = null,
} = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    requests.push(url.pathname + url.search);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (url.pathname === '/') {
      res.end(emptyHome ? '<!doctype html><div class="empty"></div>' : listHtml('vod-home', 'Home item', 'homeVod', coverModes.homeVod));
      return;
    }
    if (url.pathname === '/list/comic/1') {
      res.end(emptyCategory ? '<!doctype html><div class="empty"></div>' : listHtml('vod-1', 'Category item', 'category', coverModes.category));
      return;
    }
    if (url.pathname === '/search') {
      res.end(emptySearch ? '<!doctype html><div class="empty"></div>' : listHtml('vod-search', `Search ${url.searchParams.get('wd') || ''}`, 'search', coverModes.search));
      return;
    }
    if (url.pathname.startsWith('/detail/')) {
      const id = url.pathname.split('/').pop();
      const cover = coverMarkup(`/images/${id}.jpg?stage=detail`, coverModes.detail);
      res.end(`<!doctype html>
        <h1>${id}</h1>
        ${cover ? cover.replace('<img ', '<img class="cover" ') : ''}
        <div class="remark">finished</div>
        <div class="content">detail content</div>
        <div class="tabs"><span class="tab">Reader</span></div>
        <div class="episodes"><a href="/chapter/chapter-1">Chapter 1</a></div>`);
      return;
    }
    if (url.pathname.startsWith('/images/')) {
      res.setHeader('content-type', 'image/png');
      const stage = url.searchParams.get('stage') || inferImageStage(url.pathname);
      const mode = coverModes[stage] || 'valid';
      if (stage !== 'chapter' && requiredCoverHeader) {
        const actual = req.headers[String(requiredCoverHeader.name || '').toLowerCase()] || '';
        if (actual !== String(requiredCoverHeader.value || '')) {
          res.statusCode = 403;
          res.end('missing cover header');
          return;
        }
      }
      if (mode === 'invalid') {
        res.end('not an image');
        return;
      }
      if (mode === 'error') {
        res.statusCode = 403;
        res.end('forbidden');
        return;
      }
      if (mode === 'svg') {
        res.setHeader('content-type', 'image/svg+xml');
        res.end('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>');
        return;
      }
      res.end(Buffer.from('89504e470d0a1a0a', 'hex'));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    server,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export function writeComicRule(targetPath, baseUrl, {
  recommendable = true,
  searchable = true,
  headers = {},
} = {}) {
  const recommendRule = recommendable ? "  推荐: '*',\n" : '';
  const searchRule = searchable ? "  搜索: '*',\n" : '';
  const code = `var rule = {
  title: 'native parity fixture',
  类型: '\u6f2b\u753b',
  version: '1.0.0',
  host: '${baseUrl}',
  homeUrl: '/',
  url: '/list/fyclass/fypage',
  detailUrl: '/detail/fyid',
  searchUrl: '/search?wd=**&page=fypage',
  class_name: 'Comics',
  class_url: 'comic',
  searchable: ${searchable ? 1 : 0},
  filterable: 0,
  quickSearch: 0,
  headers: ${JSON.stringify(headers)},
  play_parse: true,
  play_json: [],
${recommendRule}  一级: '.item;.title&&Text;img&&data-src||src;.remark&&Text;a&&href',
  二级: {
    title: 'h1&&Text',
    img: '.cover&&data-src||src',
    desc: '.remark&&Text;;;;',
    content: '.content&&Text',
    tabs: '.tabs .tab',
    tab_text: 'body&&Text',
    lists: '.episodes:eq(#id) a',
    list_text: 'body&&Text',
    list_url: 'a&&href'
  },
${searchRule}  proxy_rule: async function (params) {
    return [200, 'text/plain', 'proxy:' + String(params.value || '')];
  },
  lazy: async function (flag, id) {
    return {
      parse: 0,
      jx: 0,
      url: 'pics://' + this.HOST + '/images/page-1.png&&' + this.HOST + '/images/page-2.png'
    };
  }
};`;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, code, 'utf8');
  return targetPath;
}

export function firstEpisode(vod) {
  const flag = String(vod?.vod_play_from || '').split('$$$')[0] || '';
  const raw = String(vod?.vod_play_url || '').split('$$$')[0].split('#')[0] || '';
  const separatorIndex = raw.indexOf('$');
  return {
    flag,
    name: separatorIndex >= 0 ? raw.slice(0, separatorIndex) : '',
    url: separatorIndex >= 0 ? raw.slice(separatorIndex + 1) : '',
  };
}

function listHtml(id, title, stage, coverMode) {
  const cover = coverMarkup(`/images/${id}.jpg?stage=${encodeURIComponent(stage)}`, coverMode);
  return `<!doctype html>
    <div class="item">
      <a href="/detail/${id}"><span class="title">${title}</span>${cover}</a>
      <span class="remark">ready</span>
    </div>`;
}

function coverMarkup(url, mode) {
  return mode === 'missing' ? '' : `<img data-src="" src="${url}">`;
}

function inferImageStage(pathname) {
  if (pathname.includes('vod-home')) return 'homeVod';
  if (pathname.includes('vod-search')) return 'search';
  if (pathname.includes('vod-1')) return 'category';
  return 'chapter';
}
