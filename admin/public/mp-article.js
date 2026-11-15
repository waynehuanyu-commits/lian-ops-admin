// 公众号推文：圈选热帖 → 挑评论、改字 → 预览往期同款排版 → 复制进公众号编辑器（不调公众号接口）。
// 依赖 app.js 的全局：state、api、esc、formatTime、render。排版在服务端 lib/mp-article.js。

const MP_MAX = 15

function mpState() {
  state.mp = state.mp || { keyword: '', items: [], picked: [], posts: [], html: '', banner: true, footer: true }
  return state.mp
}

async function reloadMpArticle() {
  const mp = mpState()
  const result = await api(`/api/mp-article/candidates?keyword=${encodeURIComponent(mp.keyword || '')}`)
  if (!result.ok) return alert(result.message || '读取候选帖失败')
  mp.items = result.items || []
  if (state.nav === 'mparticle') render()
}

const mpKey = (item) => `${item.contentType}:${item.contentId}`

function mpPickList(mp) {
  if (!mp.items.length) return '<p class="muted">没有找到帖子。换个关键词试试。</p>'
  return `<div class="pick-list">${mp.items.map((item) => {
    const order = mp.picked.indexOf(mpKey(item))
    return `
      <label class="pick-row ${order >= 0 ? 'picked' : ''}">
        <input type="checkbox" data-mp-pick="${esc(mpKey(item))}" ${order >= 0 ? 'checked' : ''} ${order < 0 && mp.picked.length >= MP_MAX ? 'disabled' : ''} />
        <span class="pick-no">${order >= 0 ? order + 1 : ''}</span>
        <span class="pick-main">
          <span class="pick-line">
            ${item.onBoard ? '<span class="pick-topic">热榜</span>' : (item.tag ? `<span class="pick-topic">${esc(item.tag)}</span>` : '')}
            <strong class="pick-title">${esc(item.title)}</strong>
          </span>
          ${item.summary && item.summary !== item.title ? `<span class="pick-excerpt">${esc(item.summary)}</span>` : ''}
        </span>
        <span class="pick-meta">
          ${item.createdAt ? `<span>${formatTime(item.createdAt)}</span>` : ''}
          <span>赞 ${item.likeCount} · 评 ${item.commentCount}</span>
        </span>
      </label>`
  }).join('')}</div>`
}

function mpEditor(mp) {
  if (!mp.posts.length) return ''
  return `
    <div class="card">
      <h3>2. 改字、挑评论</h3>
      <p class="muted">标题和正文可以直接改（比如删掉手机号）。评论默认勾赞最多的 3 条，评论文字也能改。</p>
      ${mp.posts.map((post, pi) => `
        <div class="mp-post">
          <div class="mp-post-head">
            <span class="pick-no">${pi + 1}</span>
            <input class="mp-title" data-mp-field="title" data-pi="${pi}" value="${esc(post.title)}" />
            <button type="button" class="quiet" data-mp-move="${pi}:-1" ${pi === 0 ? 'disabled' : ''}>上移</button>
            <button type="button" class="quiet" data-mp-move="${pi}:1" ${pi === mp.posts.length - 1 ? 'disabled' : ''}>下移</button>
          </div>
          <textarea class="mp-content" data-mp-field="content" data-pi="${pi}" rows="3">${esc(post.content)}</textarea>
          ${post.comments.length ? post.comments.map((c, ci) => `
            <label class="mp-comment">
              <input type="checkbox" data-mp-comment="${pi}:${ci}" ${c.selected ? 'checked' : ''} />
              <input type="text" data-mp-ctext="${pi}:${ci}" value="${esc(c.text)}" />
              <span class="muted">赞 ${c.likeCount || 0}</span>
            </label>`).join('') : '<p class="muted">这条还没有评论。</p>'}
        </div>`).join('')}
      <div class="actions">
        <label class="mp-toggle"><input type="checkbox" id="mp-banner" ${mp.banner ? 'checked' : ''} /> 开头 banner</label>
        <label class="mp-toggle"><input type="checkbox" id="mp-footer" ${mp.footer ? 'checked' : ''} /> 结尾扫码 + 传送门</label>
        <button type="button" id="mp-render">生成预览</button>
      </div>
    </div>`
}

function mpPreview(mp) {
  if (!mp.html) return ''
  return `
    <div class="card">
      <div class="row">
        <div>
          <h3>3. 预览并复制</h3>
          <p class="muted">点「复制排版」，到公众号后台新建图文，在正文里 Command+V。粘贴后点开一个「点此查看和评论」，确认小程序链接还在。</p>
        </div>
        <button type="button" id="mp-copy">复制排版</button>
      </div>
      <div class="mp-phone"><div id="mp-preview">${mp.html}</div></div>
    </div>`
}

function renderMpArticle(panel) {
  const mp = mpState()
  panel.innerHTML = `
    <div class="card">
      <h3>1. 圈选帖子</h3>
      <p class="muted">默认列出「园区热议」榜单和近期热帖，标「热榜」的是当前榜上的。按勾选顺序排版，最多 ${MP_MAX} 条。</p>
      <div class="actions">
        <input id="mp-keyword" placeholder="搜标题或内容" value="${esc(mp.keyword)}" />
        <button type="button" class="quiet" id="mp-search">搜索</button>
      </div>
      ${mpPickList(mp)}
      <div class="pick-dock">
        <div class="pick-dock-info"><span class="pick-count">已选 ${mp.picked.length} / ${MP_MAX}</span></div>
        <button type="button" id="mp-compose" ${mp.picked.length ? '' : 'disabled'}>下一步：挑评论</button>
      </div>
    </div>
    ${mpEditor(mp)}
    ${mpPreview(mp)}`
  bindMpArticle(panel, mp)
}

function mpPayload(mp) {
  return {
    banner: mp.banner,
    footer: mp.footer,
    posts: mp.posts.map((post) => ({
      title: post.title,
      content: post.content,
      path: post.path,
      comments: post.comments.filter((c) => c.selected).map((c) => c.text)
    }))
  }
}

async function mpRender(mp) {
  const result = await api('/api/mp-article/render', { method: 'POST', body: JSON.stringify(mpPayload(mp)) })
  if (!result.ok) return alert(result.message || '排版失败')
  mp.html = result.html
  render()
  const preview = document.getElementById('mp-preview')
  if (preview) preview.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// 富文本复制：优先写 text/html 到剪贴板；http 下没有 Clipboard API，就选中预览区走 execCommand（秀米也是这么复制的）
async function mpCopy(btn, mp) {
  if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([mp.html], { type: 'text/html' }),
        'text/plain': new Blob([document.getElementById('mp-preview').innerText], { type: 'text/plain' })
      })])
      btn.textContent = '已复制，去公众号粘贴'
      return
    } catch (err) { /* 落到选区复制 */ }
  }
  const node = document.getElementById('mp-preview')
  const range = document.createRange()
  range.selectNodeContents(node)
  const sel = window.getSelection()
  sel.removeAllRanges()
  sel.addRange(range)
  let ok = false
  try { ok = document.execCommand('copy') } catch (err) { ok = false }
  sel.removeAllRanges()
  btn.textContent = ok ? '已复制，去公众号粘贴' : '复制失败，请手动选中预览区复制'
}

function bindMpArticle(panel, mp) {
  const search = async () => {
    mp.keyword = panel.querySelector('#mp-keyword').value.trim()
    await reloadMpArticle()
  }
  panel.querySelector('#mp-search').onclick = search
  panel.querySelector('#mp-keyword').onkeydown = (e) => { if (e.key === 'Enter') search() }
  panel.querySelectorAll('[data-mp-pick]').forEach((box) => {
    box.onchange = () => {
      const key = box.dataset.mpPick
      mp.picked = box.checked ? mp.picked.concat(key).slice(0, MP_MAX) : mp.picked.filter((k) => k !== key)
      render()
    }
  })
  panel.querySelector('#mp-compose').onclick = async (e) => {
    const btn = e.currentTarget
    btn.disabled = true
    const items = mp.picked.map((key) => {
      const [contentType, contentId] = key.split(':')
      return { contentType, contentId }
    })
    const result = await api('/api/mp-article/compose', { method: 'POST', body: JSON.stringify({ items }) })
    btn.disabled = false
    if (!result.ok) return alert(result.message || '读取帖子失败')
    if (result.message) alert(result.message)
    mp.posts = result.posts || []
    mp.html = ''
    if (mp.posts.length) await mpRender(mp)
  }
  panel.querySelectorAll('[data-mp-field]').forEach((el) => {
    el.oninput = () => {
      const post = mp.posts[Number(el.dataset.pi)]
      mp.posts = mp.posts.map((p) => (p === post ? { ...p, [el.dataset.mpField]: el.value } : p))
    }
  })
  const updateComment = (ref, patch) => {
    const [pi, ci] = ref.split(':').map(Number)
    mp.posts = mp.posts.map((p, i) => (i !== pi ? p : {
      ...p,
      comments: p.comments.map((c, j) => (j === ci ? { ...c, ...patch } : c))
    }))
  }
  panel.querySelectorAll('[data-mp-comment]').forEach((box) => {
    box.onchange = () => updateComment(box.dataset.mpComment, { selected: box.checked })
  })
  panel.querySelectorAll('[data-mp-ctext]').forEach((input) => {
    input.oninput = () => updateComment(input.dataset.mpCtext, { text: input.value })
  })
  panel.querySelectorAll('[data-mp-move]').forEach((btn) => {
    btn.onclick = () => {
      const [pi, step] = btn.dataset.mpMove.split(':').map(Number)
      const next = mp.posts.slice()
      const [moved] = next.splice(pi, 1)
      next.splice(pi + step, 0, moved)
      mp.posts = next
      render()
    }
  })
  const banner = panel.querySelector('#mp-banner')
  if (banner) banner.onchange = () => { mp.banner = banner.checked }
  const footer = panel.querySelector('#mp-footer')
  if (footer) footer.onchange = () => { mp.footer = footer.checked }
  const renderBtn = panel.querySelector('#mp-render')
  if (renderBtn) renderBtn.onclick = () => mpRender(mp)
  const copyBtn = panel.querySelector('#mp-copy')
  if (copyBtn) copyBtn.onclick = () => mpCopy(copyBtn, mp)
}
