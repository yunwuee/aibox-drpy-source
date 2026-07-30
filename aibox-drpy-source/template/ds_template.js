/*
@header({
  类型: '影视',
  title: '站点名称',
  lang: 'ds',
  searchable: 2,
  filterable: 0,
  quickSearch: 0
})
*/

var rule = {
  类型: '影视',
  title: '站点名称',
  version: '1.0.0',
  host: 'https://example.com',
  homeUrl: '/latest/',
  url: '/category/fyclass/page/fypage',
  searchUrl: '/search?wd=**&pg=fypage',
  searchable: 2,
  quickSearch: 0,
  filterable: 0,
  headers: {
    'User-Agent': 'MOBILE_UA',
  },
  timeout: 5000,
  class_name: '电影&电视剧&综艺&动漫',
  class_url: '1&2&3&4',
  play_parse: true,
  play_json: [],
  limit: 6,
  double: false,

  推荐: '.recommend .item;a&&title;img&&data-src||src;.remarks&&Text;a&&href',
  一级: '.list .item;a&&title;img&&data-src||src;.remarks&&Text;a&&href',
  二级: {
    title: 'h1&&Text;.type&&Text',
    img: '.poster img&&src',
    desc: '.remarks&&Text;.year&&Text;.area&&Text;.actor&&Text;.director&&Text',
    content: '.content&&Text',
    tabs: '.tabs span',
    lists: '.playlists:eq(#id) a',
    tab_text: 'body&&Text'
  },
  搜索: '.search-result .item;a&&title;img&&src;.remarks&&Text;a&&href',

  lazy: async function (flag, id) {
    let { input } = this;
    const url = String(id || input || '');
    if (/^(?:magnet:|ftp:|thunder:)|\.(?:m3u8|mp4|flv)(?:\?|$)/i.test(url)) {
      return { parse: 0, url, header: {} };
    }
    return { parse: 1, url, js: '' };
  },

  /*
  hostJs: async function () {
    let { HOST } = this;
    return HOST;
  },

  预处理: async function () {
  },

  class_parse: async function () {
    return {
      class: [{ type_name: '电影', type_id: '1' }],
      filters: {}
    };
  }
  */
};
