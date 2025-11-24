# CodeMirror Markdown Editor with Live Preview

This directory contains a custom CodeMirror 6-based markdown editor with widget-based live preview rendering.

## Architecture Overview

The editor provides a hybrid editing experience:
- **Line-based source editing**: Edit raw markdown text directly
- **Live preview**: Lines not being edited render as formatted output
- **True semantic styling**: Widgets display bold text, bullets, etc. with proper styling

### Key Design Decision: Why Inline Rendering?

CodeMirror fundamentally works on a **line-based model**. Each line of text is wrapped in a `.cm-line` div. When we replace line content with widgets, we cannot use semantic block-level HTML elements (like `<h1>`, `<li>`, `<ul>`) because:

1. Each line exists in its own isolated `.cm-line` container
2. Block elements would create excessive vertical spacing
3. List items can't be wrapped in `<ul>`/`<ol>` parents across multiple lines
4. Block elements interfere with CodeMirror's line height calculations

**Solution**: We render everything as **inline `<span>` elements** with appropriate CSS classes and text content. For example:
- Headings → `<span class="cm-heading">text</span>` (styled bold)
- List items → `<span class="cm-list-item">• text</span>` (bullet added as text)
- Regular text → `<span>text with **bold** and *italic*</span>`

This approach:
- ✅ Eliminates spacing issues
- ✅ Works within CodeMirror's line model
- ✅ Allows proper styling with CSS
- ✅ Maintains natural line flow

## File Structure

```
editor/
├── CmEditor.tsx          # Main editor component (SolidJS)
├── CmEditor.css          # Editor and widget styling
├── CmLoader.tsx          # Loader component with content fetching
├── cm/
│   ├── livePreview2.ts   # Widget-based live preview plugin
│   ├── widgets.ts        # Widget class definitions
│   ├── renderer.ts       # Markdown → DOM renderer
│   ├── parser.ts         # Markdown AST parser (currently unused)
│   └── search.ts         # Search panel extension
└── README.md            # This file
```

## How Live Preview Works

### 1. **Live Preview Plugin** (`cm/livePreview2.ts`)

The plugin uses CodeMirror's decoration system to replace line content with widgets:

```typescript
// For each line in the document:
- If cursor is on this line → show source (no widget)
- If cursor is NOT on this line → replace with widget
- If editor loses focus → replace ALL lines with widgets
```

**Key Implementation Details:**
- Uses `Decoration.replace()` to hide source text
- Creates `MarkdownWidget` instances for each line
- Updates decorations on: doc change, selection change, focus change
- `ViewPlugin.fromClass` provides the decoration set to CodeMirror

**Why NOT block decorations?**
CodeMirror does not allow block decorations via plugins (they must be specified directly). We use inline replace decorations instead.

### 2. **Widget System** (`cm/widgets.ts`)

Widgets are custom view elements that replace text content:

```typescript
class MarkdownWidget extends WidgetType {
  toDOM(): HTMLElement {
    // Returns a single inline element (span, strong, etc.)
    // NOT a block container with children
  }
}
```

**Important**: The `toDOM()` method must return a single element that will be inserted inline within the `.cm-line` container.

### 3. **Markdown Renderer** (`cm/renderer.ts`)

Converts markdown text to DOM elements:

```typescript
export function renderMarkdownToDOM(markdown: string): HTMLElement
```

**Rendering Strategy:**
- One line of markdown → one inline element
- Headings: `<span class="cm-heading cm-heading-{level}">text</span>`
- Lists: `<span class="cm-list-item">• text</span>` or `<span class="cm-list-item">1. text</span>`
- Regular text: `<span>text with inline formatting</span>`
- Inline formatting (bold, italic, links, code) processed via `processInlineMarkdown()`

**What NOT to do:**
- ❌ Don't create container divs with nested children
- ❌ Don't render actual `<h1>`, `<li>`, `<ul>` elements
- ❌ Don't use `display: block` on widget elements

## Styling Guidelines

### Widget Styling (`CmEditor.css`)

All widget elements must be styled as inline elements:

```css
/* Base widget styles - always inline */
.cm-markdown-widget,
.cm-markdown-rendered {
  display: inline;  /* Critical! */
  margin: 0;
  padding: 0;
}

/* Specific element styling */
.cm-heading {
  font-weight: bold;  /* Headings are bold */
}

.cm-list-item {
  /* Lists already have bullets in text content */
}
```

**Key Rules:**
1. Never use `display: block` on widget elements
2. Never add vertical margins/padding to widgets
3. Use inline styling (bold, italic, color) only
4. `.cm-line` containers control line spacing automatically

### Adding New Markdown Features

To add support for a new markdown feature:

1. **Update renderer** (`cm/renderer.ts`):
   ```typescript
   // Add pattern matching
   const quoteMatch = trimmed.match(/^>\s+(.+)$/);
   if (quoteMatch) {
     const span = document.createElement("span");
     span.className = "cm-markdown-rendered cm-blockquote";
     span.innerHTML = processInlineMarkdown(quoteMatch[1]);
     return span;
   }
   ```

2. **Add CSS styling** (`CmEditor.css`):
   ```css
   .cm-blockquote {
     font-style: italic;
     color: var(--color-text-muted);
     /* NO display: block! */
   }
   ```

3. **Update inline markdown processor** if needed:
   ```typescript
   function processInlineMarkdown(text: string): string {
     // Add new inline pattern
     text = text.replace(/==(.+?)==/g, "<mark>$1</mark>");
     return text;
   }
   ```

## Integration with Auto-Save

The editor integrates with the auto-save system:

```typescript
const { isSaving, forceSave } = useAutoSave({
  getPath: () => props.path,
  getContent: content,
  delay: 500,
});
```

- Content changes trigger debounced auto-save
- Cmd/Ctrl+S forces immediate save
- Save state is tracked via `isSaving` signal

## Testing the Editor

**To verify rendering:**
1. Create a note with various markdown elements
2. Click away from a line → should render as formatted output
3. Click back on the line → should show raw markdown source
4. Unfocus editor → all lines should show formatted output
5. Check spacing → should match source mode (no extra gaps)

**Common Issues:**
- **Extra spacing**: Widget elements are using `display: block`
- **No styling**: CSS classes not matching renderer output
- **Flickering**: Decorations updating too frequently
- **Can't edit**: Widget covering the entire line including newline

## Why Not Use ProseMirror or Milkdown?

We tried both:
- **Milkdown**: Too opinionated, limited flexibility, bugs
- **ProseMirror**: WYSIWYG-first, doesn't support line-based source editing
- **TipTap**: Not focused on markdown as source of truth

**CodeMirror + widgets** gives us:
- ✅ True line-based editing (like vim, VS Code, Obsidian)
- ✅ Direct access to markdown source
- ✅ Live preview that doesn't interfere with editing
- ✅ Full control over rendering and behavior

## Future Improvements

Potential enhancements:
- [ ] Multi-line block support (code blocks, tables)
- [ ] Image preview inline
- [ ] Link preview on hover
- [ ] Smarter list handling (merge consecutive items)
- [ ] Syntax highlighting in code blocks
- [ ] Collaborative editing support

## Troubleshooting

### Widgets not appearing
- Check browser console for errors
- Verify `livePreview2` is imported correctly
- Ensure decorations are being created (debug `createDecorations()`)

### Wrong spacing
- Inspect DOM: look for `display: block` on widget elements
- Check for margins/padding on `.cm-line` or widget classes
- Verify renderer returns single inline element

### Styling not applied
- Check CSS class names match renderer output
- Use browser DevTools to inspect widget DOM
- Verify CSS specificity (widget classes should be specific enough)

### Performance issues
- Reduce decoration updates (check `update()` method)
- Profile with Chrome DevTools
- Consider virtualizing very long documents
