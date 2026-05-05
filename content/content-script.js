'use strict';

const SERVICE_UUID = '000018f0-0000-1000-8000-00805f9b34fb';
const CHAR_UUID = '00002af1-0000-1000-8000-00805f9b34fb';
const NORDIC_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NORDIC_TX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const CHUNK_SIZE = 512;

let bluetoothDevice = null;
let gattServer = null;
let printCharacteristic = null;
let queue = [];
let queueBusy = false;
let status = 'disconnected';
let buildReceiptPromise = null;

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
    buildReceiptPromise = import(chrome.runtime.getURL('lib/escpos-encoder.js')).then(
      (module) => module.buildReceipt
    );
  }
  return buildReceiptPromise;
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

  if (!bluetoothDevice) {
    const paired = await getPairedDevice();
    if (paired?.id) {
      const known = await bluetooth.getDevices();
      bluetoothDevice = known.find((item) => item.id === paired.id) ?? null;
    }
  }

  if (!bluetoothDevice) {
    if (!allowChooser) {
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

async function writeBytes(bytes) {
  if (!printCharacteristic) {
    throw new Error('Printer tidak terhubung.');
  }

  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    const chunk = bytes.slice(offset, offset + CHUNK_SIZE);
    await printCharacteristic.writeValueWithoutResponse(chunk);
    await sleep(20);
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

async function handleBridgeRequest(message) {
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
      await ensureConnected({ allowChooser: false });
      await writeBytes(bytes);
      return { success: true };
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
    handleBridgeRequest({ type: 'GET_STATUS' })
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, message: error.message }));
    return true;
  }

  if (message.type === 'DISCONNECT_DEVICE_FROM_POPUP') {
    handleBridgeRequest({ type: 'DISCONNECT_DEVICE' })
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, message: error.message }));
    return true;
  }

  if (message.type === 'TEST_PRINT_FROM_POPUP') {
    handleBridgeRequest({ type: 'THERMAL_PRINT', payload: testReceiptPayload() })
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
