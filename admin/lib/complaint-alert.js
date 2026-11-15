// 侵权投诉提醒：小程序里新提交的攻略侵权投诉（reports 里 targetType 'guide'、reason 'copyright'），
// 由 wecom-auto 每轮检查时发一条到内部企微群，提醒运营 24 小时内去后台「举报工单」核实。
// 只发标题和投诉人身份，不发联系方式（联系方式只在后台可见）。发过的记 alertedAt，不重复提醒。
const db = require('./db')

const MAX_LINES = 5

function clip(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function buildText(rows) {
  const lines = rows.slice(0, MAX_LINES).map((row, i) => `${i + 1}. 《${clip(row.targetTitle || row.targetId, 24)}》· ${row.claimantLabel || '投诉人'}：${clip(row.note, 40)}`)
  const more = rows.length > MAX_LINES ? `\n…另有 ${rows.length - MAX_LINES} 条` : ''
  return `【侵权投诉】收到 ${rows.length} 条攻略侵权投诉，请在 24 小时内到后台「举报工单」核实：属实下架，不属实点「投诉不成立」。\n${lines.join('\n')}${more}`
}

/** @param {{ webhookUrl: Function, postJson: Function }} deps 复用 wecom-auto 的内部群 webhook */
async function maybeSend({ webhookUrl, postJson }) {
  const url = webhookUrl()
  if (!url) return { sent: 0 }
  const rows = (await db.allDocs('reports', { targetType: 'guide', status: 'pending' }))
    .filter((row) => row.reason === 'copyright' && !row.alertedAt)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
  if (!rows.length) return { sent: 0 }
  const result = await postJson(url, { msgtype: 'text', text: { content: buildText(rows) } })
    .catch((err) => ({ errcode: -1, errmsg: err.message }))
  const ok = !result.errcode
  if (ok) {
    const now = Date.now()
    await Promise.all(rows.map((row) => db.updateDoc('reports', row.id || row._id, { alertedAt: now }).catch(() => {})))
  }
  return { sent: rows.length, ok }
}

module.exports = { maybeSend, buildText }
