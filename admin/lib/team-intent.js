// 判断一条帖子是不是「竞赛组队」：为竞赛、大创这类学术项目找队友。看内容，不看分类。
// isTeamText：既在找人、又说清了比赛，自动进汇总；isTeamSuspect：只占一头，放到后台「疑似」等人工判断。
// 打球开黑、兼职招人、代做保奖、拼车闲置都不收。

const { isSecondhandText } = require('./secondhand-intent')
const { isCarpoolText } = require('./carpool-intent')

// 说出具体名字的竞赛和学术项目
const NAMED_CONTEST = /青蓝(计划)?|雏[雁燕](计划)?|数模|数学建模|美赛|国赛|MCM|ICM|蓝桥杯|挑战杯|互联网\+|创青春|大创|创新创业|创业(大)?赛|三创|电商(大)?赛|ACM|ICPC|CCPC|天梯赛|黑客松|hackathon|程序设计(大|竞)?赛|电子设计|机器人(大|竞)?赛|RoboMaster|商赛|商业(大|竞)?赛|案例(大|竞)?赛|市场调研大赛|市调(大)?赛|正大杯|节能减排|外研社|大英赛|英语竞赛|学科竞赛/i
const GENERIC_CONTEST = /竞赛|比赛|大赛|挑战赛/
// 文体娱乐：也叫组队、比赛，但不是竞赛群要的
const CASUAL = /羽毛球|篮球|足球|排球|乒乓|网球|跑步|健身|爬山|徒步|飞盘|运动会|剧本杀|狼人杀|麻将|开黑|王者|吃鸡|和平精英|原神|游戏|电竞|CS2|英雄联盟|LOL|金铲铲|唱歌|歌手|舞蹈|K歌|演唱会|香港|港澳|出游|旅游/i

const RECRUIT = /组队|组个队|组一队|队友|组员|找队|寻队|招(募|队员|成员)|缺(一|两|二|三|几|个)?(个)?(人|队员|成员)|(还)?差(一|两|二|三|几)(个)?(人|队员|成员)|求带|带飞|队伍|收人|加人|组好队|一起(参加|报名|打|比)|找.{0,10}(一起|搭子|参加)/
// 想参加比赛但没明说招人
const CONTEST_INTEREST = /想(要)?参加|有没有人|有人|一起|报名/
const LOOSE_TEAM = /组队|组个队|队友|组员|找队|小组.{0,6}(缺|差|找|招)/

// 兼职招聘、代做保奖：疑似都不进
const EXCLUDED = /兼职|招聘|时薪|日结|工资|店员|服务员|代做|代写|代报|包过|保奖|培训班/

function textOf(post) {
  return [post && post.title, post && post.content]
    .filter(Boolean).map(String).join(' ').replace(/\s+/g, ' ')
}

function hasContest(text) {
  return NAMED_CONTEST.test(text) || (GENERIC_CONTEST.test(text) && !CASUAL.test(text))
}

/** 不属于竞赛组队：招聘代做、纯文体娱乐（说了具体竞赛名的除外）、已经算拼车或闲置 */
function ruledOut(post, text) {
  if (EXCLUDED.test(text)) return true
  if (CASUAL.test(text) && !NAMED_CONTEST.test(text)) return true
  return isCarpoolText(post) || isSecondhandText(post)
}

/** 内容语义上是为竞赛或学术项目找队友 */
function isTeamText(post) {
  const text = textOf(post)
  if (!text || ruledOut(post, text)) return false
  return hasContest(text) && RECRUIT.test(text)
}

/** 有点像竞赛组队，但规则拿不准 */
function isTeamSuspect(post) {
  const text = textOf(post)
  if (!text || isTeamText(post) || ruledOut(post, text)) return false
  // 不看分类：线上选「活动组队」的基本是拼车、打球、出游
  return LOOSE_TEAM.test(text) || (hasContest(text) && CONTEST_INTEREST.test(text))
}

module.exports = { isTeamText, isTeamSuspect }
