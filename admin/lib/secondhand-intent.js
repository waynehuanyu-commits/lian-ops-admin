// 判断一条帖子是不是「二手闲置」：看内容的意思，不看用户选的分类（分类常选错）。
// 出东西、收东西、转让、送东西、求购、回收都算。
// 打分制：单个词不够，「自提」「面交」「谁要」「包邮」这类词在日常帖子里也常出现，得凑够两分才算。
// 强信号 2 分（二手、闲置、转让、出售、几成新……），弱信号每类 1 分（价格、自提/面交、可刀、私聊……），
// 问攻略、拼车、失物招领的帖子扣分，避免「求购买攻略」「拼车价格 50 元」「想找人面交文件」被推进二手汇总。

const QTY = '[一二两三四五六七八九十0-9]{1,3}\\s*[个只件台本套双部张把条支块盒箱袋瓶副顶]'

const STRONG = [
  // 转让座位、名额、房子、合同不算二手物品；「便宜出行」「低价出行」也不是
  /二手|闲置|转让(?![^，。\n]{0,8}(座位|位置|名额|课程|房|租|合同|床位|工位))|转卖|转手|出售|售出|甩卖|清仓|急出|(低价|便宜)出(?!行|门|游|去|来|国)|捡漏|代售|以物换物|换购/,
  /求购(?!买)|(?:^|[\s，。,！!：:])(?:收|出|送|赠)\s*(?:二手|旧)/,
  // 成色：九五新、95新、7成新、全成新、未拆封
  /(?:九[五八]?成?|[5-9][0-9]|[5-9]成|[全9]9?成)新(?!生|闻|疆|加坡|年|学期|媒体|版本|人)|全新未拆|未拆封|没拆封|仅拆封|用过几次|基本没用/,
  /原价[^，。\n]{0,8}(现价|出|转)|(现价|出价|售价)\s*[¥￥0-9]/,
  // 标题/句首直接「出X」「收X」是最常见的写法（出小冰箱、出1L橙汁、收二手手机）；出台、出去玩、收到、收拾这类动词除外
  new RegExp(`(^|[\\s，。,！!：:；;、】\\]])出(?!台|去|来|门|游|国|行|发|现|席|名|成绩|结果|生|事|错|汗|差|院|色|口|入|场|品|版|息|力|面|题|卷|片|图|炉|道|了|完|不|得|个主意|一个主意)\\S`),
  new RegExp(`(^|[\\s，。,！!：:；;、】\\]])收(?!到|取|拾|费|藏|看|入|获|益|集|留|队|人|款|件|工|尾|摊|缩|听|快递|信息|个快递|不到|了|完|好|下|起|回|拢|敛|成)\\S`),
  // 价格紧贴「出」：6r出、50出、699出
  /\d\s*(r|元|块|rmb)?\s*出(?!去|来|门|行|台|游|国|发|现|席|名|成绩|结果|生|事|错|汗|差|院|口|入|场|品|版|息|力|面|题|卷|片|图|炉|道|了|完|不)/i,
  // 成色和使用情况：仅撕膜、仅使用2天、刚买一个月
  /仅撕膜|撕膜|仅使用|使用\d+天|刚买|买错了|没用过|吃灰|只用过/,
  // 出 3 个 / 收一本 / 送两张：要有数字，「出台」「出个主意」「收个快递」都不算
  new RegExp(`(^|[\\s，。,！!：:])(出|收|送|赠)\\s*${QTY}`),
  /(出|卖|收)[^，。\n]{1,12}(私我|私聊|私信|dd我|滴我|加v|加微|vx|联系我)/i
]

// 每类最多算 1 分
const WEAK = [
  /自提|面交|当面交易|校内交易/,
  /可刀|可小刀|不议价|不包邮|包邮(?!区)/,
  /[¥￥]\s*\d|\d+\s*(元|块|r|rmb)(?![a-z])|(价格|售价|出价)\s*\d/i,
  /出掉|卖掉|收购|回收|免费送|白送|送人|赠送/,
  /私我|私聊|dd我|滴我|加v|加微|vx/i,
  /有没有(人)?(要|收|出|想要)|(谁|有人)(要|想要|需要)/
]

// 以下情况扣分：问攻略/求推荐、拼车、失物招领
const INQUIRY = /怎么|如何|哪里|哪儿|推荐|攻略|方法|请问|有没有人知道|求助|求问/
const LOST_FOUND = /失物|招领|捡到|遗失|寻物|丢了|丢失/

/** 内容语义上的二手闲置得分，>= 2 算二手；拼车判断由调用方传入，避免循环引用 */
function secondhandScore(post, isCarpool = () => false) {
  const text = [post && post.title, post && post.content, post && post.tags]
    .filter(Boolean).map(String).join(' ').replace(/\s+/g, ' ')
  if (!text) return 0
  let score = 0
  if (STRONG.some((re) => re.test(text))) score += 2
  score += WEAK.filter((re) => re.test(text)).length
  if (INQUIRY.test(text)) score -= 1
  if (LOST_FOUND.test(text)) score -= 2
  if (isCarpool(post)) score -= 2
  return score
}

const THRESHOLD = 2

/** 内容语义上是不是二手闲置买卖 / 转让 / 赠送 */
function isSecondhandText(post) {
  // 懒加载：carpool-intent 不依赖本文件，这里只是不想在模块加载时多一层耦合
  const { isCarpoolText } = require('./carpool-intent')
  return secondhandScore(post, isCarpoolText) >= THRESHOLD
}

/** 有买卖信号但分数不够：放到后台「疑似」里等人工判断。拼车、失物招领不算 */
function isSecondhandSuspect(post) {
  const { isCarpoolText } = require('./carpool-intent')
  const text = [post && post.title, post && post.content]
    .filter(Boolean).map(String).join(' ').replace(/\s+/g, ' ')
  if (!text || isSecondhandText(post) || isCarpoolText(post) || LOST_FOUND.test(text) || INQUIRY.test(text)) return false
  // 只有「加微信 / 有没有人要」这类联系方式或询问的不算，得有买卖、价格、成色之类的信号
  const CONTACT_ONLY = [WEAK[4], WEAK[5]]
  return STRONG.some((re) => re.test(text)) || WEAK.filter((re) => !CONTACT_ONLY.includes(re)).some((re) => re.test(text))
}

module.exports = { isSecondhandText, isSecondhandSuspect, secondhandScore, THRESHOLD }
