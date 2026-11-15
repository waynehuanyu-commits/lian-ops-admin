// 攻略候选提醒：云函数定时任务 guideAuto 按 lib/guide-auto.js 打分，把「像攻略、又有人认」的帖子写成
// guides 里 kind=pick、reviewStatus=pending、autoPicked 的候选。这里由 wecom-auto 每轮检查，有新候选就发一条到内部企微群，
// 每条带帖子的小程序短链：用官号打开帖子 →「更多操作」→「设为攻略」就算确认；也可以在后台「黎安攻略 · 待审」通过 / 不通过。
// 发过的记 alertedAt，不重复提醒。2026-11-08 马飘定：圈选放给官号做，算法扫描 + 企微群人工确认。
const db = require('./db')

const MAX_LINES = 8

function clip(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function pagepathOf(row) {
  return row.refType === 'wall'
    ? `pages/wall-detail/wall-detail?id=${row.refId}`
    : `pages/forum-detail/forum-detail?id=${row.refId}`
}

function buildText(rows, links = {}) {
  const lines = rows.slice(0, MAX_LINES).map((row, i) => {
    const link = links[row.refId] ? `\n${links[row.refId]}` : ''
    return `${i + 1}. 【${row.category || '未分类'}】${clip(row.title, 30)}${link}`
  })
  const more = rows.length > MAX_LINES ? `\n…另有 ${rows.length - MAX_LINES} 条在后台「黎安攻略 · 待审」` : ''
  return `【攻略候选】算法挑了 ${rows.length} 条像攻略的帖子，确认后才会进黎安攻略。\n用官号打开帖子 →「更多操作」→「设为攻略」；不合适的到后台「黎安攻略 · 待审」点不通过。\n\n${lines.join('\n\n')}${more}`
}

/** @param {{ webhookUrl: Function, postJson: Function, shortLinks?: Function }} deps 复用 wecom-auto 的内部群 webhook 和短链 */
async function maybeSend({ webhookUrl, postJson, shortLinks }) {
  const url = webhookUrl()
  if (!url) return { sent: 0 }
  const rows = (await db.allDocs('guides', { kind: 'pick', reviewStatus: 'pending' }))
    .filter((row) => row.autoPicked && !row.alertedAt && row.refId)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
  if (!rows.length) return { sent: 0 }
  const links = shortLinks
    ? await shortLinks(rows.slice(0, MAX_LINES).map((row) => ({ contentId: row.refId, pagepath: pagepathOf(row) }))).catch(() => ({}))
    : {}
  const result = await postJson(url, { msgtype: 'text', text: { content: buildText(rows, links) } })
    .catch((err) => ({ errcode: -1, errmsg: err.message }))
  const ok = !result.errcode
  if (ok) {
    const now = Date.now()
    await Promise.all(rows.map((row) => db.updateDoc('guides', row.id || row._id, { alertedAt: now }).catch(() => {})))
  }
  return { sent: rows.length, ok }
}

module.exports = { maybeSend, buildText, pagepathOf }
