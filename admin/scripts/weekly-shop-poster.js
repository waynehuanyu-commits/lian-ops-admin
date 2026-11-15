#!/usr/bin/env node
// 每周好店海报：每周一按上周（周一到周日）同学推荐数出 Top3 海报，发内部群 webhook，内部同学再转发。
// 选店 / 推荐语 / 版式规则在 lib/weekly-poster.js。
// 用法：node scripts/weekly-shop-poster.js            出图 + 发群（cron 用）
//       --dry                                        只出图不发群，打印图片路径和选中的推荐语
//       --mock x.json                                本地调试：不连线上库，用 json 里的 { shops, weekly, quotes, images }
//       --now 2026-11-16T09:00:00+08:00              假装在这个时间跑（补发 / 调试）
//       --force                                      第 1 期之前也出图（只配合 --dry 试跑用）
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const { loadEnv } = require('../../server/load-env')

const ADMIN_DIR = path.join(__dirname, '..')
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : '' }

function loadAdminEnv() {
  loadEnv()
  const file = path.join(ADMIN_DIR, '.env')
  if (!fs.existsSync(file)) return
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line) => {
    const text = line.trim()
    const index = text.indexOf('=')
    if (!text || text.startsWith('#') || index < 1) return
    const key = text.slice(0, index).trim()
    if (!process.env[key]) process.env[key] = text.slice(index + 1).trim()
  })
}
loadAdminEnv()

const poster = require('../lib/weekly-poster')
const FONT_DIR = path.join(ADMIN_DIR, 'assets', 'poster-fonts')
const QR_FILE = path.join(ADMIN_DIR, 'data', 'poster', 'guide-qr.png')
const QR_PAGE = 'pages/guide/guide'
const QUOTE_DAYS = 60
const WEBHOOK_IMAGE_MAX = 2 * 1024 * 1024

function log(...parts) {
  process.stdout.write(`[${new Date().toISOString()}] ${parts.join(' ')}\n`)
}

// ---------- 取数 ----------

async function weeklyCounts(db, week) {
  const _ = db.getDb().command
  const rows = []
  for (let skip = 0; ; skip += 1000) {
    const res = await db.getDb().collection('shop_recommends')
      .where({ createdAt: _.gte(week.start).and(_.lt(week.end)) })
      .skip(skip).limit(1000).get()
    rows.push(...(res.data || []))
    if (!res.data || res.data.length < 1000) break
  }
  return rows.reduce((acc, row) => ({ ...acc, [row.shopId]: (acc[row.shopId] || 0) + 1 }), {})
}

function isPublic(row) {
  return !row.reviewStatus || row.reviewStatus === 'approved'
}

/** 同学说过这家店的话：挂了这家店的帖子 / 评论，加上正文提到店名或别名的 */
async function quoteCandidates(db, shop, since) {
  const database = db.getDb()
  const _ = database.command
  const names = [shop.name, ...(shop.aliases || [])]
    .map((n) => String(n || '').replace(/[^一-龥A-Za-z0-9]/g, '').trim())
    .filter((n) => n.length >= 2)
  const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const out = []
  for (const [collection, field] of [['comments', 'content'], ['forum_posts', 'content']]) {
    const attached = await database.collection(collection)
      .where({ 'shopRefs.id': shop.id, createdAt: _.gte(since) }).limit(100).get().catch(() => ({ data: [] }))
    ;(attached.data || []).filter(isPublic).forEach((row) => out.push({ text: row[field], createdAt: row.createdAt, attached: true, from: collection }))
    for (const name of names) {
      const reg = database.RegExp({ regexp: escape(name), options: 'i' })
      const res = await database.collection(collection)
        .where({ [field]: reg, createdAt: _.gte(since) }).orderBy('createdAt', 'desc').limit(50).get().catch(() => ({ data: [] }))
      ;(res.data || []).filter(isPublic).forEach((row) => out.push({ text: row[field], createdAt: row.createdAt, attached: false, from: collection }))
    }
  }
  return out
}

async function download(url, file) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`下载失败 ${res.status} ${url.slice(0, 80)}`)
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()))
  return file
}

async function shopImages(shop, dir) {
  const urls = (shop.imageUrls || []).filter(Boolean).slice(0, 3)
  const files = []
  for (let i = 0; i < urls.length; i += 1) {
    try {
      files.push(await download(urls[i], path.join(dir, `${shop.id}-${i}${path.extname(new URL(urls[i]).pathname) || '.jpg'}`)))
    } catch (err) {
      log('图片跳过', shop.name, err.message)
    }
  }
  return files
}

// 小程序码（扫码进攻略页）：生成一次存本地，以后复用
async function guideQr() {
  if (fs.existsSync(QR_FILE)) return QR_FILE
  const { MINI_APPID: appid, MINI_SECRET: secret } = process.env
  if (!appid || !secret) throw new Error('admin/.env 缺 MINI_APPID / MINI_SECRET，生成不了小程序码')
  // stable_token 不会让后台其他地方拿着的 token 失效
  const tk = await fetch('https://api.weixin.qq.com/cgi-bin/stable_token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credential', appid, secret })
  }).then((r) => r.json())
  if (!tk.access_token) throw new Error(`小程序 token 失败：${tk.errcode} ${tk.errmsg}`)
  const res = await fetch(`https://api.weixin.qq.com/wxa/getwxacode?access_token=${encodeURIComponent(tk.access_token)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: QR_PAGE, width: 430 })
  })
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf[0] === 0x7b) throw new Error(`小程序码失败：${buf.toString('utf8').slice(0, 200)}`)
  fs.mkdirSync(path.dirname(QR_FILE), { recursive: true })
  fs.writeFileSync(QR_FILE, buf)
  return QR_FILE
}

// ---------- 出图 / 发群 ----------

function chromeBin() {
  const list = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean)
  const found = list.find((p) => fs.existsSync(p))
  if (!found) throw new Error('找不到 Chrome，设 CHROME_BIN')
  return found
}

function render(html, dir) {
  const htmlFile = path.join(dir, 'poster.html')
  const out = path.join(dir, 'poster.jpeg')
  fs.writeFileSync(htmlFile, html)
  execFileSync(chromeBin(), [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
    '--force-device-scale-factor=1', '--window-size=1080,1440', '--virtual-time-budget=15000',
    `--screenshot=${out}`, `file://${htmlFile}`
  ], { stdio: 'ignore', timeout: 120000 })
  if (!fs.existsSync(out)) throw new Error('Chrome 没出图')
  return out
}

async function sendImage(file) {
  const url = process.env.WECOM_WEBHOOK_URL
  if (!url) throw new Error('没配 WECOM_WEBHOOK_URL')
  const buf = fs.readFileSync(file)
  if (buf.length > WEBHOOK_IMAGE_MAX) throw new Error(`图片 ${Math.round(buf.length / 1024)}KB 超过企微 2MB 上限`)
  const body = { msgtype: 'image', image: { base64: buf.toString('base64'), md5: crypto.createHash('md5').update(buf).digest('hex') } }
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())
  if (res.errcode) throw new Error(`企微发图失败：${res.errcode} ${res.errmsg}`)
}

async function sendText(content) {
  const res = await fetch(process.env.WECOM_WEBHOOK_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msgtype: 'text', text: { content } })
  }).then((r) => r.json())
  if (res.errcode) throw new Error(`企微发字失败：${res.errcode} ${res.errmsg}`)
}

// ---------- 主流程 ----------

async function loadLive(week, tmp) {
  const db = require('../lib/db')
  if (db.useLocal()) throw new Error('现在是本地演示库（admin/.env 没读到），不出图')
  const shops = require('../lib/shops')
  const shopStats = require('../lib/shop-stats')
  const [list, weekly, stats] = await Promise.all([shops.listShops(), weeklyCounts(db, week), shopStats.summary().catch(() => ({ shops: {} }))])
  const views = Object.fromEntries(Object.entries(stats.shops || {}).map(([id, s]) => [id, (s.w7 && s.w7.views) || 0]))
  const top = poster.pickTop(list.items || [], weekly, views)
  const since = week.end - QUOTE_DAYS * 24 * 3600 * 1000
  const entries = []
  for (const shop of top) {
    entries.push({ shop, candidates: await quoteCandidates(db, shop, since), images: await shopImages(shop, tmp) })
  }
  return { entries, qr: await guideQr() }
}

function loadMock(file, tmp) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  const top = poster.pickTop(data.shops, data.weekly, data.views || {})
  const base = path.dirname(path.resolve(file))
  const entries = top.map((shop) => ({
    shop,
    candidates: (data.quotes || {})[shop.id] || [],
    images: ((data.images || {})[shop.id] || []).map((p) => path.resolve(base, p))
  }))
  return { entries, qr: path.resolve(base, data.qr || '') }
}

async function main() {
  const now = opt('--now') ? Date.parse(opt('--now')) : Date.now()
  const week = poster.lastWeek(now)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-poster-'))
  const dry = flag('--dry') || !!opt('--mock')
  log('统计区间', week.label, `VOL.${week.vol}`)
  // 马飘 11-08 定：先攒一周推荐，第 1 期 11-16 出（统计 11.09—11.15），之前 cron 跑到也不发
  if (week.start < poster.FIRST_WEEK_START && !flag('--force') && !opt('--mock')) {
    log('还没到第 1 期，跳过（要试跑加 --dry --force）')
    return
  }

  const { entries, qr } = opt('--mock') ? loadMock(opt('--mock'), tmp) : await loadLive(week, tmp)
  if (!entries.length) {
    log('上周没有新的同学推荐，本期不出图')
    if (!dry) await sendText(`【本周好店】${week.label} 没有新的同学推荐，本期海报暂停。`)
    return
  }

  const shaped = entries.map(({ shop, candidates, images }, index) => {
    const max = index === 0 ? poster.QUOTE_MAX.main : poster.QUOTE_MAX.side
    const picked = poster.pickQuote(candidates, max)
    return {
      name: shop.name, need: shop.need, week: shop.week, images,
      quote: picked ? picked.quote : '',
      fact: picked ? '' : poster.factLine(shop, max),
      source: picked ? picked.source : null
    }
  })
  const file = render(poster.buildHtml(shaped, week, { fontDir: FONT_DIR, qr }), tmp)
  const note = shaped.map((e, i) => `${i + 1}. ${e.name}  上周 ${e.week} 人推荐 · 图 ${e.images.length} 张\n   ${e.quote ? `推荐语：${e.quote}\n   原话：${String(e.source.text || '').slice(0, 60)}` : `没挑到同学原话，用了店铺信息：${e.fact}`}`).join('\n')
  log('出图', file)
  process.stdout.write(`${note}\n`)
  if (dry) return

  await sendImage(file)
  await sendText(`【本周好店】${week.label} 海报已出，上图可直接转发。\n核对一下推荐语（只给内部看，不用转发）：\n${note}`)
  log('已发内部群')
}

main().catch(async (err) => {
  log('失败', err && err.stack ? err.stack : err)
  if (!flag('--dry') && !opt('--mock') && process.env.WECOM_WEBHOOK_URL) {
    await sendText(`【本周好店】海报生成失败：${err.message}`).catch(() => {})
  }
  process.exit(1)
})
