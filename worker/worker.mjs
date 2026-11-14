/**
 * IPTV 聚合 Worker
 * 作用：拉取多个上游订阅源 → 解析 EXTINF → 按频道名去重 → 按 央视/卫视/港澳台/其他 分组输出 m3u
 * 部署：Cloudflare Workers（无需服务器，结果自带 30 分钟缓存）
 */

const SOURCES = [
  // 优先级越小越靠前，去重时保留优先级高的那条
  { name: 'extra-itv', url: 'https://raw.githubusercontent.com/Pankeca/itv-extra/main/extra.m3u', priority: 1 },
  { name: 'pages-itv', url: 'https://itv.940214.xyz/result.m3u', priority: 2 },
  { name: 'collect-iptv', url: 'https://raw.githubusercontent.com/zilong7728/Collect-IPTV/main/best_sorted.m3u', priority: 4 },
  { name: 'iptvorg-cn', url: 'https://iptv-org.github.io/iptv/countries/cn.m3u', priority: 5 },
  { name: 'iptvorg-hk', url: 'https://iptv-org.github.io/iptv/countries/hk.m3u', priority: 5 },
  { name: 'iptvorg-tw', url: 'https://iptv-org.github.io/iptv/countries/tw.m3u', priority: 5 },
  { name: 'iptvorg-mo', url: 'https://iptv-org.github.io/iptv/countries/mo.m3u', priority: 5 },
  // 每日探测通过的有效线路，只作为补充（同名频道不会覆盖上面的源）
  { name: 'alive-probe', url: 'https://raw.githubusercontent.com/Pankeca/itv-extra/main/alive.m3u', priority: 6 },
];

const STATUS_URL = 'https://raw.githubusercontent.com/Pankeca/itv-extra/main/status.json';

const GROUPS = ['央视', '卫视', '地方', '港澳台', '点播', '其他', '海外'];
const CACHE_SECONDS = 1800;
// 两级缓存：L1 = 边缘内存（同机房最快），L2 = KV（跨机房共享，冷机房也能秒回）
const L1_URL = 'https://itv-hub.internal/payload';
const KV_KEY = 'payload:v3';
const KV_TTL_SECONDS = 6 * 3600;
// 同一频道最多输出几条线路（播放器里显示为同名多条，可手动切换）
const MAX_LINES = 2;
// 手机 Termux 中转源：稳定但占用上行带宽，同频道有直连线路时排后面
const RELAY_HOST = /itv2\.940214\.xyz/i;

// ---------- 频道名归一化（英文 / 拼音 → 中文） ----------
// 只收录常见台名，未命中的保持原名，避免误改外语频道。
function cleanName(raw) {
  let s = raw
    .replace(/^\[(?:\s*(?:超清|高清|蓝光|标清)\s*)\]\s*/, '')
    .replace(/\(\s*\d{3,4}[pi]\s*[^)]*\)/gi, '')
    .replace(/\(\s*(?:4k|8k)\s*\)/gi, '')
    .replace(/\[\s*(?:geo-blocked|not\s*24\/7)[^\]]*\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/\(\s*(?:taiwan|hong kong|macau|china)\s*\)$/gi, '').trim();
  s = s.replace(/\s*\d{3,4}[pP]$/, '').replace(/(?:hd|sd)$/i, '').trim();
  return s;
}

const FULL_NAME_MAP = [
  // 央视系列英文名
  [/^cctv[- ]?billiards$/i, 'CCTV台球'],
  [/^cctv[- ]?golf\s*&\s*tennis$/i, 'CCTV高尔夫·网球'],
  [/^cctv[- ]?culture of quality$/i, 'CCTV文化精品'],
  [/^cctv[- ]?nostalgia theater$/i, 'CCTV怀旧剧场'],
  [/^cctv[- ]?storm football$/i, 'CCTV风云足球'],
  [/^cctv[- ]?storm music$/i, 'CCTV风云音乐'],
  [/^cctv[- ]?storm theater$/i, 'CCTV风云剧场'],
  [/^cctv[- ]?the first theater$/i, 'CCTV第一剧场'],
  [/^cctv[- ]?weapon\s*&\s*technology$/i, 'CCTV兵器科技'],
  [/^cctv[- ]?women'?s fashion$/i, 'CCTV女性时尚'],
  [/^cctv[- ]?world geography$/i, 'CCTV世界地理'],
  [/^cctv[- ]?health$/i, 'CCTV卫生健康'],
  [/^cgtn documentary$/i, 'CGTN纪录'],
  [/^cgtn$/i, 'CGTN英语'],
  [/^cetv[- ]?1$/i, '中国教育1套'],
  [/^cetv[- ]?2$/i, '中国教育2套'],
  [/^cetv[- ]?4$/i, '中国教育4套'],
  // 同一频道的中文别名统一成规范名，便于合并去重
  [/^(?:cctv)?央视文化精品$/i, 'CCTV文化精品'],
  [/^(?:cctv)?央视台球$/i, 'CCTV台球'],
  [/^cctv风云剧场$/i, 'CCTV风云剧场'],
  [/^cctv风云音乐$/i, 'CCTV风云音乐'],
  [/^cctv风云足球$/i, 'CCTV风云足球'],
  [/^cctv第一剧场$/i, 'CCTV第一剧场'],
  [/^cctv兵器科技$/i, 'CCTV兵器科技'],
  [/^cctv老故事$/i, '老故事'],
  [/^风云剧场$/i, 'CCTV风云剧场'],
  [/^风云音乐$/i, 'CCTV风云音乐'],
  [/^风云足球$/i, 'CCTV风云足球'],
  [/^第一剧场$/i, 'CCTV第一剧场'],
  [/^兵器科技$/i, 'CCTV兵器科技'],
  [/^cgtn英语$/i, 'CGTN英语'],
  [/^cgtn西语$/i, 'CGTN西班牙语'],
  [/^cgtn阿语$/i, 'CGTN阿拉伯语'],
  [/^cgtn记录$/i, 'CGTN纪录'],
  [/^cgtn外语纪录$/i, 'CGTN纪录'],
  [/^凤凰卫视$/i, '凤凰中文'],
  [/^西藏卫视$/i, '西藏汉语卫视'],
  // 港台
  [/^rthk\s*(?:tv\s*)?(\d+)$/i, '港台电视%s'],
  [/^tvb news$/i, 'TVB无线新闻台'],
  [/^tvb明珠台$/i, 'TVB明珠台'],
  [/^tvb翡翠台$/i, 'TVB翡翠台'],
  [/^tvb新闻$/i, 'TVB无线新闻台'],
  [/^无线新闻$/i, 'TVB无线新闻台'],
  [/^无线新闻台$/i, 'TVB无线新闻台'],
  [/^明珠台$/i, 'TVB明珠台'],
  [/^翡翠台北美版$/i, 'TVB翡翠台北美版'],
  [/^翡翠台4k$/i, 'TVB翡翠台4K'],
  [/^翡翠台$/i, 'TVB翡翠台'],
  [/^华丽翡翠台$/i, 'TVB华丽翡翠台'],
  [/^凤凰资讯台$/i, '凤凰资讯'],
  [/^凤凰中文台$/i, '凤凰中文'],
  [/^凤凰香港台$/i, '凤凰香港'],
  [/^凤凰卫视台$/i, '凤凰中文'],
  [/^中国农林卫视$/i, '农林卫视'],
  [/^tvbs[- ]?asia$/i, 'TVBS亚洲台'],
  [/^tvbs news$/i, 'TVBS新闻台'],
  [/^hoy infotainment$/i, 'HOY资讯台'],
  [/^hoy\s*(\d+)$/i, 'HOY %s台'],
  [/^phoenix chinese channel$/i, '凤凰中文'],
  [/^phoenix infonews channel$/i, '凤凰资讯'],
  [/^jade$/i, 'TVB翡翠台'],
  [/^canal macau$/i, '澳门频道'],
  [/^tdm[- ]?ou mun$/i, '澳视澳门'],
  [/^tdm information$/i, '澳视资讯'],
  [/^tdm entertainment$/i, '澳视综艺'],
  [/^tdm sports$/i, '澳视体育'],
  [/^tdm[- ]?macau satellite$/i, '澳视卫星'],
  // 台湾
  [/^cts$/i, '华视'],
  [/^cts news$/i, '华视新闻'],
  [/^ttv$/i, '台视'],
  [/^ttv news$/i, '台视新闻'],
  [/^cti news$/i, '中天新闻'],
  [/^cti variety$/i, '中天综合'],
  [/^set news$/i, '三立新闻'],
  [/^ebc news$/i, '东森新闻'],
  [/^ebc financial news$/i, '东森财经新闻'],
  [/^ebc foreign movie$/i, '东森洋片'],
  [/^ftv$/i, '民视'],
  [/^ftv one$/i, '民视第一台'],
  [/^pts\s*3$/i, '公视3台'],
  [/^pts$/i, '公视'],
  [/^hakka tv$/i, '客家电视台'],
  [/^(?:taiwan )?indigenous tv$/i, '原住民族电视台'],
  [/^daai\s*1$/i, '大爱一台'],
  [/^daai\s*2$/i, '大爱二台'],
  [/^momo tv$/i, 'momo亲子台'],
  [/^momo\s*1$/i, 'momo综合台'],
  [/^momo\s*2$/i, 'momo亲子台'],
  [/^good\s*2$/i, '好消息二台'],
  [/^good$/i, '好消息一台'],
  [/^good tv$/i, '好消息电视台'],
  [/^ntd tv asia[- ]?pacific$/i, '新唐人亚太台'],
  [/^mei ah movie channel$/i, '美亚电影台'],
  [/^celestial movies$/i, '天映电影台'],
  // 其他中文台 / 品牌
  [/^cna$/i, '亚洲新闻台'],
  [/^ch8$/i, '新加坡8频道'],
  [/^chu$/i, '新加坡U频道'],
  [/^chc action$/i, 'CHC动作电影'],
  [/^chc home theater$/i, 'CHC家庭影院'],
  [/^golden eagle cartoon$/i, '金鹰卡通'],
  [/^you man cartoon channel$/i, '优漫卡通频道'],
  [/^fengshang shopping channel$/i, '风尚购物频道'],
  [/^brtv kaku childrens? channel$/i, '北京卡酷少儿频道'],
  [/^china travel$/i, '中国旅游频道'],
  [/^china weather channel$/i, '中国天气频道'],
  [/^documentary humanities channel$/i, '纪实人文频道'],
  [/^dragon tv international$/i, '东方卫视国际频道'],
  [/^dragon tv$/i, '东方卫视'],
  [/^tv brics chinese$/i, '金砖电视台中文频道'],
  [/^qtv[- ]?(\d)$/i, '青岛电视台%s套'],
  [/^sjtv$/i, '石家庄电视台'],
  [/^yichang sanxia general channel$/i, '宜昌三峡综合频道'],
  [/^yichang sanxia travel\s*&\s*life channel$/i, '宜昌三峡旅游生活频道'],
];

const CCTV_SUFFIX = {
  1: '综合', 2: '财经', 3: '综艺', 4: '中文国际', 5: '体育', 6: '电影',
  7: '国防军事', 8: '电视剧', 9: '纪录', 10: '科教', 11: '戏曲', 12: '社会与法',
  13: '新闻', 14: '少儿', 15: '音乐', 16: '奥林匹克', 17: '农业农村',
};

const PLACES = {
  anhui: '安徽', anshun: '安顺', baicheng: '白城', beijing: '北京', bingtuan: '兵团', chaozhou: '潮州',
  chifeng: '赤峰', chuzhou: '滁州', chuxiong: '楚雄', dali: '大理', dongguan: '东莞',
  dunhuang: '敦煌', fujian: '福建', gansu: '甘肃', guangdong: '广东', guangxi: '广西',
  guangzhou: '广州', guizhou: '贵州', harbin: '哈尔滨', hebei: '河北', hebi: '鹤壁',
  heilongjiang: '黑龙江', hezheng: '和政', hunan: '湖南', jiangsu: '江苏', jiangxi: '江西',
  jilin: '吉林', jingmen: '荆门', kangba: '康巴', lanzhou: '兰州', liangshan: '凉山',
  liaoning: '辽宁', nanchang: '南昌', 'nei monggol': '内蒙古', 'nei mongol': '内蒙古',
  ningxia: '宁夏', pingxiang: '萍乡', qianjiang: '黔江', qinghai: '青海', shandong: '山东',
  shenzhen: '深圳', sichuan: '四川', siping: '四平', tianjin: '天津', tonghua: '通化',
  xinjiang: '新疆', xizang: '西藏', "xi'an": '西安', xuzhou: '徐州', yanbian: '延边',
  yichang: '宜昌', yunnan: '云南', zhejiang: '浙江',
};

// 省级台 + “TV” 一般指卫视；城市台 + “TV” 指电视台
const PROVINCES = new Set(['安徽', '北京', '福建', '甘肃', '广东', '广西', '贵州', '海南', '河北', '河南',
  '黑龙江', '湖北', '湖南', '吉林', '江苏', '江西', '辽宁', '内蒙古', '宁夏', '青海', '山东', '山西',
  '陕西', '上海', '四川', '天津', '西藏', '新疆', '云南', '浙江', '重庆']);

const SUFFIXES = [
  [/^satellite (?:tv|channel)$/, '卫视'],
  [/^comprehensive news chann?el$/, '新闻综合频道'],
  [/^news & generalist channel$/, '新闻综合频道'],
  [/^public & news channel$/, '公共·新闻频道'],
  [/^public & agriculture channel$/, '公共·农业频道'],
  [/^econom(?:y|ic) & life channel$/, '经济生活频道'],
  [/^econom(?:y|ic) life channel$/, '经济生活频道'],
  [/^culture & tourism channel$/, '文化旅游频道'],
  [/^travel & life channel$/, '旅游生活频道'],
  [/^variety & travel channel$/, '综艺旅游频道'],
  [/^sports & leisure channel$/, '体育休闲频道'],
  [/^politics & law channel$/, '政法频道'],
  [/^minsheng leisure$/, '民生休闲频道'],
  [/^women'?s channel$/, '女性频道'],
  [/^children'?s channel$/, '少儿频道'],
  [/^educational channel$/, '教育频道'],
  [/^econom(?:y|ic) channel$/, '经济频道'],
  [/^lifestyle channel$/, '生活频道'],
  [/^life channel$/, '生活频道'],
  [/^rural channel$/, '乡村频道'],
  [/^sports channel$/, '体育频道'],
  [/^science & (?:education|technology) channel$/, '科教频道'],
  [/^science education channel$/, '科教频道'],
  [/^business information channel$/, '商务资讯频道'],
  [/^variety channel$/, '综艺频道'],
  [/^qilu channel$/, '齐鲁频道'],
  [/^silk road channel$/, '丝绸之路频道'],
  [/^movie channel$/, '电影频道'],
  [/^city channel$/, '城市频道'],
  [/^public channel$/, '公共频道'],
  [/^news channel$/, '新闻频道'],
  [/^comprehensive channel$/, '综合频道'],
  [/^general channel$/, '综合频道'],
  [/^international channel$/, '国际频道'],
  [/^channel$/, '频道'],
];

const PLACE_KEYS = Object.keys(PLACES).sort((a, b) => b.length - a.length);

function normalizeName(raw) {
  const name = cleanName(raw);
  const low = name.toLowerCase();

  // 1) 整名精确匹配
  for (const [re, cn] of FULL_NAME_MAP) {
    if (re.test(name)) {
      const m = name.match(re);
      if (m && m[1]) return cn.includes('%s') ? cn.replace('%s', m[1]) : cn + m[1];
      return cn;
    }
  }

  // 2) CCTV-6 / CCTV-13 这类编号名，统一成“CCTV-数字 频道名”
  const uhd = name.match(/^cctv[- ]?([48])\s*k(?:\s*(?:高清|超高清))?$/i);
  if (uhd) return `CCTV-${uhd[1]}K 超高清`;
  const cctv = name.match(/^cctv[- ]?(\d{1,2})(\+)?(?:\s*(.*))?$/i);
  if (cctv) {
    const num = +cctv[1];
    const rest = (cctv[3] || '').trim();
    const suffix = rest || (cctv[2] ? '体育赛事' : (CCTV_SUFFIX[num] || ''));
    return `CCTV-${num}${cctv[2] ? '+' : ''}${suffix ? ' ' + suffix : ''}`;
  }

  // 3) “地名 + 频道类型”组合（Anhui TV、Hunan Economy Channel …）
  let key = PLACE_KEYS.find(p => low.startsWith(p + ' '));
  if (!key) return name;
  let cn = PLACES[key];
  let rest = low.slice(key.length).trim();

  let m = rest.match(/^tv\s*(\d+)$/);
  if (m) return `${cn}电视台${m[1]}套`;
  m = rest.match(/^tv\s*(chinese|tibetan)$/);
  if (m) return cn + (m[1] === 'chinese' ? '汉语卫视' : '藏语卫视');
  if (rest === 'tv') return PROVINCES.has(cn) ? cn + '卫视' : cn + '电视台';
  if (rest.startsWith('tv ')) rest = rest.slice(3); // Shandong TV Life Channel → life channel
  if (rest === 'channel') return cn + '频道';
  for (const [re, suf] of SUFFIXES) if (re.test(rest)) return cn + suf;

  return name;
}


// ---------- 解析 ----------
function parseM3U(text, source) {
  const items = [];
  let pending = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      const commaIdx = line.indexOf(',');
      const head = commaIdx >= 0 ? line.slice(0, commaIdx) : line;
      const title = commaIdx >= 0 ? line.slice(commaIdx + 1).trim() : '';
      const attrs = {};
      const re = /(\w[\w-]*)="([^"]*)"/g;
      let m;
      while ((m = re.exec(head))) attrs[m[1]] = m[2];
      const name = normalizeName((attrs['tvg-name'] || title || '').trim());
      if (!name) continue;
      pending = {
        name,
        tvgId: attrs['tvg-id'] || '',
        logo: attrs['tvg-logo'] || '',
        upstreamGroup: attrs['group-title'] || '',
        source: source.name,
        priority: source.priority,
      };
    } else if (!line.startsWith('#')) {
      if (pending) {
        items.push({ ...pending, url: line });
        pending = null;
      }
    }
  }
  return items;
}

// ---------- 归一化与分组 ----------
function dedupeKey(name) {
  // 归一化：去括号内容、去连字符/空格、去画质与后缀词，CCTV 统一成 cctv+数字
  let s = name
    .toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[【\[][^】\]]*[】\]]/g, '')
    .replace(/[*·•]/g, '')
    .replace(/[\s\-_]/g, '')
    .replace(/高清|超清|蓝光|标清|频道|综合|直播|hd/g, '');
  const m = s.match(/cctv(\d{1,2})(\+|4k|8k|k)?/);
  if (m) {
    const tag = m[2] === 'k' ? `${m[1]}k` : (m[2] || '');
    return 'cctv' + m[1] + tag;
  }
  return s;
}

// 过滤真正的垃圾条目：回放录像、教程、节目单残留、景区机位等。
// 注意：春晚、剧集、电影等点播资源不能删，它们在 classify 里归「点播」。
function isJunk(name) {
  // 上游注释行或模板占位
  if (name.startsWith('#') || /自定义频道模板/.test(name)) return true;
  const s = name.toLowerCase();
  // 以台名开头的才算“正经频道”，避免“WTT…全场回放（CCTV5）”这类靠 CCTV 字样蒙混过关
  const channelLike = /^(cctv|cgtn|tvb|hoy|viutv|凤凰|翡翠|澳视|rthk|港台|chc|天映|美亚)/.test(s) || /卫视/.test(s);
  const junkRe = /回放|全场|解说|集锦|教程|预告|纯享|精编|公开课|正在播出|丨|特种兵|慢直播|不间断|视角|重播|复盘|解盘|逃顶|唯一账号|欢迎使用|大集合|24小时|｜|港剧|剧间/;
  if (junkRe.test(name)) return !(channelLike && name.length <= 20);
  // 景区机位 / 地标摄像头（奥帆中心、鼓楼广场、跨海大桥…）
  if (!channelLike && name.length <= 10 && /中心|广场|公园|大桥|路口|景区|海滩|古镇|码头|栈道|观景|阁|滩/.test(name)) return true;
  // 景区慢直播（白山市·松岭、都江堰·春野…）：带分隔点且不是频道名
  if (/[·、]/.test(name) && !channelLike && !/频道|电视台|卫视/.test(name)) return true;
  if (/\d{1,2}:\d{2}/.test(name)) return !channelLike;
  if (name.length > 36) return !channelLike;
  return false;
}

function classify(name, upstreamGroup = '') {
  const s = name.toLowerCase();
  if (/^(cctv|cgtn)/i.test(s) || /央视|中央电视|奥林匹克|风云音乐|风云足球|风云剧场|怀旧剧场|世界地理|第一剧场|电视指南|兵器科技|女性时尚|发现之旅|老故事|书画|梨园/.test(name)) return '央视';
  // 港澳台优先于卫视：香港卫视、澳门莲花卫视等仍归港澳台
  if (/香港|澳门|台湾|港台|tvb|hoy|viutv|澳视|中天|东森|三立|民视|华视|中视|台视|凤凰|佳艺|亚洲电视|nowtv|rthk|港台电视|客家电视台|原住民族|大爱|好消息|公视|寰宇|momo|daai|now新闻|now news|now tv|taiwan plus|耀才/.test(s)) return '港澳台';
  if (/卫视/.test(name)) return '卫视';
  // 纯外文名或常见境外台
  if (!/[\u4e00-\u9fff]/.test(name) || /亚洲新闻台|新加坡|金砖电视台|马来西亚|韩国|日本|美国|英国|法国|德国|印度|泰国|越南|菲律宾|印尼|俄罗斯|土耳其/.test(name)) return '海外';

  const isLocal = PROVINCE_ORDER.some(p => name.startsWith(p)) || CITY_KEYS.some(c => name.startsWith(c));
  // 影视点播资源：历年春晚、剧集、电影、综艺、轮播剧场（有地名前缀的地方影视台除外）
  if (!isLocal) {
    if (/春晚|《|》|「|」|轮播|点播/.test(name)) return '点播';
    if (/剧场|影院|电影|影视剧|电视剧|剧集|动漫|动画|综艺|贺岁|相声|小品/.test(name)) return '点播';
    // 片名带序号（拆弹专家1、飞碟之谜01…）
    if (/\d$/.test(name) && !/频道|电视台|卫视|一套|二套|三套/.test(name)) return '点播';
    // 剧集/纪录片命名特征：第二季、之精绝古城、航拍中国…
    if (/第[一二三四五六七八九十\d]+[季部集期]/.test(name)) return '点播';
    if (/之[^ ]{2,}/.test(name) && name.length <= 12) return '点播';
    if (/航拍|舌尖|大国重器|超级工程|我在故宫|人生一串|风味人间/.test(name)) return '点播';
    if (/^(?:chc|天映|美亚|邵氏)/i.test(s) || /^(?:chc|天映|美亚|邵氏)/i.test(name)) return '点播';
    // 上游分组标明是影视资源，且名字不像频道
    if (/影视|电影|电视剧|剧集|综艺|动漫|动画/.test(upstreamGroup) && !/频道|电视台|卫视/.test(name)) return '点播';
    // Fanmingming 源的「其他频道」组里混着大量剧集轮播直播间
    if (/其他频道/.test(upstreamGroup) && !/频道|电视台|台$|天地|观察|资讯|新闻|购物|商城|教育|纪实|财经|体育|影院|剧场/.test(name)) return '点播';
  }
  // 地方台：必须能识别出所属省份/城市
  if (isLocal) return '地方';
  return '其他';
}

// 省级行政区排序（由北到南的常规顺序）
const PROVINCE_ORDER = ['北京', '天津', '河北', '山西', '内蒙古', '辽宁', '吉林', '黑龙江', '上海',
  '江苏', '浙江', '安徽', '福建', '江西', '山东', '河南', '湖北', '湖南', '广东', '广西', '海南',
  '重庆', '四川', '贵州', '云南', '西藏', '陕西', '甘肃', '青海', '宁夏', '新疆', '香港', '澳门', '台湾'];

// 省 → 地级市 / 常见县级市（同时用于「地方」归属判定与按省份排序）
const PROVINCE_CITIES = {
  北京: '北京 朝阳 海淀 丰台 石景山 通州 昌平 顺义 大兴 房山 门头沟 怀柔 平谷 密云 延庆',
  天津: '天津 滨海 武清 宝坻 静海 蓟州 宁河 津南 西青 北辰 东丽',
  河北: '河北 石家庄 唐山 秦皇岛 邯郸 邢台 保定 张家口 承德 沧州 廊坊 衡水 定州 辛集 涿州 迁安 遵化 武安 清河 蔚县 张北 滦平 平泉 任丘 兴隆 昌黎 正定 黄骅',
  山西: '山西 太原 大同 阳泉 长治 晋城 朔州 晋中 运城 忻州 临汾 吕梁 平遥 太谷 孝义 汾阳 介休 原平 侯马 大宁 定襄 汾西 古县 怀仁 万荣 长子 黄河',
  内蒙古: '内蒙古 呼和浩特 包头 乌海 赤峰 通辽 鄂尔多斯 呼伦贝尔 巴彦淖尔 乌兰察布 兴安 锡林郭勒 阿拉善 满洲里 二连浩特',
  辽宁: '辽宁 沈阳 大连 鞍山 抚顺 本溪 丹东 锦州 营口 阜新 辽阳 盘锦 铁岭 朝阳 葫芦岛',
  吉林: '吉林 长春 四平 辽源 通化 白山 松原 白城 延边 长白山 梅河口 公主岭 敦化 珲春 桦甸 舒兰 德惠 九台 柳河 辉南 靖宇 东丰 东辽 洮南 大安 龙井 图们 和龙 临江 集安 磐石 汪清 长影',
  黑龙江: '黑龙江 哈尔滨 齐齐哈尔 鸡西 鹤岗 双鸭山 大庆 伊春 佳木斯 七台河 牡丹江 黑河 绥化 大兴安岭 绥芬河 漠河 甘南',
  上海: '上海 浦东 徐汇 静安 黄浦 虹口 杨浦 闵行 宝山 嘉定 松江 青浦 奉贤 崇明 金山 南汇 上视',
  江苏: '江苏 南京 无锡 徐州 常州 苏州 南通 连云港 淮安 盐城 扬州 镇江 泰州 宿迁 江都 武进 靖江 常熟 张家港 昆山 太仓 江阴 宜兴 溧阳 句容 丹阳 兴化 泰兴 如皋 海门 启东 东台 新沂 沭阳 邗江',
  浙江: '浙江 杭州 宁波 温州 嘉兴 湖州 绍兴 金华 衢州 舟山 台州 丽水 萧山 余杭 富阳 义乌 东阳 永康 兰溪 诸暨 嵊州 上虞 余姚 慈溪 象山 宁海 平湖 海宁 桐乡 嘉善 长兴 安吉 开化 龙游 江山 龙泉 青田 缙云 云和 庆元 文成 天台 新昌 武义 浦江 磐安 洞头 嵊泗 松阳 遂昌 永嘉 钱江 中国蓝 衢江 普陀 苍南',
  安徽: '安徽 合肥 芜湖 蚌埠 淮南 马鞍山 淮北 铜陵 安庆 黄山 滁州 阜阳 宿州 六安 亳州 池州 宣城 巢湖 桐城 天长 明光 界首 宁国 广德 固镇 祁门',
  福建: '福建 福州 厦门 莆田 三明 泉州 漳州 南平 龙岩 宁德 晋江 石狮 仙游 福清 长乐 闽侯 平潭 武夷山 建瓯 邵武 德化 云霄 厦视',
  江西: '江西 南昌 景德镇 萍乡 九江 新余 鹰潭 赣州 吉安 宜春 抚州 上饶 丰城 樟树 高安 瑞昌 共青城 井冈山 瑞金',
  山东: '山东 济南 青岛 淄博 枣庄 东营 烟台 潍坊 济宁 泰安 威海 日照 临沂 德州 聊城 滨州 菏泽 章丘 即墨 胶州 平度 莱西 龙口 蓬莱 荣成 乳山 滕州 曲阜 邹城 新泰 肥城 乐陵 禹城',
  河南: '河南 郑州 开封 洛阳 平顶山 安阳 鹤壁 新乡 焦作 濮阳 许昌 漯河 三门峡 南阳 商丘 信阳 周口 驻马店 济源 巩义 新郑 荥阳 登封 汝州 长垣 永城 邓州 新野',
  湖北: '湖北 武汉 黄石 十堰 宜昌 襄阳 鄂州 荆门 孝感 荆州 黄冈 咸宁 随州 恩施 江夏 仙桃 潜江 天门 神农架 大冶 宜都 当阳 枝江 枣阳 老河口 汉川 应城 安陆',
  湖南: '湖南 长沙 株洲 湘潭 衡阳 邵阳 岳阳 常德 张家界 益阳 郴州 永州 怀化 娄底 湘西 浏阳 醴陵 湘乡 韶山 耒阳 常宁 武冈 汨罗 临湘 津市 沅江 资兴 冷水江 涟源 吉首',
  广东: '广东 广州 韶关 深圳 珠海 汕头 佛山 江门 湛江 茂名 肇庆 惠州 梅州 汕尾 河源 阳江 清远 东莞 中山 潮州 揭阳 云浮 番禺 花都 增城 从化 南沙 宝安 龙岗 龙华 斗门 澄海 顺德 南海 新会 台山 开平 恩平 鹤山 高州 化州 信宜 四会 博罗 惠东 大埔 丰顺 五华 兴宁 南方 南国 GRTN',
  广西: '广西 南宁 柳州 桂林 梧州 北海 防城港 钦州 贵港 玉林 百色 贺州 河池 来宾 崇左 岑溪 东兴 凭祥 宜州 合山 荔浦 阳朔 灌阳',
  海南: '海南 海口 三亚 三沙 儋州 五指山 琼海 文昌 万宁 澄迈 临高 定安 屯昌 昌江 乐东 陵水 保亭 琼中 白沙',
  重庆: '重庆 万州 涪陵 黔江 永川 合川 江津 南川 綦江 大足 璧山 铜梁 潼南 荣昌 开州 梁平 武隆 城口 丰都 垫江 忠县 云阳 奉节 巫山 巫溪 石柱 秀山 酉阳 彭水',
  四川: '四川 成都 自贡 攀枝花 泸州 德阳 绵阳 广元 遂宁 内江 乐山 南充 眉山 宜宾 广安 达州 雅安 巴中 资阳 阿坝 甘孜 凉山 都江堰 彭州 邛崃 崇州 简阳 金堂 新津 蒲江 大邑 郫都 温江 青白江 新都 武侯 金牛 青羊 成华 锦江 广汉 什邡 绵竹 江油 峨眉山 阆中 万源 华蓥 西昌 康定 马尔康 汶川 松潘 金川 夹江 井研 犍为 营山 旺苍 剑阁 叙州 通川 乐至 大英 泸县 青川 仁寿 双流 沐川 名山 荥经',
  贵州: '贵州 贵阳 六盘水 遵义 安顺 毕节 铜仁 黔西南 黔东南 黔南 清镇 赤水 仁怀 凯里 都匀 兴义',
  云南: '云南 昆明 曲靖 玉溪 保山 昭通 丽江 普洱 临沧 楚雄 红河 文山 西双版纳 大理 德宏 怒江 迪庆 通海 个旧 开远 蒙自 弥勒 宣威 安宁 易门',
  西藏: '西藏 拉萨 日喀则 昌都 林芝 山南 那曲 阿里 安多',
  陕西: '陕西 西安 铜川 宝鸡 咸阳 渭南 延安 汉中 榆林 安康 商洛 杨凌 韩城 华阴 兴平 彬州 神木',
  甘肃: '甘肃 兰州 嘉峪关 金昌 白银 天水 武威 张掖 平凉 酒泉 庆阳 定西 陇南 临夏 甘南 敦煌 玉门 和政 华亭 天祝 渭源 西峰 永昌',
  青海: '青海 西宁 海东 海北 黄南 果洛 玉树 海西 格尔木 德令哈',
  宁夏: '宁夏 银川 石嘴山 吴忠 固原 中卫 青铜峡 灵武',
  新疆: '新疆 乌鲁木齐 克拉玛依 吐鲁番 哈密 昌吉 博尔塔拉 巴音郭楞 阿克苏 克孜勒苏 喀什 和田 伊犁 塔城 阿勒泰 石河子 阿拉尔 图木舒克 五家渠 库尔勒 奎屯 可克达拉 玛纳斯 兵团 维吾尔 哈萨克 维吾尔语 哈萨克语',
};
// 特色台 / 品牌台所属省份（城市表里没有的）
const EXTRA_CITY_PROVINCE = {
  东方: '上海', 西湖: '浙江', 泰山: '山东', 珠江: '广东', 大湾区: '广东', 农林: '陕西',
  海峡: '福建', 东南: '福建', 康巴: '四川', 人间: '台湾',
  齐鲁: '山东', 第一财经: '上海', 南京十八: '江苏', 上海: '上海',
  BRTV: '北京', CQTV: '重庆', 金鹰: '湖南',
};
const CITY_PROVINCE = {
  ...Object.fromEntries(Object.entries(PROVINCE_CITIES)
    .flatMap(([p, cities]) => cities.split(' ').filter(c => c && c !== p).map(c => [c, p]))),
  ...EXTRA_CITY_PROVINCE,
};
const CITY_KEYS = Object.keys(CITY_PROVINCE).sort((a, b) => b.length - a.length);

function provinceRank(name) {
  const idx = PROVINCE_ORDER.findIndex(p => name.startsWith(p));
  if (idx >= 0) return idx * 100;
  const city = CITY_KEYS.find(c => name.startsWith(c));
  if (city) {
    const p = PROVINCE_ORDER.indexOf(CITY_PROVINCE[city]);
    return (p < 0 ? 34 : p) * 100 + 1;
  }
  return 3400;
}

function cctvRank(name) {
  if (/^cctv-?4k/i.test(name)) return 180;
  if (/^cctv-?8k/i.test(name)) return 185;
  if (/^cctv\+/i.test(name)) return 190;
  if (/^cgtn/i.test(name)) {
    if (/纪录/.test(name)) return 213;
    const lang = ['英语', '西班牙语', '法语', '俄语', '阿拉伯语'].findIndex(l => name.includes(l));
    return 200 + (lang < 0 ? 9 : lang);
  }
  const m = name.match(/^cctv-?(\d+)(\+)?/i);
  if (m) return +m[1] * 10 + (m[2] ? 1 : 0);
  if (/^cctv/i.test(name)) return 300; // CCTV 风云剧场等非编号频道
  return 310;
}

function regionRank(name) {
  if (/^(tvb|hoy|viutv|港台|凤凰|香港|翡翠|明珠|无线|now)/i.test(name) || /佳艺|亚洲电视|耀才/i.test(name)) return 0;
  if (/澳门|澳视|tdm/i.test(name)) return 1;
  return 2;
}

const byName = (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN');

function sortBucket(group, list) {
  if (group === '央视') return list.sort((a, b) => cctvRank(a.name) - cctvRank(b.name) || byName(a, b));
  if (group === '卫视' || group === '地方') {
    return list.sort((a, b) => provinceRank(a.name) - provinceRank(b.name) || byName(a, b));
  }
  if (group === '港澳台') return list.sort((a, b) => regionRank(a.name) - regionRank(b.name) || byName(a, b));
  return list.sort(byName);
}

// ---------- 抓取 ----------
// 读取监测结果里的存活 URL 集合，用于“同频道优先选活的线路”
async function fetchAliveUrls() {
  try {
    const res = await fetch(STATUS_URL, {
      headers: { 'User-Agent': 'itv-hub' },
      cf: { cacheTtl: 600 },
    });
    if (!res.ok) return new Set();
    const s = await res.json();
    return new Set((s.results || []).filter(r => r.ok).map(r => r.url));
  } catch {
    return new Set();
  }
}

async function fetchSource(source) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 8000) : null;
  try {
    const res = await fetch(source.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; itv-hub/1.0)' },
      signal: ctrl ? ctrl.signal : undefined,
      cf: { cacheTtl: 600 },
    });
    if (!res.ok) return { source: source.name, ok: false, count: 0, error: `HTTP ${res.status}` };
    const text = await res.text();
    return { source: source.name, ok: true, count: parseM3U(text, source).length, items: parseM3U(text, source) };
  } catch (e) {
    return { source: source.name, ok: false, count: 0, error: String(e && e.message || e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function build() {
  const [results, aliveUrls] = await Promise.all([Promise.all(SOURCES.map(fetchSource)), fetchAliveUrls()]);
  const all = [];
  for (const r of results) if (r.items) all.push(...r.items);

  // 去重：同一频道（dedupeKey 相同）输出多条线路，供播放器手动切换。
  // 排序规则：存活线路优先 → 直连优先（手机中转 itv2 会占用上行带宽，排最后）→ 源优先级。
  all.sort((a, b) => a.priority - b.priority);
  const candidates = new Map();
  for (const it of all) {
    if (isJunk(it.name)) continue;
    const key = dedupeKey(it.name);
    if (!key) continue;
    if (!candidates.has(key)) candidates.set(key, []);
    candidates.get(key).push(it);
  }
  const kept = [];
  let preferAliveHits = 0;
  let multiLineChannels = 0;
  for (const list of candidates.values()) {
    const scored = list.map(it => ({
      it,
      dead: aliveUrls.size ? (aliveUrls.has(it.url) ? 0 : 1) : 0,
      relay: RELAY_HOST.test(it.url) ? 1 : 0,
    })).sort((a, b) => a.dead - b.dead || a.relay - b.relay || a.it.priority - b.it.priority);
    const aliveOnes = scored.filter(s => !s.dead);
    // 一条存活线路都没有时，退回优先级最高的那条，避免频道整组消失
    const picked = (aliveOnes.length ? aliveOnes : scored.slice(0, 1)).slice(0, MAX_LINES);
    if (scored[0].it !== list[0]) preferAliveHits++;
    if (picked.length > 1) multiLineChannels++;
    const primary = picked[0].it;
    for (const s of picked) {
      // 同名多线路统一名称 / tvg-id / logo，便于播放器识别为同一频道
      kept.push({ ...s.it, name: primary.name, tvgId: primary.tvgId, logo: primary.logo, group: classify(primary.name, primary.upstreamGroup) });
    }
  }

  // 分组 + 组内排序（央视按台号，卫视/地方按省份，港澳台按地区）
  const buckets = new Map(GROUPS.map(g => [g, []]));
  for (const it of kept) {
    if (!buckets.has(it.group)) buckets.set(it.group, []);
    buckets.get(it.group).push(it);
  }
  for (const g of GROUPS) sortBucket(g, buckets.get(g));

  const emit = (onlyAlive) => {
    const lines = ['#EXTM3U'];
    let count = 0;
    for (const g of GROUPS) {
      const list = buckets.get(g) || [];
      if (!list.length) continue;
      const subset = onlyAlive ? list.filter(it => aliveUrls.has(it.url)) : list;
      if (!subset.length) continue;
      count += subset.length;
      for (const it of subset) {
        lines.push(`#EXTINF:-1 tvg-id="${it.tvgId}" tvg-name="${it.name}" tvg-logo="${it.logo}" group-title="${g}",${it.name}`);
        lines.push(it.url);
      }
    }
    return { text: lines.join('\n') + '\n', count };
  };

  const full = emit(false);
  const only = aliveUrls.size ? emit(true) : full; // 没有探测数据时不做过滤，避免输出空列表

  const stats = {
    generatedAt: new Date().toISOString(),
    total: full.count,
    channels: candidates.size,
    multiLineChannels,
    aliveTotal: only.count,
    groups: Object.fromEntries([...buckets].map(([g, l]) => [g, l.length])),
    probe: { aliveUrls: aliveUrls.size, preferAliveApplied: preferAliveHits },
    sources: results.map(r => ({ source: r.source, ok: r.ok, count: r.count, error: r.error })),
  };

  return { m3u: full.text, aliveM3u: only.text, stats };
}

// ---------- 缓存 ----------
function kvBinding(env) {
  return env && env.ITV_CACHE ? env.ITV_CACHE : null;
}

async function kvRead(env) {
  const kv = kvBinding(env);
  if (!kv) return null;
  try {
    const got = await kv.getWithMetadata(KV_KEY, { type: 'json' });
    if (!got || !got.value) return null;
    return { payload: got.value, ts: Number((got.metadata && got.metadata.ts) || 0) };
  } catch {
    return null;
  }
}

function kvWrite(env, payload) {
  const kv = kvBinding(env);
  if (!kv) return Promise.resolve();
  return kv.put(KV_KEY, JSON.stringify(payload), {
    expirationTtl: KV_TTL_SECONDS,
    metadata: { ts: Date.now(), generatedAt: payload.stats.generatedAt },
  }).catch(() => {});
}

async function l1Read() {
  try {
    const hit = await caches.default.match(new Request(L1_URL, { method: 'GET' }));
    return hit ? await hit.json() : null;
  } catch {
    return null;
  }
}

function l1Write(payload) {
  return caches.default.put(new Request(L1_URL, { method: 'GET' }), new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${CACHE_SECONDS}` },
  })).catch(() => {});
}

// 重建并同时刷新两级缓存
async function rebuild(env) {
  const payload = await build();
  await Promise.all([kvWrite(env, payload), l1Write(payload)]);
  return payload;
}

// ---------- 入口 ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 线路健康度：直接读监测仓库的 status.json（不触发聚合，响应最快）
    if (url.pathname === '/health') {
      const res = await fetch(STATUS_URL, { headers: { 'User-Agent': 'itv-hub' }, cf: { cacheTtl: 600 } });
      const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' };
      if (!res.ok) return new Response(JSON.stringify({ ok: false, error: `status.json HTTP ${res.status}` }), { status: 502, headers: jsonHeaders });
      const s = await res.json();
      return new Response(JSON.stringify({
        ok: true,
        generatedAt: s.generatedAt,
        total: s.total,
        alive: s.alive,
        dead: s.dead,
        aliveRate: s.aliveRate,
        deadSamples: s.results.filter(r => !r.ok).slice(0, 10).map(r => ({ name: r.name, httpStatus: r.httpStatus, kind: r.kind })),
      }, null, 2), { headers: jsonHeaders });
    }

    const bypass = url.searchParams.get('refresh') === '1';
    let payload = null;
    let cacheState = 'MISS';

    if (!bypass) {
      // L1：同机房内存缓存
      payload = await l1Read();
      if (payload) {
        cacheState = 'HIT-L1';
      } else {
        // L2：KV 全局缓存（跨机房），过期数据先返回、后台重建
        const kv = await kvRead(env);
        if (kv) {
          payload = kv.payload;
          cacheState = 'HIT-KV';
          if (Date.now() - kv.ts > CACHE_SECONDS * 1000) {
            cacheState = 'HIT-KV-STALE';
            ctx.waitUntil(rebuild(env).catch(() => {}));
          }
        }
      }
    }

    if (!payload) {
      payload = await build();
      ctx.waitUntil(Promise.all([kvWrite(env, payload), l1Write(payload)]).catch(() => {}));
    }

    if (url.pathname === '/stats') {
      return new Response(JSON.stringify({ ...payload.stats, cache: cacheState }, null, 2), {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'X-Cache': cacheState },
      });
    }


    // 只输出经监测确认存活的线路（频道有效性过滤）
    const onlyAlive = url.pathname === '/alive.m3u' || url.searchParams.get('alive') === '1';
    return new Response(onlyAlive ? payload.aliveM3u : payload.m3u, {
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
        'X-Cache': cacheState,
      },
    });
  },

  // 定时预热（wrangler.toml 里配置 crons）：每 30 分钟重建一次写入 KV，
  // 让任何机房的首次请求都能直接命中缓存，不必现场聚合 9 个源。
  async scheduled(event, env, ctx) {
    await rebuild(env);
  },
};
