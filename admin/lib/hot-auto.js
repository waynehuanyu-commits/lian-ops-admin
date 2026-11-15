// 「园区热议」自动上榜：每 10 分钟按讨论热度重排 weekly_hot/current（首页轮播从前几名里按时段轮换，园区热议页列全榜）。
// 只在推送进程里跑（wecom-auto.js 的 tick 调用），8788 手动进程不跑。
//
// 规则：
// - 候选：近 7 天公开的帖子（论坛 + 校园墙），至少有 1 条评论或 1 个赞；
//   热度 = (评论×5 + 围观×0.08 + 赞×1) ÷ (1 + 发帖天数/2)。园区里大家不太点赞，主要看评论和围观；
//   2026-11 起窗口缩到 3 天、衰减收紧到 2 天减半：以前 7 天窗口 + 7 天衰减，高评论老帖能连占一周，首页每天一样
// - 新帖保送：24 小时内发的、已有互动的帖子里，热度最高的一条排在自动位第一，新话题不用等攒够评论
// - 手动项到期：后台手动加入 / 移动的帖子 24 小时后退回自动排序（manualAt 记时间），不再永久占位
// - 后台人工的优先：后台「加入热榜」「上移/下移」过的帖子标 source=manual，固定在原位置；
//   后台「移除」的进 board.blocked，自动上榜永远不再选它（后台可恢复）；其余位置按热度自动填满 BOARD_SIZE 条
// - 风险把关：候选先过 push-risk.js classifyForPush，风险 / 争议的不上榜，
//   并往内部群 webhook 发一条【运营提醒·勿转发】（每帖只提醒一次），没问题的话运营到后台手动加入
// - board.auto === false 时整个停掉，回到纯人工

const db = require('./db')
const { classifyForPush } = require('./push-risk')

const BOARD_SIZE = 10
const WINDOW_MS = 3 * 24 * 3600 * 1000 // 候选窗口
const ALERT_TTL_MS = 7 * 24 * 3600 * 1000 // 风险提醒去重记多久
const DECAY_DAYS = 2
const FRESH_MS = 24 * 3600 * 1000
const MANUAL_TTL_MS = 24 * 3600 * 1000
const REFRESH_MS = 10 * 60 * 1000
const ALERT_ID = 'hot_auto_alerts'
let lastRunAt = 0

function heatScore(post, now) {
  const ageDays = Math.max(0, (now - (post.createdAt || now)) / 86400000)
  const heat = (Number(post.commentCount) || 0) * 5 + (Number(post.viewCount) || 0) * 0.08 + (Number(post.likeCount) || 0)
  return heat / (1 + ageDays / DECAY_DAYS)
}

function keyOf(item) {
  return `${item.contentType === 'forum' ? 'forum' : 'wall'}:${item.contentId}`
}

function titleOf(post, type) {
  const title = String(post.title || '').trim()
  if (title) return title
  if (type === 'wall' && (post.routeFrom || post.routeTo)) return `${post.routeFrom || '出发地'} → ${post.routeTo || '目的地'}`
  return String(post.content || '').replace(/\s+/g, ' ').trim().slice(0, 30) || '（无标题）'
}

async function recentCandidates(now) {
  const since = now - WINDOW_MS
  const out = []
  for (const [collection, type] of [['forum_posts', 'forum'], ['wall_posts', 'wall']]) {
    const rows = await db.recentDocs(collection, 200).catch(() => [])
    rows
      .filter((post) => (post.createdAt || 0) >= since)
      .filter((post) => (Number(post.commentCount) || 0) + (Number(post.likeCount) || 0) > 0)
      .forEach((post) => out.push({ type, post, score: heatScore(post, now) }))
  }
  out.sort((a, b) => b.score - a.score)
  // 新帖保送：24 小时内热度最高的一条放最前
  const fresh = out.findIndex((row) => now - (row.post.createdAt || 0) < FRESH_MS)
  if (fresh > 0) out.unshift(out.splice(fresh, 1)[0])
  return out
}

/** 手动项超过 24 小时退回自动；没记时间的老数据从现在起算 */
function expireManual(items, now) {
  return items.map((item) => {
    if (item.source !== 'manual') return item
    const at = Number(item.manualAt) || 0
    if (!at) return { ...item, manualAt: now }
    return now - at > MANUAL_TTL_MS ? { ...item, source: 'auto', manualAt: undefined } : item
  })
}

async function sendOpsAlert(text) {
  const url = process.env.WECOM_WEBHOOK_URL
  if (!url) return false
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'text', text: { content: text } })
  }).then((r) => r.json()).catch(() => ({ errcode: -1 }))
  return !res.errcode
}

/** 被风险把关拦下的帖子，每帖只提醒一次（记 7 天） */
async function alertSkipped(skipped, now) {
  if (!skipped.length) return
  const doc = (await db.getDoc('meta', ALERT_ID).catch(() => null)) || { id: ALERT_ID, keys: {} }
  const keys = Object.fromEntries(Object.entries(doc.keys || {}).filter(([, at]) => now - at < ALERT_TTL_MS))
  const fresh = skipped.filter((s) => !keys[s.key])
  if (!fresh.length) return
  const lines = fresh.map((s) => `「${titleOf(s.post, s.type)}」\n原因：${s.reasons.join('；')}`)
  const ok = await sendOpsAlert(`【运营提醒·勿转发】园区热议自动上榜拦下 ${fresh.length} 条热帖：\n\n${lines.join('\n\n')}\n\n确认没问题的话，到运营后台「园区热议」手动加入。`)
  if (!ok) return
  fresh.forEach((s) => { keys[s.key] = now })
  await db.setDoc('meta', ALERT_ID, { id: ALERT_ID, keys }).catch(() => {})
}

/** 人工固定的留在原位，其余位置按热度填 */
function compose(current, autoPicks) {
  const manual = current.filter((item) => item.source === 'manual')
  const size = Math.max(BOARD_SIZE, manual.length)
  const slots = new Array(size).fill(null)
  manual.forEach((item) => {
    let at = Math.min(current.indexOf(item), size - 1)
    while (slots[at]) at = (at + 1) % size
    slots[at] = item
  })
  const queue = autoPicks.slice()
  for (let i = 0; i < size; i += 1) if (!slots[i] && queue.length) slots[i] = queue.shift()
  return slots.filter(Boolean).map((item, index) => ({ ...item, rank: index + 1 }))
}

async function refresh(now = Date.now(), { force = false } = {}) {
  if (!force && now - lastRunAt < REFRESH_MS) return { skipped: 'throttled' }
  lastRunAt = now
  const board = await db.getDoc('weekly_hot', 'current').catch(() => null)
  if (!board || board.auto === false) return { skipped: 'manual_mode' }
  const blocked = new Set((board.blocked || []).map(keyOf))
  // 旧数据没有 source 的一律按自动处理，参与重排
  const current = expireManual((board.items || []).map((item) => ({ ...item, source: item.source === 'manual' ? 'manual' : 'auto' })), now)
  const manualKeys = new Set(current.filter((item) => item.source === 'manual').map(keyOf))
  const need = Math.max(0, BOARD_SIZE - manualKeys.size)
  const picks = []
  const skipped = []
  for (const { type, post } of await recentCandidates(now)) {
    if (picks.length >= need) break
    const key = `${type}:${post.id || post._id}`
    if (blocked.has(key) || manualKeys.has(key)) continue
    const verdict = classifyForPush(post)
    if (verdict.level !== 'ok') {
      // 不公开的帖子不算「被拦」，直接跳过不提醒
      if (verdict.reasons[0] !== '帖子当前不公开') skipped.push({ key, type, post, reasons: verdict.reasons })
      continue
    }
    picks.push({ contentType: type, contentId: post.id || post._id, source: 'auto', pinnedAt: now })
  }
  // 冷清的时候新热帖不够，空位留着上一轮自动选的，别让首页空掉（下架的帖子读榜时会被过滤掉）
  const picked = new Set(picks.map(keyOf))
  // 留用的旧自动项也要重新过一遍风险（规则会更新，早先上榜的帖子可能现在不合格）
  const retained = current.filter((item) => item.source === 'auto' && !blocked.has(keyOf(item)) && !picked.has(keyOf(item)))
  const retainedPosts = await Promise.all(retained.map((item) => db.getDoc(item.contentType === 'forum' ? 'forum_posts' : 'wall_posts', item.contentId).catch(() => null)))
  retained
    .filter((item, i) => retainedPosts[i] && classifyForPush(retainedPosts[i]).level === 'ok')
    .slice(0, Math.max(0, need - picks.length))
    .forEach((item) => picks.push(item))
  const items = compose(current, picks)
  const before = (board.items || []).map((i) => `${keyOf(i)}${i.source === 'manual' ? '*' : ''}`).join(',')
  const after = items.map((i) => `${keyOf(i)}${i.source === 'manual' ? '*' : ''}`).join(',')
  if (before !== after || JSON.stringify(current) !== JSON.stringify(board.items || [])) await db.setDoc('weekly_hot', 'current', { ...board, items, autoAt: now, updatedAt: now })
  await alertSkipped(skipped, now).catch(() => {})
  return { changed: before !== after, count: items.length, auto: picks.length, skipped: skipped.length }
}

module.exports = { refresh, compose, heatScore, expireManual, BOARD_SIZE }
