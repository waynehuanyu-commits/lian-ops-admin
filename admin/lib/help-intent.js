// 判断一条帖子是不是「帮帮群」的内容：找人帮忙买、带、取、跑腿、借东西、有偿找人。看内容，不看分类。
// 已经算二手闲置、拼车的不算（各进各的汇总）；代课、代签到、代刷网课这类违规内容自动和疑似都不收。
// isHelpText：够明确，自动进汇总；isHelpSuspect：有点像但拿不准，放到后台「疑似」里等人工判断。

const { isSecondhandText, isSecondhandSuspect } = require('./secondhand-intent')
const { isCarpoolText, isCarpoolSuspect } = require('./carpool-intent')
const { isTeamText } = require('./team-intent')

const STRONG = [
  /跑腿|代取|代拿|代买|代寄|代领/,
  /帮(忙|我|个忙)?\s*(取|拿|带|买|寄|搬|领|抓|修|看一下|喂)/,
  /帮个(小)?忙|求帮忙|谁(能|可以)帮|有没有(人|同学|uu|宝)?(能|可以)?帮/,
  /有偿(帮|找|借|租|求)|找人(帮|取|拿|代)/,
  /求借|借(我|一个|一台|一下|个|用)|能不能借|租借|租用|求租(?!房)/,
  /顺(便|路)(带|捎)|捎(个|一|点|带)/,
  /上门(维修|喂养|服务)|寄存/
]
// 有求助意思但说不清是不是要人帮忙
const SUSPECT = /有偿|帮|借|租(?!房)|急求|求(一|个|助)|蹲/
// 问攻略、求推荐、求群、问地点、组队约拍：是提问或找搭子，不是找人帮忙
const ASKING = /推荐|怎么|如何|哪里|哪儿|在哪|地点|时刻表|攻略|方法|群|店|课程|组队|队伍|约拍|录音|搭子|地方|电话|AI/i
// 失物招领、找人：各有去处
const LOST_FOUND = /失物|招领|寻物|捡到|遗失|丢.{0,4}了|丢失|拿错|取错|误领|寻人|捞人/
// 代课、代签到、交换人生（dk）：违规，自动和疑似都不收
const CHEATING = /签到|代课|替课|代考|代刷|刷课|包答题|学习通|交换(一下)?人生|\bdk\b|qiandao|点名/i

function textOf(post) {
  return [post && post.title, post && post.content]
    .filter(Boolean).map(String).join(' ').replace(/\s+/g, ' ')
}

/** 代课、代签到、代刷网课：三种汇总的自动和疑似都不收 */
function isCheating(post) {
  return CHEATING.test(textOf(post))
}

// 分类已经是二手、拼车的，进那两个汇总
const OTHER_TOPIC = /拼车|二手|闲置/

function belongsElsewhere(post) {
  const text = textOf(post)
  const topic = `${(post && post.category) || ''} ${(post && post.tag) || ''}`
  return LOST_FOUND.test(text) || CHEATING.test(text) || OTHER_TOPIC.test(topic) || isSecondhandText(post) || isCarpoolText(post) || isTeamText(post)
}

/** 内容语义上是找人帮忙（跑腿、代取、借东西、有偿找人） */
function isHelpText(post) {
  const text = textOf(post)
  if (!text || belongsElsewhere(post)) return false
  return STRONG.some((re) => re.test(text))
}

/** 有点像帮帮群的内容，但规则拿不准 */
function isHelpSuspect(post) {
  const text = textOf(post)
  // 闲置、拼车的疑似留在它们自己那边判断，这里不重复列
  if (!text || isHelpText(post) || belongsElsewhere(post) || isSecondhandSuspect(post) || isCarpoolSuspect(post)) return false
  return SUSPECT.test(text) && !ASKING.test(text)
}

module.exports = { isHelpText, isHelpSuspect, isCheating }
