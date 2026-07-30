var rule = {
  类型: '漫画',
  title: '离线漫画验收源',
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
  class_name: '漫画',
  class_url: 'comics',
  _png: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9Z0AAAAASUVORK5CYII=',
  _png2: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  推荐: async function () {
    return setResult([{ title: '固定测试漫画', pic_url: rule._png, desc: '完结', url: '/comic/1' }]);
  },
  一级: async function () {
    return setResult([{ title: '固定测试漫画', pic_url: rule._png, desc: '完结', url: '/comic/1' }]);
  },
  二级: async function (ids) {
    return {
      vod_id: ids[0],
      vod_name: '固定测试漫画',
      vod_pic: rule._png,
      vod_remarks: '共2话',
      vod_content: '用于验证漫画目录和图片协议。',
      vod_play_from: '漫画',
      vod_play_url: '第一话$chapter-1#第二话$chapter-2',
    };
  },
  搜索: async function () {
    return setResult([{ title: '固定测试漫画', pic_url: rule._png, desc: '完结', url: '/comic/1' }]);
  },
  lazy: async function () {
    return {
      parse: 0,
      url: 'pics://' + rule._png + '&&' + rule._png2,
      header: rule.headers,
    };
  },
};
