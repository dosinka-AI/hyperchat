import { db } from '../src/lib/db'
const users = await db.user.count()
const posts = await db.post.count()
const stories = await db.story.count()
const follows = await db.follow.count()
const messages = await db.message.count()
console.log(JSON.stringify({ users, posts, stories, follows, messages }))
process.exit(0)
