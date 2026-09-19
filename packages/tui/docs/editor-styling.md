# Editor text styling

Subclasses may override the protected `styleText(text, line, startIndex)` hook to add ANSI styling to visible input fragments.

- `line` is the zero-based logical source line; `startIndex` is a UTF-16 offset within that line, not a terminal column.
- The hook runs after wrapping and scrolling. A fragment can be part of a longer token or only one side of the cursor.
- Preserve the input characters and display width. Only add self-contained ANSI styles that reset before the fragment ends.
- The cursor grapheme, cursor marker, padding, borders and autocomplete list bypass this hook. The base implementation returns the text unchanged.
- Product-specific keyword detection, theme resolution and animation lifecycle belong to the caller, not `pi-tui`.
