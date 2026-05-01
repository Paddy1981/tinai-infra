# Tinai.cloud — Brand Identity

## Logo Mark

The T-mark is a bold geometric **T** with:
- Rounded top corners on the crossbar
- Rounded base on the stem
- Square inner shoulders (where stem meets crossbar)
- Proportioned to remain crisp from 16px to 512px

### SVG Path (32×32 viewBox)

```svg
<path
  d="M 8,4 H 24 Q 29,4 29,9 V 14 H 20 V 28 Q 20,32 16,32 Q 12,32 12,28 V 14 H 3 V 9 Q 3,4 8,4 Z"
  fill="#F97316"
/>
```

---

## Files in this directory

| File | Use |
|---|---|
| `tinai-mark.svg` | Standalone T-mark, transparent bg, saffron |
| `tinai-app-icon.svg` | App icon / favicon — saffron rounded-square container |
| `tinai-wordmark-dark.svg` | Horizontal lockup for **dark** backgrounds (`#EDE9E1` text) |
| `tinai-wordmark-light.svg` | Horizontal lockup for **light** backgrounds (`#1A1818` text) |
| `README.md` | This file |

### Next.js / Dashboard usage

Copy SVGs into `tinai-dashboard/public/brand/` (already done):
```
/public/brand/tinai-mark.svg
/public/brand/tinai-app-icon.svg
/public/brand/tinai-wordmark-dark.svg
/public/brand/tinai-wordmark-light.svg
```

Favicon is wired in `app/layout.tsx`:
```tsx
export const metadata = {
  icons: {
    icon:     '/brand/tinai-app-icon.svg',
    apple:    '/brand/tinai-app-icon.svg',
    shortcut: '/brand/tinai-app-icon.svg',
  },
}
```

---

## Color Palette

| Name | Hex | Use |
|---|---|---|
| Saffron | `#F97316` | Primary brand, icon fill, CTAs |
| Ember | `#C2410C` | Hover states, pressed |
| Glow | `#FDBA74` | Highlights, gradients |
| Night | `#07070F` | Dark mode background |
| Surface | `#14142A` | Dark mode cards, panels |
| Cream | `#F5F0E8` | Light mode background |
| Ink | `#1A1818` | Light mode text |

---

## Typography

**Wordmark**: [Outfit](https://fonts.google.com/specimen/Outfit) (Google Fonts)
- `tinai` → weight **700**, letter-spacing −3%
- `.cloud` → weight **300**, opacity 38%

```html
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
```

---

## HTML Lockup (recommended over SVG for web)

**Dark background:**
```html
<div style="display:flex;align-items:center;gap:12px;">
  <img src="/brand/tinai-mark.svg" width="28" height="28" alt="Tinai">
  <span style="font-family:'Outfit',sans-serif;font-size:20px;font-weight:700;letter-spacing:-0.03em;color:#EDE9E1;">
    tinai<span style="font-weight:300;opacity:0.38;">.cloud</span>
  </span>
</div>
```

**Light background:**
```html
<div style="display:flex;align-items:center;gap:12px;">
  <img src="/brand/tinai-mark.svg" width="28" height="28" alt="Tinai">
  <span style="font-family:'Outfit',sans-serif;font-size:20px;font-weight:700;letter-spacing:-0.03em;color:#1A1818;">
    tinai<span style="font-weight:300;opacity:0.38;">.cloud</span>
  </span>
</div>
```

---

## App Icon Centering

The app icon uses `transform="translate(4.8, 3.4) scale(0.7)"` to centre the mark
in the 32×32 container. Derivation:

```
path bounds:           x[3..29] y[4..32]  →  w=26 h=28
after scale(0.7):      w=18.2   h=19.6
left padding needed:   (32−18.2)/2 − 3×0.7 = 6.9 − 2.1 = 4.8  → tx
top padding needed:    (32−19.6)/2 − 4×0.7 = 6.2 − 2.8 = 3.4  → ty
visual centre:         (16, 16) ✓
```

> **Note:** SVG transforms apply right-to-left: `translate(tx, ty) scale(s)` means
> scale first, then translate — which is what we want.

---

## Do / Don't

| Do | Don't |
|---|---|
| Use saffron `#F97316` on dark backgrounds | Recolour the mark to any other colour |
| Use white mark on saffron container | Stretch or distort the mark proportions |
| Maintain minimum clear space of ½ mark-height around the mark | Place on busy/patterned backgrounds without a container |
| Use `tinai-app-icon.svg` for favicons | Use the wordmark below 14px |
| Use HTML lockup for web (font renders better than SVG text paths) | Use `tinai-wordmark-dark.svg` on light backgrounds |

---

## Full preview

Open `C:\Dev\tinai-logo-preview.html` in a browser for the complete visual system.
