// 判断一条帖子是不是「拼车」：看内容的意思，不看用户选的分类。
// 找人拼车、车找人、人找车、顺风车、一起打车去机场/高铁站都算；外卖拼单、拼团不算。

const PLACE = '机场|高铁站?|火车站|动车站|车站|北站|南站|东站|西站|T[1-4]|航站楼|市区|解放碑|观音桥|沙坪坝|江北'
const STRONG = [
  /拼车|拼个车|拼一下车|拼辆车|顺风车|车找人|人找车|拼出租|拼的士|拼滴滴|拼网约车|拼专车|拼包车|包车拼|找(人|同伴|小伙伴)(一起|同)?(拼|打车|坐车)|(一起|同行|搭伴|搭车)(打车|打的|坐车|去)|拼(一|个)?(的|车|座)/,
  new RegExp(`(打车|打的|叫车|网约车|滴滴|出租)[^。\\n]{0,14}(${PLACE})`),
  new RegExp(`(${PLACE})[^。\\n]{0,14}(拼|一起|同行|搭伴|有人(去|吗)|顺路|空座|余座)`),
  /空座|余座|顺路带|顺路捎|(还|剩|差)\s*[一二两三四1-4]\s*(个)?(座|位)/
]

/** 内容语义上是不是拼车（不含外卖拼单、拼团） */
function isCarpoolText(post) {
  if (post && (post.routeFrom || post.routeTo)) return true
  const text = [post && post.title, post && post.content, post && post.tags]
    .filter(Boolean).map(String).join(' ').replace(/\s+/g, ' ')
  if (!text) return false
  return STRONG.some((re) => re.test(text))
}

// 提到出行（机场、车站、打车、租车、几点出发）但没说清要拼车：放到后台「疑似」里等人工判断
const TRAVEL = /机场|高铁|火车站|动车站|陵水站|车站|航站楼|打车|打的|滴滴|租车|包车|顺路|搭车|出发去|一起去/
// 问公交、问路、找店：是提问，不是找人同行
const ASKING = /推荐|怎么|如何|哪里|哪儿|在哪|公交|发车时间|店|电脑城|时刻表/

function isCarpoolSuspect(post) {
  if (isCarpoolText(post)) return false
  const text = [post && post.title, post && post.content]
    .filter(Boolean).map(String).join(' ').replace(/\s+/g, ' ')
  return !!text && TRAVEL.test(text) && !ASKING.test(text)
}

module.exports = { isCarpoolText, isCarpoolSuspect }
