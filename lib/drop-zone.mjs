/**
 * Drag-and-drop file upload manager for pages with terminal iframes.
 *
 * Terminal iframes are separate browsing contexts that swallow drag events.
 * Since iframes are same-origin, we inject drag listeners into each iframe's
 * contentWindow. When the iframe detects a drag, it posts a message to the
 * parent. The parent shows a full-viewport overlay to receive the drop.
 *
 * Uses a timer-based approach instead of a drag counter. The overlay covers
 * everything once shown, so it reliably receives dragleave when the drag
 * truly exits the viewport (no child boundary crossings to cause false events).
 */
export function createDropZone({ overlay, onFiles, hideDelay = 300 }) {
  let hideTimer = null;
  let visible = false;

  function showOverlay() {
    visible = true;
    overlay.classList.add('visible');
    resetHideTimer();
  }

  function hideOverlay() {
    visible = false;
    overlay.classList.remove('visible');
    clearHideTimer();
  }

  function resetHideTimer() {
    clearHideTimer();
    hideTimer = setTimeout(hideOverlay, hideDelay);
  }

  function clearHideTimer() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  }

  function handleDrop(e) {
    e.preventDefault();
    hideOverlay();
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) {
      onFiles(files);
    }
  }

  /**
   * Inject drag listeners into an iframe's contentWindow.
   * The iframe must be same-origin. Listeners post messages to the parent
   * so the parent can show the drop overlay.
   */
  function injectIframe(iframe) {
    if (iframe._dragInjected) return false;
    try {
      const win = iframe.contentWindow;
      const doc = win && win.document;
      if (!doc || !doc.body) return false;
      iframe._dragInjected = true;

      win.addEventListener('dragenter', (e) => {
        e.preventDefault();
        parent.postMessage({ type: 'iframe-drag', event: 'dragenter' }, '*');
      });
      win.addEventListener('dragover', (e) => {
        e.preventDefault();
      });
      win.addEventListener('dragleave', (e) => {
        e.preventDefault();
        parent.postMessage({ type: 'iframe-drag', event: 'dragleave' }, '*');
      });
      win.addEventListener('drop', (e) => {
        e.preventDefault();
        parent.postMessage({ type: 'iframe-drag', event: 'drop' }, '*');
      });
      return true;
    } catch (err) {
      return false;
    }
  }

  /** Handle postMessage from iframes */
  function handleMessage(e) {
    if (!e.data || e.data.type !== 'iframe-drag') return;
    if (e.data.event === 'dragenter') {
      showOverlay();
    }
    // Once overlay is visible, it handles its own dismissal via
    // overlay dragleave/drop. Iframe dragleave/drop messages are ignored.
  }

  /** Attach document-level and overlay drag listeners. Returns detach fn. */
  function attach(doc, win) {
    const d = doc || document;
    const w = win || window;

    function onDocDragEnter(e) { e.preventDefault(); showOverlay(); }
    function onDocDragOver(e) { e.preventDefault(); }
    function onDocDrop(e) { e.preventDefault(); handleDrop(e); }

    function onOverlayDragOver(e) { e.preventDefault(); resetHideTimer(); }
    function onOverlayDragLeave(e) {
      e.preventDefault();
      // Only hide when drag truly leaves the viewport (relatedTarget is null),
      // not when crossing into a child node inside the overlay
      if (!e.relatedTarget) { hideOverlay(); }
    }

    d.addEventListener('dragenter', onDocDragEnter);
    d.addEventListener('dragover', onDocDragOver);
    d.addEventListener('drop', onDocDrop);

    overlay.addEventListener('dragover', onOverlayDragOver);
    overlay.addEventListener('dragleave', onOverlayDragLeave);
    overlay.addEventListener('drop', handleDrop);

    w.addEventListener('message', handleMessage);

    return function detach() {
      d.removeEventListener('dragenter', onDocDragEnter);
      d.removeEventListener('dragover', onDocDragOver);
      d.removeEventListener('drop', onDocDrop);
      overlay.removeEventListener('dragover', onOverlayDragOver);
      overlay.removeEventListener('dragleave', onOverlayDragLeave);
      overlay.removeEventListener('drop', handleDrop);
      w.removeEventListener('message', handleMessage);
      clearHideTimer();
    };
  }

  return {
    showOverlay, hideOverlay, resetHideTimer, clearHideTimer,
    handleDrop, handleMessage, injectIframe, attach,
    get visible() { return visible; },
  };
}
