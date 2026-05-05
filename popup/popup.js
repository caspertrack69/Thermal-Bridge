'use strict';

// ── Helpers ────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const bg = (type, data = {}) => new Promise((resolve) => {
  chrome.runtime.sendMessage({ type, ...data }, resolve);
});

// ── Tab system ────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(s => s.classList.remove('active'));
    tab.classList.add('active');
    $('tab-' + tab.dataset.tab).classList.add('active');
  });
});

// ── Status rendering ─────────────────────────────────────────
const STATUS_LABELS = {
  connected:    'Tersambung',
  disconnected: 'Terputus',
  connecting:   'Menghubungkan…',
  error:        'Error',
};

function applyStatus({ status, device }) {
  const dot   = $('statusDot');
  const label = $('statusLabel');
  const dev   = $('statusDevice');
  const card  = $('deviceCard');

  dot.className   = 'status-dot ' + status;
  label.textContent = STATUS_LABELS[status] ?? status;
  dev.textContent   = device?.name ?? '';

  if (device?.name) {
    $('deviceName').textContent = device.name;
    $('deviceId').textContent   = device.id ? device.id.slice(0, 24) + '…' : '';
    card.classList.add('connected');
  } else {
    $('deviceName').textContent = '—';
    $('deviceId').textContent   = 'Belum ada perangkat';
    card.classList.remove('connected');
  }

  $('btnDisconnect').disabled = status !== 'connected';
}

// ── Toast ─────────────────────────────────────────────────────
let _toastTimer;
function showToast(message, type = 'success') {
  const el = $('toast');
  el.textContent = message;
  el.className   = `toast ${type} visible`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('visible'), 3500);
}

// ── Connect ───────────────────────────────────────────────────
$('btnConnect').addEventListener('click', async () => {
  $('btnConnect').disabled = true;
  applyStatus({ status: 'connecting' });
  const res = await bg('CONNECT_DEVICE');
  $('btnConnect').disabled = false;
  if (res?.success) {
    showToast('Printer berhasil tersambung!', 'success');
    await refreshStatus();
  } else {
    showToast(res?.message ?? 'Gagal tersambung.', 'error');
    applyStatus({ status: 'error' });
  }
});

// ── Disconnect ────────────────────────────────────────────────
$('btnDisconnect').addEventListener('click', async () => {
  await bg('DISCONNECT_DEVICE');
  showToast('Printer diputus.', 'success');
  applyStatus({ status: 'disconnected', device: null });
});

// ── Test Print ────────────────────────────────────────────────
$('btnTest').addEventListener('click', async () => {
  $('btnTest').disabled = true;
  $('btnTest').textContent = 'Mencetak…';
  const res = await bg('TEST_PRINT');
  $('btnTest').disabled = false;
  $('btnTest').innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="6 9 6 2 18 2 18 9"/>
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
      <rect x="6" y="14" width="12" height="8"/>
    </svg>
    Cetak Test Print`;
  if (res?.success) {
    showToast('Test print berhasil!', 'success');
  } else {
    showToast(res?.message ?? 'Gagal mencetak.', 'error');
  }
});

// ── Status refresh ────────────────────────────────────────────
async function refreshStatus() {
  const res = await bg('GET_STATUS');
  if (res) applyStatus(res);
}

// ── Whitelist ─────────────────────────────────────────────────
let domains = [];

async function loadWhitelist() {
  const res = await bg('GET_WHITELIST');
  domains = res?.whitelist ?? [];
  renderDomains();
}

function renderDomains() {
  const list  = $('domainList');
  const empty = $('whitelistEmpty');
  list.innerHTML = '';
  if (domains.length === 0) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  domains.forEach((domain, idx) => {
    const li   = document.createElement('li');
    li.className = 'domain-item';
    li.innerHTML = `<span>${domain}</span>
      <button class="domain-remove" data-idx="${idx}" title="Hapus">✕</button>`;
    li.querySelector('.domain-remove').addEventListener('click', () => removeDomain(idx));
    list.appendChild(li);
  });
}

async function saveDomains() {
  await bg('UPDATE_WHITELIST', { domains });
  renderDomains();
}

function addDomain() {
  const input = $('whitelistInput');
  const value = input.value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!value) return;
  if (domains.includes(value)) {
    showToast('Domain sudah ada.', 'error');
    return;
  }
  domains.push(value);
  input.value = '';
  saveDomains();
  showToast(`${value} ditambahkan.`, 'success');
}

function removeDomain(idx) {
  domains.splice(idx, 1);
  saveDomains();
}

$('btnAddDomain').addEventListener('click', addDomain);
$('whitelistInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addDomain(); });

// ── Copy buttons ──────────────────────────────────────────────
document.querySelectorAll('.copy-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = $(btn.dataset.target);
    const text   = target?.querySelector('code')?.textContent ?? '';
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = 'Tersalin!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = 'Salin';
        btn.classList.remove('copied');
      }, 1500);
    });
  });
});

// ── Listen for SW broadcasts ──────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATUS_UPDATE') applyStatus(msg);
});

// ── Init ──────────────────────────────────────────────────────
(async () => {
  await refreshStatus();
  await loadWhitelist();
})();
