/**
 * CodeMirror 6 Editor Modules
 *
 * This directory contains the core editor functionality:
 * - parser.ts: Markdown parsing utilities using unified/remark
 * - livePreview.ts: Live preview plugin that hides markdown syntax
 * - search.ts: In-document search with Cmd/Ctrl+F
 */

export { parseMarkdown, extractFormatMarks, extractTextNodes, isPositionInFormatting, type FormatMark } from "./parser";
export { livePreview, forceParse, getFormatMarks } from "./livePreview";
export { searchPanel } from "./search";
