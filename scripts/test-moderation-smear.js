// 曝光/指控个人劣迹类规则回归（2026-11-07 外教曝光帖）。改 moderation.js 词库或规则后必跑
const assert = require('assert')
const m = require('../utils/moderation')
const out = (t) => m.reviewText({ content: t }).outcome
const REV = 'manual_review', OK = 'approved'
const cases = [
  ['原帖', '各位同学，我来曝光一下中国地质大学海南校区外教Max Boston。在就职贵校之前曾在美国因贩毒而坐牢，后赴上海就职，因为私生活混乱导致被辞退。 想后续吃瓜的可以找我', REV],
  ['空格变体', '曝 光 一下 外教 M a x  B o s t o n 贩毒坐牢', REV],
  ['繁体', '來爆料一下某老師，曾因販毒入獄，想吃瓜私我', REV],
  ['换人同模式', '爆料某老师私生活混乱，想吃瓜的找我', REV],
  ['只曝光', '来曝光一个人', REV],
  ['只吃瓜', '有没有人想吃瓜', REV],
  ['挂人', '挂人，这个同学借钱不还', REV],
  ['骂人', '你真不要脸', REV],
  ['骂人变体', '傻🙏逼', REV],
  ['缩写', '你个sb', REV],
  ['曝光度', '怎么提高账号曝光度', OK],
  ['曝光补偿', '手机拍照曝光补偿怎么调', OK],
  ['只提名字', 'Max Boston 老师的课怎么样', REV],
  ['刑法讨论', '刑法课讲了贩毒会坐牢多少年', OK],
  ['避雷店铺', '避雷这家店，出轨老板还坐牢过', OK],
  ['避雷食堂', '避雷三食堂的鸡腿', OK]
]
cases.forEach(([name, text, want]) => assert.strictEqual(out(text), want, `${name}: ${out(text)} != ${want}`))
console.log(`ok ${cases.length}`)
