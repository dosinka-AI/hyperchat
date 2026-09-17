'use client'

// Custom keyframes for the profile system. Kept in a local <style> tag so
// globals.css stays untouched; every animation carries a reduced-motion
// guard for html[data-motion='off'].

export function ProfileStyles() {
  return (
    <style>{`
@keyframes hc-story-fill {
  from { width: 0%; }
  to { width: 100%; }
}
.hc-story-bar-fill {
  animation: hc-story-fill 5s linear forwards;
}
html[data-motion='off'] .hc-story-bar-fill {
  animation: none;
  width: 100%;
}
@keyframes hc-like-pop {
  0% { transform: scale(1); }
  40% { transform: scale(1.28); }
  100% { transform: scale(1); }
}
.hc-like-pop {
  animation: hc-like-pop 220ms ease;
}
html[data-motion='off'] .hc-like-pop {
  animation: none;
}
@keyframes hc-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.hc-fade-in {
  animation: hc-fade-in 180ms ease;
}
html[data-motion='off'] .hc-fade-in {
  animation: none;
}
@keyframes hc-count-bump {
  0% { transform: translateY(30%); opacity: 0; }
  100% { transform: translateY(0); opacity: 1; }
}
.hc-count-bump {
  animation: hc-count-bump 200ms ease;
}
html[data-motion='off'] .hc-count-bump {
  animation: none;
}
`}</style>
  )
}
