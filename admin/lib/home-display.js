// 首页展示设置：存 meta/home_display，运营后台「首页展示设置」改，小程序云函数 getHomeDisplay 读、
// 推送进程（secondhand-digest.js）读二手汇总的开关和时间。没配过时用 DEFAULTS。
const db = require('./db')

const DOC_ID = 'home_display'
const DEFAULTS = {
  carouselPostSlots: 2, // 园区热议轮播：前几位放热帖，其余放攻略
  carouselTotal: 6, // 轮播总张数
  carouselPostPool: 6, // 热帖从榜单前几名里每 3 小时轮换
  carouselArticleSlots: 2, // 攻略位里放几篇公众号推文，和投稿交叉排
  feedGuideEvery: 6, // 首页信息流每隔几条帖子插一排攻略，0 = 不插
  messagesGuidePicks: 4, // 消息页「攻略精选」篇数，0 = 不显示
  secondhandEnabled: true, // 二手闲置汇总推内部群，每天两次：午间 + 晚间
  secondhandNoonTime: '', // 午间那次，留空 = 不推午间（2026-11-11 起闲置每天只推晚间一次）
  secondhandTime: '21:00', // 晚间那次
  carpoolEnabled: true, // 每晚拼车汇总推内部群
  carpoolTime: '21:00',
  helpEnabled: true, // 每晚帮帮群汇总（跑腿、代取、借东西）推内部群
  helpTime: '21:00',
  teamEnabled: true, // 每晚竞赛组队汇总推内部群，运营转发到竞赛组队群
  teamTime: '21:00'
}
const RANGES = {
  carouselPostSlots: [0, 6],
  carouselTotal: [1, 8],
  carouselPostPool: [1, 10],
  carouselArticleSlots: [0, 6],
  feedGuideEvery: [0, 20],
  messagesGuidePicks: [0, 6]
}

function normalize(raw = {}) {
  const out = { ...DEFAULTS }
  Object.keys(RANGES).forEach((key) => {
    const n = Math.round(Number(raw[key]))
    if (Number.isFinite(n)) out[key] = Math.min(RANGES[key][1], Math.max(RANGES[key][0], n))
  })
  if (out.feedGuideEvery > 0 && out.feedGuideEvery < 3) out.feedGuideEvery = 3
  out.carouselPostSlots = Math.min(out.carouselPostSlots, out.carouselTotal)
  if (typeof raw.secondhandEnabled === 'boolean') out.secondhandEnabled = raw.secondhandEnabled
  const time = String(raw.secondhandTime || '').trim()
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) out.secondhandTime = time
  const noon = String(raw.secondhandNoonTime == null ? out.secondhandNoonTime : raw.secondhandNoonTime).trim()
  if (noon === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(noon)) out.secondhandNoonTime = noon
  if (typeof raw.carpoolEnabled === 'boolean') out.carpoolEnabled = raw.carpoolEnabled
  const carpoolTime = String(raw.carpoolTime || '').trim()
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(carpoolTime)) out.carpoolTime = carpoolTime
  if (typeof raw.helpEnabled === 'boolean') out.helpEnabled = raw.helpEnabled
  const helpTime = String(raw.helpTime || '').trim()
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(helpTime)) out.helpTime = helpTime
  if (typeof raw.teamEnabled === 'boolean') out.teamEnabled = raw.teamEnabled
  const teamTime = String(raw.teamTime || '').trim()
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(teamTime)) out.teamTime = teamTime
  return out
}

async function getDisplay() {
  const row = await db.getDoc('meta', DOC_ID).catch(() => null)
  return { ...normalize(row || {}), updatedAt: (row && row.updatedAt) || 0, updatedBy: (row && row.updatedBy) || '' }
}

async function saveDisplay(payload = {}, operator = '') {
  // 和已存的合并：「首页展示设置」和「闲置/拼车汇总」两个页面各改各的字段，互不覆盖
  const current = (await db.getDoc('meta', DOC_ID).catch(() => null)) || {}
  const next = { ...normalize({ ...current, ...payload }), id: DOC_ID, updatedAt: Date.now(), updatedBy: operator }
  await db.setDoc('meta', DOC_ID, next)
  return { ok: true, display: next }
}

/** 二手汇总最近一次处理记录（secondhand-digest.js 写） */
async function secondhandState() {
  return (await db.getDoc('meta', 'secondhand_digest_state').catch(() => null)) || null
}

/** 拼车汇总最近一次处理记录 */
async function carpoolState() {
  return (await db.getDoc('meta', 'carpool_digest_state').catch(() => null)) || null
}

module.exports = { getDisplay, saveDisplay, secondhandState, carpoolState, normalize, DEFAULTS }
