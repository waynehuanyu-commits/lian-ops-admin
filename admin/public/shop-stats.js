// 店铺数据：给商家看的效果数据（曝光 / 浏览），按天统计，近 30 天。
// 依赖 app.js 的全局：state、api、esc、render；shops.js 的 reloadShops。数据口径见 admin/lib/shop-stats.js。
// 「商家数据卡」是给运营截图发商家的，排版按手机竖屏截图来定。

const SHOP_STAT_LABELS = {
  exposure: '曝光',
  views: '浏览'
}

async function reloadShopStats() {
  const result = await api('/api/shops/stats')
  state.data = state.data || {}
  state.data.shopStats = result && result.ok ? result : { days: [], shops: {} }
}

function statsOf(id) {
  const pack = (state.data && state.data.shopStats) || { shops: {} }
  return (pack.shops || {})[id] || null
}

const ZERO_STAT = { exposure: 0, views: 0 }

/** 列表行右侧的四个数：曝光 / 浏览 取近 7 天（含今天）并标出今日，围观和推荐是累计 */
function shopMetricsHtml(item) {
  const s = statsOf(item.id)
  const w7 = s ? s.w7 : ZERO_STAT
  const today = s ? s.today : ZERO_STAT
  const cell = (label, main, sub) => `
    <div class="shop-metric">
      <span class="shop-metric-label">${label}</span>
      <strong>${main}</strong>
      <span class="shop-metric-sub">${sub}</span>
    </div>`
  return `
    <div class="shop-metrics">
      ${cell('曝光', w7.exposure, `今日 ${today.exposure}`)}
      ${cell('浏览', w7.views, `今日 ${today.views}`)}
      ${cell('围观', item.viewCount || 0, '累计')}
      ${cell('推荐', item.recommendCount || 0, '累计')}
    </div>`
}

/** 店铺页最上面的总览：所有店加起来，今日和近 7 天 */
function shopOverviewHtml(items) {
  const add = (pick) => items.reduce((acc, item) => {
    const s = statsOf(item.id)
    const v = s ? pick(s) : ZERO_STAT
    return { exposure: acc.exposure + (v.exposure || 0), views: acc.views + (v.views || 0) }
  }, { exposure: 0, views: 0 })
  const today = add((s) => s.today)
  const w7 = add((s) => s.w7)
  const total = items.reduce((n, item) => n + (item.viewCount || 0), 0)
  const tile = (num, label, hint) => `
    <div class="shop-overview-tile">
      <strong>${num}</strong>
      <span>${label}</span>
      ${hint ? `<em>${hint}</em>` : ''}
    </div>`
  return `
    <div class="card shop-overview">
      <div class="row gap" style="justify-content: space-between;">
        <h3>店铺数据</h3>
        <span class="muted">按北京时间，曝光最多晚十几分钟更新</span>
      </div>
      <div class="shop-overview-grid">
        ${tile(today.exposure, '今日曝光', '')}
        ${tile(today.views, '今日浏览', '')}
        ${tile(w7.exposure, '近 7 天曝光', '含今天')}
        ${tile(w7.views, '近 7 天浏览', '含今天')}
        ${tile(total, '累计围观', '含统计上线前')}
      </div>
      <p class="muted shop-overview-note">曝光 = 店铺卡片划进同学手机屏幕（只在 1.0.32 及以上版本里计，同学升级后才有数）；浏览 = 打开店铺页；围观 = 历史累计的打开次数。每家店的数字在下面列表右侧，点「数据」可出给商家的截图卡。</p>
    </div>`
}

function dayLabel(day) {
  return `${Number(day.slice(4, 6))}月${Number(day.slice(6, 8))}日`
}

// 数据卡只在增长时写变化（卡片是发给商家的）；下降不写，右边明细表照实显示
function changeText(now, prev) {
  if (!prev || now <= prev) return ''
  return `比上周多 ${Math.round(((now - prev) / prev) * 100)}%`
}

/** 卡片用的天：只取已过完的天（不含今天） */
function cardDays(s, range) {
  return range === 30 ? s.daily.slice(0, -1) : s.daily.slice(-8, -1)
}

function statBarsHtml(daily, field) {
  const max = Math.max(1, ...daily.map((row) => row[field] || 0))
  return `
    <div class="ss-bars">
      ${daily.map((row) => `
        <div class="ss-bar" title="${dayLabel(row.day)} ${row[field] || 0}">
          <span class="ss-bar-fill" style="height:${Math.round(((row[field] || 0) / max) * 100)}%"></span>
          <span class="ss-bar-day">${daily.length <= 7 ? dayLabel(row.day).replace(/^\d+月/, '') : ''}</span>
        </div>`).join('')}
    </div>`
}

/** 给商家截图的卡片 */
function merchantCardHtml(item, s, range) {
  const daily = cardDays(s, range)
  const total = range === 30 ? s.d30 : s.d7
  const from = dayLabel(daily[0].day)
  const to = dayLabel(daily[daily.length - 1].day)
  return `
    <div class="ss-card" id="ss-card">
      <div class="ss-card-brand">黎安话事 · 商家数据${range === 30 ? '月报' : '周报'}</div>
      <div class="ss-card-name">${esc(item.name)}</div>
      <div class="ss-card-range">${from} – ${to}</div>
      <div class="ss-card-pair">
        <div><span class="ss-card-big">${total.exposure}</span><span class="ss-card-big-label">次曝光</span></div>
        <div><span class="ss-card-big">${total.views}</span><span class="ss-card-big-label">次浏览</span></div>
      </div>
      ${range === 7 && changeText(s.d7.exposure, s.prev7.exposure) ? `<div class="ss-card-change">曝光${esc(changeText(s.d7.exposure, s.prev7.exposure))}</div>` : ''}
      ${item.recommendCount ? `<div class="ss-card-change">累计 ${item.recommendCount} 位同学推荐</div>` : ''}
      ${statBarsHtml(daily, 'exposure')}
      <div class="ss-card-foot">曝光：店铺出现在同学手机屏幕上的次数<br />浏览：打开店铺页面的次数</div>
    </div>`
}

function merchantText(item, s, range) {
  const daily = cardDays(s, range)
  const total = range === 30 ? s.d30 : s.d7
  return [
    `【${item.name}】黎安话事数据（${dayLabel(daily[0].day)}–${dayLabel(daily[daily.length - 1].day)}）`,
    `曝光 ${total.exposure} 次${range === 7 && changeText(s.d7.exposure, s.prev7.exposure) ? `，${changeText(s.d7.exposure, s.prev7.exposure)}` : ''}，浏览 ${total.views} 次`
  ].join('\n')
}

function shopStatsPageHtml(item) {
  const s = statsOf(item.id) || emptyShopStats()
  const range = state.shopStatsRange === 30 ? 30 : 7
  return `
    <div class="card">
      <div class="row gap" style="justify-content: space-between;">
        <h3>店铺数据：${esc(item.name)}</h3>
        <button type="button" class="quiet" id="ss-back">返回店铺列表</button>
      </div>
      <p class="muted">按北京时间每天统计，曝光最多晚十几分钟更新。数据卡只算已过完的天（不含今天）。统计从这项功能上线那天起算，之前的日子是 0。累计浏览（含上线前）：${item.viewCount || 0} 次。</p>
      <div class="chips">
        <button type="button" class="chip ${range === 7 ? 'active' : ''}" data-ss-range="7">近 7 天</button>
        <button type="button" class="chip ${range === 30 ? 'active' : ''}" data-ss-range="30">近 30 天</button>
      </div>
      <div class="ss-layout">
        <div>
          ${merchantCardHtml(item, s, range)}
          <div class="row gap ss-card-ops">
            <button type="button" id="ss-copy">复制文字版</button>
            <span class="muted">卡片可直接截图发给商家</span>
          </div>
        </div>
        <div class="ss-table-wrap">
          <table class="ss-table">
            <thead><tr><th>日期</th>${Object.values(SHOP_STAT_LABELS).map((label) => `<th>${label}</th>`).join('')}</tr></thead>
            <tbody>
              ${s.daily.slice().reverse().map((row) => `<tr><td>${dayLabel(row.day)}</td>${Object.keys(SHOP_STAT_LABELS).map((key) => `<td>${row[key] || 0}</td>`).join('')}</tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>`
}

function emptyShopStats() {
  const days = (state.data && state.data.shopStats && state.data.shopStats.days) || []
  const zero = (day) => ({ day, exposure: 0, views: 0 })
  const daily = days.map(zero)
  return { daily, d7: zero(''), prev7: zero(''), d30: zero('') }
}

function bindShopStatsPage(panel, item) {
  panel.querySelector('#ss-back').onclick = () => { state.shopStatsId = ''; render() }
  panel.querySelectorAll('[data-ss-range]').forEach((btn) => {
    btn.onclick = () => { state.shopStatsRange = Number(btn.dataset.ssRange); render() }
  })
  const copy = panel.querySelector('#ss-copy')
  copy.onclick = async () => {
    const s = statsOf(item.id) || emptyShopStats()
    const text = merchantText(item, s, state.shopStatsRange === 30 ? 30 : 7)
    try {
      await navigator.clipboard.writeText(text)
      copy.textContent = '已复制'
    } catch (err) {
      window.prompt('复制下面的文字', text)
    }
  }
}
