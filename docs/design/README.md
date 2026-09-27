# Design

The mockups in this folder are the source of truth for Offbeat's UI. Match their layout, spacing, colors, and type exactly, using the tokens below.

## Mockups

These are standalone HTML files exported from a design tool. They use its small template syntax (`<sc-for>`, `<sc-if>`, `{{ }}` holes, and a `DCLogic` script block holding sample data) and load a `support.js` runtime that is not included, so opened directly in a browser they show the layout without their sample data. They are **visual reference, not code to port**: rebuild each screen as Angular components using the tokens in `web/src/app/shared/tokens.scss`.

| File | Screen | Built |
| --- | --- | --- |
| `Main.dc.html` | Discover (desktop) | Phase 2 |
| `Mobile.dc.html` | Discover (mobile, 390px) and the mobile tab bar | Shell done |
| `Onboarding.dc.html` | Setup wizard, Lidarr step | Done |
| `Settings.dc.html` | Settings, Integrations section | Done |
| `Library.dc.html` | Library grid | Done |
| `Search.dc.html` | Search results | Done |
| `Artist.dc.html` | Artist page | Done |
| `Album.dc.html` | Album page (partial state shown) | Done |
| `Activity.dc.html` | Activity (requests, downloads, failures) | Phase 1 |
| `Flows.dc.html` | Flow list and editor | Phase 4 |
| `Shows.dc.html` | Shows (concert listings) | Phase 3 |

Empty, loading, and error states are not in the mockups. Build them for every screen in the same style (see `ob-empty-state`).

## Principles

- Apple Music style minimalism: album art forward, generous whitespace, very little chrome.
- One accent color, used sparingly (active nav, logo dot, quick-add buttons, toggles). Everything else is grayscale.
- Never crowded. Fewer, well-chosen sections beat many rows.
- Avoid generic app tropes: no gradient washes, no emoji, no left-border accent cards, no Inter or Roboto.
- Dark theme first. A light theme can come later through the same tokens.

## Tokens

Defined once as CSS custom properties in `web/src/app/shared/tokens.scss`. Never hard-code a color.

**Surfaces**

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#111113` | App background |
| `--bg-sidebar` | `#161618` | Sidebar, mobile tab bar |
| `--bg-bar` | `#19191C` | Bottom bar |
| `--surface` | `#18181B` | Cards, pills |
| `--surface-input` | `#1A1A1D` | Inputs, selects |
| `--surface-2` | `#1E1E21` | Segmented control track, secondary pills, selected list item |
| `--surface-3` | `#232327` | Active nav item, tertiary buttons, tag chips |
| `--surface-4` | `#34343A` | Selected segment |

**Borders**

| Token | Value | Use |
| --- | --- | --- |
| `--divider` | `#1F1F23` | List row dividers |
| `--border-sidebar` | `#222226` | Sidebar edge |
| `--border-bar` | `#25252A` | Bottom bar top edge |
| `--border-input` | `#2C2C31` | Inputs, tag pills |
| `--border-button` | `#34343A` | Outlined buttons |

**Text**

| Token | Value | Use |
| --- | --- | --- |
| `--text` | `#F2F2F2` | Primary |
| `--text-soft` | `#E4E4E8` | Outlined button labels, tag pills |
| `--text-label` | `#C4C4CA` | Form field labels |
| `--text-2` | `#B4B4BA` | Secondary, inactive nav, "In Library" |
| `--text-lead` | `#A6A6AC` | Intro paragraphs, inactive segments |
| `--text-3` | `#9A9AA0` | Captions, metadata |
| `--text-4` | `#8E8E95` | Source labels, inactive steps |

**Accent and status**

| Token | Value | Use |
| --- | --- | --- |
| `--accent` | `#FF6B4A` | Active nav icon, logo dot, quick add, toggles |
| `--on-accent` | `#1A0D08` | Icons and text on accent |
| `--status-progress` | `#6CB4FF` | Wanted, downloading, progress bars |
| `--status-failed` | `#FF8A7A` | Failed text and icons |
| `--status-failed-bg` | `#1C1719` | Failed row background |
| `--status-failed-border` | `#3A2626` | Failed row border |
| `--track` | `#2E2E33` | Progress and slider tracks |

Primary buttons are `--text` fill with `--bg` text (white pill, dark label).

## Status chips

Use these identically everywhere a release appears.

| State | Treatment |
| --- | --- |
| Not in library | Outlined "Add" pill with a plus icon |
| Wanted (monitored, nothing on disk yet) | `--status-progress` text |
| Downloading | `--status-progress` text with percentage and a 3px progress bar |
| In Library | `--text-2` with a check icon |
| Partial | `--text-3` text, for example "2 missing" |
| Failed | `--status-failed` with an alert icon, plus a Retry action |

### Album page states

The Album mockup shows the partial state. The other states reuse the same layout:

| State | Status line | Actions | Tracklist |
| --- | --- | --- | --- |
| Not added | none | Coral "Add Album" | No status column |
| Wanted | "Wanted" | Monitored, Search Missing | Missing tracks marked |
| Partial | "Partial: 11 of 13 tracks in library" | Monitored, Search Missing | Only missing tracks marked |
| Complete | none | Monitored | Plain |
| Downloading | Progress with the blue bar | | |

## Typography

[Instrument Sans](https://fonts.google.com/specimen/Instrument+Sans), weights 400, 500, 600, 700, self-hosted so the app works offline. Fallback: `-apple-system, 'Helvetica Neue', sans-serif`. Type roles are mixins in `web/src/app/shared/_mixins.scss`.

| Role | Size / weight / tracking |
| --- | --- |
| Artist hero name | 76px / 700 / -0.035em |
| Album title | 56px / 700 / -0.03em |
| Page title | 34px / 700 / -0.025em |
| Wordmark | 22px / 700 / -0.03em, lowercase "offbeat" with the accent dot |
| Section heading | 20px / 600 / -0.01em |
| Card title | 17px / 600 |
| Body and list title | 14 to 15px / 500 |
| Caption and metadata | 13px / 400 |
| Small and chip | 12px / 500 |
| Overline | 13px / 600 / 0.06em uppercase |

## Shape and spacing

- **Radius:** 5 to 6px small art thumbnails, 8px album art and nav items, 10px inputs and segmented controls, 12px cards and hero tiles, fully rounded pills and buttons, 50% artist images.
- **Layout:** sidebar 232px, bottom bar 72px, page padding 40px top and 48px sides, section gap 44px, heading to content 16px, grid gap 20px. Album rows are 6 columns on desktop; the library artist grid is 7.
- **Mobile:** below 768px the sidebar becomes a tab bar; touch targets are at least 44px.
- **Icons:** 24px viewBox stroke icons at 1.8px stroke in `currentColor` (Lucide style). See `ob-icon`.
