// 企微自动推送（需设置 WECOM_AUTO_SEND=1 才启动；
// 8788 那个手动进程不设，避免同一批推两次）。
//
// 链路：发帖 / 人工审核通过 → digest_queue（每帖一条 dq_<帖子id>，见 utils/home-feed.js digestQueueItem）
//      → 本模块每 2 分钟看一次，三种情况会推（都只在 08:00–00:30 之间，夜里攒的留到早上 8 点）：
//        1) 固定时段 08:00 / 12:10 / 13:50 / 17:20 / 20:00 / 22:30 / 00:30，有几条推几条
//        2) 两个时段之间提前推：内部群模式攒够 4 条就推；客户群模式要攒够 8 条且距上次满 1 小时
//        3) 有急事帖（push-risk.js isUrgent）：内部群模式下一次检查就推；客户群模式急事之间至少隔 30 分钟
//        每次把可推的全部推完：每条群消息最多 8 帖，多了分几条连着发，编号连续，急事排前面标【急】
//      → 推送前按 push-risk.js 分级：风险内容不推；争议内容先发企微消息给确认人，确认后进下一轮
//      → 发到哪：配了 WECOM_WEBHOOK_URL 就发内部群（现在的做法，见 pushRoundWebhook），内部同学转发到学生群；
//        否则走客户群群发，由群主在企业微信里点「发送」才进群，且每个群每天只能收 1 条
//
// 为什么放在服务器而不是云函数：企微只认「企业可信IP」，部署时需在企微后台配置运行主机的固定出口 IP。
// 配置在 server/.env：WECOM_CORP_ID / WECOM_SECRET / WECOM_AGENT_ID / WECOM_CHAT_ID（多群逗号分隔）/
// WECOM_CONFIRM_USERS / PUSH_CONFIRM_BASE / PUSH_CONFIRM_SECRET；小程序短链用 admin/.env 的 MINI_APPID / MINI_SECRET。

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const db = require('./db')
const { classifyForPush, isUrgent } = require('./push-risk')
const pushConfirm = require('./push-confirm')
const exposureFold = require('./exposure-fold')
const hotAuto = require('./hot-auto')
const secondhandDigest = require('./secondhand-digest')
const complaintAlert = require('./complaint-alert')
const guideCandidateAlert = require('./guide-candidate-alert')
const homeFeed = require('../../utils/home-feed')

const PER_MESSAGE = 8
// 北京时间的固定时段；00:30 算前一天晚上的最后一轮
const SLOTS = ['08:00', '12:10', '13:50', '17:20', '20:00', '22:30', '24:30']
// 00:30 那一轮留 10 分钟窗口（每 2 分钟才检查一次），00:40 起到 08:00 不推
const QUIET_START = 40
const QUIET_END = 8 * 60 // 08:00 之前
const VOLUME_TRIGGER = 8
const VOLUME_GAP_MS = 60 * 60 * 1000
const URGENT_GAP_MS = 30 * 60 * 1000
// 内部群 webhook 模式：攒够这么多条就推，不看距上次多久；急事不设间隔
const INTERNAL_VOLUME_TRIGGER = 4
const MIN = 60 * 1000
const TICK_MS = 2 * 60 * 1000
const RETRY_PAUSE_MS = 30 * 60 * 1000
const STATE_ID = 'wecom_push_state'
const COVER_FILE = path.join(__dirname, '../../images/share-card.jpg')
const WECOM_HOST = 'https://qyapi.weixin.qq.com'
const WX_HOST = 'https://api.weixin.qq.com'
const LINK_TITLE = '看帖'

let running = false
let pausedUntil = 0
// 运行状态：推送进程每次检查后写进 meta/wecom_push_live（心跳），
// 这样后台不管从哪个入口 / 哪个进程打开，看到的都是推送进程的真实状态
const LIVE_ID = 'wecom_push_live'
const live = { started: false, startedAt: 0, lastTickAt: 0, lastTick: null, lastPush: null }
// 总开关存在 meta/wecom_push_control，后台可暂停 / 恢复；1 分钟内复用，少读库
const CONTROL_ID = 'wecom_push_control'
let controlCache = { enabled: true, at: 0 }
let coverCache = { id: '', at: 0 }
// 已建好、还没确认发送的群发任务。「点发送」只能由群主账号在企业微信客户端完成，系统代点不了，
// 所以这里做的是：建任务后立即多渠道提醒，15 分钟还没发送再催（企微应用消息 + 可选飞书/通用 webhook）
const pendingTasks = []
const REMIND_AFTER_MS = 15 * MIN
const REMIND_GAP_MS = 30 * MIN
const ownerCache = new Map()

function uid(prefix) {
  return `${prefix}${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`
}

async function getJson(url) {
  return fetch(url).then((res) => res.json())
}

async function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then((res) => res.json())
}

async function wecomToken() {
  const data = await getJson(`${WECOM_HOST}/cgi-bin/gettoken?corpid=${process.env.WECOM_CORP_ID}&corpsecret=${process.env.WECOM_SECRET}`)
  if (data.errcode) throw new Error(`企微 token 失败：${data.errcode} ${data.errmsg}`)
  return data.access_token
}

// 去掉被截成半个的表情（孤立代理字符），否则企微整条报 40058
function cleanText(text) {
  return String(text || '').replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')
}

function clip(text, max) {
  return Array.from(cleanText(text)).slice(0, max).join('')
}

/** 小程序卡片封面：企微临时素材 3 天有效，这里 2 天内复用同一个 */
async function coverMediaId(token) {
  if (coverCache.id && Date.now() - coverCache.at < 2 * 24 * 3600 * 1000) return coverCache.id
  if (!fs.existsSync(COVER_FILE)) return ''
  const form = new FormData()
  form.append('media', new Blob([fs.readFileSync(COVER_FILE)], { type: 'image/jpeg' }), 'cover.jpg')
  const data = await fetch(`${WECOM_HOST}/cgi-bin/media/upload?access_token=${token}&type=image`, {
    method: 'POST',
    body: form
  }).then((res) => res.json())
  if (data.errcode || !data.media_id) return ''
  coverCache = { id: data.media_id, at: Date.now() }
  return data.media_id
}

/** 每条帖子一个小程序短链（#小程序://…），学生在微信群里点了能直接打开；失败就不放链接 */
async function shortLinks(items) {
  if (!process.env.MINI_APPID || !process.env.MINI_SECRET) return {}
  try {
    const tk = await getJson(`${WX_HOST}/cgi-bin/token?grant_type=client_credential&appid=${process.env.MINI_APPID}&secret=${process.env.MINI_SECRET}`)
    if (!tk.access_token) return {}
    const out = {}
    for (const item of items) {
      const res = await postJson(`${WX_HOST}/wxa/genwxashortlink?access_token=${tk.access_token}`, {
        page_url: item.pagepath,
        // 固定短标题：上面一行已经有帖子标题，链接里再重复一遍显得乱
        page_title: LINK_TITLE,
        is_permanent: false
      })
      if (res.link) out[item.contentId] = res.link
    }
    return out
  } catch (err) {
    return {}
  }
}

/** 群消息正文：只有编号列表，不加前后缀；编号在同一轮的两条消息里连续 */
// 没写标题的帖子，标题就是正文开头：按句读重新断，不另起一行摘要（旧队列里还有硬切 20 字的标题）
function lineOf(item) {
  const title = cleanText(item.title)
  const summary = cleanText(item.summary)
  const base = title.replace(/…$/, '')
  if (summary && summary.startsWith(base)) return homeFeed.headlineOf(summary)
  return summary ? `${title}\n${homeFeed.headlineOf(summary, 24)}` : title
}

function buildText(items, links, startIndex = 1) {
  return clip(items.map((item, index) => {
    const link = links[item.contentId] ? `\n${links[item.contentId]}` : ''
    return `${startIndex + index}. ${item.urgent ? '【急】' : ''}${lineOf(item)}${link}`
  }).join('\n\n'), 3900)
}

/** 要推的客户群：后台「推送目标」里启用的群，没有就用 WECOM_CHAT_ID（可逗号分隔多个） */
async function targetChatIds() {
  const groups = await db.allDocs('distribute_targets').catch(() => [])
  const ids = groups
    .filter((item) => item.enabled !== false && item.receiveDigest && item.chatId)
    .map((item) => item.chatId)
  if (ids.length) return ids
  return String(process.env.WECOM_CHAT_ID || '').split(',').map((s) => s.trim()).filter(Boolean)
}

/** 客户群群发的发送人必须是群主：按群查群主，同一个群主的群合成一条群发 */
async function groupsByOwner(token, chatIds) {
  const out = {}
  for (const chatId of chatIds) {
    let owner = ownerCache.get(chatId)
    if (!owner) {
      const res = await postJson(`${WECOM_HOST}/cgi-bin/externalcontact/groupchat/get?access_token=${token}`, { chat_id: chatId })
      owner = (res.group_chat && res.group_chat.owner) || ''
      if (owner) ownerCache.set(chatId, owner)
    }
    if (!owner) continue
    out[owner] = (out[owner] || []).concat(chatId)
  }
  return out
}

async function createGroupMessage(token, payload, digestId, title) {
  const url = `${WECOM_HOST}/cgi-bin/externalcontact/add_msg_template?access_token=${token}`
  const cover = await coverMediaId(token).catch(() => '')
  if (cover && process.env.MINI_APPID) {
    const withCard = await postJson(url, {
      ...payload,
      attachments: [{
        msgtype: 'miniprogram',
        miniprogram: {
          title: clip(title, 20),
          pic_media_id: cover,
          appid: process.env.MINI_APPID,
          page: `pages/digest/digest.html?id=${digestId}`
        }
      }]
    })
    if (!withCard.errcode) return { ...withCard, card: true }
    // 小程序没关联企微（90208）等原因发不了卡片，退回纯文字
    const textOnly = await postJson(url, payload)
    return { ...textOnly, card: false, cardError: `${withCard.errcode} ${withCard.errmsg}` }
  }
  return { ...(await postJson(url, payload)), card: false }
}

// 暂停时可带 resumeAt（毫秒），到点自动恢复
async function isEnabled(now = Date.now()) {
  if (now - controlCache.at < 60 * 1000) return controlCache.enabled
  const doc = await db.getDoc('meta', CONTROL_ID).catch(() => null)
  controlCache = { enabled: !doc || doc.enabled !== false || (doc.resumeAt > 0 && now >= doc.resumeAt), resumeAt: (doc && doc.resumeAt) || 0, at: now }
  return controlCache.enabled
}

async function setEnabled(enabled, operator = '', resumeAt = 0) {
  const doc = { id: CONTROL_ID, enabled: !!enabled, resumeAt: enabled ? 0 : resumeAt, updatedAt: Date.now(), updatedBy: operator }
  await db.setDoc('meta', CONTROL_ID, doc)
  controlCache = { enabled: !!enabled, resumeAt: doc.resumeAt, at: Date.now() }
  return doc
}

/** 提醒渠道，默认全关（只有群主账号一个人点发送，企微「群发助手」本身会提醒）。
 * 想启用：服务器 server/.env 里配 WECOM_NOTIFY_USERS（企微 userid，逗号分隔）收应用消息，和 / 或 PUSH_NOTIFY_WEBHOOK（飞书群机器人地址） */
async function sendNotice(token, text) {
  const out = []
  const users = String(process.env.WECOM_NOTIFY_USERS || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (users.length && process.env.WECOM_AGENT_ID) {
    const r = await postJson(`${WECOM_HOST}/cgi-bin/message/send?access_token=${token}`, {
      touser: users.join('|'), msgtype: 'text', agentid: Number(process.env.WECOM_AGENT_ID), text: { content: text }
    }).catch((e) => ({ errcode: -1, errmsg: e.message }))
    out.push({ channel: 'wecom', ok: !r.errcode, err: r.errmsg })
  }
  if (process.env.PUSH_NOTIFY_WEBHOOK) {
    const r = await postJson(process.env.PUSH_NOTIFY_WEBHOOK, { msg_type: 'text', content: { text } }).catch((e) => ({ code: -1, msg: e.message }))
    out.push({ channel: 'webhook', ok: r.code === 0 || r.StatusCode === 0, err: r.msg })
  }
  return out
}

/** 一轮推送建好群发后：登记待确认 + 立即提醒 */
async function registerPending(token, results) {
  const made = []
  for (const r of results) {
    if (!r.ok) continue
    for (const s of r.sends) {
      if (s.result && s.result.msgid) made.push({ digestId: r.digest, msgid: s.result.msgid, createdAt: Date.now(), remindedAt: 0, count: r.count })
    }
  }
  if (!made.length) return
  pendingTasks.push(...made)
  if (!process.env.WECOM_NOTIFY_USERS && !process.env.PUSH_NOTIFY_WEBHOOK) return
  const posts = results.filter((r) => r.ok).reduce((n, r) => n + r.count, 0)
  await sendNotice(token, `【待发送】有 ${posts} 条帖子等群主点发送（${made.length} 条群发）。请群主账号打开企业微信「群发助手」点发送，发出后才会进群。`).catch(() => {})
}

/** 已建 15 分钟还没人点发送的，查企微确认没发就再提醒；已发送的移出，超过 6 小时的不再追 */
async function remindPending(now) {
  for (let i = pendingTasks.length - 1; i >= 0; i -= 1) if (now - pendingTasks[i].createdAt > 6 * 3600 * 1000) pendingTasks.splice(i, 1)
  const due = pendingTasks.filter((t) => now - t.createdAt > REMIND_AFTER_MS && now - t.remindedAt > REMIND_GAP_MS)
  if (!due.length || (!process.env.WECOM_NOTIFY_USERS && !process.env.PUSH_NOTIFY_WEBHOOK)) return
  const token = await wecomToken()
  const unsent = []
  for (const t of due) {
    const res = await postJson(`${WECOM_HOST}/cgi-bin/externalcontact/get_groupmsg_task?access_token=${token}`, { msgid: t.msgid, limit: 5 }).catch(() => ({}))
    if ((res.task_list || []).some((x) => x.status === 2)) pendingTasks.splice(pendingTasks.indexOf(t), 1)
    else unsent.push(t)
  }
  if (!unsent.length) return
  const mins = Math.round((now - Math.min(...unsent.map((t) => t.createdAt))) / MIN)
  await sendNotice(token, `【还没发送】有 ${unsent.reduce((n, t) => n + t.count, 0)} 条帖子的群发已等了 ${mins} 分钟，群主账号还没点发送。请去企业微信「群发助手」处理。`).catch(() => {})
  unsent.forEach((t) => { t.remindedAt = now })
}

// 群发送达结果（get_groupmsg_send_result 的 status）：1 已进群；2、3 是企微拒收
const REJECT_TEXT = { 2: '客户不是好友', 3: '该群已收到过其他群发（企微频率限制）' }
// 建了群发一直没人点发送，超过这个时间就撤回任务、帖子放回队列
const UNSENT_GIVEUP_MS = 3 * 3600 * 1000

/** 查一次群发的送达情况：delivered / rejected / unsent / unknown（接口出错，下次再查） */
async function deliveryOf(token, sends) {
  const statuses = []
  for (const s of sends) {
    const res = await postJson(`${WECOM_HOST}/cgi-bin/externalcontact/get_groupmsg_send_result?access_token=${token}`, {
      msgid: s.result.msgid, userid: s.sender, limit: 100
    }).catch(() => ({ errcode: -1 }))
    if (res.errcode) return { verdict: 'unknown' }
    statuses.push(...(res.send_list || []).map((x) => Number(x.status)))
  }
  if (statuses.includes(1)) return { verdict: 'delivered' }
  const rejected = statuses.find((code) => REJECT_TEXT[code])
  if (rejected) return { verdict: 'rejected', reason: REJECT_TEXT[rejected] }
  return { verdict: 'unsent' }
}

function backToQueue(item) {
  const { inflight, inflightAt, ...rest } = item
  return rest
}

/** 每 2 分钟：看「已发出待确认」的帖子进没进群。进了才出队；被拒收、或 3 小时没人点发送就放回队列 */
async function checkDelivery(now) {
  const flying = (await db.allDocs('digest_queue').catch(() => [])).filter((item) => item.inflight)
  if (!flying.length) return
  const byDigest = {}
  flying.forEach((item) => { byDigest[item.inflight] = (byDigest[item.inflight] || []).concat(item) })
  const token = await wecomToken()
  for (const [digestId, items] of Object.entries(byDigest)) {
    const digest = await db.getDoc('digests', digestId).catch(() => null)
    const sends = ((digest && digest.wecom && digest.wecom.sends) || []).filter((s) => s.result && s.result.msgid)
    if (!sends.length) {
      // 没有 msgid 可查（推送记录被删等），没法确认，按老办法直接出队，免得卡在队列里
      await Promise.all(items.map((item) => db.removeDoc('digest_queue', item.id).catch(() => {})))
      continue
    }
    const { verdict, reason } = await deliveryOf(token, sends)
    if (verdict === 'unknown') continue
    const age = now - Math.min(...items.map((item) => item.inflightAt || now))
    if (verdict === 'unsent' && age < UNSENT_GIVEUP_MS) continue
    let status = verdict
    if (verdict === 'delivered') {
      await Promise.all(items.map((item) => db.removeDoc('digest_queue', item.id).catch(() => {})))
    } else {
      if (verdict === 'unsent') {
        status = 'expired'
        // 撤回还没发的任务，免得群主之后再点发送，和放回队列后的新一轮重复
        for (const s of sends) await postJson(`${WECOM_HOST}/cgi-bin/externalcontact/cancel_groupmsg_send?access_token=${token}`, { msgid: s.result.msgid }).catch(() => {})
      }
      await Promise.all(items.map((item) => db.setDoc('digest_queue', item.id, backToQueue(item)).catch(() => {})))
    }
    if (digest) await db.setDoc('digests', digestId, { ...digest, wecomStatus: status }).catch(() => {})
    await db.setDoc('distribute_logs', uid('dl_'), {
      groupType: 'external', contentType: 'digest_result', contentId: digestId, title: (digest && digest.title) || '',
      itemCount: items.length, status, reasons: reason ? [reason] : [], createdAt: now
    }).catch(() => {})
    console.log(`[wecom-auto] ${digestId} ${items.length} 条 → ${status}${reason ? `（${reason}）` : ''}`)
  }
}

async function loadState() {
  return (await db.getDoc('meta', STATE_ID).catch(() => null)) || { lastPushAt: 0 }
}

/** 推送前分级：风险出队、争议等确认、可推的返回 */
async function sortQueue(token, queued) {
  const ready = []
  for (const item of queued) {
    if (item.confirm === 'approved' || item.pushChecked) { ready.push(item); continue }
    if (item.confirm === 'pending') continue
    if (item.confirm === 'rejected') { await db.removeDoc('digest_queue', item.id).catch(() => {}); continue }
    const post = await db.getDoc(item.contentType === 'wall' ? 'wall_posts' : 'forum_posts', item.contentId).catch(() => null)
    const verdict = classifyForPush(post)
    if (verdict.level === 'ok') {
      // 分级结果记在队列项上，之后每 2 分钟检查时不用再读帖子（省数据库请求）
      const checked = { ...item, pushChecked: true, urgent: isUrgent(post) }
      await db.setDoc('digest_queue', item.id, checked).catch(() => {})
      ready.push(checked)
      continue
    }
    if (verdict.level === 'risk') {
      await db.removeDoc('digest_queue', item.id).catch(() => {})
      await db.setDoc('distribute_logs', uid('dl_'), {
        contentType: 'push_skip', contentId: item.contentId, title: item.title,
        status: 'skipped_risk', reasons: verdict.reasons, createdAt: Date.now()
      }).catch(() => {})
      continue
    }
    const fullText = clip(`${(post && post.title) || ''}\n${(post && post.content) || ''}`.trim(), 600)
    const next = { ...item, confirm: 'pending', urgent: isUrgent(post), confirmReasons: verdict.reasons, fullText, notifiedAt: Date.now() }
    await db.setDoc('digest_queue', item.id, next)
    const sent = await pushConfirm.notifyConfirmers(token, next, verdict.reasons).catch((err) => ({ ok: false, error: err.message }))
    if (!sent.ok) console.warn(`[wecom-auto] 确认消息没发出：${sent.error}（这条留在队列，可到后台处理）`)
  }
  return ready
}

/** 真要推之前再看一眼帖子：入队后被删、被下架、被举报的不推，退回队列重新分级 */
async function recheckBeforePush(ready) {
  const out = []
  for (const item of ready) {
    if (item.confirm === 'approved') { out.push(item); continue }
    const post = await db.getDoc(item.contentType === 'wall' ? 'wall_posts' : 'forum_posts', item.contentId).catch(() => null)
    if (classifyForPush(post).level === 'ok') { out.push(item); continue }
    const { pushChecked, ...rest } = item
    await db.setDoc('digest_queue', item.id, rest).catch(() => {})
  }
  return out
}

function stripQueueFields(item) {
  const { _id, confirm, confirmReasons, fullText, notifiedAt, confirmedAt, confirmedLabel, pushChecked, ...rest } = item
  return rest
}

// ── 内部群 webhook 通道（2026-10-30 起默认用这个）──
// 客户群群发每个群每天只能收 1 条（企微「群发规则」），满足不了一天多轮，外部群又加不了机器人。
// 所以改成：推到内部群（群机器人 webhook，地址只放 server/.env 的 WECOM_WEBHOOK_URL），
// 内部同学看到后长按转发到学生群。没配 WECOM_WEBHOOK_URL 时退回下面的客户群群发。
// 只发帖子列表本身：不加提醒、不 @所有人，保证原样转发到学生群也干净。
// 内部群不怕打扰，推送条件放宽（见 pushReason 的 INTERNAL_*）：攒够 4 条就推、急事随到随推。
// webhook 文本消息最长 2048 字节，所以每条最多 8 帖且不超过 WEBHOOK_MAX_BYTES，超了拆成多条。
const WEBHOOK_MAX_BYTES = 1900

function webhookUrl() {
  return process.env.WECOM_WEBHOOK_URL || ''
}

/** 按条数和字节数把帖子切成多条消息，编号连续 */
function webhookChunks(picked, links) {
  const chunks = []
  let current = []
  for (const item of picked) {
    const next = current.concat(item)
    const start = chunks.reduce((n, c) => n + c.length, 0) + 1
    const bytes = Buffer.byteLength(buildText(next.map(stripQueueFields), links, start))
    if (current.length && (next.length > PER_MESSAGE || bytes > WEBHOOK_MAX_BYTES)) {
      chunks.push(current)
      current = [item]
    } else {
      current = next
    }
  }
  if (current.length) chunks.push(current)
  return chunks
}

async function pushRoundWebhook(ready, now) {
  const picked = ready.filter((item) => item.urgent).concat(ready.filter((item) => !item.urgent))
  const links = await shortLinks(picked)
  const results = []
  let index = 1
  for (const chunk of webhookChunks(picked, links)) {
    const items = chunk.map(stripQueueFields)
    const start = index
    index += items.length
    const digest = {
      id: uid('dg_'),
      items,
      title: `黎安话事 · ${items.length} 条新帖`,
      summary: items.map((item, i) => `${start + i}.${item.title}`).join(' ').slice(0, 120),
      source: 'wecom_webhook',
      createdAt: Date.now()
    }
    digest.pagepath = `pages/digest/digest?id=${digest.id}`
    digest.sharePath = `/pages/digest/digest?id=${digest.id}`
    const result = await postJson(webhookUrl(), { msgtype: 'text', text: { content: buildText(items, links, start) } })
      .catch((err) => ({ errcode: -1, errmsg: err.message }))
    const ok = !result.errcode
    const sends = [{ sender: 'webhook', result }]
    await db.setDoc('digests', digest.id, { ...digest, wecomStatus: ok ? 'internal' : 'failed', wecom: { sends } })
    await db.setDoc('distribute_logs', uid('dl_'), {
      groupType: 'internal', contentType: 'digest', contentId: digest.id, title: digest.title,
      summary: digest.summary, items, itemCount: items.length,
      status: ok ? 'internal' : 'failed', wecom: { sends }, createdAt: Date.now()
    })
    // 发进内部群就算完成，出队；失败的留在队列下次再推
    if (ok) await Promise.all(chunk.map((item) => db.removeDoc('digest_queue', item.id).catch(() => {})))
    results.push({ digest: digest.id, count: items.length, ok, sends })
  }
  return results
}

async function pushRound(token, ready, now = Date.now()) {
  if (webhookUrl()) return pushRoundWebhook(ready, now)
  // 全部推完，急事排前面
  const picked = ready.filter((item) => item.urgent).concat(ready.filter((item) => !item.urgent))
  const chatIds = await targetChatIds()
  if (!chatIds.length) throw new Error('没有绑定要推送的客户群（WECOM_CHAT_ID）')
  const owners = await groupsByOwner(token, chatIds)
  if (!Object.keys(owners).length) throw new Error('查不到客户群的群主')
  const links = await shortLinks(picked)
  const results = []
  for (let start = 0; start < picked.length; start += PER_MESSAGE) {
    const chunk = picked.slice(start, start + PER_MESSAGE)
    const items = chunk.map(stripQueueFields)
    const digest = {
      id: uid('dg_'),
      items,
      title: `黎安话事 · ${items.length} 条新帖`,
      summary: items.map((item, i) => `${start + i + 1}.${item.title}`).join(' ').slice(0, 120),
      source: 'wecom_auto',
      createdAt: Date.now()
    }
    digest.pagepath = `pages/digest/digest?id=${digest.id}`
    digest.sharePath = `/pages/digest/digest?id=${digest.id}`
    await db.setDoc('digests', digest.id, digest)
    const text = buildText(items, links, start + 1)
    const sends = []
    for (const [sender, ids] of Object.entries(owners)) {
      const payload = { chat_type: 'group', chat_id_list: ids, sender, text: { content: text } }
      sends.push({ sender, chatIds: ids, result: await createGroupMessage(token, payload, digest.id, digest.title) })
    }
    const ok = sends.some((s) => !s.result.errcode)
    await db.setDoc('digests', digest.id, { ...digest, wecomStatus: ok ? 'confirm' : 'failed', wecom: { sends } })
    await db.setDoc('distribute_logs', uid('dl_'), {
      groupType: 'external', contentType: 'digest', contentId: digest.id, title: digest.title,
      summary: digest.summary, items, itemCount: items.length,
      status: ok ? 'confirm' : 'failed', wecom: { sends }, createdAt: Date.now()
    })
    // 建成群发不等于进了群：群主可能没点发送，企微也可能拒收（同一个群收群发有频率限制）。
    // 所以先标成「已发出待确认」留在队列里，checkDelivery 查到真进群才移出，被拒收 / 一直没发就放回队列
    if (ok) await Promise.all(chunk.map((item) => db.setDoc('digest_queue', item.id, { ...item, inflight: digest.id, inflightAt: now }).catch(() => {})))
    results.push({ digest: digest.id, count: items.length, ok, sends })
  }
  await registerPending(token, results)
  return results
}

// 北京时间（服务器时区不一定是东八区）
function beijingMinutes(now) {
  const d = new Date(now + 8 * 3600 * 1000)
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}

function isQuiet(now) {
  const m = beijingMinutes(now)
  return m >= QUIET_START && m < QUIET_END
}

/** 最近一个已经到点的固定时段的时间戳（毫秒） */
function latestSlotAt(now) {
  const dayStart = Math.floor((now + 8 * 3600 * 1000) / (24 * 3600 * 1000)) * 24 * 3600 * 1000 - 8 * 3600 * 1000
  let latest = 0
  for (const offset of [0, -1]) {
    for (const slot of SLOTS) {
      const [h, m] = slot.split(':').map(Number)
      const at = dayStart + offset * 24 * 3600 * 1000 + (h * 60 + m) * MIN
      if (at <= now && at > latest) latest = at
    }
  }
  return latest
}

/** 这次该不该推、为什么；ready 是已过风险分级的可推帖子 */
function pushReason(state, ready, now) {
  if (!ready.length || isQuiet(now)) return ''
  const slotAt = latestSlotAt(now)
  if (slotAt > (state.lastSlotAt || 0)) return 'slot'
  // 00:30 之后只补最后一轮，不再提前推或插队
  if (beijingMinutes(now) >= 30 && beijingMinutes(now) < QUIET_START) return ''
  const internal = !!webhookUrl()
  const urgentGap = internal ? 0 : URGENT_GAP_MS
  if (ready.some((item) => item.urgent) && now - (state.lastUrgentAt || 0) >= urgentGap) return 'urgent'
  if (internal ? ready.length >= INTERNAL_VOLUME_TRIGGER : (ready.length >= VOLUME_TRIGGER && now - (state.lastPushAt || 0) >= VOLUME_GAP_MS)) return 'volume'
  return ''
}

/** 每 2 分钟一次：先合并曝光计数，再看要不要推；结果记进 live 供后台查看 */
function digestDeps() {
  return { webhookUrl, shortLinks, webhookChunks, buildText, postJson }
}

/** 后台「闲置/拼车汇总」页：手动立即推一次，exclude 是页面上没勾选的帖子 id */
function digestSendNow(kindKey, exclude = []) {
  return secondhandDigest.maybeSend(Date.now(), digestDeps(), { force: true, manual: true, kindKey, exclude })
}

async function tick(options = {}) {
  const result = await tickInner(options)
  live.lastTickAt = options.now || Date.now()
  live.lastTick = result
  if (result && result.results) live.lastPush = { at: live.lastTickAt, ...result }
  // 心跳：每 2 分钟 1 次写库
  if (live.started) {
    await db.setDoc('meta', LIVE_ID, {
      id: LIVE_ID,
      startedAt: live.startedAt,
      lastTickAt: live.lastTickAt,
      lastSkip: (result && result.skipped) || '',
      lastError: (result && result.error) || '',
      pending: pendingTasks.map((t) => ({ createdAt: t.createdAt, count: t.count })),
      pid: process.pid
    }).catch(() => {})
  }
  return result
}

async function tickInner({ force = false, now = Date.now() } = {}) {
  if (running) return { skipped: 'running' }
  running = true
  try {
    await exposureFold.fold(now).catch((err) => console.warn('[exposure-fold]', err && err.message))
    await remindPending(now).catch((err) => console.warn('[remind]', err && err.message))
    // 暂停时也查：群主点发送后要知道进没进群
    await checkDelivery(now).catch((err) => console.warn('[delivery]', err && err.message))
    // 园区热议自动上榜（自己按 10 分钟节流，和推送开关无关）
    await hotAuto.refresh(now).catch((err) => console.warn('[hot-auto]', err && err.message))
    // 侵权投诉提醒：和推送开关、夜间时段无关，有新投诉就发内部群
    await complaintAlert.maybeSend({ webhookUrl, postJson })
      .then((r) => { if (r.sent) console.log(`[complaint] 侵权投诉 ${r.sent} 条 → ${r.ok ? '已提醒内部群' : '失败，下轮重试'}`) })
      .catch((err) => console.warn('[complaint]', err && err.message))
    // 攻略候选提醒：算法挑的候选推内部群等人确认（和推送开关无关，夜间也不怕，内部群）
    await guideCandidateAlert.maybeSend({ webhookUrl, postJson, shortLinks })
      .then((r) => { if (r.sent) console.log(`[guide-candidate] 攻略候选 ${r.sent} 条 → ${r.ok ? '已发内部群' : '失败，下轮重试'}`) })
      .catch((err) => console.warn('[guide-candidate]', err && err.message))
    if (!force && !(await isEnabled(now))) return { skipped: 'disabled' }
    if (!force && now < pausedUntil) return { skipped: 'paused' }
    if (!force && isQuiet(now)) return { skipped: 'quiet' }
    // 21:00 二手闲置当日汇总（自己判断时间、一天一次）
    await secondhandDigest.maybeSend(now, digestDeps())
      .then((r) => { if (r && r.sent) console.log(`[secondhand] 今日二手 ${r.sent} 条 → ${r.ok ? '已发内部群' : '失败，稍后重试'}`) })
      .catch((err) => console.warn('[secondhand]', err && err.message))
    await secondhandDigest.maybeSend(now, digestDeps(), { kindKey: 'carpool' })
      .then((r) => { if (r && r.sent) console.log(`[carpool] 今日拼车 ${r.sent} 条 → ${r.ok ? '已发内部群' : '失败，稍后重试'}`) })
      .catch((err) => console.warn('[carpool]', err && err.message))
    await secondhandDigest.maybeSend(now, digestDeps(), { kindKey: 'help' })
      .then((r) => { if (r && r.sent) console.log(`[help] 今日帮帮群 ${r.sent} 条 → ${r.ok ? '已发内部群' : '失败，稍后重试'}`) })
      .catch((err) => console.warn('[help]', err && err.message))
    await secondhandDigest.maybeSend(now, digestDeps(), { kindKey: 'team' })
      .then((r) => { if (r && r.sent) console.log(`[team] 今日竞赛组队 ${r.sent} 条 → ${r.ok ? '已发内部群' : '失败，稍后重试'}`) })
      .catch((err) => console.warn('[team]', err && err.message))
    const state = await loadState()
    const queued = (await db.allDocs('digest_queue'))
      .filter((item) => !item.inflight)
      .sort((a, b) => ((a.queuedAt || 0) - (b.queuedAt || 0)) || String(a.id).localeCompare(String(b.id)))
    const slotAt = latestSlotAt(now)
    if (!queued.length) {
      // 到点但没帖子：记下这一轮已经过了，免得帖子晚到几分钟时被当成到点轮
      if (slotAt > (state.lastSlotAt || 0)) await db.setDoc('meta', STATE_ID, { ...state, id: STATE_ID, lastSlotAt: slotAt })
      return { queued: 0 }
    }
    const token = await wecomToken()
    const ready = await sortQueue(token, queued)
    const reason = force ? 'force' : pushReason(state, ready, now)
    if (!reason) {
      if (!ready.length && slotAt > (state.lastSlotAt || 0)) await db.setDoc('meta', STATE_ID, { ...state, id: STATE_ID, lastSlotAt: slotAt })
      return { queued: queued.length, ready: ready.length, skipped: 'not_due' }
    }
    const confirmed = await recheckBeforePush(ready)
    if (!confirmed.length) return { queued: queued.length, ready: 0 }
    const results = await pushRound(token, confirmed, now)
    const ok = results.some((r) => r.ok)
    if (ok) {
      pausedUntil = 0
      await db.setDoc('meta', STATE_ID, {
        id: STATE_ID,
        lastPushAt: now,
        lastSlotAt: Math.max(state.lastSlotAt || 0, slotAt),
        lastUrgentAt: ready.some((item) => item.urgent) ? now : (state.lastUrgentAt || 0)
      })
    } else {
      pausedUntil = now + RETRY_PAUSE_MS
    }
    results.forEach((r) => {
      const detail = r.ok ? (webhookUrl() ? '已发到内部群' : '已建群发，等群主确认发送') :`失败：${JSON.stringify(r.sends.map((s) => s.result))}`
      console.log(`[wecom-auto] (${reason}) ${r.digest} ${r.count} 条 → ${detail}`)
    })
    return { ok, reason, results }
  } catch (err) {
    pausedUntil = now + RETRY_PAUSE_MS
    console.error('[wecom-auto]', err && err.message)
    return { error: err && err.message }
  } finally {
    running = false
  }
}

function start() {
  if (process.env.WECOM_AUTO_SEND !== '1') return false
  if (!process.env.WECOM_CORP_ID || !process.env.WECOM_SECRET) {
    console.warn('[wecom-auto] 企微参数没配齐，自动推送未启动')
    return false
  }
  live.started = true
  live.startedAt = Date.now()
  setInterval(() => { tick() }, TICK_MS)
  setTimeout(() => { tick() }, 15000)
  console.log(webhookUrl()
    ? `[wecom-auto] 企微自动推送已启动（内部群）：固定时段 + 满 ${INTERNAL_VOLUME_TRIGGER} 条就推 + 急事随到随推，08:00–00:30`
    : `[wecom-auto] 企微自动推送已启动（客户群群发）：固定时段 + 满 ${VOLUME_TRIGGER} 条提前 + 急事插队，08:00–00:30`)
  return true
}

/**
 * 人工圈选（紧急时用）：运营在后台勾选帖子。
 * - now=true：立即推送这几条，不看时段、夜间和风险分级（运营自己把关），急事标记照常
 * - now=false：放进队列最前面并标为已确认，下一轮（时段 / 急事 / 满 8 条）优先推出
 */
async function pushPicked(picks, { now = false, operator = '' } = {}) {
  const items = []
  for (const pick of (picks || []).slice(0, 24)) {
    const type = pick && pick.contentType === 'wall' ? 'wall' : 'forum'
    const post = await db.getDoc(type === 'wall' ? 'wall_posts' : 'forum_posts', String((pick && pick.contentId) || '')).catch(() => null)
    if (!post) continue
    items.push({ ...homeFeed.digestQueueItem(post, type), queuedAt: 1, confirm: 'approved', pushChecked: true, urgent: isUrgent(post), manual: true, manualBy: operator })
  }
  if (!items.length) return { ok: false, message: '勾选的帖子不存在' }
  if (!now) {
    await Promise.all(items.map((item) => db.setDoc('digest_queue', item.id, item)))
    return { ok: true, queued: items.length }
  }
  if (running) return { ok: false, message: '推送正在进行，稍等几秒再点' }
  running = true
  try {
    const token = await wecomToken()
    // 圈选的帖子和自动队列同一个 id（dq_<帖子id>），推送后会覆盖成「已发出待确认」，不会重复推
    const results = await pushRound(token, items)
    const ok = results.some((r) => r.ok)
    if (ok) {
      // 人工推成功说明通道是通的，解除失败后的 30 分钟暂停
      pausedUntil = 0
      const state = await loadState()
      await db.setDoc('meta', STATE_ID, { ...state, id: STATE_ID, lastPushAt: Date.now() })
    }
    console.log(`[wecom-auto] (manual ${operator}) ${items.length} 条 → ${ok ? '已建群发' : '失败'}`)
    return { ok, results }
  } catch (err) {
    return { ok: false, message: err.message || '推送失败' }
  } finally {
    running = false
  }
}

/** 下一个固定时段（毫秒）；夜间返回早上 8 点 */
function nextSlotAt(now = Date.now()) {
  const dayStart = Math.floor((now + 8 * 3600 * 1000) / (24 * 3600 * 1000)) * 24 * 3600 * 1000 - 8 * 3600 * 1000
  const all = []
  for (const offset of [0, 1]) {
    for (const slot of SLOTS) {
      const [h, m] = slot.split(':').map(Number)
      all.push(dayStart + offset * 24 * 3600 * 1000 + (h * 60 + m) * MIN)
    }
  }
  return all.filter((at) => at > now).sort((a, b) => a - b)[0]
}

// 失败原因转成人话；兼容旧版记录（wecom.result / wecom.error）和新版（wecom.sends[]）
const ERR_TEXT = { 93000: '内部群机器人地址失效', 45009: '机器人发送太频繁', [-1]: '连不上企微', 60020:'服务器 IP 不在企微白名单', 41048: '发送人不是该群群主', 40058: '消息内容格式不对', 90208: '小程序未关联企微', 81017: '客户群范围过大' }
function failReason(wecom) {
  if (!wecom) return '未调用企微'
  if (wecom.error) return String(wecom.error).slice(0, 60)
  const results = (wecom.sends || []).map((s) => s.result).concat(wecom.result ? [wecom.result] : []).filter(Boolean)
  const bad = results.find((r) => r.errcode)
  if (bad) return ERR_TEXT[bad.errcode] || `企微错误 ${bad.errcode}`
  if (wecom.skipped) return wecom.message || '企微参数没配齐'
  return '原因未记录'
}

/** 后台「企微群发」页用的状态汇总 */
async function getStatus(now = Date.now()) {
  const [state, queue, logs, enabled, beat] = await Promise.all([
    loadState(),
    db.allDocs('digest_queue').catch(() => []),
    db.recentDocs('distribute_logs', 12).catch(() => []),
    isEnabled(now),
    db.getDoc('meta', LIVE_ID).catch(() => null)
  ])
  const waiting = queue.filter((item) => !item.inflight)
  const lastTickAt = Math.max(live.lastTickAt || 0, (beat && beat.lastTickAt) || 0)
  const online = now - lastTickAt < TICK_MS * 2 + 30000
  return {
    running: live.started || !!(beat && beat.lastTickAt),
    online,
    enabled,
    pausedUntil: pausedUntil > now ? pausedUntil : 0,
    quiet: isQuiet(now),
    startedAt: live.startedAt || (beat && beat.startedAt) || 0,
    lastTickAt,
    lastError: (beat && beat.lastError) || '',
    awaiting: (beat && beat.pending) || [],
    resumeAt: !enabled && controlCache.resumeAt > now ? controlCache.resumeAt : 0,
    lastPushAt: state.lastPushAt || 0,
    nextSlotAt: nextSlotAt(now),
    queue: {
      total: waiting.length,
      inflight: queue.length - waiting.length,
      pendingConfirm: waiting.filter((item) => item.confirm === 'pending').length,
      urgent: waiting.filter((item) => item.urgent).length
    },
    logs: logs
      .filter((item) => ['digest', 'digest_result', 'push_skip'].includes(item.contentType))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 8)
      .map((item) => ({
        at: item.createdAt || 0,
        status: item.status,
        title: item.title,
        count: item.itemCount || 0,
        reasons: item.reasons || [],
        error: item.status === 'failed' ? failReason(item.wecom) : ''
      }))
  }
}

module.exports = { start, tick, digestSendNow, pushPicked, buildText, pushReason, latestSlotAt, isQuiet, nextSlotAt, getStatus, setEnabled, isEnabled, PER_MESSAGE }
