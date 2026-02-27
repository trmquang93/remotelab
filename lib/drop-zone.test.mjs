/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDropZone } from './drop-zone.mjs';

function makeEl(id) {
  const el = document.createElement('div');
  if (id) el.id = id;
  document.body.appendChild(el);
  return el;
}

function dragEvent(type, files) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  e.dataTransfer = { files: files || [] };
  e.preventDefault = vi.fn();
  return e;
}

describe('createDropZone', () => {
  let overlay, onFiles, dz;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    overlay = makeEl('drop-overlay');
    onFiles = vi.fn();
    dz = createDropZone({ overlay, onFiles, hideDelay: 300 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Overlay visibility ---

  describe('showOverlay / hideOverlay', () => {
    it('shows overlay and starts hide timer', () => {
      dz.showOverlay();
      expect(overlay.classList.contains('visible')).toBe(true);
      expect(dz.visible).toBe(true);
    });

    it('hides overlay after timeout if no dragover resets timer', () => {
      dz.showOverlay();
      vi.advanceTimersByTime(300);
      expect(overlay.classList.contains('visible')).toBe(false);
      expect(dz.visible).toBe(false);
    });

    it('stays visible when timer is reset before expiry', () => {
      dz.showOverlay();
      vi.advanceTimersByTime(200);
      dz.resetHideTimer();
      vi.advanceTimersByTime(200);
      expect(overlay.classList.contains('visible')).toBe(true);
      // Now let it expire
      vi.advanceTimersByTime(100);
      expect(overlay.classList.contains('visible')).toBe(false);
    });

    it('hideOverlay immediately removes visible class', () => {
      dz.showOverlay();
      dz.hideOverlay();
      expect(overlay.classList.contains('visible')).toBe(false);
      expect(dz.visible).toBe(false);
    });

    it('multiple showOverlay calls reset the timer each time', () => {
      dz.showOverlay();
      vi.advanceTimersByTime(200);
      dz.showOverlay(); // resets timer
      vi.advanceTimersByTime(200);
      expect(overlay.classList.contains('visible')).toBe(true);
      vi.advanceTimersByTime(100);
      expect(overlay.classList.contains('visible')).toBe(false);
    });
  });

  // --- Drop handling ---

  describe('handleDrop', () => {
    it('hides overlay and calls onFiles with dropped files', () => {
      dz.showOverlay();
      const fakeFile = new File(['hello'], 'test.txt');
      const e = dragEvent('drop', [fakeFile]);
      dz.handleDrop(e);

      expect(e.preventDefault).toHaveBeenCalled();
      expect(overlay.classList.contains('visible')).toBe(false);
      expect(onFiles).toHaveBeenCalledWith([fakeFile]);
    });

    it('does not call onFiles when no files in dataTransfer', () => {
      dz.showOverlay();
      dz.handleDrop(dragEvent('drop', []));
      expect(onFiles).not.toHaveBeenCalled();
    });

    it('handles missing dataTransfer gracefully', () => {
      dz.showOverlay();
      dz.handleDrop({ preventDefault: vi.fn(), dataTransfer: null });
      expect(onFiles).not.toHaveBeenCalled();
      expect(overlay.classList.contains('visible')).toBe(false);
    });
  });

  // --- iframe message handling ---

  describe('handleMessage (iframe drag events)', () => {
    it('shows overlay on iframe dragenter message', () => {
      dz.handleMessage({ data: { type: 'iframe-drag', event: 'dragenter' } });
      expect(overlay.classList.contains('visible')).toBe(true);
    });

    it('ignores iframe dragleave (overlay handles its own dismissal)', () => {
      dz.handleMessage({ data: { type: 'iframe-drag', event: 'dragenter' } });
      dz.handleMessage({ data: { type: 'iframe-drag', event: 'dragleave' } });
      // Still visible -- overlay dismissal is via overlay's own dragleave
      expect(overlay.classList.contains('visible')).toBe(true);
    });

    it('ignores iframe drop (overlay handles its own drop)', () => {
      dz.handleMessage({ data: { type: 'iframe-drag', event: 'dragenter' } });
      dz.handleMessage({ data: { type: 'iframe-drag', event: 'drop' } });
      // Still visible until timer expires or overlay dragleave
      expect(overlay.classList.contains('visible')).toBe(true);
    });

    it('ignores messages with wrong type', () => {
      dz.handleMessage({ data: { type: 'other', event: 'dragenter' } });
      expect(dz.visible).toBe(false);
    });

    it('ignores messages with no data', () => {
      dz.handleMessage({ data: null });
      expect(dz.visible).toBe(false);
    });
  });

  // --- iframe injection ---

  describe('injectIframe', () => {
    it('injects drag listeners into same-origin iframe', () => {
      const fakeWin = new EventTarget();
      const fakeDoc = { body: {} };
      Object.defineProperty(fakeWin, 'document', { value: fakeDoc });
      const iframe = { contentWindow: fakeWin };
      const addSpy = vi.spyOn(fakeWin, 'addEventListener');

      const result = dz.injectIframe(iframe);

      expect(result).toBe(true);
      expect(iframe._dragInjected).toBe(true);
      const events = addSpy.mock.calls.map(c => c[0]);
      expect(events).toContain('dragenter');
      expect(events).toContain('dragover');
      expect(events).toContain('dragleave');
      expect(events).toContain('drop');
    });

    it('does not inject twice', () => {
      const fakeWin = new EventTarget();
      Object.defineProperty(fakeWin, 'document', { value: { body: {} } });
      const iframe = { contentWindow: fakeWin };

      dz.injectIframe(iframe);
      const result = dz.injectIframe(iframe);

      expect(result).toBe(false);
    });

    it('returns false for cross-origin iframe', () => {
      const iframe = {
        get contentWindow() { throw new DOMException('cross-origin'); }
      };

      const result = dz.injectIframe(iframe);
      expect(result).toBe(false);
    });

    it('returns false when document.body is not ready', () => {
      const fakeWin = new EventTarget();
      Object.defineProperty(fakeWin, 'document', { value: { body: null } });
      const iframe = { contentWindow: fakeWin };

      const result = dz.injectIframe(iframe);
      expect(result).toBe(false);
    });
  });

  // --- Attach/detach ---

  describe('attach', () => {
    it('wires drag listeners on document, overlay, and message on window', () => {
      const doc = new EventTarget();
      const win = new EventTarget();
      const docSpy = vi.spyOn(doc, 'addEventListener');
      const winSpy = vi.spyOn(win, 'addEventListener');
      const overlaySpy = vi.spyOn(overlay, 'addEventListener');
      dz.attach(doc, win);

      const docEvents = docSpy.mock.calls.map(c => c[0]);
      expect(docEvents).toContain('dragenter');
      expect(docEvents).toContain('dragover');
      expect(docEvents).toContain('drop');
      expect(docEvents).not.toContain('dragleave'); // no doc dragleave

      const overlayEvents = overlaySpy.mock.calls.map(c => c[0]);
      expect(overlayEvents).toContain('dragover');
      expect(overlayEvents).toContain('dragleave');
      expect(overlayEvents).toContain('drop');

      const winEvents = winSpy.mock.calls.map(c => c[0]);
      expect(winEvents).toContain('message');
    });

    it('detach removes all listeners and clears timer', () => {
      const doc = new EventTarget();
      const win = new EventTarget();
      const docRemove = vi.spyOn(doc, 'removeEventListener');
      const winRemove = vi.spyOn(win, 'removeEventListener');
      const overlayRemove = vi.spyOn(overlay, 'removeEventListener');
      const detach = dz.attach(doc, win);

      dz.showOverlay(); // start a timer
      detach();

      const docEvents = docRemove.mock.calls.map(c => c[0]);
      expect(docEvents).toContain('dragenter');
      expect(docEvents).toContain('drop');

      const overlayEvents = overlayRemove.mock.calls.map(c => c[0]);
      expect(overlayEvents).toContain('dragover');
      expect(overlayEvents).toContain('dragleave');

      const winEvents = winRemove.mock.calls.map(c => c[0]);
      expect(winEvents).toContain('message');

      // Timer should be cleared -- advancing should not hide overlay
      // (it's already visible, detach cleared the timer but didn't hide)
      vi.advanceTimersByTime(1000);
      expect(overlay.classList.contains('visible')).toBe(true);
    });
  });
});
