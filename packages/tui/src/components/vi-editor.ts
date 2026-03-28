import type { TUI } from "../tui.js";
import type { EditorOptions, EditorTheme } from "./editor.js";
import { Editor } from "./editor.js";

type ViMode = "insert" | "normal";

/**
 * ViEditor extends Editor with vi/vim keybinding support.
 *
 * Implements a proper [count][operator][motion] command parser.
 *
 * Supported normal mode:
 *   Motions: h j k l w b W B e E 0 ^ $ gg G f{char} F{char} t{char} T{char}
 *   Operators: d c y (+ motion), also D C S s x X
 *   Text objects: iw aw i" a" i' a' i( a( i[ a[ i{ a{
 *   Other: i a A I o O u U (undo) r{char} ~ p P . (repeat) /<text> (no-op placeholder)
 *   dd cc yy for full-line operations
 *
 * Insert mode: normal typing with Escape to return to normal mode.
 */
export class ViEditor extends Editor {
	private viMode: ViMode = "insert";
	private cmdBuffer: string = "";
	private lastCommand: string = ""; // for . repeat
	private register: string = ""; // unnamed register (yank/delete)

	constructor(tui: TUI, theme: EditorTheme, options: EditorOptions = {}) {
		super(tui, theme, options);
	}

	getViMode(): ViMode {
		return this.viMode;
	}

	override handleInput(data: string): void {
		if (this.viMode === "insert") {
			this.handleInsertMode(data);
		} else {
			this.handleNormalMode(data);
		}
	}

	private handleInsertMode(data: string): void {
		// Escape → switch to normal mode
		if (data === "\x1b") {
			this.viMode = "normal";
			// Move cursor left one if not at start (vim behavior)
			const { col } = this.getCursor();
			if (col > 0) {
				this.moveCursor(0, -1);
			}
			return;
		}
		// Everything else passes through to the parent Editor
		super.handleInput(data);
	}

	private handleNormalMode(data: string): void {
		this.cmdBuffer += data;
		const result = this.parseAndExecute(this.cmdBuffer);
		if (result === "consumed") {
			this.lastCommand = this.cmdBuffer;
			this.cmdBuffer = "";
		} else if (result === "incomplete") {
			// waiting for more input
		} else {
			// unknown/invalid - clear buffer
			this.cmdBuffer = "";
		}
	}

	/**
	 * Parse and execute a command from the buffer.
	 * Returns:
	 *   "consumed"   - command executed, clear buffer
	 *   "incomplete" - need more characters
	 *   "unknown"    - not a valid command, clear buffer
	 */
	private parseAndExecute(buf: string): "consumed" | "incomplete" | "unknown" {
		// Extract optional count prefix
		let i = 0;
		let countStr = "";
		while (i < buf.length && buf[i]! >= "0" && buf[i]! <= "9") {
			// Special case: 0 alone is a motion (go to line start), not a count
			if (countStr === "" && buf[i] === "0") break;
			countStr += buf[i++];
		}
		const count = countStr ? parseInt(countStr, 10) : 1;
		const rest = buf.slice(i);

		if (rest.length === 0) return "incomplete";

		const cmd = rest[0]!;

		// --- Simple motions ---
		if (cmd === "h") {
			this.repeat(count, () => this.moveCursor(0, -1));
			return "consumed";
		}
		if (cmd === "l") {
			this.repeat(count, () => this.moveCursor(0, 1));
			return "consumed";
		}
		if (cmd === "j") {
			this.repeat(count, () => this.moveCursor(1, 0));
			return "consumed";
		}
		if (cmd === "k") {
			this.repeat(count, () => this.moveCursor(-1, 0));
			return "consumed";
		}
		if (cmd === "w") {
			this.repeat(count, () => this.viMoveWordForward(false));
			return "consumed";
		}
		if (cmd === "b") {
			this.repeat(count, () => this.viMoveWordBackward(false));
			return "consumed";
		}
		if (cmd === "W") {
			this.repeat(count, () => this.viMoveWordForward(true));
			return "consumed";
		}
		if (cmd === "B") {
			this.repeat(count, () => this.viMoveWordBackward(true));
			return "consumed";
		}
		if (cmd === "e") {
			this.repeat(count, () => this.moveToWordEnd());
			return "consumed";
		}
		if (cmd === "0") {
			this.moveToLineStart();
			return "consumed";
		}
		if (cmd === "^") {
			this.moveToFirstNonBlank();
			return "consumed";
		}
		if (cmd === "$") {
			this.moveToLineEnd();
			return "consumed";
		}

		// gg / G
		if (cmd === "g") {
			if (rest.length < 2) return "incomplete";
			if (rest[1] === "g") {
				this.moveToFileStart();
				return "consumed";
			}
			return "unknown";
		}
		if (cmd === "G") {
			this.moveToFileEnd();
			return "consumed";
		}

		// f/F/t/T - character find
		if (cmd === "f" || cmd === "F" || cmd === "t" || cmd === "T") {
			if (rest.length < 2) return "incomplete";
			const ch = rest[1]!;
			this.repeat(count, () => this.findChar(ch, cmd === "f" || cmd === "t", cmd === "t" || cmd === "T"));
			return "consumed";
		}

		// --- Mode switches ---
		if (cmd === "i") {
			this.viMode = "insert";
			return "consumed";
		}
		if (cmd === "a") {
			this.viMode = "insert";
			this.moveCursor(0, 1);
			return "consumed";
		}
		if (cmd === "A") {
			this.viMode = "insert";
			this.moveToLineEnd();
			return "consumed";
		}
		if (cmd === "I") {
			this.viMode = "insert";
			this.moveToFirstNonBlank();
			return "consumed";
		}
		if (cmd === "o") {
			this.moveToLineEnd();
			this.addNewLine();
			this.viMode = "insert";
			return "consumed";
		}
		if (cmd === "O") {
			this.moveToLineStart();
			this.addNewLine();
			this.moveCursor(-1, 0);
			this.viMode = "insert";
			return "consumed";
		}

		// --- Undo ---
		if (cmd === "u") {
			this.undo();
			return "consumed";
		}

		// --- Single-char delete ---
		if (cmd === "x") {
			this.repeat(count, () => {
				const line = this.state.lines[this.state.cursorLine] || "";
				if (this.state.cursorCol < line.length) {
					this.pushUndoSnapshot();
					this.handleForwardDelete();
				}
			});
			return "consumed";
		}
		if (cmd === "X") {
			this.repeat(count, () => {
				if (this.state.cursorCol > 0) {
					this.pushUndoSnapshot();
					this.handleBackspace();
				}
			});
			return "consumed";
		}

		// --- Replace char ---
		if (cmd === "r") {
			if (rest.length < 2) return "incomplete";
			const ch = rest[1]!;
			this.pushUndoSnapshot();
			this.handleForwardDelete();
			this.insertCharacter(ch);
			this.moveCursor(0, -1);
			return "consumed";
		}

		// --- Tilde (toggle case) ---
		if (cmd === "~") {
			this.toggleCase();
			return "consumed";
		}

		// --- Paste ---
		if (cmd === "p") {
			if (this.register) {
				this.pushUndoSnapshot();
				this.moveCursor(0, 1);
				this.insertTextAtCursorInternal(this.register);
			}
			return "consumed";
		}
		if (cmd === "P") {
			if (this.register) {
				this.pushUndoSnapshot();
				this.insertTextAtCursorInternal(this.register);
			}
			return "consumed";
		}

		// --- Operators: d, c, y ---
		if (cmd === "d" || cmd === "c" || cmd === "y") {
			if (rest.length < 2) return "incomplete";
			const op = cmd;
			const motionStr = rest.slice(1);
			return this.executeOperatorMotion(op, motionStr, count);
		}

		// --- D, C, S, s ---
		if (cmd === "D") {
			this.pushUndoSnapshot();
			this.deleteToEndOfLine();
			return "consumed";
		}
		if (cmd === "C") {
			this.pushUndoSnapshot();
			this.deleteToEndOfLine();
			this.viMode = "insert";
			return "consumed";
		}
		if (cmd === "S") {
			// Delete entire line content
			this.pushUndoSnapshot();
			this.moveToLineStart();
			this.deleteToEndOfLine();
			this.viMode = "insert";
			return "consumed";
		}
		if (cmd === "s") {
			this.pushUndoSnapshot();
			this.handleForwardDelete();
			this.viMode = "insert";
			return "consumed";
		}

		// . repeat
		if (cmd === ".") {
			if (this.lastCommand) {
				const saved = this.cmdBuffer;
				this.cmdBuffer = "";
				this.parseAndExecute(this.lastCommand);
				this.cmdBuffer = "";
			}
			return "consumed";
		}

		return "unknown";
	}

	private executeOperatorMotion(
		op: "d" | "c" | "y",
		motionStr: string,
		count: number,
	): "consumed" | "incomplete" | "unknown" {
		if (motionStr.length === 0) return "incomplete";

		const motion = motionStr[0]!;
		const { line: startLine, col: startCol } = this.getCursor();

		// dd / cc / yy - full line operations
		if (motion === op) {
			this.pushUndoSnapshot();
			const line = this.state.lines[this.state.cursorLine] || "";
			this.register = line;
			this.moveToLineStart();
			this.deleteToEndOfLine();
			if (op === "c") this.viMode = "insert";
			return "consumed";
		}

		// Text objects: iw, aw, i"...
		if (motion === "i" || motion === "a") {
			if (motionStr.length < 2) return "incomplete";
			const obj = motionStr[1]!;
			return this.executeTextObject(op, motion === "i", obj);
		}

		// Motion-based: move, then operate on range
		let moved = true;
		if (motion === "h") {
			this.repeat(count, () => this.moveCursor(0, -1));
		} else if (motion === "l") {
			this.repeat(count, () => this.moveCursor(0, 1));
		} else if (motion === "j") {
			this.repeat(count, () => this.moveCursor(1, 0));
		} else if (motion === "k") {
			this.repeat(count, () => this.moveCursor(-1, 0));
		} else if (motion === "w") {
			this.repeat(count, () => this.viMoveWordForward(false));
		} else if (motion === "b") {
			this.repeat(count, () => this.viMoveWordBackward(false));
		} else if (motion === "e") {
			this.repeat(count, () => this.moveToWordEnd());
		} else if (motion === "W") {
			this.repeat(count, () => this.viMoveWordForward(true));
		} else if (motion === "B") {
			this.repeat(count, () => this.viMoveWordBackward(true));
		} else if (motion === "0") {
			this.moveToLineStart();
		} else if (motion === "^") {
			this.moveToFirstNonBlank();
		} else if (motion === "$") {
			this.moveToLineEnd();
		} else if (motion === "f" || motion === "F" || motion === "t" || motion === "T") {
			if (motionStr.length < 2) return "incomplete";
			const ch = motionStr[1]!;
			this.findChar(ch, motion === "f" || motion === "t", motion === "t" || motion === "T");
			return this.applyOperatorRange(op, startLine, startCol);
		} else {
			moved = false;
		}

		if (!moved) return "unknown";

		return this.applyOperatorRange(op, startLine, startCol);
	}

	private applyOperatorRange(op: "d" | "c" | "y", startLine: number, startCol: number): "consumed" {
		const { line: endLine, col: endCol } = this.getCursor();

		// Determine direction
		let fromLine = startLine,
			fromCol = startCol;
		let toLine = endLine,
			toCol = endCol;

		if (endLine < startLine || (endLine === startLine && endCol < startCol)) {
			fromLine = endLine;
			fromCol = endCol;
			toLine = startLine;
			toCol = startCol;
		}

		// Move cursor to start of range
		this.state.cursorLine = fromLine;
		this.setCursorCol(fromCol);

		this.pushUndoSnapshot();

		// Extract and delete the range
		if (fromLine === toLine) {
			const line = this.state.lines[fromLine] || "";
			this.register = line.slice(fromCol, toCol);
			this.state.lines[fromLine] = line.slice(0, fromCol) + line.slice(toCol);
			this.setCursorCol(fromCol);
		} else {
			// Multi-line: collect text, merge lines
			const firstLine = this.state.lines[fromLine] || "";
			const lastLine = this.state.lines[toLine] || "";
			const deleted: string[] = [];
			deleted.push(firstLine.slice(fromCol));
			for (let l = fromLine + 1; l < toLine; l++) {
				deleted.push(this.state.lines[l] || "");
			}
			deleted.push(lastLine.slice(0, toCol));
			this.register = deleted.join("\n");

			this.state.lines[fromLine] = firstLine.slice(0, fromCol) + lastLine.slice(toCol);
			this.state.lines.splice(fromLine + 1, toLine - fromLine);
			this.setCursorCol(fromCol);
			this.state.cursorLine = fromLine;
		}

		if (op === "c") {
			this.viMode = "insert";
		}

		if (this.onChange) this.onChange(this.getText());
		this.tui.requestRender();
		return "consumed";
	}

	private executeTextObject(op: "d" | "c" | "y", inner: boolean, obj: string): "consumed" | "incomplete" | "unknown" {
		const { line, col } = this.getCursor();
		const currentLine = this.state.lines[line] || "";

		let from = col,
			to = col;

		if (obj === "w" || obj === "W") {
			// word object - find start: go back to start of word
			let l = col;
			while (l > 0 && !this.isWordBoundary(currentLine[l - 1]!)) l--;
			from = l;
			// Find end: go forward to end of word
			let r = col;
			while (r < currentLine.length && !this.isWordBoundary(currentLine[r]!)) r++;
			if (!inner) {
				// a includes trailing space
				while (r < currentLine.length && currentLine[r] === " ") r++;
			}
			to = r;
		} else if (obj === '"' || obj === "'" || obj === "`") {
			// quoted string
			const q = obj;
			let l = col - 1;
			while (l >= 0 && currentLine[l] !== q) l--;
			let r = col;
			while (r < currentLine.length && currentLine[r] !== q) r++;
			if (l < 0 || r >= currentLine.length) return "consumed"; // no match
			from = inner ? l + 1 : l;
			to = inner ? r : r + 1;
		} else if (obj === "(" || obj === ")" || obj === "b") {
			from = this.findMatchingPair(currentLine, col, "(", ")");
			to = this.findMatchingPairClose(currentLine, col, "(", ")");
			if (inner) {
				from++;
			} else {
				to++;
			}
		} else if (obj === "[" || obj === "]") {
			from = this.findMatchingPair(currentLine, col, "[", "]");
			to = this.findMatchingPairClose(currentLine, col, "[", "]");
			if (inner) {
				from++;
			} else {
				to++;
			}
		} else if (obj === "{" || obj === "}" || obj === "B") {
			from = this.findMatchingPair(currentLine, col, "{", "}");
			to = this.findMatchingPairClose(currentLine, col, "{", "}");
			if (inner) {
				from++;
			} else {
				to++;
			}
		} else {
			return "unknown";
		}

		// Move to from, then operate on [from, to)
		this.state.cursorLine = line;
		this.setCursorCol(from);
		return this.applyOperatorRange(op, line, from);
	}

	// --- Helper movement methods ---

	private moveToFileStart(): void {
		this.state.cursorLine = 0;
		this.setCursorCol(0);
	}

	private moveToFileEnd(): void {
		this.state.cursorLine = this.state.lines.length - 1;
		const line = this.state.lines[this.state.cursorLine] || "";
		this.setCursorCol(line.length);
	}

	private moveToFirstNonBlank(): void {
		const line = this.state.lines[this.state.cursorLine] || "";
		let col = 0;
		while (col < line.length && (line[col] === " " || line[col] === "\t")) col++;
		this.setCursorCol(col);
	}

	private moveToWordEnd(): void {
		const line = this.state.lines[this.state.cursorLine] || "";
		let col = this.state.cursorCol;
		if (col < line.length - 1) col++; // step off current char
		while (col < line.length - 1 && this.isWordBoundary(line[col]!)) col++;
		while (col < line.length - 1 && !this.isWordBoundary(line[col + 1]!)) col++;
		this.setCursorCol(col);
	}

	private findChar(ch: string, forward: boolean, till: boolean): void {
		const line = this.state.lines[this.state.cursorLine] || "";
		if (forward) {
			const idx = line.indexOf(ch, this.state.cursorCol + 1);
			if (idx !== -1) this.setCursorCol(till ? idx - 1 : idx);
		} else {
			const idx = line.lastIndexOf(ch, this.state.cursorCol - 1);
			if (idx !== -1) this.setCursorCol(till ? idx + 1 : idx);
		}
	}

	private toggleCase(): void {
		const line = this.state.lines[this.state.cursorLine] || "";
		if (this.state.cursorCol >= line.length) return;
		this.pushUndoSnapshot();
		const ch = line[this.state.cursorCol]!;
		const toggled = ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
		this.state.lines[this.state.cursorLine] =
			line.slice(0, this.state.cursorCol) + toggled + line.slice(this.state.cursorCol + 1);
		this.setCursorCol(Math.min(this.state.cursorCol + 1, line.length - 1));
		if (this.onChange) this.onChange(this.getText());
	}

	/**
	 * Vim-style word forward: skip current word, then skip whitespace to land at
	 * the start of the next word. `bigWord` = treat only whitespace as boundary (W).
	 */
	private viMoveWordForward(bigWord: boolean): void {
		const line = this.state.lines[this.state.cursorLine] || "";
		let col = this.state.cursorCol;

		const isWs = (ch: string) => ch === " " || ch === "\t";
		const isWordChar = (ch: string) => bigWord ? !isWs(ch) : /\w/.test(ch);

		if (col >= line.length) {
			// Move to next line if available
			if (this.state.cursorLine < this.state.lines.length - 1) {
				this.state.cursorLine++;
				this.setCursorCol(0);
			}
			return;
		}

		// Skip current run (word chars or punctuation)
		if (isWordChar(line[col]!)) {
			while (col < line.length && isWordChar(line[col]!)) col++;
		} else if (!isWs(line[col]!)) {
			// punctuation run
			while (col < line.length && !isWordChar(line[col]!) && !isWs(line[col]!)) col++;
		}

		// Skip whitespace
		while (col < line.length && isWs(line[col]!)) col++;

		this.setCursorCol(col);
	}

	/**
	 * Vim-style word backward: land at start of previous word.
	 * `bigWord` = treat only whitespace as boundary (B).
	 */
	private viMoveWordBackward(bigWord: boolean): void {
		const line = this.state.lines[this.state.cursorLine] || "";
		let col = this.state.cursorCol;

		const isWs = (ch: string) => ch === " " || ch === "\t";
		const isWordChar = (ch: string) => bigWord ? !isWs(ch) : /\w/.test(ch);

		if (col === 0) {
			if (this.state.cursorLine > 0) {
				this.state.cursorLine--;
				const prevLine = this.state.lines[this.state.cursorLine] || "";
				this.setCursorCol(prevLine.length);
			}
			return;
		}

		// Step back one
		col--;

		// Skip whitespace
		while (col > 0 && isWs(line[col]!)) col--;

		// Skip current run backward
		if (isWordChar(line[col]!)) {
			while (col > 0 && isWordChar(line[col - 1]!)) col--;
		} else {
			// punctuation run
			while (col > 0 && !isWordChar(line[col - 1]!) && !isWs(line[col - 1]!)) col--;
		}

		this.setCursorCol(col);
	}

	private isWordBoundary(ch: string): boolean {
		return ch === " " || ch === "\t" || ch === "\n";
	}

	private findMatchingPair(line: string, col: number, open: string, _close: string): number {
		for (let i = col; i >= 0; i--) {
			if (line[i] === open) return i;
		}
		return col;
	}

	private findMatchingPairClose(line: string, col: number, _open: string, close: string): number {
		for (let i = col; i < line.length; i++) {
			if (line[i] === close) return i;
		}
		return col;
	}

	private repeat(n: number, fn: () => void): void {
		for (let i = 0; i < n; i++) fn();
	}
}
