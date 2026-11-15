// 店铺数据（给商家看的效果数据）：小程序云函数按北京时间每天写一个 meta/shopstat_<YYYYMMDD>，
// 里面 views（浏览，打开店铺页）/ exposure（卡片曝光）各是 { 店铺id: 次数 }。
// 曝光先进云函数 bumpExposure 的 10 分钟桶，由 exposure-fold 调 addExposure 合进来；格式要和云函数 bumpShopStat 一致。
const db = require('./db')

const FIELDS = ['exposure', 'views']
const DAY_MS = 24 * 3600 * 1000
const BEIJING_MS = 8 * 3600 * 1000

function dayKey(ms) {
  return new Date(ms + BEIJING_MS).toISOString().slice(0, 10).replace(/-/g, '')
}

function docId(day) {
  return `shopstat_${day}`
}

/** 把一批曝光加到某天（day 为 YYYYMMDD） */
async function addExposure(day, counts) {
  const ids = Object.keys(counts || {}).filter((id) => counts[id] > 0)
  if (!ids.length) return
  const id = docId(day)
  const doc = await db.getDoc('meta', id).catch(() => null)
  if (!doc || db.useLocal()) {
    const prev = (doc && doc.exposure) || {}
    const exposure = { ...prev }
    ids.forEach((key) => { exposure[key] = (Number(prev[key]) || 0) + counts[key] })
    await db.setDoc('meta', id, { ...(doc || {}), kind: 'shop_stat', day, exposure, createdAt: (doc && doc.createdAt) || Date.now() })
    return
  }
  const _ = db.getDb().command
  const inc = {}
  ids.forEach((key) => { inc[key] = _.inc(counts[key]) })
  await db.updateDoc('meta', id, { exposure: inc })
}

function emptyRow(day) {
  return FIELDS.reduce((row, key) => ({ ...row, [key]: 0 }), { day })
}

/** 最近 days 天（含今天）每天每家店的数字：[{ day, perShop: { id: {exposure, views, ...} } }]，旧的在前 */
async function readDays(days = 30, now = Date.now()) {
  const list = Array.from({ length: days }, (_, i) => dayKey(now - (days - 1 - i) * DAY_MS))
  const docs = await Promise.all(list.map((day) => db.getDoc('meta', docId(day)).catch(() => null)))
  return list.map((day, i) => {
    const doc = docs[i] || {}
    const perShop = {}
    FIELDS.forEach((field) => {
      Object.entries(doc[field] || {}).forEach(([id, n]) => {
        perShop[id] = perShop[id] || emptyRow(day)
        perShop[id][field] = Number(n) || 0
      })
    })
    return { day, perShop }
  })
}

function sum(rows) {
  return rows.reduce((acc, row) => {
    FIELDS.forEach((key) => { acc[key] += row[key] || 0 })
    return acc
  }, emptyRow(''))
}

/**
 * 每家店：d7 近 7 天、prev7 前 7 天、d30 近 30 天合计（都只算已过完的天，不含今天，给商家数据卡用），
 * today 今天、w7 近 7 天含今天（后台店铺列表给运营看），daily 是近 31 天逐日（最后一天是今天，后台明细表用）
 */
async function summary(now = Date.now()) {
  const days = await readDays(31, now)
  const ids = new Set(days.flatMap((d) => Object.keys(d.perShop)))
  const out = {}
  ids.forEach((id) => {
    const daily = days.map((d) => d.perShop[id] || emptyRow(d.day))
    out[id] = {
      today: daily[daily.length - 1],
      w7: sum(daily.slice(-7)),
      d7: sum(daily.slice(-8, -1)),
      prev7: sum(daily.slice(-15, -8)),
      d30: sum(daily.slice(0, -1)),
      daily
    }
  })
  return { days: days.map((d) => d.day), shops: out }
}

module.exports = { FIELDS, dayKey, addExposure, readDays, summary, emptyRow }
