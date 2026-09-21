import { db } from '../src/lib/db'
const posts = await db.post.findMany({ select: { id: true, imageUrl: true, caption: true, author: { select: { username: true } } } })
console.log(JSON.stringify(posts))
process.exit(0)
