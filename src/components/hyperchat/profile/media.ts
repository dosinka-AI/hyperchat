'use client'

// Image picking + downscaling for the profile system. The helpers mirror the
// composer's approach (a rendered hidden file input, browser-side downscale
// of large rasters, GIFs left untouched) but live in their own module so no
// shared file needs editing.

import { useEffect, useRef } from 'react'
import type { ChangeEvent, RefObject } from 'react'
import { apiClient } from '@/lib/client/api'

const MAX_IMAGE_DIM = 1600
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp'

export class ImageTooLargeError extends Error {
  constructor() {
    super('images must stay under 8 MB')
  }
}

/** Downscale large raster images in the browser before upload. GIFs pass
 *  through untouched because canvas re-encoding strips their animation. */
export async function processProfileImage(file: File): Promise<Blob> {
  if (file.type === 'image/gif' || file.size <= 300 * 1024) {
    return file
  }
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(bitmap.width, bitmap.height))
    const w = Math.round(bitmap.width * scale)
    const h = Math.round(bitmap.height * scale)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close()
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
    return blob && blob.size < file.size ? blob : file
  } catch {
    return file
  }
}

export type ProfileImageInputProps = {
  ref: RefObject<HTMLInputElement | null>
  type: 'file'
  accept: string
  className: string
  'aria-hidden': boolean
  tabIndex: number
  onChange: (e: ChangeEvent<HTMLInputElement>) => void
}

/** A rendered hidden file input + its opener, the same picking pattern the
 *  chat composer uses. Spread the props onto an <input /> somewhere in the
 *  component and call open() from the pick affordance. */
export function useProfileImagePicker(onPick: (file: File) => void): {
  open: () => void
  inputProps: ProfileImageInputProps
} {
  const ref = useRef<HTMLInputElement | null>(null)
  const pickRef = useRef(onPick)
  useEffect(() => {
    pickRef.current = onPick
  }, [onPick])
  return {
    open: () => ref.current?.click(),
    inputProps: {
      ref,
      type: 'file',
      accept: IMAGE_ACCEPT,
      className: 'hidden',
      'aria-hidden': true,
      tabIndex: -1,
      onChange: (e) => {
        const file = e.target.files?.[0]
        if (file) pickRef.current(file)
        e.target.value = ''
      },
    },
  }
}

/** Pick, downscale, cap and upload an image through the existing upload
 *  flow. Returns the served /api/files URL. */
export async function uploadProfileImage(file: File): Promise<string> {
  const blob = await processProfileImage(file)
  if (blob.size > MAX_IMAGE_BYTES) throw new ImageTooLargeError()
  const res = await apiClient.uploadImage(blob)
  return res.url
}

/** Promise-based image pick: resolves the chosen File, or null when the
 *  picker is dismissed. One-shot input element, never mounted. */
export function pickProfileImage(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = IMAGE_ACCEPT
    input.style.display = 'none'
    input.addEventListener('change', () => {
      const file = input.files?.[0] ?? null
      input.remove()
      resolve(file)
    })
    // dismissal: focus returns to the document without a selection
    window.addEventListener('focus', () => {
      setTimeout(() => {
        if (!input.files || input.files.length === 0) {
          input.remove()
          resolve(null)
        }
      }, 300)
    }, { once: true })
    document.body.appendChild(input)
    input.click()
  })
}
