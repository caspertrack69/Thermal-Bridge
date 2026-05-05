'use strict';

const $ = (id) => document.getElementById(id);

const STATUS_LABELS = {
  connected: 'Tersambung',
  disconnected: 'Terputus',
  connecting: 'Menghubungkan...',
  error: 'Error',
};

let domains = [];
let toastTimer;

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

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) {
    throw new Error('Tab aktif tidak ditemukan.');
  }
  return tab.id;
}

async function sendToActiveTab(message) {
  try {
    const tabId = await getActiveTabId();
    const response = await chrome.tabs.sendMessage(tabId, message);
    return response ?? { success: false, message: 'Tidak ada respons dari halaman.' };
  } catch (error) {
    return {
      success: false,
      message:
        'Halaman target belum siap. Buka/refresh halaman web yang ingin dipakai print lalu coba lagi.',
    };
  }
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
  $('btnTest').innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="6 9 6 2 18 2 18 9"></polyline>
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path>
      <rect x="6" y="14" width="12" height="8"></rect>
    </svg>
    Cetak Test Print
  `;

  if (result?.success) {
    showToast('Test print berhasil!', 'success');
    await refreshStatus();
  } else {
    showToast(result?.message ?? 'Gagal mencetak.', 'error');
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
})();
