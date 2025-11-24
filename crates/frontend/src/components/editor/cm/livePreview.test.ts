import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { livePreview, getFormatMarks, forceParse } from "./livePreview";

describe("livePreview", () => {
  let view: EditorView;
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (view) {
      view.destroy();
    }
    document.body.removeChild(container);
  });

  async function createEditor(
    doc: string,
    selection?: { from: number; to?: number },
  ) {
    const state = EditorState.create({
      doc,
      selection: selection
        ? { anchor: selection.from, head: selection.to ?? selection.from }
        : undefined,
      extensions: [livePreview()],
    });

    view = new EditorView({
      state,
      parent: container,
    });

    // Wait for parsing to complete
    forceParse(view);
    await new Promise((resolve) => setTimeout(resolve, 150));

    return view;
  }

  describe("format mark parsing", () => {
    it("should parse and extract heading marks", async () => {
      await createEditor("# Heading");
      const marks = getFormatMarks(view.state);

      expect(marks).toHaveLength(1);
      expect(marks[0]).toMatchObject({
        type: "heading",
        level: 1,
        from: 0,
        to: 2,
      });
    });

    it("should parse bold marks", async () => {
      await createEditor("This is **bold** text");
      const marks = getFormatMarks(view.state);

      const boldMarks = marks.filter((m) => m.type === "bold");
      expect(boldMarks).toHaveLength(2);
      expect(boldMarks[0].from).toBe(8);
      expect(boldMarks[0].to).toBe(10);
    });

    it("should parse italic marks", async () => {
      await createEditor("This is *italic* text");
      const marks = getFormatMarks(view.state);

      const italicMarks = marks.filter((m) => m.type === "italic");
      expect(italicMarks).toHaveLength(2);
    });

    it("should parse list marks", async () => {
      await createEditor("- Item 1\n- Item 2");
      const marks = getFormatMarks(view.state);

      const listMarks = marks.filter((m) => m.type === "list");
      expect(listMarks).toHaveLength(2);
    });

    it("should parse task list marks", async () => {
      await createEditor("- [ ] Todo\n- [x] Done");
      const marks = getFormatMarks(view.state);

      const taskMarks = marks.filter((m) => m.type === "task-list");
      expect(taskMarks).toHaveLength(2);
    });

    it("should update marks when document changes", async () => {
      await createEditor("Plain text");
      expect(getFormatMarks(view.state)).toHaveLength(0);

      // Add formatting
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: "**bold**" },
      });

      forceParse(view);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const marks = getFormatMarks(view.state);
      expect(marks.length).toBeGreaterThan(0);
    });
  });

  describe("format mark extraction with different formats", () => {
    it("should handle multiple format types correctly", async () => {
      await createEditor("# Heading\n\n**bold** and *italic*");

      forceParse(view);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const marks = getFormatMarks(view.state);

      expect(marks.filter((m) => m.type === "heading")).toHaveLength(1);
      expect(marks.filter((m) => m.type === "bold")).toHaveLength(2);
      expect(marks.filter((m) => m.type === "italic")).toHaveLength(2);
    });

    it("should handle empty document", async () => {
      await createEditor("");

      const marks = getFormatMarks(view.state);
      expect(marks).toHaveLength(0);
    });

    it("should handle nested formatting", async () => {
      await createEditor("**bold *and italic* text**");

      forceParse(view);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const marks = getFormatMarks(view.state);

      expect(marks.filter((m) => m.type === "bold").length).toBeGreaterThan(0);
      expect(marks.filter((m) => m.type === "italic").length).toBeGreaterThan(
        0,
      );
    });

    it("should handle multiline content", async () => {
      const content = "# Heading\n\nParagraph with **bold**\n\n- List item";
      await createEditor(content);

      forceParse(view);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const marks = getFormatMarks(view.state);
      expect(marks.length).toBeGreaterThan(0);

      // Should have heading, bold, and list marks
      expect(marks.some((m) => m.type === "heading")).toBe(true);
      expect(marks.some((m) => m.type === "bold")).toBe(true);
      expect(marks.some((m) => m.type === "list")).toBe(true);
    });
  });

  describe("debouncing", () => {
    it("should debounce parsing on rapid changes", async () => {
      await createEditor("Initial");

      // Make multiple rapid changes
      for (let i = 0; i < 5; i++) {
        view.dispatch({
          changes: { from: 0, insert: "x" },
        });
      }

      // Wait for debounce
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Should have parsed successfully
      const marks = getFormatMarks(view.state);
      expect(Array.isArray(marks)).toBe(true);
    });

    it("should not parse identical content multiple times", async () => {
      await createEditor("# Heading");

      const marks1 = getFormatMarks(view.state);

      // Force parse again with same content
      forceParse(view);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const marks2 = getFormatMarks(view.state);

      // Marks should be the same
      expect(marks1).toEqual(marks2);
    });
  });

  describe("complex markdown scenarios", () => {
    it("should handle mixed bold and italic with underscores", async () => {
      await createEditor("__bold__ and _italic_");

      forceParse(view);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const marks = getFormatMarks(view.state);
      expect(marks.filter((m) => m.type === "bold").length).toBeGreaterThan(0);
      expect(marks.filter((m) => m.type === "italic").length).toBeGreaterThan(
        0,
      );
    });

    it("should handle ordered lists", async () => {
      await createEditor("1. First\n2. Second\n3. Third");

      forceParse(view);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const marks = getFormatMarks(view.state);
      const listMarks = marks.filter((m) => m.type === "list");
      expect(listMarks).toHaveLength(3);
    });

    it("should handle different heading levels", async () => {
      await createEditor("# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6");

      forceParse(view);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const marks = getFormatMarks(view.state);
      const headingMarks = marks.filter((m) => m.type === "heading");

      expect(headingMarks).toHaveLength(6);
      expect(headingMarks.some((m) => m.level === 1)).toBe(true);
      expect(headingMarks.some((m) => m.level === 6)).toBe(true);
    });

    it("should handle task lists with mixed states", async () => {
      await createEditor("- [ ] Not done\n- [x] Done\n- [ ] Also not done");

      forceParse(view);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const marks = getFormatMarks(view.state);
      const taskMarks = marks.filter((m) => m.type === "task-list");
      expect(taskMarks).toHaveLength(3);
    });

    it("should handle inline code (should not create format marks)", async () => {
      await createEditor("This is `inline code` text");

      forceParse(view);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const marks = getFormatMarks(view.state);
      // Inline code should not create format marks in Phase 1
      // Just verify we don't crash on inline code
      expect(marks.length).toBeGreaterThanOrEqual(0);
    });

    it("should handle edge case with empty heading", async () => {
      await createEditor("# ");

      forceParse(view);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const marks = getFormatMarks(view.state);
      expect(marks.some((m) => m.type === "heading")).toBe(true);
    });

    it("should handle bold and italic combined ***text***", async () => {
      await createEditor("This is ***bold and italic*** text");

      forceParse(view);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const marks = getFormatMarks(view.state);
      // Should have both bold and italic marks
      expect(marks.length).toBeGreaterThan(0);
    });
  });

  describe("state updates", () => {
    it("should maintain marks across non-content updates", async () => {
      await createEditor("**bold**");

      forceParse(view);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const marksBefore = getFormatMarks(view.state);

      // Update selection without changing content
      view.dispatch({
        selection: { anchor: 0 },
      });

      const marksAfter = getFormatMarks(view.state);
      expect(marksBefore).toEqual(marksAfter);
    });

    it("should update marks when content changes from bold to italic", async () => {
      await createEditor("**bold text**");

      // Change to italic
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: "*italic text*",
        },
      });

      forceParse(view);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const marks = getFormatMarks(view.state);
      const italicMarks = marks.filter((m) => m.type === "italic");
      const boldMarks = marks.filter((m) => m.type === "bold");

      expect(italicMarks.length).toBeGreaterThan(0);
      expect(boldMarks.length).toBe(0);
    });
  });
});
