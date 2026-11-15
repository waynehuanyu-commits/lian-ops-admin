#!/usr/bin/env node
// 每周好店海报的选店 / 推荐语规则（lib/weekly-poster.js）。node scripts/test-weekly-poster.js，全过输出 PASS
const assert = require('assert')
const p = require('../lib/weekly-poster')

// 周一 09:00 跑，统计上一个完整自然周；第 1 期是 11.09—11.15
const w = p.lastWeek(Date.parse('2026-11-16T09:00:00+08:00'))
assert.strictEqual(w.label, '11.09—11.15')
assert.strictEqual(w.vol, 1)
assert.strictEqual(w.end - w.start, 7 * 24 * 3600 * 1000)
assert.strictEqual(p.lastWeek(Date.parse('2026-11-23T00:05:00+08:00')).vol, 2)
// 周日晚上补跑也只算上一个完整周
assert.strictEqual(p.lastWeek(Date.parse('2026-11-22T23:00:00+08:00')).label, '11.09—11.15')

// 选店：只要上线且本周有推荐的；同票看累计，再看浏览
const shops = [
  { _id: 'a', status: 'online', recommendCount: 1 },
  { _id: 'b', status: 'online', recommendCount: 5 },
  { _id: 'c', status: 'offline', recommendCount: 9 },
  { _id: 'd', status: 'online', recommendCount: 1 },
  { _id: 'e', status: 'online', recommendCount: 9 }
]
const top = p.pickTop(shops, { a: 2, b: 2, c: 5, d: 2 }, { a: 10, d: 30 })
assert.deepStrictEqual(top.map((s) => s.id), ['b', 'd', 'a'])
assert.strictEqual(p.pickTop(shops, {}).length, 0)

// 推荐语：截整句，去表情和哈哈哈，差评 / 提问不要，挂店的优先
const q = p.pickQuote([
  { text: 'utopia那个不是预制菜！全是现炒的！今天下午去店面 老板亲自炒的打抛饭 哈哈哈哈哈 不过就是店面很小' },
  { text: 'utopia那个打抛饭在哪里？！' },
  { text: '他家饺子一般 饭还可以' }
], 34)
assert.strictEqual(q.quote, 'utopia那个不是预制菜！全是现炒的！')
assert.strictEqual(p.pickQuote([{ text: '他家饺子一般 饭还可以' }, { text: '有没有人去过这家？' }], 34), null)
assert.strictEqual(p.pickQuote([{ text: '老板人超好😭😭，还送了一份小料！' }], 20).quote, '老板人超好，还送了一份小料！')
const pref = p.pickQuote([{ text: '这家的千层真的很好吃，奶油不腻。' }, { text: '芒果千层不错，奶油很新鲜。', attached: true }], 34)
assert.strictEqual(pref.quote, '芒果千层不错，奶油很新鲜。')

// 没原话用介绍，放不下截到逗号
assert.strictEqual(p.factLine({ intro: '现包现煮的手工饺子，酸汤和玉米猪肉卖得最好。' }, 20), '现包现煮的手工饺子')
assert.strictEqual(p.factLine({ need: '正餐', address: '生活一区' }, 20), '正餐 · 生活一区')

// HTML 转义，店名里有尖括号不会坏版
const html = p.buildHtml([{ name: '<b>店', need: '', week: 1, images: [], quote: '', fact: 'x' }], w, { fontDir: '/f', qr: '/q.png' })
assert.ok(html.includes('&lt;b&gt;店') && !html.includes('<b>店'))
assert.ok(html.includes('VOL.01'))

process.stdout.write('PASS\n')
