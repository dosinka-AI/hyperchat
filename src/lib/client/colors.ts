'use client'

/** Pull the dominant colors out of an avatar so the banner picker can
 *  suggest them. Coarse histogram with boring colors filtered out. */

export function extractAvatarColors(url: string, max = 6): Promise<string[]> {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        const size = 28
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) return resolve([])
        ctx.drawImage(img, 0, 0, size, size)
        const data = ctx.getImageData(0, 0, size, size).data

        // bucket pixels by coarse hue/value, skipping near-black, near-white
        // and near-gray tones that would read as "no banner"
        const buckets = new Map<string, { count: number; r: number; g: number; b: number }>()
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i]
          const g = data[i + 1]
          const b = data[i + 2]
          const maxC = Math.max(r, g, b)
          const minC = Math.min(r, g, b)
          const sat = maxC === 0 ? 0 : (maxC - minC) / maxC
          if (maxC < 40 || maxC > 235 || sat < 0.18) continue
          const key = `${Math.round(r / 48)}-${Math.round(g / 48)}-${Math.round(b / 48)}`
          const hit = buckets.get(key)
          if (hit) {
            hit.count++
            hit.r += r
            hit.g += g
            hit.b += b
          } else {
            buckets.set(key, { count: 1, r, g, b })
          }
        }

        const colors = [...buckets.values()]
          .sort((a, b) => b.count - a.count)
          .slice(0, max)
          .map(({ r, g, b, count }) => {
            const hex = (n: number) => Math.round(n / count).toString(16).padStart(2, '0')
            return `#${hex(r)}${hex(g)}${hex(b)}`
          })
        resolve(colors)
      } catch {
        // tainted canvas or draw failure: no suggestions
        resolve([])
      }
    }
    img.onerror = () => resolve([])
    img.src = url
  })
}
