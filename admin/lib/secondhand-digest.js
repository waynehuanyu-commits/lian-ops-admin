// 每天两次（午间 12:00、晚间 21:00）把上次汇总之后发的「二手闲置」帖子汇总成文字链，推到内部群 webhook，内部同学转发到学生群。
// 和常规推送并行，不影响 digest_queue：白天按时段推过的二手帖，汇总里还会再出现一次，方便集中看。
// - 开关、时间、预览、人工圈选在后台「推送分发 → 闲置/拼车汇总」（存 meta/home_display，默认开、午间 12:00 + 晚间 21:00，午间留空 = 只推晚间）；到点后到 23:59 之间补发，每个时间点一天只发一次（meta/secondhand_digest_state.doneSlots 记已处理的时间点），服务重启不重发
// - 拼车、帮帮群、竞赛组队汇总每晚一次（帮帮群：跑腿、代取、借东西、有偿找人，见 help-intent.js；竞赛组队见 team-intent.js）
// - 是不是这一类按内容语义判断（*-intent.js），分类选错的也会收进来
// - 过 push-risk 分级：自动挑的只汇总 level=ok 的；不公开、风险、争议的都不放；代课代签到（isCheating）一律不推
// - 疑似（*Suspect）：规则拿不准的不自动推，列在后台等人工判断：「加入」进人工名单（meta/<state>_include），
//   「不是」进忽略名单（meta/<state>_dismiss，不再出现）。争议帖可以人工加，风险帖、不公开的不行
// - 人工勾掉（meta/<state>_exclude）的这一轮不推。加入、勾掉两个名单推完一轮就清空
// - 当天没有二手帖就不发，只记下已处理
// 由 wecom-auto.js 的 tick 调用，消息拼装（短链、编号、按字节拆条）复用它的函数，通过 deps 传进来避免循环引用。

const db = require('./db')
const { classifyForPush } = require('./push-risk')
const homeFeed = require('../../utils/home-feed')
const homeDisplay = require('./home-display')
const { isSecondhandText, isSecondhandSuspect } = require('./secondhand-intent')
const { isCarpoolText, isCarpoolSuspect } = require('./carpool-intent')
const { isHelpText, isHelpSuspect, isCheating } = require('./help-intent')
const { isTeamText, isTeamSuspect } = require('./team-intent')

const TOPIC = '二手闲置'
const STATE_ID = 'secondhand_digest_state'
// 三种汇总：按内容语义判断，分类选错的也收进来；topic 是分类兜底（帮帮群没有对应分类）
const KINDS = {
  secondhand: {
    topic: TOPIC, title: '今日二手闲置', stateId: STATE_ID, logType: 'secondhand_digest',
    enabled: 'secondhandEnabled', time: 'secondhandTime', earlyTime: 'secondhandNoonTime',
    match: isSecondhandText, suspect: isSecondhandSuspect
  },
  carpool: {
    topic: '拼车', title: '今日拼车', stateId: 'carpool_digest_state', logType: 'carpool_digest',
    enabled: 'carpoolEnabled', time: 'carpoolTime', match: isCarpoolText, suspect: isCarpoolSuspect
  },
  help: {
    topic: '', title: '今日帮帮群', stateId: 'help_digest_state', logType: 'help_digest',
    enabled: 'helpEnabled', time: 'helpTime', match: isHelpText, suspect: isHelpSuspect
  },
  // 推到内部群后，由运营转发到竞赛组队群
  team: {
    topic: '', title: '今日竞赛组队', stateId: 'team_digest_state', logType: 'team_digest',
    enabled: 'teamEnabled', time: 'teamTime', match: isTeamText, suspect: isTeamSuspect
  }
}

/** 规则自动收进这一类：内容判中，或分类就是这一类 */
function autoMatch(post, type, kind) {
  return (!!kind.topic && homeFeed.postTopic(post, type) === kind.topic) || kind.match(post)
}
const DAY_MS = 24 * 3600 * 1000
const BJ_OFFSET = 8 * 3600 * 1000

function beijingDay(now) {
  const d = new Date(now + BJ_OFFSET)
  return {
    key: d.toISOString().slice(0, 10),
    label: `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`,
    start: Math.floor((now + BJ_OFFSET) / DAY_MS) * DAY_MS - BJ_OFFSET,
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes()
  }
}

/** 这个汇总一天里的推送时间点，从早到晚；午间没配（空）就只剩晚间一个 */
function slotTimes(display, kind) {
  const times = [display[kind.time], kind.earlyTime && display[kind.earlyTime]].filter(Boolean)
  return [...new Set(times)].sort()
}

function slotLabel(hhmm, times) {
  if (times.length < 2) return ''
  return hhmm === times[0] ? '午间' : '晚间'
}

/**
 * 这一轮要汇总的起点：上一次推送的截止时间（meta 里记的 cutoff）。
 * 不是「当天 0 点」——推送时间点之后发的帖子要算进下一轮，不然就漏了。
 * 没记录（第一次推）或隔了好几天没推时，最多往前追到昨天最早的推送时刻，免得一次推出一大堆旧帖。
 */
function windowStart(state, day, hhmm) {
  const [hh, mm] = hhmm.split(':').map(Number)
  const yesterdayAtTime = day.start - DAY_MS + (hh * 60 + mm) * 60 * 1000
  // 老记录没有 cutoff，只有推送时刻 at，兜底用它
  return Math.max(Number(state && (state.cutoff || state.at)) || 0, yesterdayAtTime)
}

/** (since, until] 之间公开、没风险的帖子，按发帖时间从早到晚。按内容语义判断（出/收/转让/送都算），不只看分类，分类常选错 */
async function todaysItems(since, kind = KINDS.secondhand, until = Infinity) {
  const rows = []
  for (const [collection, type] of [['forum_posts', 'forum'], ['wall_posts', 'wall']]) {
    const docs = await db.recentDocs(collection, 200).catch(() => [])
    docs
      .filter((post) => (Number(post.createdAt) || 0) > since && (Number(post.createdAt) || 0) <= until)
      .filter((post) => autoMatch(post, type, kind) && !isCheating(post))
      .filter((post) => classifyForPush(post).level === 'ok')
      .forEach((post) => rows.push({ post, type }))
  }
  return rows
    .sort((a, b) => (Number(a.post.createdAt) || 0) - (Number(b.post.createdAt) || 0))
    .map(({ post, type }) => ({ ...homeFeed.digestQueueItem(post, type), createdAt: Number(post.createdAt) || 0 }))
}

/** 后台勾掉的帖子（定时推送时跳过）；推过一轮后清空，因为被跳过的帖子已在新的截止时间之前 */
async function excludedIds(kind) {
  const row = await db.getDoc('meta', `${kind.stateId}_exclude`).catch(() => null)
  return (row && Array.isArray(row.ids) ? row.ids : []).map(String)
}

async function saveExcluded(kindKey, ids) {
  const kind = KINDS[kindKey]
  const list = [...new Set((ids || []).map(String).filter(Boolean))].slice(0, 200)
  await db.setDoc('meta', `${kind.stateId}_exclude`, { id: `${kind.stateId}_exclude`, ids: list, at: Date.now() })
  return list
}

// ---- 人工圈选：运营从最近帖子里挑几条加进下一次汇总（自动判断漏掉的、分类选错的都能补） ----
const COLLECTION = { forum: 'forum_posts', wall: 'wall_posts' }
const PICK_LIMIT = 50
const CANDIDATE_DAYS = 3

function pickKey(pick) {
  return `${pick.contentType}:${pick.contentId}`
}

/** 人工加入名单：[{ contentType, contentId }]；推过一轮后清空 */
async function includedPicks(kind) {
  const row = await db.getDoc('meta', `${kind.stateId}_include`).catch(() => null)
  return (row && Array.isArray(row.picks) ? row.picks : [])
    .filter((pick) => COLLECTION[pick.contentType] && pick.contentId)
}

/** 人工能加的帖子：公开、不是风险帖。争议帖可以加，由运营把关 */
function pickable(post) {
  return classifyForPush(post).level !== 'risk'
}

async function loadPick(pick) {
  const post = await db.getDoc(COLLECTION[pick.contentType], pick.contentId).catch(() => null)
  return post && pickable(post) ? post : null
}

/** 加进人工名单（追加，不覆盖）；返回加入后的名单和被拒的条数 */
async function addIncluded(kindKey, picks) {
  const kind = KINDS[kindKey]
  const current = await includedPicks(kind)
  const seen = new Set(current.map(pickKey))
  const fresh = (Array.isArray(picks) ? picks : [])
    .map((pick) => ({ contentType: String(pick && pick.contentType), contentId: String((pick && pick.contentId) || '') }))
    .filter((pick) => COLLECTION[pick.contentType] && pick.contentId && !seen.has(pickKey(pick)))
  const checked = await Promise.all(fresh.map(async (pick) => ((await loadPick(pick)) ? pick : null)))
  const accepted = checked.filter(Boolean)
  const list = current.concat(accepted).slice(0, PICK_LIMIT)
  await db.setDoc('meta', `${kind.stateId}_include`, { id: `${kind.stateId}_include`, picks: list, at: Date.now() })
  return { picks: list, added: accepted.length, rejected: fresh.length - accepted.length }
}

async function removeIncluded(kindKey, contentId) {
  const kind = KINDS[kindKey]
  const list = (await includedPicks(kind)).filter((pick) => pick.contentId !== String(contentId))
  await db.setDoc('meta', `${kind.stateId}_include`, { id: `${kind.stateId}_include`, picks: list, at: Date.now() })
  return list
}

/** 这一轮要推的全部：自动挑中的 + 人工加入的（去重，人工的带 manual 标记），按发帖时间排 */
async function roundItems(since, kind, until) {
  const [auto, picks] = await Promise.all([todaysItems(since, kind, until), includedPicks(kind)])
  const autoIds = new Set(auto.map((item) => item.contentId))
  const posts = await Promise.all(picks.filter((pick) => !autoIds.has(pick.contentId)).map(async (pick) => {
    const post = await loadPick(pick)
    return post ? { ...homeFeed.digestQueueItem(post, pick.contentType), createdAt: Number(post.createdAt) || 0, manual: true } : null
  }))
  return auto.concat(posts.filter(Boolean)).sort((a, b) => a.createdAt - b.createdAt)
}

/** 忽略名单：运营判断过「不是」的疑似帖，不再出现（只留最近 300 条） */
async function dismissedIds(kind) {
  const row = await db.getDoc('meta', `${kind.stateId}_dismiss`).catch(() => null)
  return (row && Array.isArray(row.ids) ? row.ids : []).map(String)
}

async function dismiss(kindKey, contentId) {
  const kind = KINDS[kindKey]
  const ids = [...new Set([String(contentId)].concat(await dismissedIds(kind)))].filter(Boolean).slice(0, 300)
  await db.setDoc('meta', `${kind.stateId}_dismiss`, { id: `${kind.stateId}_dismiss`, ids, at: Date.now() })
  return ids
}

/**
 * 疑似：最近 3 天规则拿不准的帖子（*Suspect 判中、但没自动收进来），等人工判断。
 * 不含：这一轮已经要推的、以前汇总推过的、点过「不是」的、风险 / 不公开的、代课代签到的。
 */
async function suspects(kind, inRound, pushedIds, now) {
  const dismissed = new Set(await dismissedIds(kind))
  const rows = []
  for (const [type, collection] of Object.entries(COLLECTION)) {
    const docs = await db.recentDocs(collection, 200).catch(() => [])
    docs
      .filter((post) => (Number(post.createdAt) || 0) > now - CANDIDATE_DAYS * DAY_MS)
      .forEach((post) => {
        const id = String(post.id || post._id)
        if (inRound.has(id) || pushedIds.has(id) || dismissed.has(id)) return
        if (autoMatch(post, type, kind) || !kind.suspect(post) || isCheating(post)) return
        const risk = classifyForPush(post)
        if (risk.level === 'risk') return
        rows.push({ ...homeFeed.digestQueueItem(post, type), createdAt: Number(post.createdAt) || 0, disputed: risk.reasons })
      })
  }
  return rows.sort((a, b) => b.createdAt - a.createdAt).slice(0, 40)
}

function nextSlot(times, day) {
  if (!times.length) return ''
  const minutesOf = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m }
  const later = times.find((t) => minutesOf(t) > day.minutes)
  return later ? `今天 ${later}` : `明天 ${times[0]}`
}

/** 后台「闲置/拼车汇总」页：下一次要推的帖子、开关时间、最近推送记录。只读，不发消息 */
async function overview(now = Date.now()) {
  const day = beijingDay(now)
  const display = await homeDisplay.getDisplay()
  const out = {}
  for (const [key, kind] of Object.entries(KINDS)) {
    const times = slotTimes(display, kind)
    const state = (await db.getDoc('meta', kind.stateId).catch(() => null)) || null
    const since = windowStart(state, day, times[0] || '21:00')
    const [items, excluded, logs] = await Promise.all([
      roundItems(since, kind, now),
      excludedIds(kind),
      db.recentDocs('distribute_logs', 200).catch(() => [])
    ])
    const kindLogs = logs.filter((row) => row.contentType === kind.logType)
    const pushedIds = new Set(kindLogs.flatMap((row) => (row.items || []).map((item) => String(item.contentId))))
    const inRound = new Set(items.map((item) => item.contentId))
    out[key] = {
      key, title: kind.title, topic: kind.topic,
      enabled: !!display[kind.enabled], times, noonTime: kind.earlyTime ? display[kind.earlyTime] || '' : null, eveningTime: display[kind.time],
      nextSlot: display[kind.enabled] ? nextSlot(times, day) : '',
      since, last: state && state.lastDay ? { day: state.lastDay, slot: state.lastSlot || '', count: state.lastCount || 0, at: state.at || 0 } : null,
      items: items.map((item) => ({ ...item, skip: excluded.includes(item.contentId) })),
      suspects: await suspects(kind, inRound, pushedIds, now),
      history: kindLogs
        .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0)).slice(0, 8)
        .map((row) => ({ title: row.title, count: row.itemCount || 0, status: row.status, at: row.createdAt, titles: (row.items || []).map((i) => i.title).slice(0, 12) }))
    }
  }
  return out
}

function header(day, total, kind = KINDS.secondhand, label = '') {
  return `${kind.title}${label ? `（${label}）` : ''} · ${day.label} · ${total} 条`
}

/**
 * @param {number} now
 * @param {{ webhookUrl: Function, shortLinks: Function, webhookChunks: Function, buildText: Function, postJson: Function }} deps
 */
async function maybeSend(now, deps, { force = false, kindKey = 'secondhand', exclude = null, manual = false } = {}) {
  const kind = KINDS[kindKey]
  const url = deps.webhookUrl()
  if (!url) return { skipped: 'no_webhook' }
  const day = beijingDay(now)
  const display = await homeDisplay.getDisplay()
  if (!force && !display[kind.enabled]) return { skipped: 'disabled' }
  const times = slotTimes(display, kind)
  const minutesOf = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m }
  const due = times.filter((t) => day.minutes >= minutesOf(t))
  if (!force && !due.length) return { skipped: 'not_time' }
  const stored = await db.getDoc('meta', kind.stateId).catch(() => null)
  // 新加的汇总第一次跑：今天已经过了的时间点记为处理过，不补推，从下一个时间点开始（上线当晚不会突然推一条）
  if (!stored && !force) {
    // 不记 at / cutoff：下一轮从「昨天的推送时刻」算起，上线前一天的帖子也能收进第一轮
    await db.setDoc('meta', kind.stateId, { id: kind.stateId, doneDay: day.key, doneSlots: due, lastDay: '' })
    return { skipped: 'first_run' }
  }
  const state = stored || { id: kind.stateId }
  // 老记录只有 lastDay（一天一次的时代），当天的时间点算全部处理过
  const doneToday = state.doneDay === day.key ? state.doneSlots || [] : state.lastDay === day.key && !state.doneDay ? times : []
  const pending = due.filter((t) => !doneToday.includes(t))
  if (!force && !pending.length) return { skipped: 'done' }
  // 几个时间点都到了还没推（比如服务晚上才起来），合成一条推，别连发好几条
  const slot = pending.length ? pending[pending.length - 1] : times[times.length - 1]
  const label = manual ? '手动' : slotLabel(slot, times)
  const since = windowStart(state, day, times[0])
  // 手动推送用页面上这次勾选的，定时推送用后台保存过的「跳过」名单
  const skip = new Set(exclude || (await excludedIds(kind)))
  const items = (await roundItems(since, kind, now)).filter((item) => !skip.has(item.contentId))
  const doneSlots = [...new Set([...doneToday, ...due])]
  const saved = (count) => ({ id: kind.stateId, lastDay: day.key, lastCount: count, lastSlot: slot, doneDay: day.key, doneSlots, at: now, cutoff: now })
  // cutoff：这一轮汇总到几点为止，下一轮从这里接着算（空的一轮也要往前推，不然会反复捞同一段）
  if (!items.length) {
    await db.setDoc('meta', kind.stateId, saved(0))
    await db.setDoc('meta', `${kind.stateId}_include`, { id: `${kind.stateId}_include`, picks: [], at: now }).catch(() => {})
    return { sent: 0 }
  }
  const links = await deps.shortLinks(items)
  const chunks = deps.webhookChunks(items, links)
  const results = []
  let start = 1
  for (const chunk of chunks) {
    const body = deps.buildText(chunk, links, start)
    const content = start === 1 ? `${header(day, items.length, kind, label)}\n\n${body}` : body
    start += chunk.length
    const result = await deps.postJson(url, { msgtype: 'text', text: { content } })
      .catch((err) => ({ errcode: -1, errmsg: err.message }))
    results.push(result)
  }
  const ok = results.every((r) => !r.errcode)
  await db.setDoc('distribute_logs', manual ? `dl_${kindKey}_${day.key}_m${now}` : `dl_${kindKey}_${day.key}${times.length > 1 ? `_${slot.replace(':', '')}` : ''}`, {
    groupType: 'internal', contentType: kind.logType, contentId: day.key,
    title: header(day, items.length, kind, label), items, itemCount: items.length,
    status: ok ? 'internal' : 'failed', wecom: { sends: results.map((result) => ({ sender: 'webhook', result })) },
    createdAt: now
  }).catch(() => {})
  // 失败不记已发，下一次 tick（2 分钟后）再试
  if (ok) {
    await db.setDoc('meta', kind.stateId, saved(items.length))
    await db.setDoc('meta', `${kind.stateId}_exclude`, { id: `${kind.stateId}_exclude`, ids: [], at: now }).catch(() => {})
    await db.setDoc('meta', `${kind.stateId}_include`, { id: `${kind.stateId}_include`, picks: [], at: now }).catch(() => {})
  }
  return { sent: items.length, ok, messages: chunks.length }
}

module.exports = { overview, dismiss, addIncluded, removeIncluded, saveExcluded, maybeSend, todaysItems, windowStart, beijingDay, TOPIC, KINDS }
