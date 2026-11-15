// 闲置 / 拼车 / 帮帮群 / 竞赛组队汇总：推到企微内部群（webhook），由内部同学转发到各个群。
// 本页能做的：改开关和时间、预览下一次会推哪些帖子、勾掉不想推的、判断疑似帖（加入 / 不是）、立即推一次、看最近的推送记录。
// 依赖 app.js 的全局：state、api、esc、formatTime、render。

const DIGEST_STATUS = { internal: '已发内部群', failed: '发送失败' }

async function reloadDigests() {
  const started = Date.now()
  const result = await api('/api/wecom/digests')
  state.data = state.data || {}
  // 读失败也要显示出来，不能一直停在「读取中」
  state.data.digests = result.ok ? result : { error: `${result.message || '读取失败'}（${Math.round((Date.now() - started) / 100) / 10} 秒）` }
  if (state.nav === 'sdigest') render()
}

// 疑似：规则拿不准的帖子，不自动推，等人工判断。「加入」进下一次汇总，「不是」以后不再出现
function suspectSection(d) {
  const fmt = (t) => (t ? formatTime(t) : '—')
  const list = d.suspects || []
  return `
      <h4 style="margin:16px 0 6px">疑似，等你判断${list.length ? `（${list.length}）` : ''}</h4>
      <p class="muted">最近 3 天规则拿不准、没自动收进来的帖子。有争议的会标出原因，由你把关；有风险、不公开、代课代签到的不会出现。</p>
      ${list.length ? `<div class="pick-list">${list.map((p) => `
        <div class="pick-row">
          <span class="pick-main"><strong>${esc(p.title || '（无标题）')}</strong><span class="muted">${esc(p.channel || '')} · ${esc(fmt(p.createdAt))}${p.disputed && p.disputed.length ? ` · <span class="danger">争议：${esc(p.disputed.join('、'))}</span>` : ''}</span><span class="pick-excerpt">${esc(p.summary || '')}</span></span>
          <span class="actions" style="flex-shrink:0"><button data-suspect-add="${esc(p.contentType)}:${esc(p.contentId)}" type="button">加入</button><button class="ghost" data-suspect-no="${esc(p.contentId)}" type="button">不是</button></span>
        </div>`).join('')}</div>` : '<p class="muted">没有疑似帖子。</p>'}`
}

function digestCard(d, webhookReady) {
  const fmt = (t) => (t ? formatTime(t) : '—')
  const nightly = d.noonTime === null
  const items = d.items || []
  const skipped = items.filter((item) => item.skip).length
  return `
    <div class="card" data-digest="${esc(d.key)}">
      <div class="row"><h3>${esc(d.title)}</h3><span class="push-dot ${d.enabled ? 'ok' : 'warn'}">${d.enabled ? '已开启' : '已关闭'}</span></div>
      <div class="push-grid">
        <div><span class="muted">下一次推送</span><strong>${d.enabled ? esc(d.nextSlot || '—') : '已关闭'}</strong></div>
        <div><span class="muted">上一次</span><strong>${d.last ? `${esc(d.last.day)}${d.last.slot ? ` ${esc(d.last.slot)}` : ''} · ${d.last.count ? `${d.last.count} 条` : '没有帖子，未推'}` : '还没推过'}</strong></div>
        <div><span class="muted">待推帖子</span><strong>${items.length} 条${skipped ? ` · 已跳过 ${skipped}` : ''}</strong></div>
      </div>
      <div class="row gap" style="margin:12px 0;flex-wrap:wrap">
        <label class="check-row"><input data-f="on" type="checkbox" ${d.enabled ? 'checked' : ''} /><span>开启</span></label>
        ${nightly ? '' : `<label class="display-field"><span class="display-label">午间</span><input data-f="noon" type="time" value="${esc(d.noonTime)}" /></label>`}
        <label class="display-field"><span class="display-label">${nightly ? '推送时间' : '晚间'}</span><input data-f="time" type="time" value="${esc(d.eveningTime || '21:00')}" /></label>
        <button data-act="save-settings" type="button">保存开关和时间</button>
      </div>
      ${nightly ? '' : '<p class="muted">午间清空 = 只推晚间。</p>'}
      <h4 style="margin:16px 0 6px">下一次会推的帖子（自 ${esc(fmt(d.since))} 起）</h4>
      <p class="muted">规则判中的自动在这里；有风险、不公开的不会进来。取消勾选 = 这次不推。</p>
      ${items.length ? `<div class="pick-list">${items.map((item) => `
        <label class="pick-row">
          <input type="checkbox" data-id="${esc(item.contentId)}" ${item.skip ? '' : 'checked'} />
          <span class="pick-main"><strong>${item.manual ? '<span class="push-dot warn">人工加入</span> ' : ''}${esc(item.title || '（无标题）')}</strong><span class="muted">${esc(item.channel || '')} · ${esc(fmt(item.createdAt))}${item.manual ? ` · <a href="#" data-unpick="${esc(item.contentId)}">移出</a>` : ''}</span><span class="pick-excerpt">${esc(item.summary || '')}</span></span>
        </label>`).join('')}</div>
      <div class="actions">
        <button data-act="send" type="button" ${webhookReady ? '' : 'disabled'}>立即推送勾选的</button>
        <button data-act="save-skip" type="button">保存跳过名单（定时推送时生效）</button>
      </div>` : '<p class="muted">暂时没有待推的帖子。</p>'}
      ${suspectSection(d)}
      <h4 style="margin:16px 0 6px">最近推送记录</h4>
      ${d.history.length ? `<div class="push-logs">${d.history.map((h) => `
        <div class="row"><span>${esc(fmt(h.at))} · ${esc(h.title || '')}</span><span class="muted">${esc(DIGEST_STATUS[h.status] || h.status || '')}</span></div>
        ${h.titles.length ? `<div class="meta">${h.titles.map((t) => esc(t)).join(' / ')}</div>` : ''}`).join('')}</div>` : '<p class="muted">还没有推送记录。</p>'}
    </div>`
}

function renderDigests(panel, data) {
  const pack = data || {}
  const digests = pack.digests
  if (pack.error) {
    panel.innerHTML = `<div class="card"><h3>读取失败</h3><p class="muted">${esc(pack.error)}</p><div class="actions"><button id="sd-retry" type="button">重试</button></div></div>`
    panel.querySelector('#sd-retry').onclick = () => reloadDigests()
    return
  }
  if (!digests) {
    panel.innerHTML = '<div class="card"><p class="muted">读取中…</p></div>'
    return
  }
  panel.innerHTML = `
    ${pack.webhookReady ? '' : '<div class="card"><p class="muted">服务器没配内部群 webhook（WECOM_WEBHOOK_URL），推不出去，请联系技术。</p></div>'}
    <div class="card">
      <h3>汇总推送</h3>
      <p class="muted">把上一次汇总之后新发的闲置、拼车、帮帮群、竞赛组队帖子，各自整理成文字链推到企微内部群，内部同学长按转发到对应的群。规则判中的自动推；拿不准的列在「疑似」里等你判断。到点没有帖子就不推。</p>
      <div class="actions"><button id="sd-refresh" type="button">刷新</button></div>
    </div>
    ${['secondhand', 'carpool', 'help', 'team'].filter((key) => digests[key]).map((key) => digestCard(digests[key], pack.webhookReady)).join('')}`

  panel.querySelector('#sd-refresh').onclick = () => reloadDigests()
  panel.querySelectorAll('[data-digest]').forEach((card) => {
    const kind = card.dataset.digest
    const field = (name) => card.querySelector(`[data-f="${name}"]`)
    const unchecked = () => [...card.querySelectorAll('input[data-id]')].filter((box) => !box.checked).map((box) => box.dataset.id)
    const pick = (act) => card.querySelector(`[data-act="${act}"]`)

    pick('save-settings').onclick = async (event) => {
      const btn = event.currentTarget
      btn.disabled = true
      const body = kind === 'secondhand'
        ? { secondhandEnabled: field('on').checked, secondhandNoonTime: field('noon').value, secondhandTime: field('time').value }
        : { [`${kind}Enabled`]: field('on').checked, [`${kind}Time`]: field('time').value }
      const result = await api('/api/wecom/digests/settings', { method: 'POST', body: JSON.stringify(body) })
      btn.disabled = false
      if (!result.ok) return alert(result.message || '保存失败')
      await reloadDigests()
    }

    const skipBtn = pick('save-skip')
    if (skipBtn) skipBtn.onclick = async (event) => {
      const btn = event.currentTarget
      btn.disabled = true
      const result = await api('/api/wecom/digests/exclude', { method: 'POST', body: JSON.stringify({ kind, ids: unchecked() }) })
      btn.disabled = false
      if (!result.ok) return alert(result.message || '保存失败')
      await reloadDigests()
    }

    card.querySelectorAll('[data-suspect-add]').forEach((btn) => {
      btn.onclick = async () => {
        const [contentType, ...rest] = btn.dataset.suspectAdd.split(':')
        btn.disabled = true
        const result = await api('/api/wecom/digests/include', { method: 'POST', body: JSON.stringify({ kind, picks: [{ contentType, contentId: rest.join(':') }] }) })
        if (!result.ok) { btn.disabled = false; return alert(result.message || '加入失败') }
        if (result.rejected) alert('这条已变成风险或不公开，没加进去')
        await reloadDigests()
      }
    })

    card.querySelectorAll('[data-suspect-no]').forEach((btn) => {
      btn.onclick = async () => {
        btn.disabled = true
        const result = await api('/api/wecom/digests/dismiss', { method: 'POST', body: JSON.stringify({ kind, contentId: btn.dataset.suspectNo }) })
        if (!result.ok) { btn.disabled = false; return alert(result.message || '操作失败') }
        await reloadDigests()
      }
    })

    card.querySelectorAll('[data-unpick]').forEach((link) => {
      link.onclick = async (event) => {
        event.preventDefault()
        const result = await api('/api/wecom/digests/include', { method: 'POST', body: JSON.stringify({ kind, remove: link.dataset.unpick }) })
        if (!result.ok) return alert(result.message || '移出失败')
        await reloadDigests()
      }
    })

    const sendBtn = pick('send')
    if (sendBtn) sendBtn.onclick = async (event) => {
      const btn = event.currentTarget
      const total = card.querySelectorAll('input[data-id]').length
      const skip = unchecked()
      const count = total - skip.length
      if (!count) return alert('没有勾选任何帖子')
      if (!confirm(`现在就把勾选的 ${count} 条推到企微内部群？${skip.length ? `未勾选的 ${skip.length} 条这一轮不再推。` : ''}`)) return
      btn.disabled = true
      btn.textContent = '推送中…'
      const result = await api('/api/wecom/digests/send', { method: 'POST', body: JSON.stringify({ kind, exclude: skip }) })
      const r = result.result || {}
      if (result.ok) alert(r.sent ? `已推送 ${r.sent} 条到内部群` : '没有可推的帖子')
      else alert(r.skipped === 'no_webhook' ? '服务器没配内部群 webhook' : '推送失败，稍后可重试')
      await reloadDigests()
    }
  })
}
