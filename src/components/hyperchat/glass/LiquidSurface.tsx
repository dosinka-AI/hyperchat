'use client';

/**
 * LiquidSurface: HyperChat's Liquid Glass primitive.
 *
 * True Apple-style refraction on Chromium: the hook swaps the element's
 * backdrop-filter for blur -> SVG displacement (with chromatic
 * aberration) -> blur -> brightness/saturate, sized live to the element
 * (ResizeObserver, debounced, cached per geometry). Every other browser
 * keeps the glassmorphism fallback from glass.css, and users can dim
 * the whole system with data-glass="soft|off".
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  effectiveRadius,
  liquidBackdropFilter,
  supportsBackdropFilterUrl,
} from '@/lib/liquidGlass';
import { loadGlassPrefs } from '@/lib/client/glassPrefs';

export type LiquidVariant = 'float' | 'panel' | 'clear' | 'composer' | 'header';

const VARIANT_CLASS: Record<LiquidVariant, string> = {
  float: 'lg-float',
  panel: 'lg-panel',
  clear: 'lg-float lg-clear',
  composer: 'lg-composer',
  header: 'lg-header',
};

/**
 * Attaches refraction to an existing element. Returns a ref to spread
 * onto it. The element must carry one of the lg-* classes for the
 * fallback material; this only upgrades it when possible.
 */
export function useLiquidGlass<T extends HTMLElement>(options?: {
  /** fixed corner radius override (px); omit to read computed style */
  radius?: number;
  /** bezel depth; bigger = thicker lens */
  depth?: number;
  /** displacement strength */
  strength?: number;
  /** RGB split at the bezel */
  chromaticAberration?: number;
  /** material blur */
  blur?: number;
  /** disable refraction (keep CSS material) */
  disabled?: boolean;
}) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || options?.disabled) return;
    if (!supportsBackdropFilterUrl()) return;
    if (loadGlassPrefs().mode !== 'full') return;

    let raf = 0;
    let lastSig = '';

    const apply = () => {
      const rect = el.getBoundingClientRect();
      const sig = `${Math.round(rect.width)}x${Math.round(rect.height)}:${options?.radius ?? 'auto'}`;
      if (sig === lastSig) return;
      lastSig = sig;
      const filter = liquidBackdropFilter({
        width: rect.width,
        height: rect.height,
        radius: options?.radius ?? effectiveRadius(el),
        depth: options?.depth,
        strength: options?.strength,
        chromaticAberration: options?.chromaticAberration,
        blur: options?.blur,
        id: 'lgf',
      });
      if (filter) {
        el.style.backdropFilter = filter;
        (el.style as unknown as Record<string, string>).webkitBackdropFilter = filter;
      }
    };

    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(apply);
    };

    // initial pass after layout settles
    const t = window.setTimeout(schedule, 60);
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    return () => {
      window.clearTimeout(t);
      cancelAnimationFrame(raf);
      ro.disconnect();
      // restore the CSS-class material on unmount
      el.style.backdropFilter = '';
      (el.style as unknown as Record<string, string>).webkitBackdropFilter = '';
    };
  }, [options?.disabled, options?.radius, options?.depth, options?.strength, options?.chromaticAberration, options?.blur]);

  return ref;
}

/**
 * Self-contained glass surface. Renders the lg-* material class and
 * upgrades itself with refraction where supported.
 */
export function LiquidSurface({
  variant = 'float',
  className = '',
  style,
  children,
  radius,
  depth,
  strength,
  chromaticAberration,
  blur,
  refract = true,
  as: Tag = 'div',
  ...rest
}: {
  variant?: LiquidVariant;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  radius?: number;
  depth?: number;
  strength?: number;
  chromaticAberration?: number;
  blur?: number;
  refract?: boolean;
  as?: 'div' | 'section' | 'aside' | 'header' | 'footer' | 'nav';
} & Omit<React.HTMLAttributes<HTMLElement>, 'style' | 'children'>) {
  const ref = useLiquidGlass<HTMLDivElement>({
    radius,
    depth,
    strength,
    chromaticAberration,
    blur,
    disabled: !refract,
  });
  return (
    <Tag
      ref={ref}
      className={`${VARIANT_CLASS[variant]} ${className}`}
      style={style}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/**
 * The aurora backdrop: fixed layer of slowly drifting light blooms the
 * glass panels refract. Sits behind the app shell (z-0). Pure static
 * markup, hydration-safe by construction.
 */
export function GlassAurora() {
  return (
    <div className="lg-aurora" aria-hidden="true">
      <div className="lg-glow-top" />
      <div className="lg-glow-bottom" />
      <div className="lg-blob lg-blob-a" />
      <div className="lg-blob lg-blob-b" />
      <div className="lg-blob lg-blob-c" />
      <div className="lg-blob lg-blob-d" />
    </div>
  );
}
