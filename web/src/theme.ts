import type { Appearance } from './api';

// swatch = [background, surface, accent]; the full token sets live in styles.css under :root[data-theme=…]
export const THEMES: { id: Appearance['theme']; name: string; swatch: [string, string, string] }[] = [
  { id: 'light', name: 'Light', swatch: ['#f4f5fb', '#ffffff', '#5b4fe0'] },
  { id: 'dark', name: 'Dark', swatch: ['#111214', '#1b1c20', '#b4f04a'] },
  { id: 'system', name: 'System', swatch: ['#f4f5fb', '#111214', '#5b4fe0'] },
  { id: 'midnight', name: 'Midnight', swatch: ['#1c1b38', '#272649', '#6ee7f2'] },
  { id: 'paper', name: 'Paper', swatch: ['#f8f6f2', '#ffffff', '#ee6f37'] },
  { id: 'nord', name: 'Nord', swatch: ['#2e3440', '#3b4252', '#88c0d0'] },
  { id: 'dracula', name: 'Dracula', swatch: ['#21222c', '#282a36', '#bd93f9'] },
  { id: 'catppuccin', name: 'Catppuccin', swatch: ['#1e1e2e', '#262637', '#cba6f7'] },
  { id: 'solarized-light', name: 'Solarized Light', swatch: ['#fdf6e3', '#fffbef', '#268bd2'] },
  { id: 'solarized-dark', name: 'Solarized Dark', swatch: ['#002b36', '#073642', '#2aa198'] },
  { id: 'forest', name: 'Forest', swatch: ['#121a16', '#18231d', '#5fd38d'] },
  { id: 'ocean', name: 'Ocean', swatch: ['#eef4fa', '#ffffff', '#0e7bd8'] },
  { id: 'rose', name: 'Rose', swatch: ['#fbf3f5', '#ffffff', '#e0457b'] },
  { id: 'sand', name: 'Sand', swatch: ['#f4efe6', '#fffdf8', '#b5832a'] },
  { id: 'graphite', name: 'Graphite', swatch: ['#18191b', '#202124', '#8ab4f8'] },
  { id: 'contrast', name: 'High contrast', swatch: ['#000000', '#0b0b0b', '#ffd400'] },
  { id: 'gruvbox-dark', name: 'Gruvbox Dark', swatch: ['#1d2021', '#282828', '#fabd2f'] },
  { id: 'gruvbox-light', name: 'Gruvbox Light', swatch: ['#f2e5bc', '#fbf1c7', '#af3a03'] },
  { id: 'tokyo-night', name: 'Tokyo Night', swatch: ['#1a1b26', '#1f2335', '#7aa2f7'] },
  { id: 'one-dark', name: 'One Dark', swatch: ['#21252b', '#282c34', '#61afef'] },
  { id: 'monokai', name: 'Monokai', swatch: ['#1e1f1c', '#272822', '#a6e22e'] },
  { id: 'everforest', name: 'Everforest', swatch: ['#272e33', '#2e383c', '#a7c080'] },
  { id: 'kanagawa', name: 'Kanagawa', swatch: ['#16161d', '#1f1f28', '#7e9cd8'] },
  { id: 'rose-pine', name: 'Rosé Pine', swatch: ['#191724', '#1f1d2e', '#ebbcba'] },
  { id: 'rose-pine-dawn', name: 'Rosé Pine Dawn', swatch: ['#faf4ed', '#fffaf3', '#d7827e'] },
  { id: 'ayu-mirage', name: 'Ayu Mirage', swatch: ['#1f2430', '#242936', '#ffcc66'] },
  { id: 'night-owl', name: 'Night Owl', swatch: ['#011627', '#0b2034', '#82aaff'] },
  { id: 'github-light', name: 'GitHub Light', swatch: ['#f6f8fa', '#ffffff', '#0969da'] },
  { id: 'github-dark', name: 'GitHub Dark', swatch: ['#0d1117', '#161b22', '#2f81f7'] },
  { id: 'synthwave', name: 'Synthwave', swatch: ['#1a1033', '#241a45', '#ff7edb'] },
];

export const FONTS: { id: Appearance['font']; name: string; family: string }[] = [
  { id: 'jakarta', name: 'Plus Jakarta Sans', family: "'Plus Jakarta Sans Variable'" },
  { id: 'inter', name: 'Inter', family: "'Inter Variable'" },
  { id: 'figtree', name: 'Figtree', family: "'Figtree Variable'" },
  { id: 'manrope', name: 'Manrope', family: "'Manrope Variable'" },
  { id: 'dm-sans', name: 'DM Sans', family: "'DM Sans Variable'" },
  { id: 'outfit', name: 'Outfit', family: "'Outfit Variable'" },
  { id: 'nunito', name: 'Nunito', family: "'Nunito Variable'" },
  { id: 'lexend', name: 'Lexend', family: "'Lexend Variable'" },
  { id: 'source-sans', name: 'Source Sans 3', family: "'Source Sans 3 Variable'" },
  { id: 'plex', name: 'IBM Plex Sans', family: "'IBM Plex Sans Variable'" },
  { id: 'atkinson', name: 'Atkinson Hyperlegible', family: "'Atkinson Hyperlegible Next Variable'" },
  { id: 'system', name: 'System UI', family: 'system-ui' },
];

export const ACCENTS = ['#5b4fe0', '#2f7cf6', '#14a37f', '#b4f04a', '#f5b014', '#ee6f37', '#e5466b', '#a855f7'];

// readable text on top of the accent colour
function inkFor(hex: string) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55 ? '#101114' : '#ffffff';
}

export function applyAppearance(a: Appearance) {
  const root = document.documentElement;
  root.dataset.theme = a.theme;
  root.style.setProperty('--font-body', `${FONTS.find(f => f.id === a.font)?.family ?? 'system-ui'}, system-ui, sans-serif`);
  if (a.accent) {
    root.style.setProperty('--accent', a.accent);
    root.style.setProperty('--accent-ink', inkFor(a.accent));
  } else {
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent-ink');
  }
}
