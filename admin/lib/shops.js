// 店铺：运营在后台录入商家信息（只做展示，不涉及下单收款）。小程序攻略页只在「吃喝玩乐」按需求分类（正餐、剧本杀……）
// 竖排列出店铺，顶部推荐栏放运营标了「推荐」的店（各分支栏名不同）；点进去是详情 + 相关笔记（提到店名或别名、且审核通过的攻略；学生帖不自动挂）。小程序云函数 listShops / getShop 读同一个 shops 集合。
const crypto = require('crypto')
const db = require('./db')

const COLLECTION = 'shops'
const GROUPS = ['吃喝玩乐'] // 只有吃喝玩乐放店铺；以前录在「生活出行」的店小程序不再显示
const STATUSES = ['online', 'offline']
// 各分支下按真实需求分的小类（小程序分支顶部的标签），后台可改，存 meta/shop_needs
const NEEDS_DOC = 'shop_needs'
const DEFAULT_NEEDS = {
  吃喝玩乐: ['正餐', '火锅烧烤', '小吃夜宵', '奶茶咖啡', '甜品烘焙', '剧本杀', '密室逃脱', '桌游棋牌', 'KTV', '电竞网咖', '台球', '运动健身', '轰趴聚会', '拍照写真', '其他']
}
// 各分支顶部推荐栏的名字（同存 meta/shop_needs.titles）
const DEFAULT_TITLES = { 吃喝玩乐: '本周必去' }
const TITLE_MAX = 8
const NEED_MAX = 20
const NEED_NAME_MAX = 6
const LIMITS = { name: 20, tags: 24, address: 60, hours: 40, phone: 30, intro: 600, aliases: 60 }
const IMAGE_MAX = 6

function isValidImage(src) {
  return /^(cloud:\/\/|https:\/\/)/.test(src) || (db.useLocal() && src.startsWith('/uploads/'))
}

async function withPreview(rows) {
  const files = rows.flatMap((row) => (row.images || []).concat(row.contactQr || [], row.avatar || [])).filter(Boolean)
  const map = await db.resolveCloudUrls(files).catch(() => ({}))
  const url = (src) => (src ? (map[src] || (/^https?:|^\//.test(src) ? src : '')) : '')
  return rows.map((row) => ({
    ...row,
    id: row.id || row._id,
    imageUrls: (row.images || []).map(url),
    contactQrUrl: url(row.contactQr),
    avatarUrl: url(row.avatar)
  }))
}

async function getNeeds() {
  const row = await db.getDoc('meta', NEEDS_DOC).catch(() => null)
  return GROUPS.reduce((acc, group) => {
    const list = ((row && row[group]) || []).map((item) => String(item || '').trim()).filter(Boolean)
    acc[group] = list.length ? list : DEFAULT_NEEDS[group].slice()
    return acc
  }, {})
}

async function getTitles() {
  const row = await db.getDoc('meta', NEEDS_DOC).catch(() => null)
  const saved = (row && row.titles) || {}
  return GROUPS.reduce((acc, group) => ({ ...acc, [group]: String(saved[group] || '').trim() || DEFAULT_TITLES[group] }), {})
}

async function saveNeeds(payload = {}, operator = '') {
  const titles = {}
  for (const group of GROUPS) {
    const title = String((payload.titles && payload.titles[group]) || '').trim() || DEFAULT_TITLES[group]
    if (title.length > TITLE_MAX) return { ok: false, message: `推荐栏名字最多 ${TITLE_MAX} 个字：${title}` }
    titles[group] = title
  }
  const next = { id: NEEDS_DOC, titles, updatedAt: Date.now(), updatedBy: operator }
  for (const group of GROUPS) {
    const raw = Array.isArray(payload[group]) ? payload[group] : String(payload[group] || '').split(/[\n,，、]/)
    const list = Array.from(new Set(raw.map((item) => String(item || '').trim()).filter(Boolean)))
    if (!list.length) return { ok: false, message: `「${group}」至少保留一个需求分类` }
    if (list.length > NEED_MAX) return { ok: false, message: `每个分支最多 ${NEED_MAX} 个需求分类` }
    const tooLong = list.find((item) => item.length > NEED_NAME_MAX)
    if (tooLong) return { ok: false, message: `需求分类最多 ${NEED_NAME_MAX} 个字：${tooLong}` }
    next[group] = list
  }
  await db.setDoc('meta', NEEDS_DOC, next)
  return { ok: true, needs: next }
}

async function listShops() {
  await db.ensureCollection(COLLECTION).catch(() => {})
  const [rows, needs, titles] = await Promise.all([db.allDocs(COLLECTION).catch(() => []), getNeeds(), getTitles()])
  rows.sort((a, b) => (b.sortAt || 0) - (a.sortAt || 0))
  return { ok: true, groups: GROUPS, needs, titles, items: await withPreview(rows) }
}

function clean(value, max) {
  return String(value || '').replace(/\r\n/g, '\n').trim().slice(0, max + 1)
}

/** 新增或修改一家店：新增默认上线、排在最前 */
async function saveShop(payload = {}, operator = '') {
  const fields = {}
  for (const key of Object.keys(LIMITS)) {
    fields[key] = clean(payload[key], LIMITS[key])
    if (fields[key].length > LIMITS[key]) return { ok: false, message: `${key === 'intro' ? '介绍' : key} 最多 ${LIMITS[key]} 个字` }
  }
  if (!fields.name) return { ok: false, message: '请填写店名' }
  const group = String(payload.group || GROUPS[0]).trim()
  if (!GROUPS.includes(group)) return { ok: false, message: '店铺只能放在「吃喝玩乐」' }
  const need = String(payload.need || '').trim()
  if (!(await getNeeds())[group].includes(need)) return { ok: false, message: '请选择需求分类' }
  const images = (Array.isArray(payload.images) ? payload.images : []).map((src) => String(src || '').trim()).filter(Boolean)
  if (images.length > IMAGE_MAX) return { ok: false, message: `图片最多 ${IMAGE_MAX} 张` }
  const bad = images.find((src) => !isValidImage(src))
  if (bad) return { ok: false, message: '图片地址只能是云存储 fileID 或 https 链接' }
  // 联系二维码：商家的微信 / 企业微信码，小程序店铺页长按识别联系
  const contactQr = String(payload.contactQr || '').trim()
  if (contactQr && !isValidImage(contactQr)) return { ok: false, message: '联系二维码地址只能是云存储 fileID 或 https 链接' }
  // 头像（选填）：Logo 或经营微信头像，列表缩略图 / 推荐栏 / 详情页顶部优先用它，没有就用第一张照片
  const avatar = String(payload.avatar || '').trim()
  if (avatar && !isValidImage(avatar)) return { ok: false, message: '头像地址只能是云存储 fileID 或 https 链接' }
  // 推荐：上分支顶部推荐栏；可设到期日（北京时间当天结束），过期自动不推荐
  const featured = !!payload.featured
  const until = String(payload.featuredUntil || '').trim()
  if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) return { ok: false, message: '推荐到期日格式不对' }
  const now = Date.now()
  const id = String(payload.id || '').trim()
  const prev = id ? await db.getDoc(COLLECTION, id) : null
  if (id && !prev) return { ok: false, message: '这家店不存在' }
  const next = {
    ...(prev || {}),
    ...fields,
    id: id || `sp_${crypto.randomBytes(8).toString('hex')}`,
    group,
    need,
    featured,
    featuredUntil: featured ? until : '',
    images,
    contactQr,
    avatar,
    status: prev ? prev.status : 'online',
    sortAt: prev ? (prev.sortAt || now) : now,
    viewCount: prev ? prev.viewCount || 0 : 0,
    createdAt: prev ? prev.createdAt : now,
    updatedAt: now,
    updatedBy: operator
  }
  delete next._id
  await db.setDoc(COLLECTION, next.id, next)
  return { ok: true, shop: next }
}

/** online 上线 / offline 下线 / feature 设为推荐 / unfeature 取消推荐 / top 移到最前 / delete 删除 */
async function updateShop(payload = {}, operator = '') {
  const id = String(payload.id || '').trim()
  const action = String(payload.action || '')
  const row = id ? await db.getDoc(COLLECTION, id) : null
  if (!row) return { ok: false, message: '这家店不存在' }
  if (action === 'delete') {
    await db.removeDoc(COLLECTION, id)
    return { ok: true }
  }
  const now = Date.now()
  const next = { ...row, updatedAt: now, updatedBy: operator }
  delete next._id
  if (STATUSES.includes(action)) next.status = action
  else if (action === 'feature') next.featured = true
  else if (action === 'unfeature') {
    next.featured = false
    next.featuredUntil = ''
  } else if (action === 'top') {
    const rows = await db.allDocs(COLLECTION).catch(() => [])
    next.sortAt = Math.max(now, ...rows.map((item) => Number(item.sortAt) || 0)) + 1
  } else return { ok: false, message: '未知操作' }
  await db.setDoc(COLLECTION, id, next)
  return { ok: true }
}

// ── 批量导入：运营从飞书多维表格 / Excel 复制整块粘贴，或上传 CSV，前端解析成行后提交到这里 ──
// 同名店铺更新已有记录（只覆盖这次填了的字段），新店新建；需求分类决定分支（没写分支时）
const IMPORT_MAX = 200
const IMPORT_FIELDS = ['name', 'group', 'need', 'tags', 'address', 'hours', 'phone', 'intro', 'aliases']

function groupOfNeed(need, needs) {
  return GROUPS.find((group) => (needs[group] || []).includes(need)) || ''
}

/** 先校验不写库：返回每行的处理结果（新建 / 更新 / 有问题），给后台预览用 */
async function checkImport(rows = []) {
  const needs = await getNeeds()
  const existing = await db.allDocs(COLLECTION).catch(() => [])
  const byName = new Map(existing.map((row) => [String(row.name || '').trim(), row]))
  const seen = new Set()
  return rows.slice(0, IMPORT_MAX).map((raw, index) => {
    const row = {}
    IMPORT_FIELDS.forEach((key) => { row[key] = String((raw && raw[key]) || '').replace(/\r\n/g, '\n').trim() })
    const problems = []
    if (!row.name) problems.push('没有店名')
    if (row.name && seen.has(row.name)) problems.push('表里重复')
    seen.add(row.name)
    const prev = byName.get(row.name)
    if (!row.need && prev) row.need = prev.need || ''
    if (!row.group) row.group = groupOfNeed(row.need, needs) || (prev && prev.group) || ''
    if (!GROUPS.includes(row.group)) {
      if (row.group) problems.push(`分支「${row.group}」不存在`)
      else problems.push(row.need ? `需求分类「${row.need}」不在任何分支里（先在店铺页加上这个分类）` : '缺需求分类')
    }
    else if (!(needs[row.group] || []).includes(row.need)) problems.push(row.need ? `需求分类「${row.need}」不在「${row.group}」里` : '缺需求分类')
    for (const key of Object.keys(LIMITS)) {
      if (row[key] && row[key].length > LIMITS[key]) problems.push(`${key} 超过 ${LIMITS[key]} 字`)
    }
    return { index, row, action: prev ? 'update' : 'create', id: prev ? prev.id || prev._id : '', problems }
  })
}

/** 正式导入：只写没有问题的行 */
async function importShops(rows = [], operator = '') {
  const checked = await checkImport(rows)
  const results = []
  for (const item of checked) {
    if (item.problems.length) {
      results.push({ index: item.index, ok: false, message: item.problems.join('；') })
      continue
    }
    const prev = item.id ? await db.getDoc(COLLECTION, item.id) : null
    // 更新时没填的列沿用原值，图片、联系码、推荐状态不动
    const merged = { ...(prev || {}) }
    IMPORT_FIELDS.forEach((key) => { if (item.row[key]) merged[key] = item.row[key] })
    const result = await saveShop({ ...merged, id: item.id || '', images: (prev && prev.images) || [], contactQr: (prev && prev.contactQr) || '', avatar: (prev && prev.avatar) || '' }, operator)
    results.push({ index: item.index, ok: result.ok, message: result.message || '', action: item.action, id: result.shop && result.shop.id })
  }
  return { ok: true, results, created: results.filter((r) => r.ok && r.action === 'create').length, updated: results.filter((r) => r.ok && r.action === 'update').length, failed: results.filter((r) => !r.ok).length }
}

/** 批量传图：按店名把一张图追加到店铺图片，或设为联系码 / 头像 */
async function attachImage(payload = {}, operator = '') {
  const name = String(payload.name || '').trim()
  const src = String(payload.src || '').trim()
  const kind = ['qr', 'avatar'].includes(payload.kind) ? payload.kind : 'photo'
  if (!name || !src) return { ok: false, message: '缺店名或图片' }
  if (!isValidImage(src)) return { ok: false, message: '图片地址只能是云存储 fileID 或 https 链接' }
  const rows = await db.allDocs(COLLECTION).catch(() => [])
  const prev = rows.find((row) => String(row.name || '').trim() === name)
  if (!prev) return { ok: false, message: `没有叫「${name}」的店` }
  const next = { ...prev, updatedAt: Date.now(), updatedBy: operator }
  delete next._id
  if (kind === 'qr') next.contactQr = src
  else if (kind === 'avatar') next.avatar = src
  else {
    const images = (prev.images || []).filter((item) => item !== src)
    if (images.length >= IMAGE_MAX) return { ok: false, message: `「${name}」已经有 ${IMAGE_MAX} 张图` }
    next.images = images.concat(src)
  }
  await db.setDoc(COLLECTION, prev.id || prev._id, next)
  return { ok: true }
}

module.exports = { listShops, saveShop, updateShop, getNeeds, getTitles, saveNeeds, checkImport, importShops, attachImage, GROUPS }
