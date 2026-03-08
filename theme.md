# Neon Decay — Cyberpunk Color Theme

Dark theme with deep blue-black backgrounds, neon accents, and a four-step text hierarchy. Designed for developer tooling and data-heavy interfaces.

## Backgrounds

Five elevation levels, all with a slight violet undertone.

| Token            | Hex       | Use                              |
|------------------|-----------|----------------------------------|
| `bg-void`        | `#0a0a0f` | Page/app background              |
| `bg-primary`     | `#0d0d14` | Code blocks, inset panels        |
| `bg-surface`     | `#12121c` | Cards, modals, sidebars          |
| `bg-elevated`    | `#1a1a28` | Popovers, dropdowns, tooltips    |
| `bg-hover`       | `#222233` | Hover/active states on surfaces  |

## Text

| Token            | Hex       | Use                                    |
|------------------|-----------|----------------------------------------|
| `text-primary`   | `#e0dfe6` | Headings, body text, primary content   |
| `text-secondary` | `#8a8a9e` | Descriptions, supporting text          |
| `text-muted`     | `#55556a` | Timestamps, metadata, placeholders     |
| `text-ghost`     | `#33334a` | Disabled states, watermarks            |

## Borders

| Token            | Hex       | Use                              |
|------------------|-----------|----------------------------------|
| `border-subtle`  | `#1e1e30` | Dividers between same-level items |
| `border-default` | `#2a2a40` | Card borders, input outlines     |
| `border-strong`  | `#3a3a55` | Hover borders, active outlines   |

## Neon Accents

Eight saturated neon colors. Each has a corresponding glow token for box-shadow/text-shadow effects.

| Token            | Hex       | Glow (box-shadow)                                    | Suggested Use                        |
|------------------|-----------|------------------------------------------------------|--------------------------------------|
| `neon-cyan`      | `#00f0ff` | `0 0 8px #00f0ff44, 0 0 20px #00f0ff22`              | Links, focus rings, primary actions  |
| `neon-magenta`   | `#ff00aa` | `0 0 8px #ff00aa44, 0 0 20px #ff00aa22`              | Destructive actions, alerts          |
| `neon-violet`    | `#bf5af2` | `0 0 8px #bf5af244, 0 0 20px #bf5af222`              | Keywords, tags, labels               |
| `neon-amber`     | `#ffb800` | `0 0 8px #ffb80044, 0 0 20px #ffb80022`              | Warnings, numbers, constants         |
| `neon-lime`      | `#39ff14` | `0 0 8px #39ff1444, 0 0 20px #39ff1422`              | Success, strings, confirmations      |
| `neon-coral`     | `#ff6b6b` | `0 0 8px #ff6b6b44, 0 0 20px #ff6b6b22`              | Notifications, soft errors, badges   |
| `neon-electric`  | `#4d4dff` | `0 0 8px #4d4dff44, 0 0 20px #4d4dff22`              | Selections, active states            |
| `neon-plasma`    | `#ff5e00` | `0 0 8px #ff5e0044, 0 0 20px #ff5e0022`              | Live data, hot paths, urgency        |

## Semantic / Status

| Token      | Hex       | Use            |
|------------|-----------|----------------|
| `success`  | `#00e676` | Online, pass   |
| `warning`  | `#ffab00` | Degraded, slow |
| `error`    | `#ff1744` | Critical, fail |
| `info`     | `#00b0ff` | Syncing, info  |

## Diff

| Token             | Hex         | Use                   |
|-------------------|-------------|-----------------------|
| `diff-added`      | `#00e676`   | Added lines (text)    |
| `diff-added-bg`   | `#00e67615` | Added lines (bg)      |
| `diff-removed`    | `#ff1744`   | Removed lines (text)  |
| `diff-removed-bg` | `#ff174415` | Removed lines (bg)    |
| `diff-modified`   | `#00b0ff`   | Modified lines (text) |
| `diff-modified-bg`| `#00b0ff15` | Modified lines (bg)   |

## Syntax Highlighting Map

Mapping accents to code token types:

| Token Type  | Color          | Hex       |
|-------------|----------------|-----------|
| Keywords    | `neon-violet`  | `#bf5af2` |
| Functions   | `neon-cyan`    | `#00f0ff` |
| Strings     | `neon-lime`    | `#39ff14` |
| Numbers     | `neon-amber`   | `#ffb800` |
| Operators   | `neon-magenta` | `#ff00aa` |
| Types       | `neon-cyan`    | `#00f0ff` (80% opacity) |
| Comments    | `text-muted`   | `#55556a` |
| Properties  | `text-primary` | `#e0dfe6` |

## CSS Variables

Copy-paste ready block:

```css
:root {
  /* Backgrounds */
  --bg-void:        #0a0a0f;
  --bg-primary:     #0d0d14;
  --bg-surface:     #12121c;
  --bg-elevated:    #1a1a28;
  --bg-hover:       #222233;

  /* Text */
  --text-primary:   #e0dfe6;
  --text-secondary: #8a8a9e;
  --text-muted:     #55556a;
  --text-ghost:     #33334a;

  /* Borders */
  --border-subtle:  #1e1e30;
  --border-default: #2a2a40;
  --border-strong:  #3a3a55;

  /* Neon Accents */
  --neon-cyan:      #00f0ff;
  --neon-magenta:   #ff00aa;
  --neon-violet:    #bf5af2;
  --neon-amber:     #ffb800;
  --neon-lime:      #39ff14;
  --neon-coral:     #ff6b6b;
  --neon-electric:  #4d4dff;
  --neon-plasma:    #ff5e00;

  /* Semantic */
  --success:        #00e676;
  --warning:        #ffab00;
  --error:          #ff1744;
  --info:           #00b0ff;

  /* Glows */
  --glow-cyan:      0 0 8px #00f0ff44, 0 0 20px #00f0ff22;
  --glow-magenta:   0 0 8px #ff00aa44, 0 0 20px #ff00aa22;
  --glow-violet:    0 0 8px #bf5af244, 0 0 20px #bf5af222;
  --glow-amber:     0 0 8px #ffb80044, 0 0 20px #ffb80022;
  --glow-lime:      0 0 8px #39ff1444, 0 0 20px #39ff1422;
  --glow-coral:     0 0 8px #ff6b6b44, 0 0 20px #ff6b6b22;
  --glow-electric:  0 0 8px #4d4dff44, 0 0 20px #4d4dff22;
  --glow-plasma:    0 0 8px #ff5e0044, 0 0 20px #ff5e0022;

  /* Diff */
  --diff-added-bg:  #00e67615;
  --diff-added:     #00e676;
  --diff-removed-bg:#ff174415;
  --diff-removed:   #ff1744;
  --diff-modified-bg:#00b0ff15;
  --diff-modified:  #00b0ff;
}
```

## Tailwind Config (optional)

If using Tailwind, extend your theme:

```js
// tailwind.config.js
module.exports = {
  theme: {
    extend: {
      colors: {
        bg: {
          void:     '#0a0a0f',
          primary:  '#0d0d14',
          surface:  '#12121c',
          elevated: '#1a1a28',
          hover:    '#222233',
        },
        text: {
          primary:   '#e0dfe6',
          secondary: '#8a8a9e',
          muted:     '#55556a',
          ghost:     '#33334a',
        },
        border: {
          subtle:  '#1e1e30',
          DEFAULT: '#2a2a40',
          strong:  '#3a3a55',
        },
        neon: {
          cyan:     '#00f0ff',
          magenta:  '#ff00aa',
          violet:   '#bf5af2',
          amber:    '#ffb800',
          lime:     '#39ff14',
          coral:    '#ff6b6b',
          electric: '#4d4dff',
          plasma:   '#ff5e00',
        },
        status: {
          success: '#00e676',
          warning: '#ffab00',
          error:   '#ff1744',
          info:    '#00b0ff',
        },
      },
    },
  },
};
```
