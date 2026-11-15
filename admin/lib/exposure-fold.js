// 「围观」曝光计数合并：小程序首页卡片划进屏幕就算一次曝光，云函数 bumpExposure 先按 10 分钟一个桶
// 记进 meta/exposure_<桶号>.counts（键是 forum__<帖子id> / wall__<帖子id>），一批曝光只写 1 次库。
// 这里每 2 分钟把已经结束的桶合进帖子的 viewCount（店铺合进当天店铺数据和店铺的 exposureCount），再删掉桶。数字因此最多晚十几分钟。
// 改桶格式要同时改云函数 cloudfunctions/userApi/index.js 的 bumpExposure。

const db = require('./db')
const shopStats = require('./shop-stats')

const BUCKET_MS = 10 * 60 * 1000

function currentBucket(now = Date.now()) {
  return Math.floor(now / BUCKET_MS)
}

async function incView(collection, id, n) {
  if (db.useLocal()) {
    const post = await db.getDoc(collection, id)
    if (post) await db.setDoc(collection, id, { ...post, viewCount: (Number(post.viewCount) || 0) + n })
    return
  }
  const database = db.getDb()
  await database.collection(collection).doc(id).update({ viewCount: database.command.inc(n) })
}

// 店铺累计曝光：加在店铺记录的 exposureCount 上，小程序「围观」= 累计曝光 + 累计浏览
async function incShopExposure(id, n) {
  if (db.useLocal()) {
    const shop = await db.getDoc('shops', id)
    if (shop) await db.setDoc('shops', id, { ...shop, exposureCount: (Number(shop.exposureCount) || 0) + n })
    return
  }
  const database = db.getDb()
  await database.collection('shops').doc(id).update({ exposureCount: database.command.inc(n) })
}

async function fold(now = Date.now()) {
  const buckets = await db.allDocs('meta', { kind: 'exposure_buffer' }).catch(() => [])
  const done = buckets.filter((doc) => Number(doc.bucket) < currentBucket(now))
  let posts = 0
  for (const doc of done) {
    // 先删桶再加数：中途失败最多少算这一桶，不会重复加
    await db.removeDoc('meta', doc.id || doc._id)
    const counts = doc.counts || {}
    const shopCounts = {}
    for (const key of Object.keys(counts)) {
      const n = Math.max(0, Math.min(5000, Number(counts[key]) || 0))
      const [type, id] = key.split('__')
      if (!n || !id) continue
      // 店铺卡片曝光：记进当天的店铺数据，不加到 viewCount（店铺的 viewCount 是进店次数）
      if (type === 'shop') {
        shopCounts[id] = n
        continue
      }
      await incView(type === 'wall' ? 'wall_posts' : 'forum_posts', id, n).catch(() => {})
      posts += 1
    }
    await shopStats.addExposure(shopStats.dayKey(Number(doc.bucket) * BUCKET_MS), shopCounts)
      .catch((err) => console.warn('[exposure-fold] 店铺曝光', err && err.message))
    for (const id of Object.keys(shopCounts)) {
      await incShopExposure(id, shopCounts[id]).catch((err) => console.warn('[exposure-fold] 店铺累计', err && err.message))
    }
  }
  return { buckets: done.length, posts }
}

module.exports = { fold, currentBucket, BUCKET_MS }
