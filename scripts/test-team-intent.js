#!/usr/bin/env node
// 竞赛组队判定回归：node scripts/test-team-intent.js，全部通过才输出 PASS。
const assert = require('assert')
const { isTeamText, isTeamSuspect } = require('../admin/lib/team-intent')
const { isHelpText } = require('../admin/lib/help-intent')

const post = (content, extra = {}) => ({ title: '', content, ...extra })

const AUTO = [
  '美赛组队，缺一个会写论文的队友',
  '数学建模国赛找队友，本人负责编程',
  '挑战杯还差两个人，有想一起参加的吗',
  '互联网+大赛招募队员，项目已有雏形',
  '蓝桥杯有没有人一起报名组队',
  '大创项目缺人，计算机方向优先',
  '商赛组队求带，大二会 PPT',
  '有没有同学一起参加市场调研大赛，想找两个组员',
  // 线上真实说法
  '蹲学长学姐参加青蓝计划还没组好队的，或者队伍还能加人的',
  '还有无正大杯队收人的！求来一支队伍收留',
  '寻找雏雁计划队友，需要会用 AI 工具',
  '北邮雏燕招募 直接加我',
  '找想要参加竞赛的同学，需要建模和写报告的',
  '有没有参加人工智能大赛的队伍缺人'
]
const SUSPECT = [
  '有人想组队吗，还没想好做什么',
  '小组作业还缺一个人，有同学愿意加入吗',
  '想参加数学建模比赛，有没有人了解一下',
  '找两个队友，周末开始准备'
]
const NEITHER = [
  '周末羽毛球组队，还差两人',
  '王者荣耀开黑缺一个队友',
  '篮球比赛缺人，今晚来打',
  '奶茶店招人，时薪 18',
  '数模比赛代做论文，保奖，私聊',
  '拼车去机场还差一人',
  '今天比赛结果出来了，太激动',
  '食堂新开了一家麻辣烫',
  // 线上真实误伤
  '招募CS2队友参加极限之地比赛，缺2人',
  '北语羽毛球比赛男双缺一人',
  '12.5 陈粒演唱会找搭子',
  '香港组队dd，想找个搭子去玩',
  '校园歌手大赛，想报名的可以来',
  '大家填一下问卷呀，我们小组作业'
]

AUTO.forEach((text) => assert.strictEqual(isTeamText(post(text)), true, `应自动收：${text}`))
SUSPECT.forEach((text) => {
  assert.strictEqual(isTeamText(post(text)), false, `不该自动收：${text}`)
  assert.strictEqual(isTeamSuspect(post(text)), true, `应进疑似：${text}`)
})
NEITHER.forEach((text) => {
  assert.strictEqual(isTeamText(post(text)), false, `不该自动收：${text}`)
  assert.strictEqual(isTeamSuspect(post(text)), false, `不该进疑似：${text}`)
})

// 标题里写的也算；分类选了「活动组队」不算信号（线上基本是拼车、打球、出游）
assert.strictEqual(isTeamText(post('本人大三会建模', { title: '美赛找队友' })), true)
assert.strictEqual(isTeamSuspect(post('周六有个活动', { category: '活动组队' })), false)

// 组队帖同时带「帮忙」字样时只进组队汇总，不重复进帮帮群
const both = post('美赛组队，有没有人能帮我们写论文，缺一个队友')
assert.strictEqual(isTeamText(both), true)
assert.strictEqual(isHelpText(both), false)
assert.strictEqual(isHelpText(post('帮我取个快递，有偿')), true)

console.log('PASS')
