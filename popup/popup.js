'use strict';

const $ = (id) => document.getElementById(id);

const STATUS_LABELS = {
  connected: 'Tersambung',
  disconnected: 'Terputus',
  connecting: 'Menghubungkan...',
  error: 'Error',
};

const TEST_PRINT_BUTTON_HTML = `
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <polyline points="6 9 6 2 18 2 18 9"></polyline>
    <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path>
    <rect x="6" y="14" width="12" height="8"></rect>
  </svg>
  Cetak Test Print
`;

const PAGE_PRINT_BUTTON_HTML = 'Cetak Nota Halaman';
const RECEIPT_SELECTORS_KEY = 'receiptSelectors';

let domains = [];
let toastTimer;
let activeHost = '';

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((item) => item.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((item) => item.classList.remove('active'));
    tab.classList.add('active');
    $(`tab-${tab.dataset.tab}`).classList.add('active');
  });
});

function showToast(message, type = 'success') {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast ${type} visible`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 3500);
}

function applyStatus({ status, device }) {
  const dot = $('statusDot');
  const label = $('statusLabel');
  const deviceLabel = $('statusDevice');
  const card = $('deviceCard');

  dot.className = `status-dot ${status}`;
  label.textContent = STATUS_LABELS[status] ?? status;
  deviceLabel.textContent = device?.name ?? '';

  if (device?.name) {
    $('deviceName').textContent = device.name;
    $('deviceId').textContent = device.id ? `${device.id.slice(0, 24)}...` : '';
    card.classList.add('connected');
  } else {
    $('deviceName').textContent = '-';
    $('deviceId').textContent = 'Belum ada perangkat';
    card.classList.remove('connected');
  }

  $('btnDisconnect').disabled = status !== 'connected';
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) {
    throw new Error('Tab aktif tidak ditemukan.');
  }
  return tab;
}

function isRestrictedUrl(url) {
  if (!url) {
    return true;
  }

  const blockedSchemes = [
    'chrome://',
    'edge://',
    'about:',
    'chrome-extension://',
    'moz-extension://',
    'devtools://',
    'view-source:',
  ];

  return blockedSchemes.some((prefix) => url.startsWith(prefix));
}

async function ensureContentScript(tab) {
  if (isRestrictedUrl(tab.url)) {
    throw new Error(
      'Tab ini tidak bisa diakses extension. Buka halaman web biasa (http/https), lalu coba lagi.'
    );
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['content/content-script.js'],
  });
}

async function sendToActiveTab(message) {
  try {
    const tab = await getActiveTab();
    const response = await chrome.tabs.sendMessage(tab.id, message);
    return response ?? { success: false, message: 'Tidak ada respons dari halaman.' };
  } catch (firstError) {
    try {
      const tab = await getActiveTab();
      await ensureContentScript(tab);
      const response = await chrome.tabs.sendMessage(tab.id, message);
      return response ?? { success: false, message: 'Tidak ada respons dari halaman.' };
    } catch (secondError) {
    return {
      success: false,
      message: secondError?.message ?? firstError?.message ?? 'Gagal menghubungi halaman target.',
    };
    }
  }
}

function extractHostname(url) {
  try {
    const value = new URL(url);
    return value.hostname.toLowerCase();
  } catch {
    return '';
  }
}

function getSelectorMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  return { ...raw };
}

function updatePagePrintControls() {
  const enabled = Boolean(activeHost);
  $('selectorHost').textContent = activeHost || 'Tidak tersedia';
  $('btnSaveSelector').disabled = !enabled;
  $('btnPrintPage').disabled = !enabled;
}

async function loadPagePrintProfile() {
  try {
    const tab = await getActiveTab();
    if (isRestrictedUrl(tab.url)) {
      activeHost = '';
      $('receiptSelectorInput').value = '';
      updatePagePrintControls();
      return;
    }

    activeHost = extractHostname(tab.url);
    const data = await chrome.storage.local.get(RECEIPT_SELECTORS_KEY);
    const map = getSelectorMap(data[RECEIPT_SELECTORS_KEY]);
    $('receiptSelectorInput').value = activeHost ? map[activeHost] ?? '' : '';
    updatePagePrintControls();
  } catch {
    activeHost = '';
    $('receiptSelectorInput').value = '';
    updatePagePrintControls();
  }
}

async function savePagePrintProfile() {
  if (!activeHost) {
    showToast('Halaman aktif tidak mendukung mode ini.', 'error');
    return;
  }

  const selector = $('receiptSelectorInput').value.trim();
  const data = await chrome.storage.local.get(RECEIPT_SELECTORS_KEY);
  const map = getSelectorMap(data[RECEIPT_SELECTORS_KEY]);

  if (selector) {
    map[activeHost] = selector;
  } else {
    delete map[activeHost];
  }

  await chrome.storage.local.set({ [RECEIPT_SELECTORS_KEY]: map });
  showToast(selector ? 'Selector tersimpan untuk host ini.' : 'Selector default (auto-detect) dipakai.', 'success');
}

async function refreshStatus() {
  const result = await sendToActiveTab({ type: 'GET_STATUS_FROM_POPUP' });
  if (result?.success) {
    applyStatus(result);
  } else {
    applyStatus({ status: 'disconnected', device: null });
  }
}

async function loadWhitelist() {
  const data = await chrome.storage.local.get('whitelist');
  domains = Array.isArray(data.whitelist) ? data.whitelist : [];
  renderDomains();
}

async function saveDomains() {
  await chrome.storage.local.set({ whitelist: domains });
  renderDomains();
}

function renderDomains() {
  const list = $('domainList');
  const empty = $('whitelistEmpty');
  list.innerHTML = '';

  if (domains.length === 0) {
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';
  domains.forEach((domain, index) => {
    const li = document.createElement('li');
    li.className = 'domain-item';
    li.innerHTML = `<span>${domain}</span><button class="domain-remove" data-idx="${index}" title="Hapus">x</button>`;
    li.querySelector('.domain-remove').addEventListener('click', () => removeDomain(index));
    list.appendChild(li);
  });
}

function addDomain() {
  const input = $('whitelistInput');
  const value = input.value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');

  if (!value) {
    return;
  }

  if (domains.includes(value)) {
    showToast('Domain sudah ada.', 'error');
    return;
  }

  domains.push(value);
  input.value = '';
  saveDomains();
  showToast(`${value} ditambahkan.`, 'success');
}

function removeDomain(index) {
  domains.splice(index, 1);
  saveDomains();
}

$('btnConnect').addEventListener('click', async () => {
  $('btnConnect').disabled = true;
  applyStatus({ status: 'connecting' });

  const result = await sendToActiveTab({ type: 'CONNECT_DEVICE_FROM_POPUP' });
  $('btnConnect').disabled = false;

  if (result?.success) {
    showToast('Printer berhasil tersambung!', 'success');
    await refreshStatus();
  } else {
    const msg = result?.message ?? 'Gagal tersambung.';
    if (
      /gesture|activation|chooser|cancelled|canceled|requestdevice/i.test(msg)
    ) {
      showToast('Klik tombol print/connect di halaman web agar izin Bluetooth muncul.', 'error');
    } else {
      showToast(msg, 'error');
    }
    applyStatus({ status: 'error', device: null });
  }
});

$('btnDisconnect').addEventListener('click', async () => {
  const result = await sendToActiveTab({ type: 'DISCONNECT_DEVICE_FROM_POPUP' });
  if (result?.success) {
    showToast('Printer diputus.', 'success');
    applyStatus({ status: 'disconnected', device: null });
  } else {
    showToast(result?.message ?? 'Gagal memutus koneksi.', 'error');
  }
});

$('btnTest').addEventListener('click', async () => {
  $('btnTest').disabled = true;
  $('btnTest').textContent = 'Mencetak...';
  const result = await sendToActiveTab({ type: 'TEST_PRINT_FROM_POPUP' });
  $('btnTest').disabled = false;
  $('btnTest').innerHTML = TEST_PRINT_BUTTON_HTML;

  if (result?.success) {
    showToast('Test print berhasil!', 'success');
    await refreshStatus();
  } else {
    showToast(result?.message ?? 'Gagal mencetak.', 'error');
  }
});

$('btnSaveSelector').addEventListener('click', savePagePrintProfile);

$('btnPrintPage').addEventListener('click', async () => {
  if (!activeHost) {
    showToast('Tab ini tidak mendukung mode cetak halaman.', 'error');
    return;
  }

  const button = $('btnPrintPage');
  button.disabled = true;
  button.textContent = 'Mencetak...';

  const selector = $('receiptSelectorInput').value.trim();
  const result = await sendToActiveTab({
    type: 'PRINT_PAGE_RECEIPT_FROM_POPUP',
    selector,
    width: 32,
  });

  button.disabled = false;
  button.textContent = PAGE_PRINT_BUTTON_HTML;

  if (result?.success) {
    showToast(result.message ?? 'Cetak dari halaman berhasil.', 'success');
    await refreshStatus();
  } else {
    showToast(result?.message ?? 'Gagal mencetak dari halaman.', 'error');
  }
});

$('receiptSelectorInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    savePagePrintProfile();
  }
});

$('btnAddDomain').addEventListener('click', addDomain);
$('whitelistInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    addDomain();
  }
});

document.querySelectorAll('.copy-btn').forEach((button) => {
  button.addEventListener('click', async () => {
    const target = $(button.dataset.target);
    const text = target?.querySelector('code')?.textContent ?? '';
    await navigator.clipboard.writeText(text);
    button.textContent = 'Tersalin!';
    button.classList.add('copied');
    setTimeout(() => {
      button.textContent = 'Salin';
      button.classList.remove('copied');
    }, 1500);
  });
});

(async () => {
  await refreshStatus();
  await loadWhitelist();
  await loadPagePrintProfile();
})();
