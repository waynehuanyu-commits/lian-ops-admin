// 首页展示设置（meta/home_display）：园区热议轮播、信息流插攻略、消息页攻略精选、。
// 依赖 app.js 的全局：state、api、esc、formatTime、render。攻略在各处的先后由自动排序决定（热度 + 新鲜 + 轮换），
// 这里只管「放几条、隔几条」；想让某篇多露脸，到「黎安攻略」里点「移到最前」（排在最前的 3 篇会加分）。

async function reloadDisplay() {
  const result = await api('/api/home-display')
  if (!result.ok) return
  state.data = state.data || {}
  state.data.display = result
  if (state.nav === 'display') render()
}

function displayNumber(id, label, value, min, max, hint) {
  return `
    <label class="display-field">
      <span class="display-label">${esc(label)}</span>
      <input id="${id}" type="number" min="${min}" max="${max}" value="${esc(value)}" />
      <span class="muted">${esc(hint)}</span>
    </label>`
}

function renderDisplay(panel, data) {
  const pack = data || {}
  const d = pack.display || {}
  panel.innerHTML = `
    <div class="card">
      <h3>园区热议轮播（首页顶部）</h3>
      <p class="muted">热帖由热度自动上榜（评论和围观为主、赞为辅，7 天内的帖子按天慢慢降权；「园区热议」页可人工加入 / 移除）；攻略按自动排序：围观、下载、点赞评论、发布新鲜度、后台排序前三加分，用户看过的往后排；推文点开会记围观。</p>
      ${displayNumber('dp-total', '轮播总张数', d.carouselTotal, 1, 8, '1–8 张')}
      ${displayNumber('dp-posts', '其中热帖', d.carouselPostSlots, 0, 6, '前几张放热帖，其余放攻略；热帖不够时攻略补上')}
      ${displayNumber('dp-pool', '轮换池', d.carouselPostPool, 1, 10, '热帖和攻略（含推文）都从排序前几名里每 3 小时换一组（一天 8 组）；人工加入热榜的热帖一直优先。设 1 就是固定只放第一名')}
      ${displayNumber('dp-articles', '攻略位里放几篇公众号推文', d.carouselArticleSlots, 0, 6, '公众号推文没有赞和评论，按热度排不过投稿，这里给它留位置；和投稿一篇隔一篇交叉排，有封面图的优先，推文不够时投稿补上；0 = 纯按热度')}
    </div>
    <div class="card">
      <h3>首页信息流插攻略</h3>
      ${displayNumber('dp-feed', '每隔几条帖子插一排', d.feedGuideEvery, 0, 20, '0 = 不插；最少隔 3 条。三个分支轮流，轮播里出现过的不重复')}
    </div>
    <div class="card">
      <h3>消息页「攻略精选」</h3>
      ${displayNumber('dp-msg', '显示篇数', d.messagesGuidePicks, 0, 6, '0 = 不显示；三个分支各挑排在前面的')}
    </div>
    <div class="card">
      <h3>闲置 / 拼车 / 帮帮群汇总</h3>
      <p class="muted">开关、推送时间、预览和立即推送，已挪到「推送分发 → 汇总推送」。</p>
    </div>
    <div class="row gap">
      <button id="dp-save" type="button">保存</button>
      ${d.updatedAt ? `<span class="meta">上次修改：${formatTime(d.updatedAt)} ${esc(d.updatedBy || '')}</span>` : ''}
    </div>
    <p class="muted">小程序最多 10 分钟后生效；</p>`
  panel.querySelector('#dp-save').onclick = async (e) => {
    const btn = e.currentTarget
    btn.disabled = true
    const num = (id) => Number(panel.querySelector(id).value)
    const result = await api('/api/home-display', {
      method: 'POST',
      body: JSON.stringify({
        carouselTotal: num('#dp-total'),
        carouselPostSlots: num('#dp-posts'),
        carouselPostPool: num('#dp-pool'),
        carouselArticleSlots: num('#dp-articles'),
        feedGuideEvery: num('#dp-feed'),
        messagesGuidePicks: num('#dp-msg')
      })
    })
    btn.disabled = false
    if (!result.ok) return alert(result.message || '保存失败')
    await reloadDisplay()
  }
}
