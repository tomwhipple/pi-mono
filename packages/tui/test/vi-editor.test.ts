import assert from "node:assert";
import { describe, it } from "node:test";
import { ViEditor } from "../src/components/vi-editor.js";
import { TUI } from "../src/tui.js";
import { defaultEditorTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

function createTestTUI(cols = 80, rows = 24): TUI {
	return new TUI(new VirtualTerminal(cols, rows));
}

function createViEditor(): ViEditor {
	return new ViEditor(createTestTUI(), defaultEditorTheme);
}

/** Type a string character by character (insert mode) */
function typeText(editor: ViEditor, text: string): void {
	for (const ch of text) {
		editor.handleInput(ch);
	}
}

describe("ViEditor", () => {
	describe("Mode switching", () => {
		it("starts in insert mode", () => {
			const editor = createViEditor();
			assert.strictEqual(editor.getViMode(), "insert");
		});

		it("Escape switches from insert to normal mode", () => {
			const editor = createViEditor();
			assert.strictEqual(editor.getViMode(), "insert");
			editor.handleInput("\x1b");
			assert.strictEqual(editor.getViMode(), "normal");
		});

		it("i switches from normal to insert mode", () => {
			const editor = createViEditor();
			editor.handleInput("\x1b"); // → normal
			editor.handleInput("i");    // → insert
			assert.strictEqual(editor.getViMode(), "insert");
		});

		it("a switches to insert mode and moves cursor right one", () => {
			const editor = createViEditor();
			typeText(editor, "hello");
			editor.handleInput("\x1b"); // → normal (cursor moves left one to 'o')
			editor.handleInput("0");    // go to start → cursor at 0
			editor.handleInput("a");    // → insert, cursor should now be at col 1
			assert.strictEqual(editor.getViMode(), "insert");
			assert.strictEqual(editor.getCursor().col, 1);
		});

		it("A switches to insert mode at end of line", () => {
			const editor = createViEditor();
			typeText(editor, "hello");
			editor.handleInput("\x1b"); // → normal
			editor.handleInput("0");    // go to start
			editor.handleInput("A");    // → insert at end
			assert.strictEqual(editor.getViMode(), "insert");
			assert.strictEqual(editor.getCursor().col, 5);
		});

		it("I switches to insert mode at start of line", () => {
			const editor = createViEditor();
			typeText(editor, "  hello");
			editor.handleInput("\x1b"); // → normal
			editor.handleInput("$");    // go to end
			editor.handleInput("I");    // → insert at first non-blank
			assert.strictEqual(editor.getViMode(), "insert");
			assert.strictEqual(editor.getCursor().col, 2);
		});

		it("typing in insert mode works normally after mode switch", () => {
			const editor = createViEditor();
			typeText(editor, "hello");
			editor.handleInput("\x1b"); // → normal, cursor at col 4
			editor.handleInput("A");    // → insert at end of line (col 5)
			typeText(editor, " world");
			assert.strictEqual(editor.getText(), "hello world");
		});
	});

	describe("Normal mode - basic motions", () => {
		it("h moves cursor left", () => {
			const editor = createViEditor();
			typeText(editor, "hello");
			editor.handleInput("\x1b"); // → normal (cursor at col 4)
			const colBefore = editor.getCursor().col;
			editor.handleInput("h");
			assert.strictEqual(editor.getCursor().col, colBefore - 1);
		});

		it("l moves cursor right", () => {
			const editor = createViEditor();
			typeText(editor, "hello");
			editor.handleInput("\x1b"); // → normal
			editor.handleInput("0");    // to start
			const colBefore = editor.getCursor().col;
			editor.handleInput("l");
			assert.strictEqual(editor.getCursor().col, colBefore + 1);
		});

		it("0 moves to start of line", () => {
			const editor = createViEditor();
			typeText(editor, "hello world");
			editor.handleInput("\x1b");
			editor.handleInput("0");
			assert.strictEqual(editor.getCursor().col, 0);
		});

		it("$ moves to end of line", () => {
			const editor = createViEditor();
			typeText(editor, "hello");
			editor.handleInput("\x1b");
			editor.handleInput("0"); // go to start first
			editor.handleInput("$");
			assert.strictEqual(editor.getCursor().col, 5);
		});

		it("w moves forward by word", () => {
			const editor = createViEditor();
			typeText(editor, "hello world");
			editor.handleInput("\x1b");
			editor.handleInput("0");
			editor.handleInput("w");
			// should land at start of "world" (col 6)
			assert.strictEqual(editor.getCursor().col, 6);
		});

		it("b moves backward by word", () => {
			const editor = createViEditor();
			typeText(editor, "hello world");
			editor.handleInput("\x1b");
			editor.handleInput("0");
			editor.handleInput("w"); // → col 6 (start of "world")
			editor.handleInput("l"); // → col 7 (inside "world")
			editor.handleInput("b"); // → col 6 (back to start of "world")
			assert.strictEqual(editor.getCursor().col, 6);
		});

		it("count prefix works with l (3l moves 3 right)", () => {
			const editor = createViEditor();
			typeText(editor, "hello world");
			editor.handleInput("\x1b");
			editor.handleInput("0");
			editor.handleInput("3");
			editor.handleInput("l");
			assert.strictEqual(editor.getCursor().col, 3);
		});

		it("count prefix works with w (2w skips two words)", () => {
			const editor = createViEditor();
			typeText(editor, "one two three");
			editor.handleInput("\x1b");
			editor.handleInput("0");
			editor.handleInput("2");
			editor.handleInput("w");
			// after 2w from col 0: "one " (4 chars) → "two " (4 chars) → col 8 = start of "three"
			assert.strictEqual(editor.getCursor().col, 8);
		});
	});

	describe("Normal mode - editing", () => {
		it("x deletes character under cursor", () => {
			const editor = createViEditor();
			typeText(editor, "hello");
			editor.handleInput("\x1b");
			editor.handleInput("0");
			editor.handleInput("x"); // delete 'h'
			assert.strictEqual(editor.getText(), "ello");
		});

		it("X deletes character before cursor", () => {
			const editor = createViEditor();
			typeText(editor, "hello");
			editor.handleInput("\x1b");
			editor.handleInput("0");
			editor.handleInput("l"); // col 1
			editor.handleInput("X"); // delete 'h'
			assert.strictEqual(editor.getText(), "ello");
		});

		it("D deletes to end of line", () => {
			const editor = createViEditor();
			typeText(editor, "hello world");
			editor.handleInput("\x1b");
			editor.handleInput("0");
			editor.handleInput("w"); // jump to "world" (col 6)
			editor.handleInput("D");
			assert.strictEqual(editor.getText(), "hello ");
		});

		it("dd deletes the entire line content", () => {
			const editor = createViEditor();
			typeText(editor, "hello world");
			editor.handleInput("\x1b");
			editor.handleInput("d");
			editor.handleInput("d");
			assert.strictEqual(editor.getText(), "");
		});

		it("cw deletes word and enters insert mode", () => {
			const editor = createViEditor();
			typeText(editor, "hello world");
			editor.handleInput("\x1b");
			editor.handleInput("0");
			editor.handleInput("c");
			editor.handleInput("w");
			assert.strictEqual(editor.getViMode(), "insert");
			// "hello" should be deleted (or at least partial depending on word boundary)
			assert.ok(!editor.getText().startsWith("hello"));
		});

		it("C deletes to end of line and enters insert mode", () => {
			const editor = createViEditor();
			typeText(editor, "hello world");
			editor.handleInput("\x1b");
			editor.handleInput("0");
			editor.handleInput("w"); // col 6
			editor.handleInput("C");
			assert.strictEqual(editor.getViMode(), "insert");
			assert.strictEqual(editor.getText(), "hello ");
		});

		it("s deletes char and enters insert mode", () => {
			const editor = createViEditor();
			typeText(editor, "hello");
			editor.handleInput("\x1b");
			editor.handleInput("0");
			editor.handleInput("s");
			assert.strictEqual(editor.getViMode(), "insert");
			assert.strictEqual(editor.getText(), "ello");
		});

		it("S clears entire line and enters insert mode", () => {
			const editor = createViEditor();
			typeText(editor, "hello world");
			editor.handleInput("\x1b");
			editor.handleInput("S");
			assert.strictEqual(editor.getViMode(), "insert");
			assert.strictEqual(editor.getText(), "");
		});

		it("r replaces character under cursor", () => {
			const editor = createViEditor();
			typeText(editor, "hello");
			editor.handleInput("\x1b");
			editor.handleInput("0");
			editor.handleInput("r");
			editor.handleInput("H");
			assert.strictEqual(editor.getText(), "Hello");
			assert.strictEqual(editor.getViMode(), "normal");
		});

		it("~ toggles case of character under cursor", () => {
			const editor = createViEditor();
			typeText(editor, "hello");
			editor.handleInput("\x1b");
			editor.handleInput("0");
			editor.handleInput("~");
			assert.strictEqual(editor.getText(), "Hello");
		});
	});

	describe("Normal mode - undo", () => {
		it("u undoes last change", () => {
			const editor = createViEditor();
			typeText(editor, "hello");
			editor.handleInput("\x1b");
			editor.handleInput("0");
			editor.handleInput("x"); // delete 'h'
			assert.strictEqual(editor.getText(), "ello");
			editor.handleInput("u"); // undo
			assert.strictEqual(editor.getText(), "hello");
		});
	});

	describe("Normal mode - o/O", () => {
		it("o opens new line below and enters insert mode", () => {
			const editor = createViEditor();
			typeText(editor, "hello");
			editor.handleInput("\x1b");
			editor.handleInput("o");
			assert.strictEqual(editor.getViMode(), "insert");
			assert.strictEqual(editor.getCursor().line, 1);
		});

		it("O opens new line above and enters insert mode", () => {
			const editor = createViEditor();
			typeText(editor, "hello");
			editor.handleInput("\x1b");
			editor.handleInput("O");
			assert.strictEqual(editor.getViMode(), "insert");
			assert.strictEqual(editor.getCursor().line, 0);
		});
	});

	describe("Normal mode - dw (delete word)", () => {
		it("dw deletes from cursor to start of next word", () => {
			const editor = createViEditor();
			typeText(editor, "hello world");
			editor.handleInput("\x1b");
			editor.handleInput("0");
			editor.handleInput("d");
			editor.handleInput("w");
			// dw from col 0: motion lands at col 6 (start of "world"),
			// so deletes "hello " (cols 0–5), leaving "world"
			assert.strictEqual(editor.getText(), "world");
		});
	});

	describe("Insert mode passthrough", () => {
		it("arrow keys work in insert mode", () => {
			const editor = createViEditor();
			typeText(editor, "hello");
			editor.handleInput("\x1b[D"); // left arrow (in insert mode — wait, we're in normal after esc)
			// Re-enter insert mode first
			editor.handleInput("\x1b"); // normal
			editor.handleInput("i");    // insert
			const colBefore = editor.getCursor().col;
			editor.handleInput("\x1b[D"); // left arrow
			assert.strictEqual(editor.getCursor().col, colBefore - 1);
		});

		it("backspace works in insert mode", () => {
			const editor = createViEditor();
			typeText(editor, "hello");
			assert.strictEqual(editor.getText(), "hello");
			editor.handleInput("\x7f"); // backspace
			assert.strictEqual(editor.getText(), "hell");
		});

		it("Escape in insert mode does not leave stray characters", () => {
			const editor = createViEditor();
			typeText(editor, "hello");
			editor.handleInput("\x1b");
			assert.strictEqual(editor.getViMode(), "normal");
			// Text should be unchanged
			assert.strictEqual(editor.getText(), "hello");
		});
	});
});
