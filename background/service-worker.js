/**
 * Thermal Bridge Service Worker (MV3)
 * Manages Bluetooth connection, print queue, whitelist, and status broadcast.
 */

import { buildReceipt } from '../lib/escpos-encoder.js';

// Generic Serial profile used by many BLE thermal printers.
const SERVICE_UUID = '000018f0-0000-1000-8000-00805f9b34fb';
const CHAR_UUID = '00002af1-0000-1000-8000-00805f9b34fb';

// Fallback: Nordic UART Service.
const NORDIC_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NORDIC_TX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';

const CHUNK_SIZE = 512;

let bluetoothDevice = null;
let gattServer = null;
let printCharacteristic = null;
let printQueue = [];
let isProcessingQueue = false;
let connectionStatus = 'disconnected';

async function getPairedDevice() {
  const result = await chrome.storage.local.get('pairedDevice');
  return result.pairedDevice ?? null;
}

async function savePairedDevice(device) {
  await chrome.storage.local.set({ pairedDevice: device });
}

async function getWhitelist() {
  const result = await chrome.storage.local.get('whitelist');
  return result.whitelist ?? [];
}

function broadcastStatus(status, extra = {}) {
  connectionStatus = status;
  chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', status, ...extra }).catch(() => {});
}

function getBluetoothApi() {
  const api = globalThis.navigator?.bluetooth;
  if (!api) {
    throw new Error(
      'Web Bluetooth tidak tersedia pada context ini. Buka popup ekstensi dan gunakan Chrome versi terbaru.'
    );
  }
  return api;
}

async function connectToDevice(deviceId = null) {
  try {
    broadcastStatus('connecting');
    const bluetooth = getBluetoothApi();

    if (deviceId) {
      const devices = await bluetooth.getDevices();
      const saved = devices.find((device) => device.id === deviceId);
      if (saved) {
        bluetoothDevice = saved;
      }
    }

    if (!bluetoothDevice) {
      if (typeof bluetooth.requestDevice !== 'function') {
        throw new Error(
          'requestDevice() tidak tersedia di context ini. Gunakan popup extension untuk pairing perangkat.'
        );
      }

      bluetoothDevice = await bluetooth.requestDevice({
        filters: [{ services: [SERVICE_UUID] }, { services: [NORDIC_SERVICE] }],
        optionalServices: [SERVICE_UUID, NORDIC_SERVICE],
      });
    }

    if (!bluetoothDevice.gatt) {
      throw new Error('Perangkat tidak menyediakan GATT server.');
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

    const paired = {
      id: bluetoothDevice.id,
      name: bluetoothDevice.name ?? 'Printer',
    };
    await savePairedDevice(paired);

    broadcastStatus('connected', { device: paired });
  } catch (error) {
    broadcastStatus('error', { message: error.message });
    throw error;
  }
}

async function disconnectDevice() {
  if (gattServer?.connected) {
    gattServer.disconnect();
  }
  onDisconnected();
}

function onDisconnected() {
  gattServer = null;
  printCharacteristic = null;
  broadcastStatus('disconnected');
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

function enqueuePrint(job) {
  printQueue.push(job);
  if (!isProcessingQueue) {
    processQueue();
  }
}

async function processQueue() {
  isProcessingQueue = true;
  while (printQueue.length > 0) {
    const job = printQueue.shift();
    try {
      if (!gattServer?.connected) {
        const paired = await getPairedDevice();
        await connectToDevice(paired?.id ?? null);
      }
      const bytes = buildReceipt(job.payload);
      await writeBytes(bytes);
      job.resolve({ success: true });
    } catch (error) {
      job.reject({ success: false, message: error.message });
    }
  }
  isProcessingQueue = false;
}

async function isOriginAllowed(origin) {
  const whitelist = await getWhitelist();
  if (whitelist.length === 0) {
    return true;
  }

  try {
    const { hostname } = new URL(origin);
    return whitelist.some((entry) => hostname === entry || hostname.endsWith(`.${entry}`));
  } catch {
    return false;
  }
}

function normalizeRawBytes(value) {
  if (!Array.isArray(value)) {
    throw new Error('Payload bytes harus berupa array angka.');
  }

  if (value.length === 0) {
    throw new Error('Payload bytes tidak boleh kosong.');
  }

  const safe = value.map((item) => Number(item));
  for (const num of safe) {
    if (!Number.isInteger(num) || num < 0 || num > 255) {
      throw new Error('Setiap byte harus integer di rentang 0..255.');
    }
  }
  return new Uint8Array(safe);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const origin = sender.origin ?? sender.url ?? '';

  (async () => {
    switch (msg.type) {
      case 'THERMAL_PRINT': {
        const allowed = await isOriginAllowed(origin);
        if (!allowed) {
          sendResponse({ success: false, message: 'Domain tidak ada di whitelist.' });
          return;
        }

        try {
          await new Promise((resolve, reject) => {
            enqueuePrint({ payload: msg.payload, resolve, reject });
          });
          sendResponse({ success: true });
        } catch (error) {
          sendResponse({ success: false, message: error.message });
        }
        break;
      }

      case 'THERMAL_RAW': {
        const allowed = await isOriginAllowed(origin);
        if (!allowed) {
          sendResponse({ success: false, message: 'Domain tidak ada di whitelist.' });
          return;
        }

        try {
          if (!gattServer?.connected) {
            const paired = await getPairedDevice();
            await connectToDevice(paired?.id ?? null);
          }
          const bytes = normalizeRawBytes(msg.bytes);
          await writeBytes(bytes);
          sendResponse({ success: true });
        } catch (error) {
          sendResponse({ success: false, message: error.message });
        }
        break;
      }

      case 'CONNECT_DEVICE': {
        try {
          await connectToDevice(msg.deviceId ?? null);
          sendResponse({
            success: true,
            device: {
              id: bluetoothDevice?.id ?? null,
              name: bluetoothDevice?.name ?? null,
            },
          });
        } catch (error) {
          sendResponse({ success: false, message: error.message });
        }
        break;
      }

      case 'DISCONNECT_DEVICE': {
        await disconnectDevice();
        sendResponse({ success: true });
        break;
      }

      case 'GET_STATUS': {
        const paired = await getPairedDevice();
        sendResponse({ status: connectionStatus, device: paired });
        break;
      }

      case 'UPDATE_WHITELIST': {
        const domains = Array.isArray(msg.domains) ? msg.domains : [];
        await chrome.storage.local.set({ whitelist: domains });
        sendResponse({ success: true });
        break;
      }

      case 'GET_WHITELIST': {
        const list = await getWhitelist();
        sendResponse({ whitelist: list });
        break;
      }

      case 'TEST_PRINT': {
        try {
          if (!gattServer?.connected) {
            const paired = await getPairedDevice();
            await connectToDevice(paired?.id ?? null);
          }
          await new Promise((resolve, reject) => {
            enqueuePrint({
              payload: testReceiptPayload(),
              resolve,
              reject,
            });
          });
          sendResponse({ success: true });
        } catch (error) {
          sendResponse({ success: false, message: error.message });
        }
        break;
      }

      default:
        sendResponse({ success: false, message: `Unknown message type: ${msg.type}` });
    }
  })();

  return true;
});

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
