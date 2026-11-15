// 飞书商家登记表 → 线上 shops 每日同步（脚本入口 admin/scripts/sync-shops.js）
//
// 规则（三方对比：表单现值 / 上次同步时的表单快照 / 线上店铺）：
// - 只有「表单值跟上次同步快照不一样」的字段才会写到线上：商家改了才同步，运营在后台改过、商家没动的字段不会被冲掉
// - 表单里清空的字段不会清掉线上（空值一律忽略）
// - 照片 / 联系码 / 头像按飞书 file_token 判断有没有换；换了才重新下载、压缩、上传
// - 不碰上下线、推荐、置顶、浏览量，也不会新建店铺（新提交的还是运营核对后录入）
// - 店铺跟飞书行的对应：优先 feishuRecordId，没有就按店名匹配一次并回填；快照存在店铺 feishuSnapshot 里
// - 没有快照的店铺（首次对上）只记基线，不改线上，差异列在报告里让人看一眼

const NEED_TEXT = {
  name: '店名',
  tags: '一句话标签',
  address: '地址',
  hours: '营业时间',
  intro: '店铺介绍',
  phone: '公开电话',
  aliases: '学生怎么叫这家店'
}
const LIMITS = { name: 20, tags: 24, address: 60, hours: 40, phone: 30, intro: 600, aliases: 60 }
const SKIP_STATUS = '暂不上线'
const IMAGE_MAX = 6

function text(value) {
  if (value == null) return ''
  if (Array.isArray(value)) return text(value[0])
  if (typeof value === 'object') return String(value.text || value.name || '').trim()
  return String(value).replace(/\r\n/g, '\n').trim()
}

function files(value) {
  return (Array.isArray(value) ? value : []).filter((item) => item && item.file_token).map((item) => item.file_token)
}

/** 把 lark-cli 的矩阵结果转成 [{ recordId, 店名: ..., ... }] */
function toRecords(result) {
  const { fields, data, record_id_list: ids } = result
  return data.map((row, index) => {
    const rec = { recordId: ids[index] }
    fields.forEach((name, i) => { rec[name] = row[i] })
    return rec
  })
}

/** 一行表单 → 能直接对比的规整值 */
function formValues(rec) {
  const out = { need: text(rec['需求分类']) }
  Object.keys(NEED_TEXT).forEach((key) => { out[key] = text(rec[NEED_TEXT[key]]) })
  out.images = files(rec['店铺照片']).slice(0, IMAGE_MAX)
  out.contactQr = files(rec['联系二维码']).slice(0, 1)
  out.avatar = files(rec['店铺头像（选填）']).slice(0, 1)
  return out
}

const FILE_KEYS = ['images', 'contactQr', 'avatar']
const TEXT_KEYS = ['name', 'tags', 'address', 'hours', 'intro', 'phone', 'aliases', 'need']

function sameList(a, b) {
  return JSON.stringify(a || []) === JSON.stringify(b || [])
}

/**
 * @param {Array} records toRecords 的结果
 * @param {Array} shops 线上 shops
 * @param {{ needs: string[] }} ctx 允许的需求分类
 * @returns {{ updates: Array, baselines: Array, pending: Array, skipped: Array, problems: Array }}
 */
function planSync(records, shops, ctx = {}) {
  const byRecord = new Map(shops.filter((s) => s.feishuRecordId).map((s) => [s.feishuRecordId, s]))
  const byName = new Map(shops.filter((s) => !s.feishuRecordId).map((s) => [String(s.name || '').trim(), s]))
  const plan = { updates: [], baselines: [], pending: [], skipped: [], problems: [] }
  for (const rec of records) {
    const form = formValues(rec)
    const label = form.name || rec.recordId
    if (text(rec['录入状态']) === SKIP_STATUS) { plan.skipped.push(label); continue }
    const shop = byRecord.get(rec.recordId) || byName.get(form.name)
    if (!shop) { plan.pending.push({ recordId: rec.recordId, name: label, status: text(rec['录入状态']) }); continue }
    const snap = shop.feishuSnapshot
    if (!snap || shop.feishuRecordId !== rec.recordId) {
      // 首次对上：只记基线；把表单跟线上不一致的字段列出来
      const diffs = TEXT_KEYS.filter((k) => form[k] && form[k] !== String(shop[k] || '')).map((k) => ({ key: k, form: form[k], shop: String(shop[k] || '') }))
      plan.baselines.push({ shop, recordId: rec.recordId, snapshot: form, diffs })
      continue
    }
    const set = {}
    const changed = []
    for (const key of TEXT_KEYS) {
      if (!form[key] || form[key] === snap[key]) continue
      if (LIMITS[key] && form[key].length > LIMITS[key]) { plan.problems.push(`${label}：${key} 超过 ${LIMITS[key]} 字，没同步`); continue }
      if (key === 'need' && ctx.needs && !ctx.needs.includes(form.need)) { plan.problems.push(`${label}：需求分类「${form.need}」后台没有，没同步`); continue }
      set[key] = form[key]
      changed.push(key)
    }
    const refresh = FILE_KEYS.filter((k) => form[k].length && !sameList(form[k], snap[k]))
    if (changed.length || refresh.length) plan.updates.push({ shop, recordId: rec.recordId, set, refresh, form, changed: changed.concat(refresh) })
    else if (!sameList(form.images, snap.images) || !sameList(form.contactQr, snap.contactQr) || !sameList(form.avatar, snap.avatar)) {
      // 只是商家把图删空了：线上不动，快照不更新，免得下次误判
    }
  }
  return plan
}

module.exports = { planSync, toRecords, formValues, FILE_KEYS, TEXT_KEYS, IMAGE_MAX }
