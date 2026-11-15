// 一次性：把 post_watches 里已有的蹲一蹲人数回填到帖子的 watchCount。
// 默认只打印统计；加 --apply 才写库。可重复执行，结果按真实行数覆盖。
// 用法（在 admin 目录）：node scripts/backfill-watch-count.js [--apply]
const fs = require('fs')
const path = require('path')
const { allDocs, getDb } = require('../lib/db')

// 和 server.js 一样读 admin/.env，已有的环境变量优先
function loadLocalEnv(file) {
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '')
  })
}

const ADMIN_DIR = process.env.ADMIN_DIR || path.join(__dirname, '..')
const COLLECTIONS = { forum: 'forum_posts', wall: 'wall_posts' }

function countByPost(rows) {
  return rows.reduce((counts, row) => {
    const key = `${row.type === 'wall' ? 'wall' : 'forum'}:${row.postId}`
    return { ...counts, [key]: (counts[key] || 0) + 1 }
  }, {})
}

async function main() {
  loadLocalEnv(path.join(ADMIN_DIR, '.env'))
  const apply = process.argv.includes('--apply')
  const counts = Object.entries(countByPost(await allDocs('post_watches')))
  const values = counts.map(([, count]) => count)
  console.log(JSON.stringify({
    posts: counts.length,
    watches: values.reduce((sum, count) => sum + count, 0),
    max: Math.max(0, ...values),
    atLeast3: values.filter((count) => count >= 3).length
  }))
  if (!apply) return

  const db = getDb()
  let written = 0
  let failed = 0
  for (const [key, count] of counts) {
    const [type, postId] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
    try {
      await db.collection(COLLECTIONS[type]).doc(postId).update({ watchCount: count })
      written += 1
    } catch (err) {
      failed += 1
      console.warn('跳过', key, err && err.message)
    }
  }
  console.log(JSON.stringify({ written, failed }))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
