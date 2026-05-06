'use strict';

if (!globalThis.__thermalBridgeContentLoaded) {
globalThis.__thermalBridgeContentLoaded = true;

const SERVICE_UUID = '000018f0-0000-1000-8000-00805f9b34fb';
const CHAR_UUID = '00002af1-0000-1000-8000-00805f9b34fb';
const NORDIC_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NORDIC_TX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const DEFAULT_CHUNK_SIZE = 180;
const MIN_CHUNK_SIZE = 20;
const MAX_WRITE_RETRIES = 5;
const CHUNK_DELAY_MS = 30;
const RETRY_DELAY_MS = 120;
const DEFAULT_RECEIPT_WIDTH = 32;
const MAX_CAPTURE_LINES = 260;
const MAX_FALLBACK_LINES = 120;
const AMOUNT_TOKEN_REGEX = /(?:rp|idr)\s*-?\d[\d.,]*|-?\d{1,3}(?:[.,]\d{3})+|-?\d{4,}/gi;
const META_LINE_REGEX = /^([^:]{2,24})\s*[:\-]\s*(.+)$/;
const RECEIPT_NUMBER_REGEX = /\b(no|nomor)\b.*\b(struk|nota|invoice|order)|\b(invoice|order id|receipt)\b/i;
const CASHIER_REGEX = /\b(kasir|cashier|operator)\b/i;
const DATE_REGEX = /\b(tanggal|date)\b/i;
const TIME_REGEX = /\b(waktu|time|jam)\b/i;
const TOTAL_REGEX = /\b(grand total|jumlah total|total)\b/i;
const SUBTOTAL_REGEX = /\b(subtotal|sub total)\b/i;
const DISCOUNT_REGEX = /\b(discount|diskon|potongan)\b/i;
const TAX_REGEX = /\b(ppn|tax|pajak)\b/i;
const PAYMENT_REGEX = /\b(bayar|payment|paid|tunai|cash|debit|kredit|qris|transfer)\b/i;
const CHANGE_REGEX = /\b(kembalian|change)\b/i;
const GENERIC_META_KEY_REGEX = /\b(no|nomor|meja|table|customer|pelanggan|server|terminal|order|invoice|receipt|payment|metode|shift|cabang|branch)\b/i;

let bluetoothDevice = null;
let gattServer = null;
let printCharacteristic = null;
let queue = [];
let queueBusy = false;
let status = 'disconnected';
let buildReceiptPromise = null;
let escposModulePromise = null;

function injectBridgeApi() {
  const script = document.createElement('script');
  script.textContent = `
(() => {
  'use strict';
  if (window.ThermalBridge) return;

  let seq = 0;
  const pending = new Map();

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'thermal-bridge-ext') return;

    const item = pending.get(data.id);
    if (!item) return;

    pending.delete(data.id);
    if (data.success === false) {
      item.reject(new Error(data.message || 'ThermalBridge error'));
      return;
    }
    item.resolve(data);
  });

  function call(type, data = {}) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      window.postMessage({ source: 'thermal-bridge-web', id, type, ...data }, '*');
      setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error('ThermalBridge timeout: ekstensi tidak merespons.'));
      }, 15000);
    });
  }

  window.ThermalBridge = {
    connect() {
      return call('CONNECT_DEVICE');
    },
    disconnect() {
      return call('DISCONNECT_DEVICE');
    },
    print(payload) {
      return call('THERMAL_PRINT', { payload });
    },
    raw(bytes) {
      return call('THERMAL_RAW', { bytes: Array.from(bytes || []) });
    },
    status() {
      return call('GET_STATUS');
    },
    version: '1.0.1',
  };
})();
`;
  (document.head || document.documentElement).prepend(script);
  script.remove();
}

async function getBuildReceipt() {
  if (!buildReceiptPromise) {
    buildReceiptPromise = getEscPosModule().then((module) => module.buildReceipt);
  }
  return buildReceiptPromise;
}

async function getEscPosModule() {
  if (!escposModulePromise) {
    escposModulePromise = import(chrome.runtime.getURL('lib/escpos-encoder.js'));
  }
  return escposModulePromise;
}

async function getWhitelist() {
  const data = await chrome.storage.local.get('whitelist');
  return Array.isArray(data.whitelist) ? data.whitelist : [];
}

async function isOriginAllowed() {
  const list = await getWhitelist();
  if (list.length === 0) {
    return true;
  }

  const host = location.hostname.toLowerCase();
  return list.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

function getBluetoothApi() {
  const api = window.navigator?.bluetooth;
  if (!api) {
    throw new Error('Web Bluetooth tidak tersedia di halaman ini.');
  }
  return api;
}

async function tryGetKnownDevice(bluetooth, deviceId) {
  if (!deviceId || typeof bluetooth.getDevices !== 'function') {
    return null;
  }

  try {
    const knownDevices = await bluetooth.getDevices();
    return knownDevices.find((item) => item.id === deviceId) ?? null;
  } catch {
    return null;
  }
}

async function savePairedDevice(device) {
  await chrome.storage.local.set({
    pairedDevice: { id: device.id, name: device.name ?? 'Printer' },
  });
}

async function getPairedDevice() {
  const data = await chrome.storage.local.get('pairedDevice');
  return data.pairedDevice ?? null;
}

function broadcastStatus(next, extra = {}) {
  status = next;
  window.dispatchEvent(
    new CustomEvent('thermalbridge:status', {
      detail: { status: next, ...extra },
    })
  );
}

async function connectToDevice({ allowChooser }) {
  broadcastStatus('connecting');
  const bluetooth = getBluetoothApi();
  const paired = await getPairedDevice();
  const supportsGetDevices = typeof bluetooth.getDevices === 'function';

  if (!bluetoothDevice) {
    bluetoothDevice = await tryGetKnownDevice(bluetooth, paired?.id);
  }

  if (!bluetoothDevice) {
    if (!allowChooser) {
      if (paired?.id && !supportsGetDevices) {
        throw new Error(
          'Browser ini tidak mendukung bluetooth.getDevices(). Klik Connect lagi dari popup untuk memilih printer.'
        );
      }
      throw new Error(
        'Printer belum dipasangkan. Panggil ThermalBridge.connect() dari tombol klik pengguna.'
      );
    }

    bluetoothDevice = await bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }, { services: [NORDIC_SERVICE] }],
      optionalServices: [SERVICE_UUID, NORDIC_SERVICE],
    });
  }

  bluetoothDevice.removeEventListener('gattserverdisconnected', onDisconnected);
  bluetoothDevice.addEventListener('gattserverdisconnected', onDisconnected);

  gattServer = await bluetoothDevice.gatt.connect();

  let service;
  let charUuid = CHAR_UUID;
  try {
    service = await gattServer.getPrimaryService(SERVICE_UUID);
  } catch {
    service = await gattServer.getPrimaryService(NORDIC_SERVICE);
    charUuid = NORDIC_TX;
  }

  printCharacteristic = await service.getCharacteristic(charUuid);
  await savePairedDevice(bluetoothDevice);
  broadcastStatus('connected', {
    device: { id: bluetoothDevice.id, name: bluetoothDevice.name ?? 'Printer' },
  });

  return { id: bluetoothDevice.id, name: bluetoothDevice.name ?? 'Printer' };
}

function onDisconnected() {
  gattServer = null;
  printCharacteristic = null;
  broadcastStatus('disconnected');
}

async function disconnectDevice() {
  if (gattServer?.connected) {
    gattServer.disconnect();
  }
  onDisconnected();
}

async function ensureConnected({ allowChooser }) {
  if (gattServer?.connected && printCharacteristic) {
    return;
  }
  await connectToDevice({ allowChooser });
}

function getWriteMode(characteristic) {
  const properties = characteristic?.properties ?? {};

  if (
    properties.writeWithoutResponse &&
    typeof characteristic.writeValueWithoutResponse === 'function'
  ) {
    return 'without-response';
  }

  if (properties.write && typeof characteristic.writeValueWithResponse === 'function') {
    return 'with-response';
  }

  if (typeof characteristic.writeValueWithoutResponse === 'function') {
    return 'without-response';
  }

  if (typeof characteristic.writeValueWithResponse === 'function') {
    return 'with-response';
  }

  throw new Error('Characteristic printer tidak mendukung operasi tulis.');
}

async function writeSingleChunk(characteristic, chunk, mode) {
  if (mode === 'without-response') {
    await characteristic.writeValueWithoutResponse(chunk);
    return;
  }

  await characteristic.writeValueWithResponse(chunk);
}

function isRecoverableGattWriteError(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return (
    message.includes('gatt operation failed') ||
    message.includes('unknown reason') ||
    message.includes('networkerror') ||
    message.includes('not connected') ||
    message.includes('connection')
  );
}

async function writeBytes(bytes) {
  if (!printCharacteristic) {
    throw new Error('Printer tidak terhubung.');
  }

  let chunkSize = DEFAULT_CHUNK_SIZE;
  let mode = getWriteMode(printCharacteristic);

  for (let offset = 0; offset < bytes.length; ) {
    let written = false;
    let lastError = null;
    let nextOffset = offset;

    for (let attempt = 1; attempt <= MAX_WRITE_RETRIES; attempt += 1) {
      try {
        if (!gattServer?.connected || !printCharacteristic) {
          await ensureConnected({ allowChooser: false });
          mode = getWriteMode(printCharacteristic);
        }

        const chunkEnd = Math.min(offset + chunkSize, bytes.length);
        const chunk = bytes.slice(offset, chunkEnd);
        await writeSingleChunk(printCharacteristic, chunk, mode);
        nextOffset = chunkEnd;
        written = true;
        break;
      } catch (error) {
        lastError = error;

        if (chunkSize > MIN_CHUNK_SIZE) {
          chunkSize = Math.max(MIN_CHUNK_SIZE, Math.floor(chunkSize / 2));
        }

        if (!isRecoverableGattWriteError(error) && attempt >= 2) {
          break;
        }

        await sleep(RETRY_DELAY_MS);
      }
    }

    if (!written) {
      const reason = lastError?.message ?? 'Unknown write error';
      throw new Error(`Gagal menulis data BLE: ${reason}`);
    }

    offset = nextOffset;
    await sleep(CHUNK_DELAY_MS);
  }
}

function normalizeRawBytes(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Payload bytes harus array non-kosong.');
  }

  const parsed = value.map((item) => Number(item));
  for (const item of parsed) {
    if (!Number.isInteger(item) || item < 0 || item > 255) {
      throw new Error('Setiap byte harus integer 0..255.');
    }
  }

  return new Uint8Array(parsed);
}

function cleanLine(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitLongToken(token, width) {
  const parts = [];
  for (let i = 0; i < token.length; i += width) {
    parts.push(token.slice(i, i + width));
  }
  return parts;
}

function wrapTextLine(line, width) {
  if (!line) {
    return [''];
  }

  const tokens = line.split(' ').filter(Boolean);
  if (tokens.length === 0) {
    return [''];
  }

  const wrapped = [];
  let current = '';

  for (const token of tokens) {
    if (token.length > width) {
      if (current) {
        wrapped.push(current);
        current = '';
      }
      wrapped.push(...splitLongToken(token, width));
      continue;
    }

    const next = current ? `${current} ${token}` : token;
    if (next.length <= width) {
      current = next;
      continue;
    }

    wrapped.push(current);
    current = token;
  }

  if (current) {
    wrapped.push(current);
  }

  return wrapped.length > 0 ? wrapped : [''];
}

function isVisibleElement(element) {
  if (!element) {
    return false;
  }

  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function getElementTextLines(element) {
  const raw = String(element?.innerText ?? element?.textContent ?? '');
  const rawLines = raw.replace(/\r/g, '\n').split('\n');
  const lines = [];
  let previous = null;

  for (const item of rawLines) {
    const line = cleanLine(item);
    if (!line) {
      continue;
    }

    if (line === previous) {
      continue;
    }

    lines.push(line);
    previous = line;
    if (lines.length >= MAX_CAPTURE_LINES) {
      break;
    }
  }

  return lines;
}

function scoreReceiptCandidate(element) {
  const text = String(element?.innerText ?? '').trim();
  if (text.length < 40) {
    return Number.NEGATIVE_INFINITY;
  }
  if (text.length > 18000) {
    return Number.NEGATIVE_INFINITY;
  }

  const normalized = text.toLowerCase();
  const identifier = `${element.id ?? ''} ${element.className ?? ''}`.toLowerCase();
  const lines = text.split('\n').length;

  let score = 0;
  if (/(receipt|invoice|nota|struk|bill)/i.test(identifier)) {
    score += 12;
  }
  if (/\b(total|subtotal|qty|jumlah|bayar|kembalian|cashier|kasir)\b/.test(normalized)) {
    score += 10;
  }
  if (/\brp\s?[0-9]|idr\s?[0-9]|[0-9]{1,3}(?:[.,][0-9]{3})+/.test(normalized)) {
    score += 8;
  }
  if (lines >= 6 && lines <= 220) {
    score += 6;
  }
  if (text.length >= 120 && text.length <= 4000) {
    score += 5;
  }
  if (!isVisibleElement(element)) {
    score -= 12;
  }

  return score;
}

function pickBestReceiptCandidate(candidates) {
  let best = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const item of candidates) {
    const score = scoreReceiptCandidate(item);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  if (best && bestScore >= 4) {
    return best;
  }
  return null;
}

function getAutoReceiptElement() {
  const selectors = [
    '[data-receipt]',
    '[data-invoice]',
    '.receipt',
    '.invoice',
    '.nota',
    '.struk',
    '[class*="receipt"]',
    '[class*="invoice"]',
    '[class*="nota"]',
    '[class*="struk"]',
    '[id*="receipt"]',
    '[id*="invoice"]',
    '[id*="nota"]',
    '[id*="struk"]',
    'main',
    'article',
    'section',
  ];

  const candidates = [];
  for (const selector of selectors) {
    const elements = document.querySelectorAll(selector);
    for (const element of elements) {
      candidates.push(element);
      if (candidates.length >= 120) {
        break;
      }
    }
    if (candidates.length >= 120) {
      break;
    }
  }

  const best = pickBestReceiptCandidate(candidates);
  return best ?? document.body;
}

function resolveReceiptElement(selector) {
  const trimmedSelector = String(selector ?? '').trim();
  if (!trimmedSelector) {
    return { element: getAutoReceiptElement(), autoDetected: true };
  }

  const target = document.querySelector(trimmedSelector);
  if (!target) {
    throw new Error(`Selector tidak ditemukan: ${trimmedSelector}`);
  }

  return { element: target, autoDetected: false };
}

function parseAmountToken(token) {
  const raw = String(token ?? '');
  const sign = raw.includes('-') ? -1 : 1;
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) {
    return null;
  }

  return sign * Number(digits);
}

function splitLabelAndAmount(line) {
  const matcher = new RegExp(AMOUNT_TOKEN_REGEX.source, 'gi');
  const matches = Array.from(String(line ?? '').matchAll(matcher));
  if (matches.length === 0) {
    return null;
  }

  let selected = matches[matches.length - 1];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const candidate = matches[index];
    const start = candidate.index ?? -1;
    if (start < 0) {
      continue;
    }

    const tail = line.slice(start + candidate[0].length).trim();
    if (tail.length === 0 || /^[)\]}.,]*$/.test(tail)) {
      selected = candidate;
      break;
    }
  }

  const start = selected.index ?? -1;
  if (start < 0) {
    return null;
  }

  const amount = parseAmountToken(selected[0]);
  if (amount === null) {
    return null;
  }

  const label = cleanLine(line.slice(0, start).replace(/[:=\-]+$/, ''));
  if (!label) {
    return null;
  }

  return {
    label,
    amount,
    amountToken: selected[0],
  };
}

function detectSummaryType(lineLower, labelLower) {
  const haystack = `${lineLower} ${labelLower}`;
  if (SUBTOTAL_REGEX.test(haystack)) {
    return 'subtotal';
  }
  if (DISCOUNT_REGEX.test(haystack)) {
    return 'discount';
  }
  if (TAX_REGEX.test(haystack)) {
    return 'tax';
  }
  if (CHANGE_REGEX.test(haystack)) {
    return 'change';
  }
  if (PAYMENT_REGEX.test(haystack)) {
    return 'payment';
  }
  if (TOTAL_REGEX.test(haystack) && !SUBTOTAL_REGEX.test(haystack)) {
    return 'total';
  }
  return null;
}

function parseMetaLine(line) {
  const match = String(line ?? '').match(META_LINE_REGEX);
  if (!match) {
    return null;
  }

  const keyRaw = cleanLine(match[1]);
  const value = cleanLine(match[2]);
  if (!keyRaw || !value) {
    return null;
  }

  const key = keyRaw.toLowerCase();
  if (DATE_REGEX.test(key)) {
    return { type: 'date', label: 'Tanggal', value };
  }
  if (TIME_REGEX.test(key)) {
    return { type: 'time', label: 'Waktu', value };
  }
  if (CASHIER_REGEX.test(key)) {
    return { type: 'cashier', label: 'Kasir', value };
  }
  if (RECEIPT_NUMBER_REGEX.test(key)) {
    return { type: 'receipt_no', label: 'No. Struk', value };
  }
  if (keyRaw.length <= 20 && GENERIC_META_KEY_REGEX.test(key)) {
    return { type: 'other', label: keyRaw, value };
  }
  return null;
}

function looksLikeSeparatorLine(line) {
  return /^[-=*_~.]{3,}$/.test(String(line ?? '').trim());
}

function looksLikelyMetaCode(lineLower) {
  return (
    RECEIPT_NUMBER_REGEX.test(lineLower) ||
    CASHIER_REGEX.test(lineLower) ||
    DATE_REGEX.test(lineLower) ||
    TIME_REGEX.test(lineLower)
  );
}

function hasAlphabetCharacter(line) {
  return /[a-zA-Z]/.test(String(line ?? ''));
}

function looksLikeHeaderLine(line) {
  const clean = cleanLine(line);
  if (!clean) {
    return false;
  }
  if (!hasAlphabetCharacter(clean)) {
    return false;
  }
  if (clean.length > 48) {
    return false;
  }
  if (parseMetaLine(clean)) {
    return false;
  }
  if (splitLabelAndAmount(clean)) {
    return false;
  }
  return true;
}

function buildItemCandidate(line, amountData) {
  const qtyUnitPattern = /^(.*?)(\d+)\s*[xX]\s*(?:rp|idr)?\s*([\d.,]+)\s*$/i;
  const leadingQtyPattern = /^(\d+)\s*[xX]\s+(.+)$/i;

  let name = amountData.label;
  let qty = 1;
  let unitPrice = null;

  const qtyUnitMatch = amountData.label.match(qtyUnitPattern);
  if (qtyUnitMatch) {
    const parsedName = cleanLine(qtyUnitMatch[1]);
    const parsedQty = Number(qtyUnitMatch[2]);
    const parsedUnitPrice = parseAmountToken(qtyUnitMatch[3]);

    if (parsedName) {
      name = parsedName;
    }
    if (Number.isFinite(parsedQty) && parsedQty > 0) {
      qty = parsedQty;
    }
    if (Number.isFinite(parsedUnitPrice) && parsedUnitPrice > 0) {
      unitPrice = parsedUnitPrice;
    }
  } else {
    const leadingQtyMatch = amountData.label.match(leadingQtyPattern);
    if (leadingQtyMatch) {
      const parsedQty = Number(leadingQtyMatch[1]);
      const parsedName = cleanLine(leadingQtyMatch[2]);

      if (parsedName) {
        name = parsedName;
      }
      if (Number.isFinite(parsedQty) && parsedQty > 0) {
        qty = parsedQty;
      }
    }
  }

  if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
    unitPrice = Math.max(1, Math.round(amountData.amount / Math.max(1, qty)));
  }

  return {
    name,
    qty,
    price: unitPrice,
    lineTotal: amountData.amount,
    originalLine: line,
  };
}

function parseCapturedReceiptModel(lines, title) {
  const model = {
    headerLines: [],
    meta: [],
    items: [],
    summary: {},
    notes: [],
  };

  let bodyStarted = false;

  for (const rawLine of lines) {
    const line = cleanLine(rawLine);
    if (!line || looksLikeSeparatorLine(line)) {
      continue;
    }

    const lineLower = line.toLowerCase();
    const meta = parseMetaLine(line);
    if (meta) {
      model.meta.push(meta);
      continue;
    }

    const amountData = splitLabelAndAmount(line);
    if (amountData && Number.isFinite(amountData.amount) && amountData.amount > 0) {
      const summaryType = detectSummaryType(lineLower, amountData.label.toLowerCase());
      if (summaryType) {
        model.summary[summaryType] = Math.abs(amountData.amount);
        bodyStarted = true;
        continue;
      }

      if (!looksLikelyMetaCode(lineLower)) {
        const item = buildItemCandidate(line, amountData);
        const previous = model.items[model.items.length - 1];
        if (!previous || previous.name !== item.name || previous.lineTotal !== item.lineTotal) {
          model.items.push(item);
        }
        bodyStarted = true;
        continue;
      }
    }

    if (!bodyStarted && model.headerLines.length < 3 && looksLikeHeaderLine(line)) {
      model.headerLines.push(line);
      continue;
    }

    if (model.notes.length < MAX_FALLBACK_LINES) {
      model.notes.push(line);
    }
  }

  if (model.headerLines.length === 0) {
    const fallbackTitle = cleanLine(title) || 'WEB RECEIPT';
    model.headerLines.push(fallbackTitle);
  }

  return model;
}

function getMetaValue(model, type) {
  const entry = model.meta.find((item) => item.type === type);
  return entry?.value ?? null;
}

function formatCurrency(amount) {
  const safeNumber = Number(amount ?? 0);
  if (!Number.isFinite(safeNumber)) {
    return 'Rp0';
  }

  const abs = Math.abs(Math.round(safeNumber));
  const value = `Rp${abs.toLocaleString('id-ID')}`;
  return safeNumber < 0 ? `-${value}` : value;
}

function buildFooterText(notes) {
  const highlighted = notes.filter((line) =>
    /\b(terima kasih|thank you|sampai jumpa|silakan datang kembali)\b/i.test(line)
  );
  const selected = highlighted.slice(0, 2);
  if (selected.length > 0) {
    return `${selected.join('\n')}\nDicetak via Thermal Bridge`;
  }
  return 'Terima kasih.\nDicetak via Thermal Bridge';
}

function createProfessionalPayload(model, pageTitle, width) {
  const items = model.items.map((item) => ({
    name: item.name,
    qty: item.qty,
    price: item.price,
  }));

  const computedSubtotal = items.reduce((sum, item) => sum + item.qty * item.price, 0);
  const subtotal = model.summary.subtotal ?? computedSubtotal;
  const discount = Math.abs(model.summary.discount ?? 0);
  const tax = Math.abs(model.summary.tax ?? 0);

  let total = model.summary.total;
  if (!Number.isFinite(total) || total <= 0) {
    total = subtotal - discount + tax;
  }
  if (!Number.isFinite(total) || total <= 0) {
    total = computedSubtotal;
  }

  const paymentAmount = model.summary.payment;
  const changeAmount = model.summary.change;

  const headerTitle = model.headerLines[0] ?? cleanLine(pageTitle) ?? 'WEB RECEIPT';
  const headerSubtitle = model.headerLines[1] ?? '';
  const headerAddress = model.headerLines.slice(2).join(' ');

  return {
    header: {
      title: headerTitle,
      subtitle: headerSubtitle || undefined,
      address: headerAddress || undefined,
      receipt_no: getMetaValue(model, 'receipt_no') ?? undefined,
      cashier: getMetaValue(model, 'cashier') ?? undefined,
    },
    items,
    subtotal,
    discount,
    tax,
    total,
    payment: paymentAmount
      ? {
          method: 'AUTO',
          amount: paymentAmount,
          change: Number.isFinite(changeAmount) ? Math.max(0, changeAmount) : Math.max(0, paymentAmount - total),
        }
      : undefined,
    footer: buildFooterText(model.notes),
    width,
  };
}

function buildFallbackProfessionalReceiptBytes(EscPosEncoder, model, pageTitle, width) {
  const encoder = new EscPosEncoder();
  const title = model.headerLines[0] ?? cleanLine(pageTitle) ?? 'WEB RECEIPT';
  const subtitleLines = model.headerLines.slice(1, 3);

  encoder.initialize();
  encoder.align('center').bold(true).size(2, 1).line(title).size(1, 1).bold(false);
  for (const subtitle of subtitleLines) {
    encoder.line(subtitle);
  }

  encoder.rule('=', width);
  encoder.align('left');
  encoder.columns('Dicetak', new Date().toLocaleDateString('id-ID'), width);
  encoder.columns('Jam', new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }), width);

  const metaLines = model.meta.slice(0, 6);
  for (const meta of metaLines) {
    encoder.columns(meta.label, meta.value, width);
  }

  encoder.rule('-', width);
  encoder.bold(true).line('DETAIL TRANSAKSI').bold(false);
  encoder.rule('-', width);

  const detailLines = model.notes.slice(0, MAX_FALLBACK_LINES);
  for (const line of detailLines) {
    const wrapped = wrapTextLine(line, width);
    for (const row of wrapped) {
      encoder.line(row);
    }
  }

  const summaryRows = [
    ['Subtotal', model.summary.subtotal],
    ['Diskon', model.summary.discount ? -Math.abs(model.summary.discount) : null],
    ['Pajak', model.summary.tax],
    ['Total', model.summary.total],
    ['Bayar', model.summary.payment],
    ['Kembalian', model.summary.change],
  ];

  const printableSummary = summaryRows.filter((row) => Number.isFinite(row[1]) && row[1] !== 0);
  if (printableSummary.length > 0) {
    encoder.rule('=', width);
    for (const [label, value] of printableSummary) {
      encoder.columns(label, formatCurrency(value), width);
    }
  }

  encoder.rule('-', width);
  encoder.align('center').line(buildFooterText(model.notes));
  encoder.newline(3).cut();
  return encoder.encode();
}

async function buildCapturedReceiptBytes({ lines, title, width }) {
  const module = await getEscPosModule();
  const EscPosEncoder = module?.EscPosEncoder;
  const buildReceipt = module?.buildReceipt;

  if (typeof EscPosEncoder !== 'function') {
    throw new Error('Encoder thermal tidak tersedia.');
  }
  if (typeof buildReceipt !== 'function') {
    throw new Error('Builder receipt tidak tersedia.');
  }

  const safeWidth = width === 42 ? 42 : DEFAULT_RECEIPT_WIDTH;
  const model = parseCapturedReceiptModel(lines, title);
  if (model.items.length > 0) {
    const payload = createProfessionalPayload(model, title, safeWidth);
    return buildReceipt(payload);
  }

  return buildFallbackProfessionalReceiptBytes(EscPosEncoder, model, title, safeWidth);
}

function enqueue(job) {
  queue.push(job);
  if (!queueBusy) {
    processQueue();
  }
}

async function processQueue() {
  queueBusy = true;
  while (queue.length > 0) {
    const job = queue.shift();
    try {
      await ensureConnected({ allowChooser: false });
      const bytes = await job.getBytes();
      await writeBytes(bytes);
      job.resolve({ success: true });
    } catch (error) {
      job.reject({ success: false, message: error.message });
    }
  }
  queueBusy = false;
}

function postReply(id, payload) {
  window.postMessage({ source: 'thermal-bridge-ext', id, ...payload }, '*');
}

async function handleBridgeRequest(message, options = {}) {
  const fromPopup = options.fromPopup === true;
  const allowed = await isOriginAllowed();
  if (
    (message.type === 'THERMAL_PRINT' || message.type === 'THERMAL_RAW') &&
    !allowed
  ) {
    return { success: false, message: 'Domain tidak ada di whitelist.' };
  }

  switch (message.type) {
    case 'CONNECT_DEVICE': {
      const device = await connectToDevice({ allowChooser: true });
      return { success: true, device };
    }
    case 'DISCONNECT_DEVICE': {
      await disconnectDevice();
      return { success: true };
    }
    case 'GET_STATUS': {
      const paired = await getPairedDevice();
      return { success: true, status, device: paired };
    }
    case 'THERMAL_PRINT': {
      return await new Promise((resolve, reject) => {
        enqueue({
          getBytes: async () => {
            const buildReceipt = await getBuildReceipt();
            return buildReceipt(message.payload);
          },
          resolve,
          reject,
        });
      });
    }
    case 'THERMAL_RAW': {
      const bytes = normalizeRawBytes(message.bytes);
      return await new Promise((resolve, reject) => {
        enqueue({
          getBytes: async () => bytes,
          resolve,
          reject,
        });
      });
    }
    case 'PRINT_PAGE_RECEIPT': {
      if (!fromPopup) {
        return {
          success: false,
          message: 'PRINT_PAGE_RECEIPT hanya tersedia dari popup extension.',
        };
      }

      return await new Promise((resolve, reject) => {
        enqueue({
          getBytes: async () => {
            const { element } = resolveReceiptElement(message.selector);
            const lines = getElementTextLines(element);
            if (lines.length === 0) {
              throw new Error('Tidak ada teks nota yang bisa dicetak dari halaman ini.');
            }

            return buildCapturedReceiptBytes({
              lines,
              title: document.title,
              width: message.width,
            });
          },
          resolve: () => {
            const selector = String(message.selector ?? '').trim();
            const mode = selector ? 'selector' : 'auto-detect';
            resolve({ success: true, message: `Cetak dari halaman selesai (${mode}).` });
          },
          reject,
        });
      });
    }
    default:
      return { success: false, message: `Unknown message type: ${message.type}` };
  }
}

window.addEventListener('message', (event) => {
  if (event.source !== window) {
    return;
  }

  const message = event.data;
  if (!message || message.source !== 'thermal-bridge-web') {
    return;
  }

  handleBridgeRequest(message)
    .then((result) => postReply(message.id, result))
    .catch((error) => postReply(message.id, { success: false, message: error.message }));
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) {
    return;
  }

  if (message.type === 'CONNECT_DEVICE_FROM_POPUP') {
    connectToDevice({ allowChooser: true })
      .then((device) => sendResponse({ success: true, device }))
      .catch((error) => sendResponse({ success: false, message: error.message }));
    return true;
  }

  if (message.type === 'GET_STATUS_FROM_POPUP') {
    handleBridgeRequest({ type: 'GET_STATUS' }, { fromPopup: true })
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, message: error.message }));
    return true;
  }

  if (message.type === 'DISCONNECT_DEVICE_FROM_POPUP') {
    handleBridgeRequest({ type: 'DISCONNECT_DEVICE' }, { fromPopup: true })
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, message: error.message }));
    return true;
  }

  if (message.type === 'TEST_PRINT_FROM_POPUP') {
    handleBridgeRequest({ type: 'THERMAL_PRINT', payload: testReceiptPayload() }, { fromPopup: true })
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, message: error.message }));
    return true;
  }

  if (message.type === 'PRINT_PAGE_RECEIPT_FROM_POPUP') {
    handleBridgeRequest({
      type: 'PRINT_PAGE_RECEIPT',
      selector: message.selector,
      width: message.width,
    }, { fromPopup: true })
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, message: error.message }));
    return true;
  }
});

injectBridgeApi();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function testReceiptPayload() {
  return {
    header: {
      title: 'THERMAL BRIDGE',
      subtitle: 'Test Print',
      address: 'Jl. Contoh No. 1, Jakarta',
      phone: '021-12345678',
      receipt_no: 'TEST-001',
      cashier: 'System',
    },
    items: [
      { name: 'Produk Test A', qty: 2, price: 15000 },
      { name: 'Produk Test B', qty: 1, price: 25000 },
      { name: 'Produk Panjang Sekali Namanya', qty: 3, price: 9900 },
    ],
    subtotal: 99700,
    discount: 0,
    tax: 0,
    total: 99700,
    payment: { method: 'CASH', amount: 100000, change: 300 },
    footer: 'Terima kasih sudah menggunakan\nThermal Bridge!',
    width: 32,
  };
}
}
