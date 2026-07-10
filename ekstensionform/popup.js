/**
 * popup.js — Google Form Autofill PLN v3.1
 * Memicu otomatisasi di background.js dan memantau statusnya.
 * Mendukung multi-email bergilir otomatis, loop foto, & counter upload.
 * Foto akan loop: 1→limit→1→limit... sampai user klik Stop.
 */

// ── UI ────────────────────────────────────────────────────────────────────────
const btnStart      = document.getElementById('btnStart');
const btnStop       = document.getElementById('btnStop');
const inputNama     = document.getElementById('inputNama');
const inputEmail    = document.getElementById('inputEmail');
const inputFolder   = document.getElementById('inputFolder');
const inputLimit    = document.getElementById('inputLimit');
const inputStartFrom = document.getElementById('inputStartFrom');
const statusBar     = document.getElementById('statusBar');
const statusText    = document.getElementById('statusText');
const emailCountNum = document.getElementById('emailCountNum');
const counterValue  = document.getElementById('counterValue');

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
  inputStartFrom.disabled = disabled;
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

  if (changes.uploadCount !== undefined) {
    counterValue.textContent = changes.uploadCount.newValue || 0;
  }
});

// ── Inisialisasi: Pulihkan status terakhir ─────────────────────────────────────
chrome.storage.local.get([
  'statusText', 'statusMode', 'isRunning', 
  'lastNama', 'lastEmails', 'lastFolder', 'lastLimit', 'lastStartFrom',
  'uploadCount'
], (data) => {
  if (data.lastNama)   inputNama.value   = data.lastNama;
  if (data.lastEmails && Array.isArray(data.lastEmails)) {
    inputEmail.value = data.lastEmails.join('\n');
    emailCountNum.textContent = data.lastEmails.length;
  }
  if (data.lastFolder) inputFolder.value = data.lastFolder;
  if (data.lastLimit)  inputLimit.value  = data.lastLimit;
  if (data.lastStartFrom && data.lastStartFrom > 1) inputStartFrom.value = data.lastStartFrom;

  // Restore counter
  counterValue.textContent = data.uploadCount || 0;

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
  const startFrom  = parseInt(inputStartFrom.value, 10) || 1;

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
    setStatus('⚠️ Jumlah foto harus minimal 1!', 'error');
    inputLimit.focus();
    return;
  }
  if (startFrom < 1 || startFrom > limit) {
    setStatus(`⚠️ "Mulai dari" harus antara 1 - ${limit}!`, 'error');
    inputStartFrom.focus();
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

  // Email yang dipakai di iterasi pertama (berdasarkan startFrom)
  const firstEmail = emails[(startFrom - 1) % emails.length];

  // Simpan input terakhir ke storage dan nyalakan flag botActive
  await chrome.storage.local.set({
    lastNama: nama,
    lastEmails: emails,
    lastFolder: folderName,
    lastLimit: limit,
    lastStartFrom: startFrom,
    
    nama: nama,
    emails: emails,
    email: firstEmail,
    folderName: folderName,
    limit: limit,              // Jumlah foto di folder (untuk loop)
    currentIndex: startFrom,   // Mulai dari angka yang ditentukan
    tabId: tab.id,
    formUrl: formUrl,
    uploadCount: 0,            // Reset counter
    
    botActive: true,
    isRunning: true,
    statusText: `🚀 Memulai: Foto ${startFrom}/${limit} — ${firstEmail} (loop sampai Stop)`,
    statusMode: 'running'
  });

  // Reset counter di UI
  counterValue.textContent = 0;

  // Arahkan ke URL form awal dan muat ulang untuk memulai iterasi 1
  await chrome.tabs.update(tab.id, { url: formUrl });
});

// ── Klik Tombol Stop ─────────────────────────────────────────────────────────
btnStop.addEventListener('click', async () => {
  const data = await chrome.storage.local.get(['uploadCount']);
  const count = data.uploadCount || 0;
  await chrome.storage.local.set({
    botActive: false,
    isRunning: false,
    statusText: `⏹ Dihentikan oleh pengguna. Total upload: ${count}`,
    statusMode: 'error'
  });
});
