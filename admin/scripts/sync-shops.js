#!/usr/bin/env node
// 每日同步：飞书商家登记表 → 线上 shops。规则见 lib/shop-sync.js。
// 用法：node scripts/sync-shops.js            只看差异，不写库
//       node scripts/sync-shops.js --apply     写库（首次对上的店只记基线，不改线上）
//       --notify                               把结果发到内部群 webhook（WECOM_WEBHOOK_URL）
//       --records-file x.json --shops-file y.json   本地调试：不连飞书 / 线上库（只能 dry-run）
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { planSync, toRecords, FILE_KEYS } = require('../lib/shop-sync')

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : '' }

function shopSource() {
  const { SHOP_BASE_TOKEN: baseToken, SHOP_TABLE_ID: tableId, LARK_AS: as = 'bot' } = process.env
  if (!baseToken || !tableId) throw new Error('请设置 SHOP_BASE_TOKEN 和 SHOP_TABLE_ID')
  return ['--base-token', baseToken, '--table-id', tableId, '--as', as]
}

function lark(argv) {
  const prefix = process.env.LARK_PROFILE ? ['--profile', process.env.LARK_PROFILE] : []
  return execFileSync('lark-cli', prefix.concat(argv), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
}

function fetchRecords() {
  const rows = { fields: null, data: [], record_id_list: [] }
  for (let offset = 0; ; offset += 200) {
    const out = JSON.parse(lark(['base', '+record-list', '--limit', '200', '--offset', String(offset), '--json', ...shopSource()]))
    const d = out.data
    rows.fields = d.fields
    rows.data.push(...d.data)
    rows.record_id_list.push(...d.record_id_list)
    if (!d.has_more) break
  }
  return toRecords(rows)
}

/** 下载飞书附件 → ffmpeg 压成长边 1600 的 jpg → 传云存储，返回 cloud:// fileID */
async function uploadAttachment(db, recordId, token, shopId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shopsync-'))
  try {
    const raw = path.join(dir, 'raw')
    lark(['base', '+record-download-attachment', '--record-id', recordId, '--file-token', token, '--output', raw, ...shopSource()])
    const out = path.join(dir, 'out.jpg')
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-vf', "scale='min(1600,iw)':-2", '-frames:v', '1', '-update', '1', '-q:v', '4', out])
    return await db.uploadFile(`shops/${shopId}-${token.slice(0, 10)}.jpg`, fs.readFileSync(out))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

async function applyPlan(db, plan, report) {
  const now = Date.now()
  for (const b of plan.baselines) {
    const doc = { ...b.shop, feishuRecordId: b.recordId, feishuSnapshot: b.snapshot }
    delete doc._id
    await db.setDoc('shops', doc.id || b.shop._id, doc)
  }
  for (const u of plan.updates) {
    const doc = { ...(await db.getDoc('shops', u.shop.id || u.shop._id)) }
    const snap = { ...doc.feishuSnapshot }
    Object.assign(doc, u.set)
    Object.keys(u.set).forEach((k) => { snap[k] = u.form[k] })
    const shopId = doc.id || doc._id
    for (const key of u.refresh) {
      const ids = []
      for (const token of u.form[key]) ids.push(await uploadAttachment(db, u.recordId, token, shopId))
      if (key === 'images') doc.images = ids
      else doc[key] = ids[0]
      snap[key] = u.form[key]
    }
    doc.feishuSnapshot = snap
    doc.updatedAt = now
    doc.updatedBy = 'feishu-sync'
    delete doc._id
    await db.setDoc('shops', shopId, doc)
    report.applied.push(`${doc.name}：${u.changed.join('、')}`)
  }
}

async function notify(text) {
  const url = process.env.WECOM_WEBHOOK_URL
  if (!url) return
  await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msgtype: 'text', text: { content: text } }) }).catch(() => {})
}

/** 云库密钥在 admin/.env（和 server.js 一样读，已有的环境变量不覆盖） */
function loadAdminEnv() {
  const file = path.join(__dirname, '..', '.env')
  if (!fs.existsSync(file)) return
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line) => {
    const t = line.trim()
    const i = t.indexOf('=')
    if (!t || t.startsWith('#') || i < 1) return
    const key = t.slice(0, i).trim()
    if (!process.env[key]) process.env[key] = t.slice(i + 1).trim()
  })
}

async function main() {
  const local = opt('--records-file')
  let db = null
  let shops
  let needs
  if (local) {
    shops = JSON.parse(fs.readFileSync(opt('--shops-file'), 'utf8'))
    needs = ['正餐', '火锅烧烤', '小吃夜宵', '奶茶咖啡', '甜品烘焙', '剧本杀', '密室逃脱', '桌游棋牌', 'KTV', '电竞网咖', '台球', '运动健身', '轰趴聚会', '拍照写真', '其他']
  } else {
    require('../../server/load-env').loadEnv()
    loadAdminEnv()
    shopSource()
    db = require('../lib/db')
    if (db.useLocal()) throw new Error('没读到 TCB_ENV / TCB_SECRET_ID / TCB_SECRET_KEY（admin/.env），拒绝在本地演示库上跑')
    shops = await db.allDocs('shops')
    needs = ((await require('../lib/shops').getNeeds())['吃喝玩乐']) || []
  }
  const records = local ? toRecords(JSON.parse(fs.readFileSync(local, 'utf8'))) : fetchRecords()
  const plan = planSync(records, shops, { needs })
  const report = { applied: [] }
  if (flag('--apply') && db) await applyPlan(db, plan, report)

  const lines = []
  const mode = flag('--apply') ? '已写入' : '仅预览（没写库）'
  const label = (s) => `「${s.name || s}」`
  plan.updates.forEach((u) => lines.push(`更新 ${label(u.shop)}：${u.changed.join('、')}`))
  plan.baselines.forEach((b) => {
    lines.push(`首次对上 ${label(b.shop)}，记基线${b.diffs.length ? `；表单与线上不一致：${b.diffs.map((d) => `${d.key}（表单「${d.form.slice(0, 20)}」/ 线上「${d.shop.slice(0, 20)}」）`).join('；')}` : '，无差异'}`)
  })
  plan.pending.forEach((p) => lines.push(`线上没有 ${label(p.name)}（表单状态：${p.status || '空'}），等运营录入`))
  plan.problems.forEach((p) => lines.push(`⚠ ${p}`))
  const summary = `商家同步 ${mode}：更新 ${plan.updates.length} 家，新对上 ${plan.baselines.length} 家，待录入 ${plan.pending.length} 家，跳过 ${plan.skipped.length} 家`
  console.log([summary, ...lines].join('\n'))
  const important = plan.updates.length || plan.baselines.length || plan.problems.length || plan.pending.length
  if (flag('--notify') && flag('--apply') && important) await notify(`【运营提醒·勿转发】${summary}\n${lines.join('\n')}`)
}

main().catch((err) => { console.error('[sync-shops]', err && err.stack || err); process.exit(1) })
