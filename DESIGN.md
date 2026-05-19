---
name: Chandra
description: Teacher-guided AI learning platform for classrooms.
colors:
  forest-instruction: "#245f48"
  forest-instruction-strong: "#174833"
  forest-instruction-soft: "#e9f1ec"
  classroom-canvas: "#f4f5f2"
  classroom-sidebar: "#f7f7f3"
  classroom-surface: "#fffffb"
  classroom-surface-muted: "#f8f9f5"
  classroom-border: "#979a8f"
  classroom-ink: "#20261f"
  classroom-secondary: "#30372f"
  classroom-muted: "#5d6559"
  evening-canvas: "#070911"
  evening-sidebar: "#090c15"
  evening-surface: "#101625"
  evening-row: "#0c111d"
  evening-border: "#848fa6"
  evening-ink: "#fcfdff"
  source-gold: "#b9903a"
  review-rose: "#b94e55"
  analytics-purple: "#5b35c9"
  analytics-orange: "#e87512"
  analytics-blue: "#1667b7"
typography:
  display:
    fontFamily: "Charter, Georgia, Times New Roman, serif"
    fontSize: "2rem"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "normal"
  headline:
    fontFamily: "Avenir Next, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "normal"
  title:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "1.12rem"
    fontWeight: 700
    lineHeight: 1.18
    letterSpacing: "normal"
  body:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.95rem"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.78rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.02em"
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "18px"
  pill: "999px"
spacing:
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "18px"
  xl: "24px"
  xxl: "30px"
components:
  button-primary:
    backgroundColor: "{colors.forest-instruction}"
    textColor: "{colors.evening-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 15px"
    height: "42px"
  button-secondary:
    backgroundColor: "{colors.classroom-surface}"
    textColor: "{colors.forest-instruction}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "40px"
  chip-selected:
    backgroundColor: "{colors.forest-instruction-soft}"
    textColor: "{colors.forest-instruction}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "28px"
  card-panel:
    backgroundColor: "{colors.classroom-surface}"
    textColor: "{colors.classroom-ink}"
    rounded: "{rounded.md}"
    padding: "22px"
  input-field:
    backgroundColor: "{colors.classroom-surface}"
    textColor: "{colors.classroom-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "40px"
---

# Design System: Chandra

## 1. Overview

**Creative North Star: "The Instructor's Workbench"**

Chandra's product UI is a calm classroom work surface: useful tools close at hand, restrained materials, visible evidence, and no theatrical AI gloss. The system should feel rigorous enough for teachers managing real classes and quiet enough for students to stay focused on the problem in front of them.

The visual language uses warm institutional neutrals, forest and teal instructional accents, compact controls, and softly bounded panels. It supports density without becoming harsh. The product can be configurable by class, theme, and mood, but every variant should still feel like Chandra: composed, teacher-trusted, and built for learning.

It explicitly rejects generic AI SaaS styling, over-polished productivity theater, childish edtech visuals, gamified classroom gimmicks, surveillance or punitive classroom tooling, and interfaces that make AI feel magical or more central than the teacher's instructional intent.

**Key Characteristics:**
- Restrained, task-forward product surfaces.
- Warm canvas tones with forest instructional accents.
- Dense panels, rows, and controls that stay predictable.
- Mood variants that change pressure and contrast, not product identity.
- Evidence-oriented states for review, sources, learning signals, and access.

## 2. Colors

The palette is a classroom-neutral system anchored by Forest Instruction, with semantic accents reserved for review, sources, analytics, and student understanding states.

### Primary

- **Forest Instruction**: The core action and selection color. Use it for primary buttons, current navigation, selected rows, focus support, class theme defaults, and teacher-controlled intent.
- **Forest Instruction Strong**: The hover and active variant for committed actions. Use it when a button or selected state needs extra confidence.
- **Forest Instruction Soft**: The quiet selected or highlighted background. Use it for active rows, selected pills, source-aware hints, and low-pressure emphasis.

### Secondary

- **Source Gold**: Use for source or material emphasis only. It should point to evidence, not decorate.
- **Review Rose**: Use for errors, sensitive review states, and unresolved feedback. It should feel serious, not alarmist.
- **Analytics Purple, Analytics Orange, Analytics Blue**: Use inside data and analytics contexts where distinct categories need to be compared.

### Neutral

- **Classroom Canvas**: The default light product background. It should read as calm paper, not bright white.
- **Classroom Sidebar**: A slightly separated neutral for rails, drawers, and persistent navigation.
- **Classroom Surface**: The main card, input, and panel surface.
- **Classroom Surface Muted**: Hover rows and subtle separations.
- **Classroom Border**: Low-contrast structure for rows, controls, and panels.
- **Classroom Ink, Secondary, Muted**: Text hierarchy from primary content to supporting metadata.
- **Evening Canvas, Sidebar, Surface, Row, Border, Ink**: Dark mode mirrors the same product hierarchy with stronger tonal separation.

### Named Rules

**The Forest Is Functional Rule.** Forest and teal accents are for action, selection, focus, source-guided confidence, or instructional state. They are not decorative washes.

**The Evidence Accent Rule.** Gold means source material, rose means review or error, and analytics hues mean category comparison. Do not reuse these colors for ornamental variety.

## 3. Typography

**Display Font:** Charter, Georgia, Times New Roman, serif  
**Body Font:** system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif  
**Label/Mono Font:** system-ui for labels; monospace only for codes and technical identifiers

**Character:** Product screens use a native sans for clarity and speed. The serif is a limited Chandra signature for brand moments, onboarding, and selected headings where a scholarly tone is useful.

### Hierarchy

- **Display** (700, 2rem, 1.25): Use sparingly in onboarding, welcome, and signature empty states.
- **Headline** (700, 1.75rem, 1.15): Use for main product page titles such as daily overview and class workspaces.
- **Title** (700, 1.12rem, 1.18): Use for panel titles, card headings, and dashboard section headings.
- **Body** (500, 0.95rem, 1.5): Use for normal explanation, form copy, chat messages, and supporting prose. Keep longer prose near 65-75ch.
- **Label** (700, 0.78rem, 0.02em): Use for metadata, chips, table headers, compact buttons, and status labels.

### Named Rules

**The Serif Has Tenure Rule.** Serif type appears only where a scholarly Chandra voice helps. Never use it inside dense settings labels, data tables, primary navigation, or utility controls.

**The Label Pressure Rule.** Labels may be compact and firm, but not shouty. Uppercase is allowed for table headers and eyebrows only.

## 4. Elevation

Chandra is quietly layered, restrained, and task-forward. Depth is usually conveyed through tonal layering, borders, selected backgrounds, and fixed rails. Shadows are ambient and low contrast; they are used for floating panels, composers, popovers, and warm or calm mood selections rather than routine decoration.

### Shadow Vocabulary

- **App Soft** (`0 10px 24px rgba(44, 42, 33, 0.07)`): Default light panel depth for the older warm system.
- **Focused Flat** (`none`): Default focused mood depth. Use borders and selected backgrounds instead of shadows.
- **Calm Lift** (`0 6px 18px rgba(45, 58, 38, 0.035)`): Quiet depth for low-pressure classroom surfaces.
- **Warm Lift** (`0 14px 30px rgba(108, 68, 22, 0.09)`): Slightly more tactile depth for warm mood.
- **Dark Lift** (`0 16px 38px rgba(0, 0, 0, 0.3)`): Dark mode structural separation.
- **Popover Lift** (`0 18px 42px rgba(24, 34, 54, 0.16)`): Calendar menus, flyouts, and overlays that must clear the surface.
- **Composer Lift** (`0 -10px 26px rgba(15, 23, 42, 0.075)`): Bottom chat composer separation.

### Named Rules

**The Flat-First Rule.** Product surfaces are flat at rest unless they float, overlay, or need persistent separation from scrolling content.

**The Shadow Must Explain Position Rule.** If a shadow does not clarify layer order, remove it.

## 5. Components

### Buttons

- **Shape:** Gently squared product controls, usually 8px radius or mood-adjusted with `max(6px, mood-radius - 4px)`.
- **Primary:** Forest background with light text, 42px height, compact horizontal padding, and no decorative gradient.
- **Hover / Focus:** Shift to Forest Instruction Strong for committed actions. Focus uses visible ring treatment through `--theme-primary-ring` or `--focus-ring`.
- **Secondary / Ghost:** Surface background, border, forest text, and subtle forest-soft hover. Use for review, open, copy, and settings actions.

### Chips

- **Style:** Compact, border-backed filters and status pills, usually 28-40px tall depending on mood.
- **State:** Selected chips use Forest Instruction Soft with forest text and a visible border. Analytics chips may use category colors only when they identify actual categories.

### Cards / Containers

- **Corner Style:** 8px for focused panels, 18px for calm, 12px for warm, 4-6px for high contrast.
- **Background:** Classroom Surface in light mode, Evening Surface in dark mode, with sidebar and row layers kept distinct.
- **Shadow Strategy:** Follow the Flat-First Rule; use `--app-shadow` only where the mood or layer requires it.
- **Border:** Always present on product panels and rows unless the surface is a fixed rail.
- **Internal Padding:** 18-24px for dashboard cards, 10-14px for rows and compact stats.

### Inputs / Fields

- **Style:** Surface background, 1px border, 6-8px radius, native sans text, and compact height.
- **Focus:** Border shifts toward selected-row or primary color and adds a 3px focus ring.
- **Error / Disabled:** Error states use Review Rose. Disabled buttons keep a visible border and muted text rather than disappearing.

### Navigation

Navigation uses persistent sidebars, icon rails, secondary sidebars, tabs, and row-based current states. Current rows use Forest Instruction Soft, selected borders, and stronger text. Mobile behavior should collapse structure before reducing type size.

### Student Composer

The student composer is a signature product component. It stays centered and bounded, uses a quiet top shadow, and reserves the strongest forest fill for send and attachment controls. Textareas must keep visible focus rings and usable attachment/send dimensions on mobile.

## 6. Do's and Don'ts

### Do:

- **Do** use Forest Instruction for action, selection, focus, and teacher intent.
- **Do** keep product screens calm, rigorous, and teacher-trusted through restrained color and predictable controls.
- **Do** preserve the mood system: calm is softer, focused is flatter, warm is tactile, high contrast is explicit.
- **Do** use visible focus states, sufficient contrast, reduced-motion-safe transitions, and color-blind-safe status cues.
- **Do** make evidence inspectable with source, review, and analytics colors tied to real meaning.
- **Do** keep dense teacher dashboards scannable with rows, panels, and compact hierarchy.

### Don't:

- **Don't** use generic AI SaaS styling.
- **Don't** use over-polished productivity theater.
- **Don't** use childish edtech visuals or gamified classroom gimmicks.
- **Don't** imply surveillance or punitive classroom tooling.
- **Don't** make AI feel magical, autonomous, or more central than the teacher's instructional intent.
- **Don't** use decorative gradients, glassmorphism, animated page-load choreography, or side-stripe accent borders.
- **Don't** use gold, rose, purple, orange, or blue as ornamental accents outside their semantic roles.
- **Don't** introduce new button shapes, invented controls, or display fonts inside dense product UI.
