// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getCaretBoundaryOffsets,
  getLineDirection,
  getTransform,
  isRTL,
  isWritableElement,
  textWysiwyg,
} from './textWysiwyg';
import type { TextWysiwyg, TextWysiwygOptions } from './textWysiwyg';
import { NOTE_MAX_CHARS, makeNote } from '../sim/annotations';
import type { Note } from '../sim/annotations';
import { NOTE_SIZES, TAB, layoutNote } from './annotationLayout';

/**
 * The ported Excalidraw editor, driven with real DOM events on the textarea
 * it creates. Pinned here is the contract the port exists to reproduce:
 * which keys end the edit and which insert, that composition is never
 * interrupted, that the blur submit is disarmed by a press on the editing
 * chrome and re-armed by the release, that a press on the canvas submits
 * on the next frame, and that submit runs exactly once however the edit
 * ends.
 */

let host: HTMLDivElement;
let surface: HTMLDivElement;
let chrome: HTMLDivElement;
let button: HTMLButtonElement;

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  surface = document.createElement('div');
  surface.className = 'cv-surface';
  chrome = document.createElement('div');
  chrome.dataset.chrome = 'format';
  button = document.createElement('button');
  chrome.appendChild(button);
  document.body.append(host, surface, chrome);
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

interface Harness {
  editor: TextWysiwyg;
  el: HTMLTextAreaElement;
  onChange: ReturnType<typeof vi.fn>;
  onSubmit: ReturnType<typeof vi.fn>;
  note: Note;
  setNote: (n: Note | null) => void;
}

function open(
  text = 'hello world',
  opts: Partial<TextWysiwygOptions> & { zoom?: number; note?: Note } = {},
): Harness {
  // Fixed width by default: the wrap contract is the one with more to
  // pin. Auto-sized notes get their own cases.
  let note: Note | null = opts.note ?? {
    ...makeNote(40, 60, text),
    width: 220,
    autoResize: undefined,
  };
  const onChange = vi.fn();
  const onSubmit = vi.fn();
  const zoom = opts.zoom ?? 1;
  const editor = textWysiwyg({
    getNote: () => note,
    initialText: text,
    getViewportCoords: (x, y) => [x * zoom + 10, y * zoom + 20],
    getZoom: () => zoom,
    container: host,
    surface,
    chromeSelector: '[data-chrome="format"], [data-chrome="zoom"]',
    onChange,
    onSubmit,
    ...opts,
  });
  // The deferred focus (a setTimeout, so the pointerdown that opened the
  // editor cannot blur it on its pointerup) and the deferred window
  // pointerdown listener (a rAF, for the same reason).
  vi.runAllTimers();
  return {
    editor,
    el: editor.editable,
    onChange,
    onSubmit,
    note: note!,
    setNote: (n) => {
      note = n;
    },
  };
}

function type(el: HTMLTextAreaElement, value: string, caret = value.length): void {
  el.value = value;
  el.setSelectionRange(caret, caret);
  el.dispatchEvent(new Event('input'));
}

function key(
  el: EventTarget,
  k: string,
  init: KeyboardEventInit & { keyCode?: number } = {},
): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', {
    key: k,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  if (init.keyCode !== undefined)
    Object.defineProperty(ev, 'keyCode', { value: init.keyCode });
  el.dispatchEvent(ev);
  return ev;
}

function pointer(
  type: 'pointerdown' | 'pointerup',
  target: EventTarget,
  button = 0,
): void {
  // jsdom has no PointerEvent; a MouseEvent carries what the handlers read.
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, button });
  target.dispatchEvent(ev);
}

describe('getTransform', () => {
  it('is the identity at zoom 1', () => {
    expect(getTransform(200, 50, 0, 1, 200, 50)).toBe(
      'translate(0px, 0px) scale(1) rotate(0deg)',
    );
  });

  it('moves the centre-scaled box back to its top-left corner', () => {
    // The textarea scales about its centre; the corner moves by half the
    // growth, and the translate undoes exactly that.
    expect(getTransform(200, 50, 0, 2, 200, 50)).toBe(
      'translate(100px, 25px) scale(2) rotate(0deg)',
    );
    expect(getTransform(200, 50, 0, 0.5, 200, 50)).toBe(
      'translate(-50px, -12.5px) scale(0.5) rotate(0deg)',
    );
  });

  it('corrects against the room rather than the box when the box overflows it', () => {
    expect(getTransform(200, 500, 0, 2, 200, 100)).toBe(
      'translate(100px, 50px) scale(2) rotate(0deg)',
    );
  });
});

describe('text helpers', () => {
  it('detects a right-to-left line by its first directional character', () => {
    expect(isRTL('שלום')).toBe(true);
    expect(isRTL('123 مرحبا')).toBe(true);
    expect(isRTL('hello')).toBe(false);
    expect(isRTL('hello مرحبا')).toBe(false);
    expect(getLineDirection('abc\nمرحبا\nxyz', 5)).toBe('rtl');
    expect(getLineDirection('abc\nمرحبا\nxyz', 1)).toBe('ltr');
  });

  it('never puts a caret boundary inside a surrogate pair', () => {
    expect(getCaretBoundaryOffsets('a🙂b')).toEqual([0, 1, 3, 4]);
    expect(getCaretBoundaryOffsets('')).toEqual([0]);
  });

  it('knows which targets take typed text', () => {
    const ta = document.createElement('textarea');
    const text = document.createElement('input');
    text.type = 'text';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    expect(isWritableElement(ta)).toBe(true);
    expect(isWritableElement(text)).toBe(true);
    expect(isWritableElement(checkbox)).toBe(false);
    expect(isWritableElement(document.createElement('button'))).toBe(false);
    expect(isWritableElement(null)).toBe(false);
  });
});

describe('textWysiwyg: mounting', () => {
  it('appends a bare textarea to the container, focused, with everything selected', () => {
    const { el } = open('hello');
    expect(el.parentElement).toBe(host);
    expect(el.dataset.type).toBe('wysiwyg');
    expect(el.dataset.chrome).toBe('note-edit');
    expect(document.activeElement).toBe(el);
    expect(el.selectionStart).toBe(0);
    expect(el.selectionEnd).toBe(5);
    expect(el.style.border).toBe('0px');
    expect(el.style.padding).toBe('0px');
    expect(el.style.outline).toBe('0px');
    expect(el.style.backgroundColor).toBe('transparent');
    expect(el.style.resize).toBe('none');
    expect(el.maxLength).toBe(NOTE_MAX_CHARS);
  });

  it('does not select on a touch screen (autoSelect off)', () => {
    const { el } = open('hello', { autoSelect: false });
    expect(document.activeElement).toBe(el);
    expect(el.selectionStart).toBe(el.selectionEnd);
  });

  it('places the caret at the double-clicked character', () => {
    // jsdom lays nothing out, so the mirror's Range rects are stubbed to a
    // fixed advance per character, which is all the placement reads.
    const orig = Range.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = function (this: Range) {
      return { left: this.startOffset * 10, top: 0 } as DOMRect;
    };
    try {
      const note = { ...makeNote(40, 60, 'hello world'), width: 10_000 };
      const { el } = open('hello world', {
        note,
        initialCaretSceneCoords: { x: 40 + 34, y: 60 + 5 },
      });
      // 34 px in at 10 px per character rounds to the boundary after 3.
      expect(el.selectionStart).toBe(3);
      expect(el.selectionEnd).toBe(3);
    } finally {
      Range.prototype.getBoundingClientRect = orig;
    }
  });

  it('places the caret on the clicked line of a wrapped note', () => {
    const orig = Range.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = function (this: Range) {
      return { left: this.startOffset * 10, top: 0 } as DOMRect;
    };
    try {
      const note = { ...makeNote(0, 0, 'aa\nbb\ncc'), width: 10_000 };
      const { el } = open('aa\nbb\ncc', {
        note,
        initialCaretSceneCoords: { x: 7, y: NOTE_SIZES.md.line * 2 + 1 },
      });
      // Third line starts at offset 6; 7px is nearest the boundary after 1.
      expect(el.selectionStart).toBe(7);
    } finally {
      Range.prototype.getBoundingClientRect = orig;
    }
  });
});

describe('textWysiwyg: geometry', () => {
  it('sits on the note in scene px and scales by transform at any zoom', () => {
    for (const zoom of [1, 0.5, 2.5]) {
      document.body.innerHTML = '';
      host = document.createElement('div');
      surface = document.createElement('div');
      // jsdom lays nothing out; the viewport bound reads this.
      Object.defineProperty(surface, 'clientHeight', { value: 900 });
      document.body.append(host, surface);
      const { el, note } = open('hello', { zoom });
      const h = layoutNote('hello', note.width, 'md').height;
      const width = note.width + 0.5;
      const top = 60 * zoom + 20;
      expect(el.style.left).toBe(`${40 * zoom + 10}px`);
      expect(el.style.top).toBe(`${top}px`);
      expect(el.style.width).toBe(`${width}px`);
      expect(el.style.height).toBe(`${h * 1.05}px`);
      // Read back through a style so the comparison follows the DOM's own
      // serialisation, which drops a zero translate's second argument.
      const probe = document.createElement('div');
      probe.style.transform = getTransform(
        width,
        h * 1.05,
        0,
        zoom,
        width,
        (900 - top) / zoom,
      );
      expect(el.style.transform).toBe(probe.style.transform);
      expect(el.style.lineHeight).toBe(`${NOTE_SIZES.md.line}px`);
      expect(el.style.font).toContain(`${NOTE_SIZES.md.font}px`);
    }
  });

  it('an auto-sized note never wraps: the textarea is as wide as its text and grows', () => {
    const note = makeNote(0, 0, 'my');
    expect(note.autoResize).toBe(true);
    const { el } = open('my', { note });
    expect(el.style.whiteSpace).toBe('pre');
    const narrow = parseFloat(el.style.width);
    expect(narrow).toBeLessThan(note.width);
    type(el, 'my name is a rather long single line that a fixed note would wrap');
    const wide = parseFloat(el.style.width);
    expect(wide).toBeGreaterThan(note.width);
    expect(el.style.height).toBe(`${layoutNote('x', Infinity, 'md').height * 1.05}px`);
  });

  it('a fixed-width note wraps at its width', () => {
    const { el } = open('my');
    expect(el.style.whiteSpace).toBe('pre-wrap');
    expect(el.style.width).toBe('220.5px');
  });

  it('grows with the draft and follows the note when it changes under it', () => {
    const { el, editor, note, setNote } = open('a');
    const one = layoutNote('a', note.width, 'md').height;
    expect(el.style.height).toBe(`${one * 1.05}px`);
    type(el, 'a\nb\nc');
    const three = layoutNote('a\nb\nc', note.width, 'md').height;
    expect(el.style.height).toBe(`${three * 1.05}px`);

    setNote({ ...note, size: 'lg', bold: true, font: 'hand', tone: 3 });
    editor.update();
    expect(el.className).toContain('is-lg');
    expect(el.className).toContain('is-bold');
    expect(el.dataset.font).toBe('hand');
    expect(el.dataset.tone).toBe('3');
    expect(el.style.font).toContain('700');
    expect(el.style.lineHeight).toBe(`${NOTE_SIZES.lg.line}px`);
  });
});

describe('textWysiwyg: typing', () => {
  it('reports every input as the new text, normalised', () => {
    const { el, onChange } = open('');
    type(el, 'ab');
    expect(onChange).toHaveBeenLastCalledWith('ab');
    type(el, 'one\r\ntwo\rthree');
    expect(onChange).toHaveBeenLastCalledWith('one\ntwo\nthree');
    expect(el.value).toBe('one\ntwo\nthree');
  });

  it('turns a pasted tab into the Tab key’s spaces and keeps the caret nearby', () => {
    const { el, onChange } = open('');
    type(el, 'a\tb', 2);
    expect(onChange).toHaveBeenLastCalledWith(`a${TAB}b`);
    expect(el.selectionStart).toBe(2);
  });

  it('keeps multiline and Unicode text intact', () => {
    const { el, onChange } = open('');
    const text = 'naïve café\n日本語 🙂🙃\nالعربية';
    type(el, text);
    expect(onChange).toHaveBeenLastCalledWith(text);
  });

  it('never reports more than NOTE_MAX_CHARS', () => {
    const { el, onChange } = open('');
    type(el, '\t'.repeat(NOTE_MAX_CHARS));
    const last = onChange.mock.lastCall?.[0] as string | undefined;
    expect(last?.length).toBe(NOTE_MAX_CHARS);
  });
});

describe('textWysiwyg: keys', () => {
  it('Enter and Shift+Enter are newlines: not handled', () => {
    const { el, onSubmit } = open();
    expect(key(el, 'Enter').defaultPrevented).toBe(false);
    expect(key(el, 'Enter', { shiftKey: true }).defaultPrevented).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Escape submits via keyboard, with the current text', () => {
    const { el, onSubmit } = open('a');
    type(el, 'abc');
    expect(key(el, 'Escape').defaultPrevented).toBe(true);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ viaKeyboard: true, nextText: 'abc' });
    expect(el.isConnected).toBe(false);
  });

  it('Ctrl+Enter and Cmd+Enter submit via keyboard', () => {
    const a = open('a');
    key(a.el, 'Enter', { ctrlKey: true });
    expect(a.onSubmit).toHaveBeenCalledWith({ viaKeyboard: true, nextText: 'a' });
    const b = open('b');
    key(b.el, 'Enter', { metaKey: true });
    expect(b.onSubmit).toHaveBeenCalledWith({ viaKeyboard: true, nextText: 'b' });
  });

  it('ignores Escape, Ctrl+Enter and Tab while composing', () => {
    const { el, onSubmit } = open('か');
    key(el, 'Escape', { isComposing: true });
    key(el, 'Enter', { ctrlKey: true, isComposing: true });
    key(el, 'Tab', { isComposing: true });
    key(el, 'Escape', { keyCode: 229 });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(el.value).toBe('か');
  });

  it('leaves navigation and the browser’s own undo alone', () => {
    const { el } = open('ab\ncd');
    for (const k of [
      'ArrowLeft',
      'ArrowRight',
      'ArrowUp',
      'ArrowDown',
      'Home',
      'End',
    ]) {
      expect(key(el, k).defaultPrevented).toBe(false);
    }
    expect(key(el, 'z', { ctrlKey: true, code: 'KeyZ' }).defaultPrevented).toBe(false);
  });

  it('stops propagation so window shortcuts never see a keystroke', () => {
    const { el } = open();
    const seen = vi.fn();
    window.addEventListener('keydown', seen);
    key(el, 'n');
    key(el, 'Delete');
    window.removeEventListener('keydown', seen);
    expect(seen).not.toHaveBeenCalled();
  });

  it('Tab indents the caret line and keeps focus', () => {
    const { el, onChange } = open('ab');
    el.setSelectionRange(1, 1);
    expect(key(el, 'Tab').defaultPrevented).toBe(true);
    expect(el.value).toBe(`${TAB}ab`);
    expect(el.selectionStart).toBe(1 + TAB.length);
    expect(onChange).toHaveBeenLastCalledWith(`${TAB}ab`);
    expect(document.activeElement).toBe(el);
  });

  it('Tab indents every selected line; Shift+Tab outdents them', () => {
    const { el } = open('one\ntwo\nthree');
    el.setSelectionRange(1, 9);
    key(el, 'Tab');
    expect(el.value).toBe(`${TAB}one\n${TAB}two\n${TAB}three`);
    expect(el.selectionStart).toBe(1 + TAB.length);
    expect(el.selectionEnd).toBe(9 + TAB.length * 3);
    key(el, 'Tab', { shiftKey: true });
    expect(el.value).toBe('one\ntwo\nthree');
    expect(el.selectionStart).toBe(1);
    expect(el.selectionEnd).toBe(9);
  });

  it('Ctrl+] and Ctrl+[ are indent and outdent too', () => {
    const { el } = open('x');
    el.setSelectionRange(0, 0);
    key(el, ']', { ctrlKey: true, code: 'BracketRight' });
    expect(el.value).toBe(`${TAB}x`);
    key(el, '[', { ctrlKey: true, code: 'BracketLeft' });
    expect(el.value).toBe('x');
  });

  it('Shift+Tab with nothing to outdent changes nothing', () => {
    const { el } = open('ab');
    el.setSelectionRange(1, 1);
    key(el, 'Tab', { shiftKey: true });
    expect(el.value).toBe('ab');
    expect(el.selectionStart).toBe(1);
  });

  it('Tab at the limit inserts nothing', () => {
    const full = 'x'.repeat(NOTE_MAX_CHARS);
    const { el } = open(full);
    el.setSelectionRange(0, 0);
    key(el, 'Tab');
    expect(el.value).toBe(full);
  });

  it('zoom and size chords reach the canvas without leaving the editor', () => {
    const actions = {
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
      resetZoom: vi.fn(),
      increaseFontSize: vi.fn(),
      decreaseFontSize: vi.fn(),
    };
    const { el, onSubmit } = open('a', { actions });
    key(el, '=', { ctrlKey: true, code: 'Equal' });
    key(el, '-', { metaKey: true, code: 'Minus' });
    key(el, '0', { ctrlKey: true, code: 'Digit0' });
    key(el, '>', { ctrlKey: true, shiftKey: true });
    key(el, '<', { ctrlKey: true, shiftKey: true });
    expect(actions.zoomIn).toHaveBeenCalledTimes(1);
    expect(actions.zoomOut).toHaveBeenCalledTimes(1);
    expect(actions.resetZoom).toHaveBeenCalledTimes(1);
    expect(actions.increaseFontSize).toHaveBeenCalledTimes(1);
    expect(actions.decreaseFontSize).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(el.isConnected).toBe(true);
  });
});

describe('textWysiwyg: leaving', () => {
  it('blur submits, not via keyboard', () => {
    const { el, onSubmit } = open('a');
    type(el, 'ab');
    el.dispatchEvent(new FocusEvent('blur'));
    expect(onSubmit).toHaveBeenCalledWith({ viaKeyboard: false, nextText: 'ab' });
  });

  it('submits exactly once, whatever fires afterwards', () => {
    const { el, editor, onSubmit } = open('a');
    key(el, 'Escape');
    el.dispatchEvent(new FocusEvent('blur'));
    key(el, 'Escape');
    editor.submit();
    window.dispatchEvent(new Event('blur'));
    vi.runAllTimers();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('a press on the editing chrome disarms blur; the release re-arms it and refocuses', () => {
    const { el, onSubmit } = open('a');
    pointer('pointerdown', button);
    // The button takes focus in a browser; the textarea's blur must not
    // submit now.
    el.dispatchEvent(new FocusEvent('blur'));
    expect(onSubmit).not.toHaveBeenCalled();
    button.focus();
    pointer('pointerup', button);
    vi.runAllTimers();
    expect(document.activeElement).toBe(el);
    // Armed again: the next real blur submits.
    el.dispatchEvent(new FocusEvent('blur'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('a press on a writable control inside the chrome is not a button press', () => {
    const input = document.createElement('input');
    input.type = 'text';
    chrome.appendChild(input);
    const { el, onSubmit } = open('a');
    pointer('pointerdown', input);
    el.dispatchEvent(new FocusEvent('blur'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('alt-tabbing away while disarmed submits via the window blur', () => {
    const { onSubmit } = open('a');
    pointer('pointerdown', button);
    window.dispatchEvent(new Event('blur'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('a press on the canvas submits on the next frame', () => {
    const { onSubmit } = open('a');
    pointer('pointerdown', surface);
    expect(onSubmit).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('a middle press anywhere keeps the editor open (a pan)', () => {
    const { el, onSubmit } = open('a');
    pointer('pointerdown', surface, 1);
    el.dispatchEvent(new FocusEvent('blur'));
    vi.runAllTimers();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(el);
  });

  it('a press elsewhere (other UI) submits through the ordinary blur', () => {
    const { el, onSubmit } = open('a');
    const other = document.createElement('div');
    document.body.appendChild(other);
    pointer('pointerdown', other);
    el.dispatchEvent(new FocusEvent('blur'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('removes its listeners on submit so nothing late-fires', () => {
    const { el, onSubmit, onChange } = open('a');
    key(el, 'Escape');
    pointer('pointerdown', surface);
    vi.runAllTimers();
    el.dispatchEvent(new Event('input'));
    expect(onChange).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('passes empty and whitespace-only text through for the caller to delete', () => {
    const a = open('abc');
    type(a.el, '');
    key(a.el, 'Escape');
    expect(a.onSubmit).toHaveBeenCalledWith({ viaKeyboard: true, nextText: '' });
    const b = open('abc');
    type(b.el, '  \n ');
    b.el.dispatchEvent(new FocusEvent('blur'));
    expect(b.onSubmit).toHaveBeenCalledWith({ viaKeyboard: false, nextText: '  \n ' });
  });
});
