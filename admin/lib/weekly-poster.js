// 每周好店海报：选店、挑同学原话、拼 HTML。不碰数据库和网络，测试见 scripts/test-weekly-poster.js
// 版式 2026-11-08 和马飘定稿（每周好店海报/top3-v4.html）：第一名三图主角，二三名横排两图配角。
// 推荐语只用同学真话；挑不到就写店铺事实，不加引号，绝不编。

const DAY_MS = 24 * 3600 * 1000
const BEIJING_MS = 8 * 3600 * 1000
// 第 1 期统计的是 2026-11-09（周一）到 11-15，11-16 周一出图
const FIRST_WEEK_START = Date.UTC(2026, 10, 9) - BEIJING_MS
const TOP_N = 3
const QUOTE_MAX = { main: 34, side: 20 }
const QUOTE_MIN = 8
// 夸不出口的话：差评、吐槽、疑问都不能当推荐语
const NEGATIVE = /一般|难吃|踩雷|避雷|别去|不推荐|不好吃|拉胯|翻车|失望|难喝|差评|太贵|坑|退款|投诉|恶心|无语|垃圾|服了|不行|退全款/
const QUESTION = /[?？]|吗|哪里|在哪|有没有|求推荐|怎么样|如何/

/** 上一个完整的自然周（北京时间周一 00:00 到下周一 00:00），now 一般是周一早上 */
function lastWeek(now = Date.now()) {
  const bj = new Date(now + BEIJING_MS)
  const dayStart = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - BEIJING_MS
  const weekday = (bj.getUTCDay() + 6) % 7 // 周一 = 0
  const end = dayStart - weekday * DAY_MS
  const start = end - 7 * DAY_MS
  const vol = Math.max(1, Math.round((start - FIRST_WEEK_START) / (7 * DAY_MS)) + 1)
  return { start, end, vol, label: `${md(start)}—${md(end - DAY_MS)}` }
}

function md(ms) {
  const d = new Date(ms + BEIJING_MS)
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}.${String(d.getUTCDate()).padStart(2, '0')}`
}

/** 本周推荐数排前 n 的上线店；同票看累计推荐，再看本周进店浏览 */
function pickTop(shops, weekly, views = {}, n = TOP_N) {
  return (shops || [])
    .filter((shop) => shop && shop.status === 'online' && (weekly[shop._id || shop.id] || 0) > 0)
    .map((shop) => {
      const id = shop._id || shop.id
      return { ...shop, id, week: weekly[id] || 0, total: Number(shop.recommendCount) || 0, views: views[id] || 0 }
    })
    .sort((a, b) => b.week - a.week || b.total - a.total || b.views - a.views)
    .slice(0, n)
}

function cleanText(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/@\S+/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\[[^\]]{1,6}\]/g, '') // 微信表情 [捂脸]
    .replace(/(哈){2,}|(h){3,}/gi, '')
    .replace(/\s+/g, '，')
    .replace(/，*([。！!，,；;~～…])，*/g, '$1')
    .replace(/^[，,。！!、\s]+|[，,、\s]+$/g, '')
    .trim()
}

/** 从一段话开头截出 ≤max 字的完整分句；截不出来返回空 */
function headSentences(text, max) {
  const parts = text.match(/[^。！!；;~～…]+[。！!；;~～…]*/g) || []
  let out = ''
  for (const part of parts) {
    if ((out + part).length > max) break
    out += part
  }
  if (!out && text.length <= max) out = text
  return out.replace(/[，,；;、]$/, '').replace(/!/g, '！')
}

/** 店铺介绍这种不怕截断的：整句放不下就截到最后一个逗号，再不行硬截加省略号 */
function clip(text, max) {
  const whole = headSentences(text, max)
  if (whole) return whole
  const head = text.slice(0, max)
  const comma = Math.max(head.lastIndexOf('，'), head.lastIndexOf(','))
  return comma >= 6 ? head.slice(0, comma) : `${text.slice(0, max - 1)}…`
}

/** 候选 [{ text, createdAt, attached }] → 最合适的一句；attached 表示评论挂了这家店 */
function pickQuote(candidates, max) {
  const scored = []
  ;(candidates || []).forEach((c) => {
    const quote = headSentences(cleanText(c.text), max)
    if (quote.length < QUOTE_MIN || NEGATIVE.test(quote) || QUESTION.test(quote)) return
    scored.push({ quote, source: c, score: (c.attached ? 1000 : 0) + Math.min(quote.length, max) + (Number(c.createdAt) || 0) / 1e13 })
  })
  scored.sort((a, b) => b.score - a.score)
  return scored[0] || null
}

/** 没有同学原话时的一行事实：介绍 > 标签 > 分类+地址 */
function factLine(shop, max) {
  const intro = cleanText(shop.intro)
  if (intro) return clip(intro, max)
  const tags = (shop.tags || []).filter(Boolean).slice(0, 3).join(' · ')
  if (tags) return tags
  return [shop.need, shop.address].filter(Boolean).join(' · ').slice(0, max)
}

function esc(text) {
  return String(text == null ? '' : text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
}

function img(src, extra = '') {
  return `<div class="ph"${extra}><img src="${esc(src)}"></div>`
}

function line(entry) {
  return entry.quote ? `<q>${esc(entry.quote)}</q>` : `<p class="fact">${esc(entry.fact)}</p>`
}

function mainBlock(e) {
  const pics = e.images.slice(0, 3)
  const sticker = '<div class="sticker"><div><b>TOP1</b>本周第一</div></div>'
  const grid = pics.length >= 3
    ? `<div class="p1">${img(pics[0], ' data-big').replace('<img', sticker + '<img')}${img(pics[1])}${img(pics[2])}</div>`
    : pics.length === 2
      ? `<div class="p1 two">${img(pics[0], ' data-big').replace('<img', sticker + '<img')}${img(pics[1])}</div>`
      : `<div class="p1 one">${img(pics[0] || '', ' data-big').replace('<img', sticker + '<img')}</div>`
  return `${grid}
  <div class="c1">
    <div class="name"><span class="no">01</span><h2>${esc(e.name)}</h2><span class="n"><b>${e.week}</b>人推荐</span></div>
    ${line(e)}
  </div>`
}

function sideBlock(e, rank, top) {
  const pics = e.images.slice(0, 2)
  const cls = pics.length >= 2 ? 'row' : 'row single'
  return `<div class="${cls}" style="top:${top}px">
    ${pics.map((src) => img(src)).join('')}
    <div class="txt">
      <div class="name"><span class="no">0${rank}</span><h3>${esc(e.name)}</h3></div>
      <div class="n"><b>${e.week}</b>人推荐${e.need ? ` · ${esc(e.need)}` : ''}</div>
      ${line(e)}
    </div>
  </div>`
}

/** entries：[{ name, need, week, images:[本地路径], quote|fact }]；assets：{ fontDir, qr } */
function buildHtml(entries, week, assets) {
  const count = ['', '一', '两', '三'][entries.length] || entries.length
  const hasQuote = entries.some((e) => e.quote)
  const font = (family, file) => `@font-face{font-family:"${family}";src:url("file://${assets.fontDir}/${file}");font-weight:100 900;font-display:block}`
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>本周好店</title><style>
${font('Noto Sans SC', 'NotoSansSC.ttf')}
${font('Noto Serif SC', 'NotoSerifSC.ttf')}
${font('Oswald', 'Oswald.ttf')}
:root{--brand:#084BD8;--lime:#C7E31A;--ink:#0E1830;--ink-2:#3b4458;--ink-3:#7A8294;--line:rgba(14,24,48,.16);--bg:#f4f1ea}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);font-family:"Noto Sans SC",sans-serif;color:var(--ink);width:1080px;height:1440px;overflow:hidden}
.poster{width:1080px;height:1440px;position:relative;overflow:hidden;background:var(--bg)}
.grain{position:absolute;inset:0;opacity:.3;background-image:radial-gradient(rgba(0,0,0,.05) 1px,transparent 1px);background-size:5px 5px}
.ph{position:relative;min-width:0;min-height:0}
.ph img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:8px;display:block}
.bar{position:absolute;left:60px;right:60px;top:52px;display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid var(--ink);padding-bottom:14px;font-size:22px;letter-spacing:3px;font-weight:700}
.bar b{color:var(--brand)}
.bar span{font-family:Oswald;font-weight:500;letter-spacing:2px;color:var(--ink-2)}
.head{position:absolute;left:56px;right:60px;top:104px;display:flex;justify-content:space-between;align-items:flex-end}
.head h1{font-family:"Noto Serif SC";font-weight:900;font-size:124px;line-height:1;letter-spacing:6px}
.head h1 i{font-style:normal;color:var(--brand)}
.head .sub{font-size:22px;color:var(--ink-3);margin:14px 0 0 6px;letter-spacing:2px}
.qr{width:112px;height:112px;display:block}
.qrcap{font-size:16px;color:var(--ink-3);text-align:center;margin-top:6px}
.p1{position:absolute;left:60px;right:60px;top:296px;height:430px;display:grid;grid-template-columns:2.15fr 1fr;grid-template-rows:1fr 1fr;gap:10px}
.p1 [data-big]{grid-row:1/3}
.p1.two{grid-template-columns:1.6fr 1fr;grid-template-rows:1fr}
.p1.two [data-big]{grid-row:auto}
.p1.one{grid-template-columns:1fr;grid-template-rows:1fr}
.p1.one [data-big]{grid-row:auto}
.sticker{position:absolute;left:-22px;top:-26px;width:128px;height:128px;border-radius:50%;background:var(--lime);display:grid;place-items:center;text-align:center;transform:rotate(-10deg);box-shadow:0 8px 20px rgba(0,0,0,.16);font-weight:700;font-size:15px;letter-spacing:1px;line-height:1.15;z-index:3}
.sticker b{display:block;font-family:Oswald;font-size:44px;line-height:1;color:var(--brand)}
.c1{position:absolute;left:60px;right:60px;top:748px}
.c1 .name{display:flex;align-items:baseline;gap:16px}
.c1 .no{font-family:Oswald;font-weight:700;font-size:72px;line-height:.9;color:var(--brand)}
.c1 h2{font-family:"Noto Serif SC";font-weight:900;font-size:46px;letter-spacing:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:720px}
.c1 .n{margin-left:auto;font-size:22px;color:var(--ink-2);white-space:nowrap}
.c1 .n b{font-family:Oswald;font-size:50px;color:var(--brand);margin-right:4px}
.c1 q{display:block;margin-top:16px;font-family:"Noto Serif SC";font-weight:700;font-size:26px;line-height:1.5;color:var(--ink-2);padding-left:18px;border-left:5px solid var(--lime);quotes:"“" "”"}
.c1 .fact{margin-top:16px;font-size:24px;color:var(--ink-2)}
.rule{position:absolute;left:60px;right:60px;top:902px;border-top:1.5px solid var(--line)}
.row{position:absolute;left:60px;right:60px;height:196px;display:grid;grid-template-columns:300px 150px 1fr;gap:10px}
.row.single{grid-template-columns:460px 1fr}
.row .txt{padding-left:30px;display:flex;flex-direction:column;justify-content:center;min-width:0}
.row .name{display:flex;align-items:baseline;gap:12px}
.row .no{font-family:Oswald;font-weight:700;font-size:44px;line-height:1;color:var(--ink)}
.row h3{font-family:"Noto Serif SC";font-weight:900;font-size:34px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .n{font-size:18px;color:var(--ink-3);margin-top:6px}
.row .n b{font-family:Oswald;font-weight:500;font-size:26px;color:var(--ink-2);margin-right:3px}
.row q{display:block;margin-top:14px;font-family:"Noto Serif SC";font-weight:700;font-size:21px;line-height:1.5;color:var(--ink-2);quotes:"“" "”"}
.row .fact{margin-top:14px;font-size:19px;color:var(--ink-2)}
.foot{position:absolute;left:60px;right:60px;bottom:28px;border-top:3px solid var(--ink);padding-top:12px;font-size:17px;color:var(--ink-3)}
</style></head><body><section class="poster">
  <div class="grain"></div>
  <div class="bar"><div><b>黎安话事</b> · 同学推荐榜</div><span>VOL.${String(week.vol).padStart(2, '0')}  ${week.label}</span></div>
  <div class="head">
    <div><h1>本周<i>好店</i></h1><div class="sub">上周同学们推荐最多的${count}家</div></div>
    <div><img class="qr" src="${esc(assets.qr)}"><div class="qrcap">去攻略看全部</div></div>
  </div>
  ${entries[0] ? mainBlock(entries[0]) : ''}
  ${entries.length > 1 ? '<div class="rule"></div>' : ''}
  ${entries[1] ? sideBlock(entries[1], 2, 924) : ''}
  ${entries[2] ? sideBlock(entries[2], 3, 1144) : ''}
  <div class="foot">${hasQuote ? '推荐语来自黎安话事同学评价 · ' : ''}按上周同学推荐人数排，每周一更新</div>
</section></body></html>`
}

module.exports = { FIRST_WEEK_START, lastWeek, pickTop, pickQuote, factLine, cleanText, headSentences, buildHtml, QUOTE_MAX, TOP_N }
