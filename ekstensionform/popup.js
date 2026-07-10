/**
 * popup.js — Google Form Autofill PLN v2.5
 * Memicu otomatisasi di background.js dan memantau statusnya.
 * Mendukung multi-email yang bergilir otomatis setiap iterasi.
 */

// ── UI ────────────────────────────────────────────────────────────────────────
const btnStart      = document.getElementById('btnStart');
const btnStop       = document.getElementById('btnStop');
const inputNama     = document.getElementById('inputNama');
const inputEmail    = document.getElementById('inputEmail');
const inputFolder   = document.getElementById('inputFolder');
const inputLimit    = document.getElementById('inputLimit');
const statusBar     = document.getElementById('statusBar');
const statusText    = document.getElementById('statusText');
const emailCountNum = document.getElementById('emailCountNum');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parse textarea menjadi array email bersih */
function parseEmails(raw) {
  return raw
    .split('\n')
    .map(e => e.trim())
    .filter(e => e.length > 0 && e.includes('@'));
}

function setStatus(msg, mode = 'idle') {
  statusText.textContent = msg;
  statusBar.className    = 'status-bar ' + mode;
}

function setFormDisabled(disabled) {
  btnStart.disabled    = disabled;
  btnStop.disabled     = !disabled;
  inputNama.disabled   = disabled;
  inputEmail.disabled  = disabled;
  inputFolder.disabled = disabled;
  inputLimit.disabled  = disabled;
}

// ── Hitung email secara real-time ─────────────────────────────────────────────
inputEmail.addEventListener('input', () => {
  const emails = parseEmails(inputEmail.value);
  emailCountNum.textContent = emails.length;
});

// ── Hubungkan perubahan storage ke UI ──────────────────────────────────────────
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  if (changes.statusText) {
    setStatus(changes.statusText.newValue, changes.statusMode?.newValue || 'idle');
  }

  if (changes.isRunning) {
    setFormDisabled(changes.isRunning.newValue);
  }
});

// ── Inisialisasi: Pulihkan status terakhir ─────────────────────────────────────
chrome.storage.local.get([
  'statusText', 'statusMode', 'isRunning', 
  'lastNama', 'lastEmails', 'lastFolder', 'lastLimit'
], (data) => {
  if (data.lastNama)   inputNama.value   = data.lastNama;
  if (data.lastEmails && Array.isArray(data.lastEmails)) {
    inputEmail.value = data.lastEmails.join('\n');
    emailCountNum.textContent = data.lastEmails.length;
  }
  if (data.lastFolder) inputFolder.value = data.lastFolder;
  if (data.lastLimit)  inputLimit.value  = data.lastLimit;

  if (data.statusText) {
    setStatus(data.statusText, data.statusMode || 'idle');
  }

  setFormDisabled(!!data.isRunning);
});

// ── Klik Tombol Start ────────────────────────────────────────────────────────
btnStart.addEventListener('click', async () => {
  const nama       = inputNama.value.trim();
  const emails     = parseEmails(inputEmail.value);
  const folderName = inputFolder.value.trim();
  const limit      = parseInt(inputLimit.value, 10);

  if (!nama) {
    setStatus('⚠️ Nama kosong!', 'error');
    inputNama.focus();
    return;
  }
  if (emails.length === 0) {
    setStatus('⚠️ Masukkan minimal satu email yang valid!', 'error');
    inputEmail.focus();
    return;
  }
  if (!folderName) {
    setStatus('⚠️ Nama folder kosong!', 'error');
    inputFolder.focus();
    return;
  }
  if (isNaN(limit) || limit < 1) {
    setStatus('⚠️ Limit foto harus minimal 1!', 'error');
    inputLimit.focus();
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus('❌ Tidak ada tab aktif.', 'error');
    return;
  }
  if (!tab.url?.includes('docs.google.com/forms')) {
    setStatus('❌ Tab aktif bukan Google Forms!', 'error');
    return;
  }

  let formUrl = tab.url;
  if (formUrl.includes('/formResponse')) {
    formUrl = formUrl.replace('/formResponse', '/viewform');
  }

  // Email pertama yang akan dipakai di iterasi 1
  const firstEmail = emails[0];

  // Simpan input terakhir ke storage dan nyalakan flag botActive
  await chrome.storage.local.set({
    lastNama: nama,
    lastEmails: emails,
    lastFolder: folderName,
    lastLimit: limit,
    
    nama: nama,
    emails: emails,          // Array email untuk rotasi
    email: firstEmail,       // Email iterasi saat ini (untuk backward compat)
    folderName: folderName,
    limit: limit,
    currentIndex: 1,         // Mulai dari 1
    tabId: tab.id,
    formUrl: formUrl,
    
    botActive: true,
    isRunning: true,
    statusText: `🚀 Memulai batch: Iterasi 1 — ${firstEmail}`,
    statusMode: 'running'
  });

  // Arahkan ke URL form awal dan muat ulang untuk memulai iterasi 1
  await chrome.tabs.update(tab.id, { url: formUrl });
});

// ── Klik Tombol Stop ─────────────────────────────────────────────────────────
btnStop.addEventListener('click', async () => {
  await chrome.storage.local.set({
    botActive: false,
    isRunning: false,
    statusText: '⏹ Dihentikan oleh pengguna.',
    statusMode: 'error'
  });
});
