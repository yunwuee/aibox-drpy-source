var rule = {
  类型: '小说',
  title: '离线小说验收源',
  version: '1.0.0',
  host: 'https://fixture.invalid',
  homeUrl: '/',
  url: '/category/fyclass/fypage',
  searchUrl: '/search?wd=**&pg=fypage',
  searchable: 2,
  quickSearch: 0,
  filterable: 0,
  play_parse: true,
  play_json: [],
  headers: { 'User-Agent': 'MOBILE_UA' },
  class_name: '小说',
  class_url: 'books',
  推荐: async function () {
    return setResult([{ title: '固定测试小说', pic_url: '', desc: '完结', url: '/book/1' }]);
  },
  一级: async function () {
    return setResult([{ title: '固定测试小说', pic_url: '', desc: '完结', url: '/book/1' }]);
  },
  二级: async function (ids) {
    return {
      vod_id: ids[0],
      vod_name: '固定测试小说',
      vod_remarks: '共2章',
      vod_content: '用于验证小说目录和正文协议。',
      vod_play_from: '正文',
      vod_play_url: '第一章$chapter-1#第二章$chapter-2',
    };
  },
  搜索: async function () {
    return setResult([{ title: '固定测试小说', pic_url: '', desc: '完结', url: '/book/1' }]);
  },
  lazy: async function (flag, id) {
    const title = id === 'chapter-2' ? '第二章' : '第一章';
    return {
      parse: 0,
      url: 'novel://' + JSON.stringify({
        title,
        content: title + '\n这是离线夹具提供的正文内容，用于确认 Aibox 阅读器可以直接解析。',
      }),
    };
  },
};
