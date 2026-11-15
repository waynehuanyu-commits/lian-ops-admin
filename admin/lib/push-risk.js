// 企微群推送前的内容分级（只影响「推不推进群」，不影响帖子在小程序里的展示）。
// 词库沿用 utils/moderation.js，帖子已经过机审/人审，这里是第二道、更保守的「群里不扩散」过滤：
// - risk：涉政、代课代考、诈骗借贷、赌博色情、辱骂仇恨、挂人曝光等 → 不推，留在小程序里
// - disputed：传闻、隐私对象、思政语境、学业暗语、被举报过 → 发企微消息给确认人，谁先确认按谁的
// - ok：直接进下一批推送

const moderation = require('../../utils/moderation')

const RISK_SIGNALS = {
  politics_entity: '涉政',
  politics_attack: '涉政',
  politics_highrisk: '涉政',
  academic_core: '代课代考',
  fraud_core: '诈骗',
  fraud_recruit: '诈骗',
  fraud_lend: '借贷套现',
  gambling_core: '赌博',
  adult_core: '色情',
  dating_solicit: '约会引流',
  adult_hint: '色情擦边',
  abuse_core: '辱骂',
  hate_core: '极端仇恨',
  voyeur_privacy: '偷拍隐私',
  rebate_promo: '返利引流',
  violence_call: '行动号召',
  official_impersonate: '冒充官方',
  serious_accusation: '严重指控',
  doxx_intent: '挂人曝光',
  exposure_hook: '曝光吃瓜',
  person_smear: '指控个人',
  targeted_person: '曝光个人',
  illegal_goods: '违禁品'
}

// 词库归一化会把「帮签」并成「qd」后连写，导致漏判；推送这里按原文再兜一次底
// 「代一下历史水课」「帮忙代课」这类口语说法也算（2026-10-30 热议试算时漏过一条）；不碰「代购课本」
const ACADEMIC_RAW = /帮签|代签|替签|代上课|帮上课|代写作业|代做作业|代(?:一下|一节|节)[^，。！？\n]{0,8}课|帮(?:忙|我)?代(?:一下)?课/

// 「传闻（听说）」「隐私对象（宿舍/学号）」在审核词库里只是辅助词，要和挂人、曝光、严重指控一起出现才算问题
// （那几种已在上面 RISK_SIGNALS 里）。单独出现太敏感：「宿舍自己做饭」「听说罗翔要来」都会被误拦，2026-10-30 起不再单独算争议
const DISPUTED_SIGNALS = {
  politics_context: '思政相关',
  academic_variant: '疑似学业暗语'
}

// 踩人 / 拉踩：嘲讽、指责某些人、说给学校丢脸。词库没有这类，这里按原文补：不推、不上园区热议。
// 只收针对人的说法，「避雷某店」「抵制炒票」这类对事不对人的不算
const TRAMPLE_RAW = moderation.TRAMPLE_RAW

function hitLabels(signals, table) {
  return Object.keys(table)
    .filter((key) => Array.isArray(signals[key]) && signals[key].length)
    .map((key) => `${table[key]}（${signals[key].slice(0, 2).join('、')}）`)
}

/** 返回 { level: 'ok' | 'disputed' | 'risk', reasons: [] } */
function classifyForPush(post) {
  if (!post) return { level: 'risk', reasons: ['帖子已不存在'] }
  if (!moderation.isPublicStatus(post.reviewStatus || 'approved')) return { level: 'risk', reasons: ['帖子当前不公开'] }
  const review = moderation.reviewText({
    title: post.title,
    content: post.content,
    extra: post.extra,
    routeFrom: post.routeFrom,
    routeTo: post.routeTo
  })
  const signals = { ...(review.signals || {}) }
  // 「避雷」多是避雷店铺 / 食堂，对事不对人；只命中它不算挂人（挂人 / 人肉 / 曝光照常算）
  if (Array.isArray(signals.doxx_intent)) signals.doxx_intent = signals.doxx_intent.filter((w) => w !== '避雷')
  // 只有思政学习语境、没有攻击类词时，涉政实体降为争议
  const politicsStudyOnly = (signals.politics_context || []).length
    && !(signals.politics_attack || []).length
    && !(signals.politics_highrisk || []).length
  const riskTable = politicsStudyOnly ? { ...RISK_SIGNALS, politics_entity: undefined } : RISK_SIGNALS
  const risk = hitLabels(signals, Object.fromEntries(Object.entries(riskTable).filter(([, v]) => v)))
  const raw = `${post.title || ''}\n${post.content || ''}`
  const academic = raw.match(ACADEMIC_RAW)
  if (academic) risk.push(`代课代考（${academic[0]}）`)
  else if ((review.ruleIds || []).some((id) => /^A\d/.test(id))) risk.push('代课代考（口语说法）')
  const trample = raw.match(TRAMPLE_RAW)
  if (trample) risk.push(`踩人 / 拉踩（${trample[0]}）`)
  if (risk.length) return { level: 'risk', reasons: risk }
  const disputed = hitLabels(signals, DISPUTED_SIGNALS)
  if ((Number(post.reportCount) || 0) > 0) disputed.push(`被举报 ${post.reportCount} 次`)
  if (disputed.length) return { level: 'disputed', reasons: disputed }
  return { level: 'ok', reasons: [] }
}

// 急事：时间紧、找东西、求助类，推送时插队（10 分钟内发出，急事之间至少隔 30 分钟），消息里标【急】
const URGENT_WORDS = /急|紧急|马上|立刻|尽快|今晚|今早|丢了|丢失|遗失|捡到|谁看到|有没有人看到|求助|找人|寻人|寻物|借一下|谁有/
const URGENT_TOPICS = new Set(['失物招领', '求物求助', '求助'])

function isUrgent(post) {
  if (!post) return false
  const text = `${post.title || ''}\n${post.content || ''}\n${post.departTime || ''}`
  const topic = String(post.tag || post.category || '')
  if (URGENT_TOPICS.has(topic)) return true
  return URGENT_WORDS.test(text)
}

module.exports = { classifyForPush, isUrgent }
