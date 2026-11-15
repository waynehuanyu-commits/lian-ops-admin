// 店铺：商家信息录入（只做展示，不涉及下单收款）。依赖 app.js 的全局：state、api、esc、formatTime、render、shrinkImage。
// 小程序攻略页只在「吃喝玩乐」放店铺：顶部推荐栏放标了「推荐」的店（栏名在本页上方改），下面按需求分类竖排列店铺；
// 推荐栏和列表的顺序由云函数 listShops 自动轮换（每 3 小时一轮、每人不同），后台不再手动排序；
// 详情页的「相关笔记」按店名和别名匹配审核通过的攻略，学生帖不自动挂。

state.shopDraft = state.shopDraft || null

async function reloadShops() {
  const [result] = await Promise.all([api('/api/shops'), reloadShopStats()])
  if (!result.ok) return
  state.data = state.data || {}
  state.data.shops = result
  if (state.nav === 'shops') render()
}

function needsOf(group) {
  const needs = (state.data && state.data.shops && state.data.shops.needs) || {}
  return needs[group] || []
}

function emptyShop(groups) {
  const group = groups[0] || '吃喝玩乐'
  return { id: '', name: '', group, need: needsOf(group)[0] || '', tags: '', address: '', hours: '', phone: '', intro: '', aliases: '', images: [], imageUrls: [], contactQr: '', contactQrUrl: '', avatar: '', avatarUrl: '' }
}

function shopFormHtml(draft, groups) {
  const local = (state.data && state.data.overview && state.data.overview.mode) !== 'cloud'
  return `
    <div class="card">
      <h3>${draft.id ? `编辑：${esc(draft.name)}` : '添加店铺'}</h3>
      <p class="muted">保存后出现在小程序「黎安攻略」对应分支的需求分类下；勾了「推荐」还会进顶部推荐栏。第一张图是封面（建议方图）。「别名」用来匹配相关笔记：已发布的攻略提到店名或任一别名，就会出现在店铺详情下面（学生发的帖子不会自动出现）。</p>
      <div class="shop-form">
        <div class="shop-images">
          ${(draft.imageUrls || []).map((url, index) => `
            <div class="shop-img">
              <img src="${esc(url)}" alt="" />
              ${index === 0 ? '<span class="shop-img-tag">封面</span>' : `<button type="button" class="quiet" data-shop-img-first="${index}">设为封面</button>`}
              <button type="button" class="quiet warn" data-shop-img-del="${index}">删</button>
            </div>`).join('')}
          ${(draft.images || []).length < 6 ? '<label class="upload-btn shop-img-add">上传图片<input id="shop-file" type="file" accept="image/jpeg,image/png,image/webp" hidden /></label>' : ''}
          <span id="shop-upload-status" class="muted"></span>
          <div class="shop-qr">
            <span class="shop-qr-label">头像（选填）</span>
            ${draft.avatarUrl
              ? `<img class="shop-avatar" src="${esc(draft.avatarUrl)}" alt="" /><button type="button" class="quiet warn" id="shop-avatar-del">删</button>`
              : '<span class="muted">Logo 或经营微信头像，列表和推荐栏的方形小图优先用它；不传就用第一张照片</span>'}
            <label class="upload-btn">${draft.avatarUrl ? '换一张' : '上传头像'}<input id="shop-avatar-file" type="file" accept="image/jpeg,image/png,image/webp" hidden /></label>
          </div>
          <div class="shop-qr">
            <span class="shop-qr-label">联系二维码</span>
            ${draft.contactQrUrl
              ? `<img src="${esc(draft.contactQrUrl)}" alt="" /><button type="button" class="quiet warn" id="shop-qr-del">删</button>`
              : '<span class="muted">商家的微信 / 企业微信码，学生在店铺页长按识别联系</span>'}
            <label class="upload-btn">${draft.contactQrUrl ? '换一张' : '上传二维码'}<input id="shop-qr-file" type="file" accept="image/jpeg,image/png,image/webp" hidden /></label>
          </div>
        </div>
        <div class="gd-fields">
          <label class="shop-field"><span>店名</span><input id="shop-name" maxlength="20" placeholder="店名（必填）" value="${esc(draft.name)}" /></label>
          <label class="shop-field" ${groups.length < 2 ? 'hidden' : ''}><span>分支</span><select id="shop-group">${groups.map((g) => `<option value="${esc(g)}" ${g === draft.group ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select></label>
          <label class="shop-field"><span>需求分类</span><select id="shop-need">${needsOf(draft.group).map((n) => `<option value="${esc(n)}" ${n === draft.need ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
          <label class="shop-field"><span>推荐</span><span class="row gap"><label class="check-row"><input id="shop-featured" type="checkbox" ${draft.featured ? 'checked' : ''} /><span>放进顶部推荐栏</span></label><input id="shop-featured-until" type="date" value="${esc(draft.featuredUntil || '')}" title="推荐到期日（选填）" /></span></label>
          <label class="shop-field"><span>标签</span><input id="shop-tags" maxlength="24" placeholder="一句话标签，如：重庆小面 · 人均 15" value="${esc(draft.tags)}" /></label>
          <label class="shop-field"><span>地址</span><input id="shop-address" maxlength="60" placeholder="地址，如：大墩村赵都客栈一楼" value="${esc(draft.address)}" /></label>
          <label class="shop-field"><span>营业时间</span><input id="shop-hours" maxlength="40" placeholder="营业时间，如：10:00–22:00" value="${esc(draft.hours)}" /></label>
          <label class="shop-field"><span>电话</span><input id="shop-phone" maxlength="30" placeholder="联系电话（选填）" value="${esc(draft.phone)}" /></label>
          <label class="shop-field"><span>别名</span><input id="shop-aliases" maxlength="60" placeholder="别名（选填，逗号分隔，如：重庆面馆,小面）" value="${esc(draft.aliases)}" /></label>
          <label class="shop-field"><span>介绍</span><textarea id="shop-intro" maxlength="600" rows="6" placeholder="店铺介绍（选填）">${esc(draft.intro)}</textarea></label>
          <div class="row gap">
            <button id="shop-save" type="button">${draft.id ? '保存修改' : '保存并上线'}</button>
            <button id="shop-cancel" type="button" class="quiet">取消</button>
          </div>
          ${local ? '<p class="muted">当前是本地演示模式：上传的图片只用于后台预览，小程序读不到。</p>' : ''}
        </div>
      </div>
    </div>`
}

// 推荐到期日按北京时间当天结束算
function featuredNow(item) {
  if (!item.featured) return false
  if (!item.featuredUntil) return true
  return Date.now() < new Date(`${item.featuredUntil}T23:59:59+08:00`).getTime()
}

// 没传图的店：和小程序一样按文字封面规则显示（店名 + 需求分类），颜色按名字稳定分配
function shopTone(item) {
  return Array.from(String(item.name || '')).reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 5
}

function shopRowHtml(item) {
  const online = item.status !== 'offline'
  return `
    <div class="gd-row">
      ${item.avatarUrl || (item.imageUrls && item.imageUrls[0])
        ? `<img class="shop-thumb" src="${esc(item.avatarUrl || item.imageUrls[0])}" alt="" />`
        : `<div class="shop-thumb gd-tthumb tone-${shopTone(item)} shop-mini"><strong>${esc(item.name)}</strong><span>${esc(item.need || item.group)}</span></div>`}
      <div class="gd-copy">
        <strong>${esc(item.name)}${featuredNow(item) ? ` <span class="shop-featured">推荐${item.featuredUntil ? ` · 到 ${esc(item.featuredUntil)}` : ''}</span>` : (item.featured ? ' <span class="shop-featured expired">推荐已到期</span>' : '')}</strong>
        <span class="meta"><span class="gd-kind ${online ? 'article' : 'post'}">${online ? '已上线' : '已下线'}</span> ${esc(item.group)} · ${esc(item.need || '未选需求')}${item.tags ? ` · ${esc(item.tags)}` : ''}</span>
        <span class="meta">${esc(item.address || '未填地址')}${item.hours ? ` · ${esc(item.hours)}` : ''} · ${item.contactQr ? '有联系码' : '<span class="warn-text">没联系码</span>'}</span>
      </div>
      ${shopMetricsHtml(item)}
      <div class="gd-ops">
        <button type="button" class="quiet" data-shop-stats="${esc(item.id)}">数据</button>
        ${online ? `<button type="button" class="quiet" data-shop-act="${featuredNow(item) ? 'unfeature' : 'feature'}" data-id="${esc(item.id)}">${featuredNow(item) ? '取消推荐' : '设为推荐'}</button>` : ''}
        <button type="button" class="quiet" data-shop-edit="${esc(item.id)}">编辑</button>
        ${online
          ? `<button type="button" class="quiet warn" data-shop-act="offline" data-id="${esc(item.id)}">下线</button>`
          : `<button type="button" class="quiet" data-shop-act="online" data-id="${esc(item.id)}">重新上线</button>
             <button type="button" class="quiet warn" data-shop-act="delete" data-id="${esc(item.id)}">删除</button>`}
      </div>
    </div>`
}

function renderShops(panel, data) {
  const pack = data || { items: [], groups: ['吃喝玩乐'] }
  const groups = pack.groups || ['吃喝玩乐']
  if (state.shopImport) {
    panel.innerHTML = shopImportHtml()
    bindShopImport(panel)
    return
  }
  const items = pack.items || []
  const statsItem = state.shopStatsId && items.find((row) => row.id === state.shopStatsId)
  if (statsItem) {
    panel.innerHTML = shopStatsPageHtml(statsItem)
    bindShopStatsPage(panel, statsItem)
    return
  }
  const draft = state.shopDraft
  const needs = pack.needs || {}
  panel.innerHTML = draft ? shopFormHtml(draft, groups) : `
    ${shopOverviewHtml(items)}
    <div class="card">
      <h3>推荐栏和需求分类</h3>
      <p class="muted">每个分支顶部是推荐栏（放下面标了「推荐」的店，栏名最多 8 个字）；推荐栏下面是需求分类标签，按学生的真实需求分（顿号分隔，每支最多 8 个、每个最多 6 个字），标签前面固定有「全部」。</p>
      ${groups.map((group) => `
        <div class="shop-needs-group">
          <strong>${esc(group)}</strong>
          <label class="shop-field"><span>推荐栏名</span><input data-title-of="${esc(group)}" maxlength="8" value="${esc((pack.titles || {})[group] || '')}" /></label>
          <label class="shop-field"><span>需求分类</span><input data-needs-of="${esc(group)}" value="${esc((needs[group] || []).join('、'))}" /></label>
        </div>`).join('')}
      <div class="row gap"><button id="shop-needs-save" type="button" class="quiet">保存</button></div>
    </div>
    <div class="card">
      <div class="row gap" style="justify-content: space-between;">
        <h3>店铺 · ${items.length} 家</h3>
        <span class="row gap"><button id="shop-import" type="button" class="quiet">批量导入</button><button id="shop-add" type="button">添加店铺</button></span>
      </div>
      <p class="muted">只做信息展示，不在小程序里下单收款。「设为推荐」的店进分支顶部推荐栏（可在编辑里设到期日，到期自动下来）；没设推荐时推荐栏自动放 6 家。推荐栏和列表的顺序每 3 小时自动轮换一次，每个同学看到的顺序也不同，每家店都能轮到前排。</p>
      ${groups.map((group) => {
        const rows = items.filter((item) => item.group === group)
        return `<h4 class="shop-group-title">${esc(group)}（${rows.length}）</h4>${rows.length ? rows.map(shopRowHtml).join('') : '<p class="muted">还没有店铺</p>'}`
      }).join('')}
    </div>`
  if (draft) bindShopForm(panel)
  else bindShopList(panel, pack)
}

function bindShopList(panel, pack) {
  const needsSave = panel.querySelector('#shop-needs-save')
  if (needsSave) needsSave.onclick = async () => {
    const body = { titles: {} }
    panel.querySelectorAll('[data-needs-of]').forEach((input) => { body[input.dataset.needsOf] = input.value })
    panel.querySelectorAll('[data-title-of]').forEach((input) => { body.titles[input.dataset.titleOf] = input.value })
    needsSave.disabled = true
    const result = await api('/api/shops/needs', { method: 'POST', body: JSON.stringify(body) })
    needsSave.disabled = false
    if (!result.ok) return alert(result.message || '保存失败')
    await reloadShops()
  }
  panel.querySelectorAll('[data-shop-stats]').forEach((btn) => {
    btn.onclick = () => { state.shopStatsId = btn.dataset.shopStats; state.shopStatsRange = 7; render() }
  })
  const importBtn = panel.querySelector('#shop-import')
  if (importBtn) importBtn.onclick = () => { state.shopImport = { text: '' }; render() }
  const add = panel.querySelector('#shop-add')
  if (add) add.onclick = () => { state.shopDraft = emptyShop(pack.groups || []); render() }
  panel.querySelectorAll('[data-shop-edit]').forEach((btn) => {
    btn.onclick = () => {
      const item = (pack.items || []).find((row) => row.id === btn.dataset.shopEdit)
      if (!item) return
      state.shopDraft = { ...emptyShop(pack.groups || []), ...item, images: (item.images || []).slice(), imageUrls: (item.imageUrls || []).slice(), contactQr: item.contactQr || '', contactQrUrl: item.contactQrUrl || '', avatar: item.avatar || '', avatarUrl: item.avatarUrl || '' }
      render()
    }
  })
  panel.querySelectorAll('[data-shop-act]').forEach((btn) => {
    btn.onclick = async () => {
      const action = btn.dataset.shopAct
      if (action === 'delete' && !window.confirm('删除后不能恢复，确定删除这家店？')) return
      btn.disabled = true
      const result = await api('/api/shops/update', { method: 'POST', body: JSON.stringify({ id: btn.dataset.id, action }) })
      btn.disabled = false
      if (!result.ok) return alert(result.message || '操作失败')
      await reloadShops()
    }
  })
}

function bindShopForm(panel) {
  const readDraft = () => ({
    ...state.shopDraft,
    name: panel.querySelector('#shop-name').value.trim(),
    group: panel.querySelector('#shop-group').value,
    need: panel.querySelector('#shop-need') ? panel.querySelector('#shop-need').value : '',
    featured: panel.querySelector('#shop-featured').checked,
    featuredUntil: panel.querySelector('#shop-featured-until').value,
    tags: panel.querySelector('#shop-tags').value.trim(),
    address: panel.querySelector('#shop-address').value.trim(),
    hours: panel.querySelector('#shop-hours').value.trim(),
    phone: panel.querySelector('#shop-phone').value.trim(),
    aliases: panel.querySelector('#shop-aliases').value.trim(),
    intro: panel.querySelector('#shop-intro').value.trim()
  })
  const fileInput = panel.querySelector('#shop-file')
  const status = panel.querySelector('#shop-upload-status')
  if (fileInput) fileInput.onchange = async (e) => {
    const file = e.target.files && e.target.files[0]
    if (!file) return
    status.textContent = '上传中…'
    try {
      const dataUrl = await shrinkImage(file)
      const result = await api('/api/guides/upload', { method: 'POST', body: JSON.stringify({ type: 'image/jpeg', data: dataUrl }) })
      if (!result.ok) {
        status.textContent = result.message || '上传失败'
        return
      }
      const d = readDraft()
      state.shopDraft = { ...d, images: d.images.concat(result.src), imageUrls: d.imageUrls.concat(result.previewUrl || result.src) }
      render()
    } catch (err) {
      status.textContent = (err && err.message) || '上传失败'
    }
  }
  // 联系二维码、头像：各一张，传完替换
  const bindSingleImage = (inputId, delId, key, label) => {
    const input = panel.querySelector(inputId)
    if (input) input.onchange = async (e) => {
      const file = e.target.files && e.target.files[0]
      if (!file) return
      status.textContent = `${label}上传中…`
      try {
        const dataUrl = await shrinkImage(file)
        const result = await api('/api/guides/upload', { method: 'POST', body: JSON.stringify({ type: 'image/jpeg', data: dataUrl }) })
        if (!result.ok) {
          status.textContent = result.message || '上传失败'
          return
        }
        state.shopDraft = { ...readDraft(), [key]: result.src, [`${key}Url`]: result.previewUrl || result.src }
        render()
      } catch (err) {
        status.textContent = (err && err.message) || '上传失败'
      }
    }
    const del = panel.querySelector(delId)
    if (del) del.onclick = () => {
      state.shopDraft = { ...readDraft(), [key]: '', [`${key}Url`]: '' }
      render()
    }
  }
  bindSingleImage('#shop-qr-file', '#shop-qr-del', 'contactQr', '二维码')
  bindSingleImage('#shop-avatar-file', '#shop-avatar-del', 'avatar', '头像')
  panel.querySelectorAll('[data-shop-img-del]').forEach((btn) => {
    btn.onclick = () => {
      const i = Number(btn.dataset.shopImgDel)
      const d = readDraft()
      state.shopDraft = { ...d, images: d.images.filter((_, k) => k !== i), imageUrls: d.imageUrls.filter((_, k) => k !== i) }
      render()
    }
  })
  panel.querySelectorAll('[data-shop-img-first]').forEach((btn) => {
    btn.onclick = () => {
      const i = Number(btn.dataset.shopImgFirst)
      const d = readDraft()
      const move = (list) => [list[i]].concat(list.filter((_, k) => k !== i))
      state.shopDraft = { ...d, images: move(d.images), imageUrls: move(d.imageUrls) }
      render()
    }
  })
  // 换分支后需求分类跟着换
  panel.querySelector('#shop-group').onchange = () => {
    const d = readDraft()
    state.shopDraft = { ...d, need: needsOf(d.group)[0] || '' }
    render()
  }
  panel.querySelector('#shop-cancel').onclick = () => { state.shopDraft = null; render() }
  const save = panel.querySelector('#shop-save')
  save.onclick = async () => {
    save.disabled = true
    const { imageUrls, contactQrUrl, avatarUrl, ...body } = readDraft()
    const result = await api('/api/shops/save', { method: 'POST', body: JSON.stringify(body) })
    save.disabled = false
    if (!result.ok) return alert(result.message || '保存失败')
    state.shopDraft = null
    await reloadShops()
  }
}

// ── 批量导入 / 批量传图 ──
// 粘贴：从飞书多维表格或 Excel 选中整块（含表头）复制过来，按列名认字段；也能选 CSV 文件
const IMPORT_HEADERS = {
  name: ['店名', '店铺名称', '名称'],
  group: ['分支', '店铺属于哪一类'],
  need: ['需求分类', '主要做什么', '分类'],
  tags: ['一句话标签', '一句话介绍', '标签'],
  address: ['地址'],
  hours: ['营业时间'],
  phone: ['公开电话', '给学生打的电话', '电话', '联系电话'],
  intro: ['店铺介绍', '介绍'],
  aliases: ['别名', '学生怎么叫这家店', '学生平时怎么叫咱家']
}
const IMPORT_LABELS = { name: '店名', group: '分支', need: '需求分类', tags: '标签', address: '地址', hours: '营业时间', phone: '电话', intro: '介绍', aliases: '别名' }

// 支持制表符（飞书 / Excel 复制）和逗号（CSV，带引号转义）
function parseTable(text) {
  const src = String(text || '').replace(/^﻿/, '')
  const delim = src.split('\n')[0].includes('\t') ? '\t' : ','
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i += 1 }
      else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"' && cell === '') quoted = true
    else if (ch === delim) { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1
      row.push(cell); cell = ''
      if (row.some((c) => c.trim())) rows.push(row)
      row = []
    } else cell += ch
  }
  row.push(cell)
  if (row.some((c) => c.trim())) rows.push(row)
  return rows
}

function tableToShops(text) {
  const table = parseTable(text)
  if (table.length < 2) return { rows: [], columns: [] }
  const header = table[0].map((h) => h.trim())
  const columns = {}
  Object.keys(IMPORT_HEADERS).forEach((key) => {
    const idx = header.findIndex((h) => IMPORT_HEADERS[key].includes(h))
    if (idx >= 0) columns[key] = idx
  })
  const rows = table.slice(1).map((cells) => {
    const row = {}
    Object.keys(columns).forEach((key) => { row[key] = String(cells[columns[key]] || '').trim() })
    return row
  })
  return { rows, columns: Object.keys(columns) }
}

function shopImportHtml() {
  const imp = state.shopImport || {}
  const checked = imp.checked || []
  const good = checked.filter((r) => !r.problems.length)
  return `
    <div class="card">
      <div class="row gap" style="justify-content: space-between;">
        <h3>批量导入店铺</h3>
        <button id="imp-close" type="button" class="quiet">返回店铺列表</button>
      </div>
      <p class="muted">在飞书多维表格（或 Excel）里选中要导入的整块内容，<strong>连同第一行表头</strong>一起复制，粘贴到下面；也可以选 CSV 文件。能认的列：店名、需求分类（或「主要做什么」）、一句话标签、地址、营业时间、电话、介绍、别名、分支（不填按需求分类自动归）。店名相同的会更新原来那家，不会重复新建；照片和二维码用下面的「批量传图」。</p>
      <textarea id="imp-text" rows="8" placeholder="把表格粘贴到这里">${esc(imp.text || '')}</textarea>
      <div class="row gap" style="margin-top: 10px;">
        <button id="imp-check" type="button">预览</button>
        <label class="upload-btn">选 CSV 文件<input id="imp-file" type="file" accept=".csv,text/csv" hidden /></label>
        <span class="muted">${imp.columns ? `认出的列：${imp.columns.map((k) => IMPORT_LABELS[k]).join('、') || '无'}` : ''}</span>
      </div>
      ${checked.length ? `
        <table class="imp-table">
          <thead><tr><th>#</th><th>操作</th><th>店名</th><th>分支 / 需求</th><th>标签</th><th>地址</th><th>营业时间</th><th>问题</th></tr></thead>
          <tbody>${checked.map((r) => `
            <tr class="${r.problems.length ? 'bad' : ''}">
              <td>${r.index + 1}</td>
              <td>${r.problems.length ? '跳过' : (r.action === 'update' ? '更新' : '新建')}</td>
              <td>${esc(r.row.name)}</td>
              <td>${esc(r.row.group)} / ${esc(r.row.need)}</td>
              <td>${esc(r.row.tags)}</td>
              <td>${esc(r.row.address)}</td>
              <td>${esc(r.row.hours)}</td>
              <td class="warn-text">${esc(r.problems.join('；'))}</td>
            </tr>`).join('')}</tbody>
        </table>
        <div class="row gap">
          <button id="imp-go" type="button" ${good.length ? '' : 'disabled'}>导入 ${good.length} 家</button>
          <span class="muted">${checked.length - good.length ? `${checked.length - good.length} 行有问题会跳过，改好后重新粘贴即可` : ''}</span>
        </div>` : ''}
      ${imp.done ? `<p class="meta">导入完成：新建 ${imp.done.created} 家，更新 ${imp.done.updated} 家${imp.done.failed ? `，失败 ${imp.done.failed} 家` : ''}。</p>` : ''}
    </div>
    <div class="card">
      <h3>批量传图</h3>
      <p class="muted">一次选多张图，<strong>文件名就是店名</strong>：「店名.jpg」「店名-2.jpg」会加到店铺照片（第一张当封面），「店名-二维码.jpg」会设为联系二维码，「店名-头像.jpg」会设为头像。店铺要先导入或建好。</p>
      <label class="upload-btn">选择图片<input id="imp-images" type="file" accept="image/jpeg,image/png,image/webp" multiple hidden /></label>
      ${(imp.imageLog || []).length ? `<ul class="imp-log">${imp.imageLog.map((l) => `<li class="${l.ok ? '' : 'warn-text'}">${esc(l.file)} → ${esc(l.text)}</li>`).join('')}</ul>` : ''}
    </div>`
}

// 文件名 → { name, kind }：去扩展名；以「二维码 / qr」结尾的是联系码，「头像 / logo」结尾的是头像；结尾「-数字」是同店第几张
function parseImageName(fileName) {
  let base = String(fileName || '').replace(/\.[^.]+$/, '').trim()
  if (/[-_ ]?(头像|logo|LOGO|Logo)$/.test(base)) return { name: base.replace(/[-_ ]?(头像|logo|LOGO|Logo)$/, '').trim(), kind: 'avatar' }
  if (/[-_ ]?(二维码|联系码|qr|QR)$/.test(base)) return { name: base.replace(/[-_ ]?(二维码|联系码|qr|QR)$/, '').trim(), kind: 'qr' }
  base = base.replace(/[-_ ]\d+$/, '').trim()
  return { name: base, kind: 'photo' }
}

function bindShopImport(panel) {
  const imp = state.shopImport
  panel.querySelector('#imp-close').onclick = async () => { state.shopImport = null; await reloadShops() }
  const runCheck = async (text) => {
    const { rows, columns } = tableToShops(text)
    if (!rows.length) {
      state.shopImport = { ...imp, text, checked: [], columns, done: null }
      render()
      return alert('没读到数据：确认第一行是表头、下面是店铺')
    }
    const result = await api('/api/shops/import-check', { method: 'POST', body: JSON.stringify({ rows }) })
    if (!result.ok) return alert(result.message || '预览失败')
    state.shopImport = { ...imp, text, rows, columns, checked: result.rows, done: null }
    render()
  }
  panel.querySelector('#imp-check').onclick = () => runCheck(panel.querySelector('#imp-text').value)
  panel.querySelector('#imp-file').onchange = async (e) => {
    const file = e.target.files && e.target.files[0]
    if (file) runCheck(await file.text())
  }
  const go = panel.querySelector('#imp-go')
  if (go) go.onclick = async () => {
    go.disabled = true
    const result = await api('/api/shops/import', { method: 'POST', body: JSON.stringify({ rows: imp.rows }) })
    go.disabled = false
    if (!result.ok) return alert(result.message || '导入失败')
    state.shopImport = { ...imp, checked: [], done: result }
    render()
  }
  panel.querySelector('#imp-images').onchange = async (e) => {
    const files = Array.from(e.target.files || [])
    const log = []
    const show = () => { state.shopImport = { ...state.shopImport, imageLog: log.slice() }; render() }
    for (const file of files) {
      const { name, kind } = parseImageName(file.name)
      try {
        const dataUrl = await shrinkImage(file)
        const up = await api('/api/guides/upload', { method: 'POST', body: JSON.stringify({ type: 'image/jpeg', data: dataUrl }) })
        if (!up.ok) { log.push({ file: file.name, ok: false, text: up.message || '上传失败' }); show(); continue }
        const r = await api('/api/shops/attach-image', { method: 'POST', body: JSON.stringify({ name, kind, src: up.src }) })
        log.push({ file: file.name, ok: r.ok, text: r.ok ? `${name} 的${({ qr: '联系二维码', avatar: '头像' })[kind] || '照片'}` : (r.message || '失败') })
      } catch (err) {
        log.push({ file: file.name, ok: false, text: (err && err.message) || '失败' })
      }
      show()
    }
  }
}
