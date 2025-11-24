import { describe, it, expect } from "vitest";
import {
  parseMarkdown,
  extractFormatMarks,
  extractTextNodes,
  isPositionInFormatting,
} from "./parser";
import type { Paragraph } from "mdast";

describe("parseMarkdown", () => {
  it("should parse basic markdown text", () => {
    const text = "Hello world";
    const ast = parseMarkdown(text);

    expect(ast.type).toBe("root");
    expect(ast.children.length).toBeGreaterThan(0);
  });

  it("should parse headings", () => {
    const text = "# Heading 1\n## Heading 2";
    const ast = parseMarkdown(text);

    expect(ast.children[0].type).toBe("heading");
    expect(ast.children[1].type).toBe("heading");
  });

  it("should parse bold text", () => {
    const text = "This is **bold** text";
    const ast = parseMarkdown(text);

    const paragraph = ast.children[0] as Paragraph;
    expect(paragraph.type).toBe("paragraph");
    // Should contain text, strong, text nodes
    expect(paragraph.children.length).toBe(3);
    expect(paragraph.children[1].type).toBe("strong");
  });

  it("should parse italic text", () => {
    const text = "This is *italic* text";
    const ast = parseMarkdown(text);

    const paragraph = ast.children[0] as Paragraph;
    expect(paragraph.type).toBe("paragraph");
    expect(paragraph.children[1].type).toBe("emphasis");
  });

  it("should parse lists", () => {
    const text = "- Item 1\n- Item 2";
    const ast = parseMarkdown(text);

    expect(ast.children[0].type).toBe("list");
  });

  it("should parse task lists with remark-gfm", () => {
    const text = "- [ ] Todo\n- [x] Done";
    const ast = parseMarkdown(text);

    const list = ast.children[0] as any;
    expect(list.type).toBe("list");
    expect(list.children[0].checked).toBe(false);
    expect(list.children[1].checked).toBe(true);
  });

  it("should parse strikethrough with remark-gfm", () => {
    const text = "~~strikethrough~~";
    const ast = parseMarkdown(text);

    const paragraph = ast.children[0] as Paragraph;
    expect(paragraph.children[0].type).toBe("delete");
  });

  it("should parse tables with remark-gfm", () => {
    const text = "| Col 1 | Col 2 |\n|-------|-------|\n| A | B |";
    const ast = parseMarkdown(text);

    expect(ast.children[0].type).toBe("table");
  });
});

describe("extractFormatMarks", () => {
  it("should extract heading marks", () => {
    const text = "# Heading";
    const ast = parseMarkdown(text);
    const marks = extractFormatMarks(ast);

    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({
      from: 0,
      to: 2, // "# "
      type: "heading",
      level: 1,
    });
  });

  it("should extract marks for different heading levels", () => {
    const text = "# H1\n## H2\n### H3";
    const ast = parseMarkdown(text);
    const marks = extractFormatMarks(ast);

    expect(marks).toHaveLength(3);
    expect(marks[0].level).toBe(1);
    expect(marks[0].to - marks[0].from).toBe(2); // "# "
    expect(marks[1].level).toBe(2);
    expect(marks[1].to - marks[1].from).toBe(3); // "## "
    expect(marks[2].level).toBe(3);
    expect(marks[2].to - marks[2].from).toBe(4); // "### "
  });

  it("should extract bold marks with **", () => {
    const text = "This is **bold** text";
    const ast = parseMarkdown(text);
    const marks = extractFormatMarks(ast);

    expect(marks).toHaveLength(2);
    expect(marks[0]).toMatchObject({
      from: 8,
      to: 10, // Opening **
      type: "bold",
    });
    expect(marks[1]).toMatchObject({
      from: 14,
      to: 16, // Closing **
      type: "bold",
    });
  });

  it("should extract bold marks with __", () => {
    const text = "This is __bold__ text";
    const ast = parseMarkdown(text);
    const marks = extractFormatMarks(ast);

    expect(marks).toHaveLength(2);
    expect(marks[0].type).toBe("bold");
    expect(marks[1].type).toBe("bold");
  });

  it("should extract italic marks with *", () => {
    const text = "This is *italic* text";
    const ast = parseMarkdown(text);
    const marks = extractFormatMarks(ast);

    expect(marks).toHaveLength(2);
    expect(marks[0]).toMatchObject({
      from: 8,
      to: 9, // Opening *
      type: "italic",
    });
    expect(marks[1]).toMatchObject({
      from: 15,
      to: 16, // Closing *
      type: "italic",
    });
  });

  it("should extract italic marks with _", () => {
    const text = "This is _italic_ text";
    const ast = parseMarkdown(text);
    const marks = extractFormatMarks(ast);

    expect(marks).toHaveLength(2);
    expect(marks[0].type).toBe("italic");
    expect(marks[1].type).toBe("italic");
  });

  it("should extract unordered list marks", () => {
    const text = "- Item 1\n- Item 2";
    const ast = parseMarkdown(text);
    const marks = extractFormatMarks(ast);

    expect(marks).toHaveLength(2);
    expect(marks[0]).toMatchObject({
      from: 0,
      to: 2, // "- "
      type: "list",
    });
    expect(marks[1]).toMatchObject({
      from: 9,
      to: 11, // "- "
      type: "list",
    });
  });

  it("should extract ordered list marks", () => {
    const text = "1. First\n2. Second";
    const ast = parseMarkdown(text);
    const marks = extractFormatMarks(ast);

    expect(marks).toHaveLength(2);
    expect(marks[0].type).toBe("list");
    expect(marks[1].type).toBe("list");
  });

  it("should extract task list marks", () => {
    const text = "- [ ] Todo\n- [x] Done";
    const ast = parseMarkdown(text);
    const marks = extractFormatMarks(ast);

    expect(marks).toHaveLength(2);
    expect(marks[0]).toMatchObject({
      from: 0,
      to: 6, // "- [ ] "
      type: "task-list",
    });
    expect(marks[1]).toMatchObject({
      from: 11,
      to: 17, // "- [x] "
      type: "task-list",
    });
  });

  it("should handle multiple formatting types in one document", () => {
    const text = "# Heading\n\nThis is **bold** and *italic*.\n\n- List item";
    const ast = parseMarkdown(text);
    const marks = extractFormatMarks(ast);

    // Should have marks for: heading, bold (2), italic (2), list
    expect(marks.length).toBeGreaterThanOrEqual(6);

    const headingMarks = marks.filter((m) => m.type === "heading");
    const boldMarks = marks.filter((m) => m.type === "bold");
    const italicMarks = marks.filter((m) => m.type === "italic");
    const listMarks = marks.filter((m) => m.type === "list");

    expect(headingMarks).toHaveLength(1);
    expect(boldMarks).toHaveLength(2);
    expect(italicMarks).toHaveLength(2);
    expect(listMarks).toHaveLength(1);
  });

  it("should handle nested formatting", () => {
    const text = "**bold *and italic* text**";
    const ast = parseMarkdown(text);
    const marks = extractFormatMarks(ast);

    // Should extract marks for both bold and italic
    const boldMarks = marks.filter((m) => m.type === "bold");
    const italicMarks = marks.filter((m) => m.type === "italic");

    expect(boldMarks).toHaveLength(2);
    expect(italicMarks).toHaveLength(2);
  });
});

describe("extractTextNodes", () => {
  it("should extract text nodes with positions", () => {
    const text = "Hello world";
    const ast = parseMarkdown(text);
    const textNodes = extractTextNodes(ast);

    expect(textNodes).toHaveLength(1);
    expect(textNodes[0].value).toBe("Hello world");
    expect(textNodes[0].position).toBeDefined();
  });

  it("should extract multiple text nodes", () => {
    const text = "Hello **bold** world";
    const ast = parseMarkdown(text);
    const textNodes = extractTextNodes(ast);

    expect(textNodes.length).toBeGreaterThan(1);
    const values = textNodes.map((n) => n.value);
    expect(values).toContain("Hello ");
    expect(values).toContain("bold");
    expect(values).toContain(" world");
  });

  it("should include position information", () => {
    const text = "Test";
    const ast = parseMarkdown(text);
    const textNodes = extractTextNodes(ast);

    expect(textNodes[0].position.start.offset).toBe(0);
    expect(textNodes[0].position.end.offset).toBe(4);
  });
});

describe("isPositionInFormatting", () => {
  it("should detect position inside heading", () => {
    const text = "# Heading";
    const ast = parseMarkdown(text);

    expect(isPositionInFormatting(0, ast)).toBe(true);
    expect(isPositionInFormatting(5, ast)).toBe(true);
  });

  it("should detect position inside bold text", () => {
    const text = "This is **bold** text";
    const ast = parseMarkdown(text);

    expect(isPositionInFormatting(10, ast)).toBe(true); // Inside **bold**
    expect(isPositionInFormatting(0, ast)).toBe(false); // Outside formatting
  });

  it("should detect position inside italic text", () => {
    const text = "This is *italic* text";
    const ast = parseMarkdown(text);

    expect(isPositionInFormatting(10, ast)).toBe(true); // Inside *italic*
    expect(isPositionInFormatting(20, ast)).toBe(false); // Outside formatting
  });

  it("should detect specific format types", () => {
    const text = "# Heading\n\nThis is **bold** text";
    const ast = parseMarkdown(text);

    expect(isPositionInFormatting(0, ast, "heading")).toBe(true);
    expect(isPositionInFormatting(0, ast, "bold")).toBe(false);
    expect(isPositionInFormatting(22, ast, "bold")).toBe(true);
    expect(isPositionInFormatting(22, ast, "heading")).toBe(false);
  });

  it("should handle positions at boundaries", () => {
    const text = "**bold**";
    const ast = parseMarkdown(text);

    expect(isPositionInFormatting(0, ast)).toBe(true);
    expect(isPositionInFormatting(7, ast)).toBe(true);
  });
});
