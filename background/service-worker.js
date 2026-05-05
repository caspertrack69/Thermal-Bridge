/**
 * Thermal Bridge – Service Worker (MV3)
 * Manages: Bluetooth connection, print queue, domain whitelist,
 *          device persistence, and status broadcasting.
 */

import { buildReceipt } from '../lib/escpos-encoder.js';

// ── BLE constants ──────────────────────────────────────────────────────────
// Generic Serial Port Profile over BLE (most BT thermal printers)
const SERVICE_UUID = '000018f0-0000-1000-8000-00805f9b34fb';
const CHAR_UUID    = '00002af1-0000-1000-8000-00805f9b34fb';

// Fallback: Nordic UART Service (common on Epson, Bixolon, etc.)
const NORDIC_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NORDIC_TX      = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';

// ── State ──────────────────────────────────────────────────────────────────
let bluetoothDevice      = null;
let gattServer           = null;
let printCharacteristic  = null;
let printQueue           = [];
let isProcessingQueue    = false;
let connectionStatus     = 'disconnected'; // 'disconnected' | 'connecting' | 'connected' | 'error'

// ── Storage helpers ────────────────────────────────────────────────────────
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

// ── Status broadcast ──────────────────────────────────────────────────────
function broadcastStatus(status, extra = {}) {
  connectionStatus = status;
  chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', status, ...extra }).catch(() => {});
}

// ── Connect to a Bluetooth device ─────────────────────────────────────────
async function connectToDevice(deviceId = null) {
  try {
    broadcastStatus('connecting');

    // If we have a previously paired device, try to reconnect
    if (deviceId) {
      const devices = await navigator.bluetooth.getDevices();
      const saved   = devices.find(d => d.id === deviceId);
      if (saved) {
        bluetoothDevice = saved;
      }
    }

    // If no saved device found, scan
    if (!bluetoothDevice) {
      bluetoothDevice = await navigator.bluetooth.requestDevice({
        filters: [{ services: [SERVICE_UUID] }, { services: [NORDIC_SERVICE] }],
        optionalServices: [SERVICE_UUID, NORDIC_SERVICE],
      });
    }

    bluetoothDevice.addEventListener('gattserverdisconnected', onDisconnected);

    gattServer = await bluetoothDevice.gatt.connect();

    // Try primary service, fallback to Nordic UART
    let service;
    let charUuid = CHAR_UUID;
    try {
      service = await gattServer.getPrimaryService(SERVICE_UUID);
    } catch {
      service  = await gattServer.getPrimaryService(NORDIC_SERVICE);
      charUuid = NORDIC_TX;
    }

    printCharacteristic = await service.getCharacteristic(charUuid);

    const paired = { id: bluetoothDevice.id, name: bluetoothDevice.name ?? 'Printer' };
    await savePairedDevice(paired);

    broadcastStatus('connected', { device: paired });
  } catch (err) {
    broadcastStatus('error', { message: err.message });
    throw err;
  }
}

// ── Disconnect ────────────────────────────────────────────────────────────
async function disconnectDevice() {
  if (gattServer?.connected) gattServer.disconnect();
  onDisconnected();
}

function onDisconnected() {
  gattServer          = null;
  printCharacteristic = null;
  broadcastStatus('disconnected');
}

// ── Write bytes to printer (chunked) ─────────────────────────────────────
const CHUNK_SIZE = 512;

async function writeBytes(bytes) {
  if (!printCharacteristic) throw new Error('Printer tidak terhubung.');

  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    const chunk = bytes.slice(offset, offset + CHUNK_SIZE);
    await printCharacteristic.writeValueWithoutResponse(chunk);
    // Small delay between chunks to avoid buffer overflow
    await sleep(20);
  }
}

// ── Print Queue ──────────────────────────────────────────────────────────
function enqueuePrint(job) {
  printQueue.push(job);
  if (!isProcessingQueue) processQueue();
}

async function processQueue() {
  isProcessingQueue = true;
  while (printQueue.length > 0) {
    const job = printQueue.shift();
    try {
      // Auto-reconnect if needed
      if (!gattServer?.connected) {
        const paired = await getPairedDevice();
        await connectToDevice(paired?.id);
      }
      const bytes = buildReceipt(job.payload);
      await writeBytes(bytes);
      job.resolve({ success: true });
    } catch (err) {
      job.reject({ success: false, message: err.message });
    }
  }
  isProcessingQueue = false;
}

// ── Domain whitelist check ────────────────────────────────────────────────
async function isOriginAllowed(origin) {
  const whitelist = await getWhitelist();
  if (whitelist.length === 0) return true; // no whitelist = allow all
  try {
    const { hostname } = new URL(origin);
    return whitelist.some(entry => hostname === entry || hostname.endsWith('.' + entry));
  } catch {
    return false;
  }
}

// ── Message handler (from content-script + popup) ─────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const origin = sender.origin ?? sender.url ?? '';

  (async () => {
    switch (msg.type) {

      // ── API: print receipt ────────────────────────────────────
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
        } catch (err) {
          sendResponse({ success: false, message: err.message });
        }
        break;
      }

      // ── API: raw ESC/POS bytes ────────────────────────────────
      case 'THERMAL_RAW': {
        const allowed = await isOriginAllowed(origin);
        if (!allowed) {
          sendResponse({ success: false, message: 'Domain tidak ada di whitelist.' });
          return;
        }
        try {
          if (!gattServer?.connected) {
            const paired = await getPairedDevice();
            await connectToDevice(paired?.id);
          }
          const bytes = new Uint8Array(msg.bytes);
          await writeBytes(bytes);
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, message: err.message });
        }
        break;
      }

      // ── Popup: scan & connect ─────────────────────────────────
      case 'CONNECT_DEVICE': {
        try {
          await connectToDevice(msg.deviceId ?? null);
          sendResponse({ success: true, device: { id: bluetoothDevice?.id, name: bluetoothDevice?.name } });
        } catch (err) {
          sendResponse({ success: false, message: err.message });
        }
        break;
      }

      // ── Popup: disconnect ─────────────────────────────────────
      case 'DISCONNECT_DEVICE': {
        await disconnectDevice();
        sendResponse({ success: true });
        break;
      }

      // ── Popup: get current status ─────────────────────────────
      case 'GET_STATUS': {
        const paired = await getPairedDevice();
        sendResponse({ status: connectionStatus, device: paired });
        break;
      }

      // ── Popup: update whitelist ───────────────────────────────
      case 'UPDATE_WHITELIST': {
        await chrome.storage.local.set({ whitelist: msg.domains });
        sendResponse({ success: true });
        break;
      }

      // ── Popup: get whitelist ──────────────────────────────────
      case 'GET_WHITELIST': {
        const list = await getWhitelist();
        sendResponse({ whitelist: list });
        break;
      }

      // ── Popup: test print ─────────────────────────────────────
      case 'TEST_PRINT': {
        try {
          if (!gattServer?.connected) {
            const paired = await getPairedDevice();
            await connectToDevice(paired?.id);
          }
          await new Promise((resolve, reject) => {
            enqueuePrint({
              payload: testReceiptPayload(),
              resolve,
              reject,
            });
          });
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, message: err.message });
        }
        break;
      }

      default:
        sendResponse({ success: false, message: 'Unknown message type: ' + msg.type });
    }
  })();

  return true; // keep channel open for async sendResponse
});

// ── Keep-alive ping (prevents SW from sleeping on MV3) ────────────────────
chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    // no-op, just wakes the SW
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function testReceiptPayload() {
  return {
    header: {
      title:      'THERMAL BRIDGE',
      subtitle:   'Test Print',
      address:    'Jl. Contoh No. 1, Jakarta',
      phone:      '021-12345678',
      receipt_no: 'TEST-001',
      cashier:    'System',
    },
    items: [
      { name: 'Produk Test A',   qty: 2, price: 15000 },
      { name: 'Produk Test B',   qty: 1, price: 25000 },
      { name: 'Produk Panjang Sekali Namanya', qty: 3, price: 9900 },
    ],
    subtotal: 99700,
    discount: 0,
    tax:      0,
    total:    99700,
    payment:  { method: 'CASH', amount: 100000, change: 300 },
    footer:   'Terima kasih sudah menggunakan\nThermal Bridge!',
    width:    32,
  };
}
