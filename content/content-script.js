/**
 * Thermal Bridge – Content Script
 *
 * Exposes `window.ThermalBridge` on every page.
 * Web apps communicate via postMessage (serialisable across origins).
 * The content script relays messages to the service worker via
 * chrome.runtime.sendMessage and resolves the caller's Promise.
 *
 * ── API (consumed by web apps) ──────────────────────────────────────────
 *
 *   window.ThermalBridge.print(payload) → Promise<{success, message?}>
 *   window.ThermalBridge.status()       → Promise<{status, device?}>
 *   window.ThermalBridge.raw(bytes)     → Promise<{success, message?}>
 *
 * ── postMessage protocol ────────────────────────────────────────────────
 *
 *   Request  → { source: 'thermal-bridge-web', id, type, ...data }
 *   Response ← { source: 'thermal-bridge-ext', id, ...result }
 */

'use strict';

(() => {
  // Inject the public API into the page context via an inline script
  const script = document.createElement('script');
  script.textContent = `
(function () {
  'use strict';
  if (window.ThermalBridge) return; // already injected

  let _seq = 0;
  const _pending = new Map();

  // Listen for replies from the content script
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const msg = e.data;
    if (!msg || msg.source !== 'thermal-bridge-ext') return;
    const resolve = _pending.get(msg.id);
    if (resolve) {
      _pending.delete(msg.id);
      resolve(msg);
    }
  });

  function _send(type, data = {}) {
    return new Promise((resolve, reject) => {
      const id = ++_seq;
      _pending.set(id, resolve);
      window.postMessage({ source: 'thermal-bridge-web', id, type, ...data }, '*');
      // Timeout after 10 s
      setTimeout(() => {
        if (_pending.has(id)) {
          _pending.delete(id);
          reject(new Error('ThermalBridge timeout — ekstensi tidak merespons.'));
        }
      }, 10000);
    });
  }

  window.ThermalBridge = {
    /**
     * Print a structured receipt.
     * @param {object} payload – see buildReceipt() in escpos-encoder.js
     */
    print(payload) {
      return _send('THERMAL_PRINT', { payload });
    },

    /**
     * Send raw ESC/POS byte array.
     * @param {number[]} bytes
     */
    raw(bytes) {
      return _send('THERMAL_RAW', { bytes: Array.from(bytes) });
    },

    /**
     * Get current connection status.
     * @returns {{ status: string, device: object|null }}
     */
    status() {
      return _send('GET_STATUS');
    },

    /** Version */
    version: '1.0.0',
  };

  console.log('[ThermalBridge] API ready. window.ThermalBridge tersedia.');
})();
`;
  (document.head || document.documentElement).prepend(script);
  script.remove();

  // ── Relay: page → service worker ─────────────────────────────────────────
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== 'thermal-bridge-web') return;

    const { id, type, ...rest } = msg;

    chrome.runtime.sendMessage({ type, ...rest }, (response) => {
      if (chrome.runtime.lastError) {
        window.postMessage({
          source:  'thermal-bridge-ext',
          id,
          success: false,
          message: chrome.runtime.lastError.message,
        }, '*');
        return;
      }
      window.postMessage({ source: 'thermal-bridge-ext', id, ...response }, '*');
    });
  });

  // ── Relay: service worker broadcast → page ────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'STATUS_UPDATE') {
      window.dispatchEvent(new CustomEvent('thermalbridge:status', { detail: msg }));
    }
  });
})();
