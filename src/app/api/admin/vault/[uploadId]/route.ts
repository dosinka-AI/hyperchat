import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireSiteAdmin } from '@/lib/siteAdmin'
import { deleteUploadHard } from '@/lib/vault'

/**
 * DELETE /api/admin/vault/[uploadId] — force-expire one upload (Task 6-c).
 * Site-admin only. Reuses deleteUploadHard: rows die, chunk files die when
 * no other upload shares them, and the carrier message is patched live.
 */
type Params = { params: Promise<{ uploadId: string }> }

export async function DELETE(_req: NextRequest, { params }: Params) {
  const gate = await requireSiteAdmin()
  if (!gate.ok) return gate.response

  try {
    const { uploadId } = await params
    const upload = await db.fileUpload.findUnique({ where: { id: uploadId }, select: { id: true } })
    if (!upload) return NextResponse.json({ error: 'Upload not found.' }, { status: 404 })

    await deleteUploadHard(uploadId)
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 })
  }
}
