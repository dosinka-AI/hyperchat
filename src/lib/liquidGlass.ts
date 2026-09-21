/**
 * Liquid Glass refraction engine.
 *
 * Generates SVG displacement maps + filters that reproduce Apple's Liquid
 * Glass look (WWDC 2025, iOS 26): a neutral gray field (no displacement)
 * with an edge "bezel" lens built from red/green axis gradients and a
 * blurred rounded rectangle. Applied via `backdrop-filter: url(<filter>)`
 * (Chromium). Non-Chromium browsers get the CSS glassmorphism fallback
 * (see glass.css) — this module is only called after support detection.
 *
 * Technique sources (researched this round, see
 * .zscripts/liquid-glass-research.md): kube.io refraction deep-dive,
 * github.com/nikdelvin/liquid-glass, css-tricks.
 */

type MapOptions = {
  width: number;
  height: number;
  radius: number;
  depth: number;
};

type FilterOptions = MapOptions & {
  strength?: number;
  chromaticAberration?: number;
  id: string;
};

const mapCache = new Map<string, string>();
const filterCache = new Map<string, string>();

/** Chromatic + refraction scale factors tuned for dark UI chrome. */
export const LIQUID_DEFAULTS = {
  strength: 62,
  chromaticAberration: 2.5,
  depth: 14,
  blur: 18,
  saturate: 1.45,
  brightness: 1.08,
} as const;

function clampRound(v: number, min: number, max: number) {
  return Math.round(Math.min(max, Math.max(min, v)));
}

/**
 * The displacement map: a data-URI SVG image.
 *  - base rect #808080 (neutral, R=G=128 -> zero displacement)
 *  - vertical green gradient + horizontal red gradient (screen-blended)
 *    encode per-axis offsets, strongest at the edges, dying off inward
 *  - a blurred rounded rect of neutral gray centered with margin `depth`
 *    carves the lens bezel: pixels near the border displace along the
 *    gradient, the flat interior does not -> the Apple "edge lensing".
 */
export function getDisplacementMap({ width, height, radius, depth }: MapOptions): string {
  const key = `m:${width}x${height}:${radius}:${depth}`;
  const hit = mapCache.get(key);
  if (hit) return hit;

  const w = clampRound(width, 2, 4096);
  const h = clampRound(height, 2, 4096);
  const r = clampRound(radius, 0, Math.min(w, h) / 2);
  const d = clampRound(depth, 1, Math.floor(Math.min(w, h) / 4));

  // gradient stops inset proportionally to the corner radius, like the
  // reference implementation (radius/size * 15%) so bigger radii get a
  // wider, softer bezel.
  const yInset = Math.min(45, Math.ceil((r / h) * 15));
  const xInset = Math.min(45, Math.ceil((r / w) * 15));

  const svg =
    `<svg height="${h}" width="${w}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">` +
    `<defs>` +
    `<linearGradient id="Y" x1="0" x2="0" y1="${yInset}%" y2="${100 - yInset}%">` +
    `<stop offset="0%" stop-color="#0F0"/><stop offset="100%" stop-color="#000"/>` +
    `</linearGradient>` +
    `<linearGradient id="X" x1="${xInset}%" x2="${100 - xInset}%" y1="0" y2="0">` +
    `<stop offset="0%" stop-color="#F00"/><stop offset="100%" stop-color="#000"/>` +
    `</linearGradient>` +
    `</defs>` +
    `<rect width="${w}" height="${h}" fill="#808080"/>` +
    `<g filter="blur(2px)">` +
    `<rect width="${w}" height="${h}" fill="#000080"/>` +
    `<rect width="${w}" height="${h}" fill="url(#Y)" style="mix-blend-mode:screen"/>` +
    `<rect width="${w}" height="${h}" fill="url(#X)" style="mix-blend-mode:screen"/>` +
    `<rect x="${d}" y="${d}" width="${w - 2 * d}" height="${h - 2 * d}" rx="${r}" ry="${r}" fill="#808080" filter="blur(${d}px)"/>` +
    `</g>` +
    `</svg>`;

  const uri = "data:image/svg+xml;utf8," + encodeURIComponent(svg);
  mapCache.set(key, uri);
  return uri;
}

/**
 * The displacement filter: three feDisplacementMap passes at slightly
 * different scales, each isolated to one RGB channel via feColorMatrix
 * and recombined with screen blends -> chromatic aberration (the subtle
 * prismatic split along the bezel). Returns a data-URI ending in
 * `#<id>` so it can be referenced from `backdrop-filter: url(...)`.
 */
export function getDisplacementFilter({
  width,
  height,
  radius,
  depth,
  strength = LIQUID_DEFAULTS.strength,
  chromaticAberration = LIQUID_DEFAULTS.chromaticAberration,
  id,
}: FilterOptions): string {
  const key = `f:${id}:${width}x${height}:${radius}:${depth}:${strength}:${chromaticAberration}`;
  const hit = filterCache.get(key);
  if (hit) return hit;

  const mapHref = getDisplacementMap({ width, height, radius, depth })
    // the map is embedded as an href inside another SVG: double-encode
    .replace(/"/g, "'");

  const s = strength;
  const sG = strength + chromaticAberration;
  const sR = strength + chromaticAberration * 2;

  const svg =
    `<svg height="${height}" width="${width}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">` +
    `<defs><filter id="${id}" color-interpolation-filters="sRGB">` +
    `<feImage x="0" y="0" width="${width}" height="${height}" href="${mapHref}" result="map"/>` +
    // red pass
    `<feDisplacementMap in="SourceGraphic" in2="map" scale="${sR}" xChannelSelector="R" yChannelSelector="G"/>` +
    `<feColorMatrix type="matrix" values="1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0" result="dR"/>` +
    // green pass
    `<feDisplacementMap in="SourceGraphic" in2="map" scale="${sG}" xChannelSelector="R" yChannelSelector="G"/>` +
    `<feColorMatrix type="matrix" values="0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0" result="dG"/>` +
    `<feBlend in="dR" in2="dG" mode="screen" result="dRG"/>` +
    // blue pass
    `<feDisplacementMap in="SourceGraphic" in2="map" scale="${s}" xChannelSelector="R" yChannelSelector="G"/>` +
    `<feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0" result="dB"/>` +
    `<feBlend in="dRG" in2="dB" mode="screen"/>` +
    `</filter></defs></svg>`;

  const uri = "data:image/svg+xml;utf8," + encodeURIComponent(svg) + `#${id}`;
  filterCache.set(key, uri);
  return uri;
}

/** One-time check: does this browser accept SVG url() in backdrop-filter? */
let urlSupport: boolean | null = null;
export function supportsBackdropFilterUrl(): boolean {
  if (urlSupport !== null) return urlSupport;
  if (typeof window === "undefined") return false;
  try {
    const el = document.createElement("div");
    el.style.cssText = "backdrop-filter: url(#lgtest)";
    urlSupport =
      el.style.backdropFilter === "url(#lgtest)" ||
      el.style.backdropFilter === 'url("#lgtest")';
  } catch {
    urlSupport = false;
  }
  return urlSupport;
}

/** Read the effective corner radius (px) of an element from computed style. */
export function effectiveRadius(el: HTMLElement): number {
  const v = getComputedStyle(el).borderRadius;
  const m = v.match(/^([\d.]+)px$/);
  if (m) return parseFloat(m[1]);
  // "a px b px c px d px" -> take the first
  const first = v.match(/^([\d.]+)px/);
  return first ? parseFloat(first[1]) : 0;
}

/**
 * Build the full backdrop-filter value for a liquid glass layer.
 * Chain order (from the reference implementations): a half-strength pre
 * blur to dither the map, the displacement url, the material blur, then
 * brightness + saturate for the tinted-glass lift.
 */
export function liquidBackdropFilter(opts: {
  width: number;
  height: number;
  radius: number;
  depth?: number;
  strength?: number;
  chromaticAberration?: number;
  blur?: number;
  id: string;
}): string | null {
  if (!supportsBackdropFilterUrl()) return null;
  const {
    width,
    height,
    radius,
    depth = LIQUID_DEFAULTS.depth,
    strength = LIQUID_DEFAULTS.strength,
    chromaticAberration = LIQUID_DEFAULTS.chromaticAberration,
    blur = LIQUID_DEFAULTS.blur,
    id,
  } = opts;
  if (width < 8 || height < 8) return null;
  const url = getDisplacementFilter({
    width,
    height,
    radius,
    depth,
    strength,
    chromaticAberration,
    id,
  });
  return (
    `blur(${Math.max(1, blur / 36)}px) url('${url}') ` +
    `blur(${blur / 3}px) brightness(${LIQUID_DEFAULTS.brightness}) ` +
    `saturate(${LIQUID_DEFAULTS.saturate})`
  );
}
