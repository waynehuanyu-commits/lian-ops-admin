// 公众号推文排版：运营在后台圈选热帖 → 挑评论、改字 → 生成和往期推文同款的内联样式 HTML，复制进公众号编辑器。
// 不调公众号接口，只出 HTML；样式照搬往期推文（卡片 + 蓝色标题 + 评论列表 + 「点此查看和评论」小程序文字链）。
// 开头 banner、结尾「扫码进入」和传送门用的是公众号素材库里的图（mmbiz.qpic.cn），粘回同一个公众号能直接显示。
const service = require('./service')
const contentAdmin = require('./content-admin')

const MAX_POSTS = 15
const MAX_COMMENTS = 20
const DEFAULT_COMMENTS = 3

const MINI = {
  appid: process.env.MINI_APPID || 'wx4f76b34a1edf6503',
  nickname: '晶洋黎安话事'
}
const IMG = {
  banner: 'https://mmbiz.qpic.cn/mmbiz_png/ChicKIFEXOVcJ6DSIPGzzrbJUlAbbLOWV8LNkSarJkh8BpWGa0S1bLsziaeibg0D97wWFSVic1JOBD0IWhb2p3Yia8AqqDl6SfrrEQwd2FoQbKwc/640?wx_fmt=png&from=appmsg',
  qrcode: 'https://mmbiz.qpic.cn/sz_mmbiz_png/ChicKIFEXOVe7NlM7MyKGoYXGAujLLVDiblH1eqYPVslffeJzq9kYuYJZ6dP6QiacOyvLHEeiaRloRiakB0MRWuwhv04TXI5ADLHw1CB9FN7HThU/640?wx_fmt=png&from=appmsg',
  wallPoster: 'https://mmbiz.qpic.cn/sz_mmbiz_png/ChicKIFEXOVeibnNNof0ZB5qZXqUZwucibibC1DicmFviaMlT0opiaWwONSrqz77zdcXgK526y06ia9MbBHcTk0jPBE3Am7KLegibg6jnOibj6MV8SQiaE/640?wx_fmt=png&from=appmsg',
  wallEntry: 'https://mmbiz.qpic.cn/mmbiz_png/ChicKIFEXOVcg794NFDC6suRFicnoOoSKfe2SfKTia3cH1tQWntzFVqk1lZ8tBP11uI5edJqicHC4NCiauAarRjSriafUMduG54kCrTiaJpic3xtHNc/640?wx_fmt=png&from=appmsg'
}
const COLOR = {
  text: 'rgb(62, 62, 62)',
  title: 'rgb(108, 154, 203)',
  line: 'rgb(174, 192, 224)',
  comment: 'rgb(100, 100, 100)',
  link: 'rgb(159, 208, 238)'
}
const P = 'white-space: normal;margin: 0px;padding: 0px;box-sizing: border-box;'
const BLANK = `<p style="${P}"><br></p>`

function esc(text) {
  return String(text == null ? '' : text).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]))
}

function detailPath(type, id) {
  return type === 'forum'
    ? `pages/forum-detail/forum-detail?id=${id}`
    : `pages/wall-detail/wall-detail?id=${id}`
}

function lines(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

// ---- 数据：候选 + 帖子详情 ----

async function listCandidates(keyword = '') {
  const { board, candidates } = await service.weeklyHotState(keyword)
  const seen = new Set()
  const shape = (item, onBoard) => ({
    contentType: item.contentType === 'forum' ? 'forum' : 'wall',
    contentId: item.contentId || item.id,
    title: item.title || item.oneLiner || '',
    summary: item.summary || '',
    tag: item.tag || item.channel || '',
    likeCount: Number(item.likeCount) || 0,
    commentCount: Number(item.commentCount) || 0,
    createdAt: item.createdAt || 0,
    onBoard
  })
  const boardItems = keyword ? [] : (board.items || []).map((item) => shape(item, true))
  const rest = (candidates || []).map((item) => shape(item, false))
  const items = boardItems.concat(rest).filter((item) => {
    const key = `${item.contentType}:${item.contentId}`
    if (!item.contentId || seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { ok: true, items }
}

function pickComments(thread) {
  return (thread || [])
    .filter((c) => c.statusGroup === 'public' && !c.reportHidden && String(c.content || '').trim())
    .sort((a, b) => (b.likeCount - a.likeCount) || (a.createdAt - b.createdAt))
    .slice(0, MAX_COMMENTS)
    .map((c, index) => ({
      id: c.id,
      text: String(c.content || '').trim(),
      likeCount: c.likeCount,
      authorName: c.anonymous ? '' : c.authorName,
      selected: index < DEFAULT_COMMENTS
    }))
}

async function composePosts(picks = []) {
  const list = (Array.isArray(picks) ? picks : []).slice(0, MAX_POSTS)
  if (!list.length) return { ok: false, message: '先勾选要放进推文的帖子' }
  const details = await Promise.all(list.map(async (pick) => {
    const type = pick.contentType === 'forum' ? 'forum' : 'wall'
    const detail = await contentAdmin.getContentDetail(type, pick.contentId).catch(() => null)
    if (!detail || !detail.ok || !detail.post) return null
    const post = detail.post
    if (post.statusGroup !== 'public' || post.reportHidden) return null
    return {
      contentType: type,
      contentId: post.id,
      title: post.title || post.headline || '',
      content: [post.content, post.extra].filter(Boolean).join('\n'),
      path: detailPath(type, post.id),
      comments: pickComments(detail.thread)
    }
  }))
  const posts = details.filter(Boolean)
  const skipped = list.length - posts.length
  return { ok: true, posts, message: skipped ? `${skipped} 条已下架或不存在，已跳过` : '' }
}

// ---- 排版：往期推文同款内联样式 ----

function miniTextLink(path, text) {
  return `<a class="weapp_text_link js_weapp_entry" style="color: inherit;text-decoration: none;" data-miniprogram-type="text" data-miniprogram-appid="${esc(MINI.appid)}" data-miniprogram-path="${esc(path)}" data-miniprogram-nickname="${esc(MINI.nickname)}" data-miniprogram-servicetype="0" href=""><span style="font-size: 12px;">${esc(text)}</span></a>`
}

function miniImageLink(path, src, frameStyle) {
  const img = `<img src="${esc(src)}" referrerpolicy="no-referrer" style="vertical-align: middle;max-width: 100%;width: 100%;box-sizing: border-box;">`
  return `<section style="text-align: center;margin-top: 10px;margin-bottom: 10px;line-height: 0;box-sizing: border-box;"><section style="vertical-align: middle;display: inline-block;line-height: 0;box-sizing: border-box;${frameStyle}"><a class="weapp_image_link js_weapp_entry" data-miniprogram-type="image" style="width:100%;" data-miniprogram-appid="${esc(MINI.appid)}" data-miniprogram-path="${esc(path)}" data-miniprogram-nickname="${esc(MINI.nickname)}" data-miniprogram-servicetype="0" data-miniprogram-imageurl="${esc(src)}" href="">${img}</a></section></section>`
}

function plainImage(src) {
  return `<section style="text-align: center;margin-top: 10px;margin-bottom: 10px;line-height: 0;box-sizing: border-box;"><section style="max-width: 100%;vertical-align: middle;display: inline-block;line-height: 0;width: 100%;box-sizing: border-box;"><img src="${esc(src)}" referrerpolicy="no-referrer" style="vertical-align: middle;max-width: 100%;width: 100%;box-sizing: border-box;"></section></section>`
}

function renderCard(post) {
  const body = lines(post.content).map((line) => `<p style="${P}">${esc(line)}</p>`).join('')
  const comments = (post.comments || []).map((text) => String(text || '').trim()).filter(Boolean)
  const commentBlock = comments.length
    ? `<section style="text-align: justify;font-size: 14px;line-height: 2;box-sizing: border-box;"><p style="${P}"><span style="color: ${COLOR.title};"><strong>评论：</strong></span></p><ul style="list-style-type: disc;box-sizing: border-box;padding-left: 20px;list-style-position: outside;margin: 0px;">${comments.map((text) => `<li style="box-sizing: border-box;"><p style="margin: 0px;padding: 0px;box-sizing: border-box;"><span style="color: ${COLOR.comment};">${esc(text)}</span></p></li>`).join('')}</ul></section>${BLANK}`
    : ''
  return `<section style="text-align: center;justify-content: center;display: flex;flex-flow: row;margin: 10px 0px 20px;box-sizing: border-box;"><section style="display: inline-block;width: 97%;vertical-align: top;align-self: flex-start;flex: 0 0 auto;border-radius: 9px;overflow: hidden;box-shadow: ${COLOR.line} 0px 3px 7px 0px;height: auto;padding: 24px;box-sizing: border-box;">`
    + `<section style="text-align: left;justify-content: flex-start;display: flex;flex-flow: row;margin: 0px 0px 10px;box-sizing: border-box;"><section style="display: inline-block;width: auto;vertical-align: top;align-self: flex-start;flex: 0 0 auto;min-width: 5%;max-width: 100%;height: auto;border-style: solid;border-width: 0px 0px 2px;border-bottom-color: ${COLOR.line};box-sizing: border-box;"><section style="text-align: justify;color: ${COLOR.title};box-sizing: border-box;"><p style="${P}"><strong>${esc(post.title)}</strong></p></section></section></section>`
    + `<section style="text-align: justify;box-sizing: border-box;">${body}</section>${BLANK}`
    + commentBlock
    + (post.path ? `<section style="text-align: right;font-size: 12px;color: ${COLOR.link};box-sizing: border-box;"><p style="margin: 0px;padding: 0px;box-sizing: border-box;">${miniTextLink(post.path, '点此查看和评论')}</p></section>` : '')
    + '</section></section>'
}

function renderFooter() {
  return BLANK
    + miniImageLink('pages/forum/forum', IMG.qrcode, 'width: 40%;border-style: solid;border-width: 3px;border-color: rgb(182, 182, 182);')
    + `<section style="text-align: center;font-size: 14px;box-sizing: border-box;"><p style="margin: 0px;padding: 0px;line-height: 1.75em;"><strong>扫码进入“黎安话事”小程序</strong></p><p style="margin: 0px;padding: 0px;line-height: 1.75em;"><strong>查看更多园区生活精彩瞬间</strong></p></section>`
    + BLANK
    + plainImage(IMG.wallPoster)
    + plainImage(IMG.wallEntry)
    + `<section style="margin: 20px 0px 0px;box-sizing: border-box;"><section style="font-size: 12px;color: rgb(160, 160, 160);box-sizing: border-box;"><p style="text-align: center;${P}"><span>&nbsp;👆</span><span style="color: rgb(255, 255, 255);background-color: ${COLOR.line};">“黎安校园墙”传送门&nbsp;</span></p></section></section>`
}

/**
 * @param {{ posts: Array<{ title: string, content: string, comments: string[], path?: string }>, banner?: boolean, footer?: boolean }} payload
 */
function renderArticle(payload = {}) {
  const posts = (Array.isArray(payload.posts) ? payload.posts : [])
    .slice(0, MAX_POSTS)
    .filter((post) => post && String(post.title || '').trim())
  if (!posts.length) return { ok: false, message: '没有可排版的帖子' }
  const html = `<section style="box-sizing: border-box;font-style: normal;font-weight: 400;text-align: justify;font-size: 16px;color: ${COLOR.text};">`
    + (payload.banner === false ? '' : miniImageLink('pages/forum/forum', IMG.banner, 'max-width: 100%;width: 100%;border-style: solid;border-width: 3px;border-color: rgb(240, 240, 240);') + BLANK)
    + posts.map(renderCard).join('')
    + (payload.footer === false ? '' : renderFooter())
    + '</section>'
  return { ok: true, html, count: posts.length }
}

module.exports = { listCandidates, composePosts, renderArticle, MAX_POSTS }
