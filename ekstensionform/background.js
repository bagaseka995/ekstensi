/**
 * background.js — Service Worker (Manifest V3)
 * Google Form Autofill PLN v3.0 (Batch Mode & Auto Drive Picker)
 */

const sleep = ms => new Promise(r => setTimeout(r, ms));

let isBotRunning = false;

// Helper: update status di storage agar popup bisa baca
async function updateStatus(msg, mode = 'idle', isRunning = true) {
  console.log(`[BG-STATUS] ${msg} (${mode})`);
  await chrome.storage.local.set({
    statusText: msg,
    statusMode: mode,
    isRunning: isRunning
  });
}

// Helper: cek apakah bot dihentikan secara manual oleh user
async function checkStopped() {
  const data = await chrome.storage.local.get(['botActive', 'isRunning']);
  if (data.botActive === false || data.isRunning === false) {
    throw new Error('Dihentikan oleh pengguna.');
  }
}

// ── CDP: klik nyata (isTrusted=true) ─────────────────────────────────────────
async function cdpClick(tabId, x, y) {
  const tgt  = { tabId };
  const base = { x: Math.round(x), y: Math.round(y), button: 'left', modifiers: 0 };
  await chrome.debugger.sendCommand(tgt, 'Input.dispatchMouseEvent',
    { ...base, type: 'mousePressed', buttons: 1, clickCount: 1 });
  await sleep(100);
  await chrome.debugger.sendCommand(tgt, 'Input.dispatchMouseEvent',
    { ...base, type: 'mouseReleased', buttons: 0, clickCount: 1 });
  await sleep(80);
}

// ── CDP: tekan tombol keyboard ────────────────────────────────────────────────
async function cdpKey(tabId, key, keyCode) {
  const tgt  = { tabId };
  const base = { key, code: key, keyCode, windowsVirtualKeyCode: keyCode, modifiers: 0 };
  await chrome.debugger.sendCommand(tgt, 'Input.dispatchKeyEvent', { ...base, type: 'keyDown' });
  await sleep(60);
  await chrome.debugger.sendCommand(tgt, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

// ── Jalankan kode di halaman & kembalikan hasilnya ───────────────────────────
async function inPage(tabId, func, args = []) {
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
    return r?.result ?? null;
  } catch (err) {
    console.error('[BG-INPAGE-ERR]', err);
    return null;
  }
}

// ── STEP: Isi Nama & Email ───────────────────────────────────────────────────
async function fillInputs(tabId, nama, email) {
  await inPage(tabId, (nama, email) => {
    const inputs = [...document.querySelectorAll(
      'input[type="text"], input[type="email"], input:not([type])'
    )].filter(el => el.offsetParent !== null);

    function fill(el, val) {
      const proto  = HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter ? setter.call(el, val) : (el.value = val);
      ['input', 'change', 'blur'].forEach(t =>
        el.dispatchEvent(new Event(t, { bubbles: true }))
      );
    }
    if (inputs[0]) fill(inputs[0], nama);
    if (inputs[1]) fill(inputs[1], email);
    return inputs.length;
  }, [nama, email]);
}

// ── STEP: Dapatkan koordinat dropdown trigger ────────────────────────────────
async function getTriggerCoords(tabId, idx) {
  return inPage(tabId, (idx) => {
    const all = [
      ...document.querySelectorAll('.quantumWizMenuPaperselectEl'),
      ...document.querySelectorAll('.appsMaterialWizMenuPaperselectEl'),
      ...[...document.querySelectorAll('[role="listbox"]')]
        .filter(el => el.getAttribute('aria-expanded') !== 'true'),
    ].filter((el, i, arr) => arr.indexOf(el) === i)
     .filter(el => el.offsetParent !== null);

    const el = all[idx];
    if (!el) return null;

    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();

    // DOM click as backup
    try {
      ['mousedown', 'mouseup', 'click'].forEach(type => {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      });
    } catch (e) {}

    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, [idx]);
}

// ── STEP: Dapatkan koordinat opsi dari dropdown ──────────────────────────────
async function getOptionCoords(tabId, nilai) {
  return inPage(tabId, (nilai) => {
    const cleanVal = nilai.replace(/\s+/g, ' ').trim().toLowerCase();

    const candidates = [
      ...document.querySelectorAll('[role="option"]'),
      ...document.querySelectorAll('[data-value]'),
      ...document.querySelectorAll('.quantumWizMenuPaperselectOption'),
      ...document.querySelectorAll('.appsMaterialWizMenuPaperselectOption'),
      ...document.querySelectorAll('li'),
      ...document.querySelectorAll('[role="listitem"]')
    ];

    const matches = candidates.filter(el => {
      if (el.offsetParent === null) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return false;

      const dataVal = (el.getAttribute?.('data-value') ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (dataVal.includes(cleanVal)) return true;

      const txt = el.textContent.replace(/\s+/g, ' ').trim().toLowerCase();
      return txt.includes(cleanVal);
    });

    if (matches.length === 0) return null;

    matches.sort((a, b) => {
      const aIsOpt = a.getAttribute?.('role') === 'option' || a.className?.toLowerCase().includes('option');
      const bIsOpt = b.getAttribute?.('role') === 'option' || b.className?.toLowerCase().includes('option');
      if (aIsOpt && !bIsOpt) return -1;
      if (!aIsOpt && bIsOpt) return 1;
      return a.children.length - b.children.length;
    });

    const el = matches[0];
    el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    const r = el.getBoundingClientRect();

    // DOM click as backup
    try {
      ['mousedown', 'mouseup', 'click'].forEach(type => {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      });
    } catch (e) {}

    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, [nilai]);
}

// ── STEP: Pilih Dropdown ─────────────────────────────────────────────────────
async function pilihDropdown(tabId, idx, nilai) {
  const tCoords = await getTriggerCoords(tabId, idx);
  if (!tCoords) throw new Error(`Dropdown ke-${idx} tidak ditemukan.`);

  await cdpClick(tabId, tCoords.x, tCoords.y);
  await sleep(1500);

  const BATAS = Date.now() + 7000;
  let oCoords  = null;

  while (Date.now() < BATAS) {
    oCoords = await getOptionCoords(tabId, nilai);
    if (oCoords) break;
    await sleep(350);
  }

  if (!oCoords) {
    const ada = await inPage(tabId, () => {
      const candidates = [
        ...document.querySelectorAll('[role="option"]'),
        ...document.querySelectorAll('[data-value]'),
        ...document.querySelectorAll('.quantumWizMenuPaperselectOption'),
        ...document.querySelectorAll('.appsMaterialWizMenuPaperselectOption'),
        ...document.querySelectorAll('li')
      ];
      return [...new Set(candidates.map(e => e.textContent.replace(/\s+/g, ' ').trim()))]
        .filter(t => t && t.length > 0 && t.length < 100)
        .slice(0, 25);
    });
    throw new Error(
      `"${nilai}" tidak muncul dalam 7 detik. Tersedia: [${(ada ?? []).join(', ')}]`
    );
  }

  await cdpClick(tabId, oCoords.x, oCoords.y);
  await sleep(900);

  const terpilih = await inPage(tabId, (idx, nilai) => {
    const all = [
      ...document.querySelectorAll('.quantumWizMenuPaperselectEl'),
      ...document.querySelectorAll('.appsMaterialWizMenuPaperselectEl'),
      ...[...document.querySelectorAll('[role="listbox"]')]
        .filter(el => el.getAttribute('aria-expanded') !== 'true'),
    ].filter((el, i, arr) => arr.indexOf(el) === i)
     .filter(el => el.offsetParent !== null);
    const el = all[idx];
    if (!el) return false;
    return el.textContent.trim().toLowerCase().includes(nilai.toLowerCase());
  }, [idx, nilai]);

  if (!terpilih) {
    console.warn(`[BG-AUTOFILL] Verifikasi gagal untuk "${nilai}", coba keyboard Enter…`);
    await cdpKey(tabId, 'Enter', 13);
    await sleep(600);
  }

  console.log(`[BG-AUTOFILL] Dropdown[${idx}] → "${nilai}" ✅`);
}

// ── STEP: Klik Berikutnya ────────────────────────────────────────────────────
async function klikBerikutnya(tabId) {
  const nCoords = await inPage(tabId, () => {
    const tombol =
      [...document.querySelectorAll('[role="button"]')].find(el => {
        const t = el.textContent.trim().toLowerCase();
        return t === 'berikutnya' || t === 'next' || t === 'selanjutnya';
      }) ||
      document.querySelector('[jsname="OCpkoe"]') ||
      document.querySelector('[jsname="P1ekSe"]');
    if (!tombol) return null;
    const r = tombol.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (!nCoords) throw new Error('Tombol Berikutnya tidak ditemukan.');

  const sebelum = await inPage(tabId, () =>
    document.querySelector('input[name="pageHistory"]')?.value ?? null
  );

  await cdpClick(tabId, nCoords.x, nCoords.y);

  for (let i = 0; i < 50; i++) {
    await sleep(200);
    const sekarang = await inPage(tabId, () =>
      document.querySelector('input[name="pageHistory"]')?.value ?? null
    );
    if (sekarang !== sebelum) {
      await sleep(700);
      return;
    }
  }

  const errMsg = await inPage(tabId, () =>
    document.querySelector('[role="alert"]')?.textContent?.trim() ?? ''
  );
  throw new Error(`Halaman tidak berganti (10 detik). ${errMsg.slice(0, 120)}`);
}

// ── OTOMASI DI DALAM IFRAME GOOGLE DRIVE PICKER ──────────────────────────────
function runInsidePickerFrame(folderName, index) {
  // Cek apakah kita berada di domain docs.google.com/picker
  if (!window.location.href.includes('docs.google.com/picker')) {
    return null;
  }

  // Inisialisasi state di window jika belum ada untuk melacak apakah folder sudah dibuka
  if (window.__pickerFolderOpened === undefined) {
    window.__pickerFolderOpened = false;
  }

  console.log(`[PICKER-IFRAME] FolderOpened: ${window.__pickerFolderOpened}, Kueri: "${folderName}" -> "${index}"`);

  const searchInput = document.querySelector('input[type="text"], input[aria-label*="Search" i], input[aria-label*="Cari" i]');
  
  if (!searchInput) {
    // Jika tidak ada input pencarian, mungkin kita masih berada di tab Upload. Coba beralih ke tab "Drive Saya"
    const tabs = [...document.querySelectorAll('[role="tab"], .picker-tab-label, div, span')];
    const driveTab = tabs.find(el => {
      const txt = el.textContent.trim().toLowerCase();
      return txt === 'drive saya' || txt === 'my drive' || txt === 'sebelumnya' || txt === 'recent';
    });
    if (driveTab) {
      ['mousedown', 'mouseup', 'click'].forEach(type => {
        driveTab.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      });
      return 'Switching to Drive tab';
    }
    return 'Search input and Drive tab not found';
  }

  // ── TAHAP A: CARI DAN BUKA FOLDER ──────────────────────────────────────────
  if (!window.__pickerFolderOpened) {
    // Jika input pencarian belum terisi dengan nama folder
    if (searchInput.value !== folderName) {
      searchInput.focus();
      searchInput.value = folderName;
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      searchInput.dispatchEvent(new Event('change', { bubbles: true }));

      // Cari tombol cari atau kirim event key Enter
      const searchBtn = document.querySelector('.picker-search-button') || 
                        document.querySelector('[aria-label*="Search" i]') || 
                        document.querySelector('[aria-label*="Cari" i]');
      if (searchBtn) {
        searchBtn.click();
      } else {
        const enterEvent = new KeyboardEvent('keydown', { 
          bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13 
        });
        searchInput.dispatchEvent(enterEvent);
      }
      return 'Searching folder...';
    }

    // Cari item folder dari hasil pencarian
    const items = [...document.querySelectorAll('[role="option"], .picker-list-item, .picker-grid-tile, div')];
    
    let folderItem = items.find(el => {
      const txt = el.textContent.replace(/\s+/g, ' ').trim().toLowerCase();
      if (txt !== folderName.toLowerCase()) return false;
      const isFolder = el.className?.toLowerCase().includes('folder') || 
                       el.querySelector('[class*="folder" i]') !== null ||
                       el.getAttribute?.('aria-label')?.toLowerCase().includes('folder') ||
                       el.getAttribute?.('data-type') === 'folder';
      return isFolder;
    });

    // Fallback jika indikator folder tidak terdeteksi, ambil yang namanya cocok persis
    if (!folderItem) {
      folderItem = items.find(el => el.textContent.replace(/\s+/g, ' ').trim().toLowerCase() === folderName.toLowerCase());
    }

    if (!folderItem) {
      return 'Waiting for folder search results...';
    }

    // Aksi klik + enter + double click untuk menjamin folder terbuka
    folderItem.scrollIntoView({ block: 'nearest' });
    ['mousedown', 'mouseup', 'click'].forEach(type => {
      folderItem.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    });

    const enterEvent = new KeyboardEvent('keydown', { 
      bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13 
    });
    folderItem.dispatchEvent(enterEvent);

    folderItem.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
    
    window.__pickerFolderOpened = true;
    return 'Folder double-clicked, waiting to open...';
  }

  // ── TAHAP B: CARI DAN PILIH FOTO DI DALAM FOLDER ───────────────────────────

  // Inisialisasi state klik file jika belum ada
  if (window.__pickerFileClicked === undefined) {
    window.__pickerFileClicked = false;
  }

  // Sub-tahap B2: File sudah diklik sebelumnya, sekarang cari tombol Sisipkan yang sudah muncul
  if (window.__pickerFileClicked) {
    const candidates = [
      ...document.querySelectorAll('.picker-dialog-button-action'),
      ...document.querySelectorAll('.picker-button-recommend'),
      ...document.querySelectorAll('.g-button-share'),
      ...document.querySelectorAll('button'),
      ...document.querySelectorAll('[role="button"]'),
      ...document.querySelectorAll('div'),
      ...document.querySelectorAll('span')
    ];

    // Tahap 1: pencocokan persis
    let matches = candidates.filter(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const txt = el.textContent.replace(/\s+/g, ' ').trim().toLowerCase();
      return txt === 'sisipkan' || txt === 'select' || txt === 'pilih' || txt === 'insert';
    });

    // Tahap 2: pencocokan parsial jika persis tidak ada
    if (matches.length === 0) {
      matches = candidates.filter(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const txt = el.textContent.replace(/\s+/g, ' ').trim().toLowerCase();
        return txt.includes('sisipkan') || txt.includes('select') || txt.includes('pilih') || txt.includes('insert');
      });
    }

    // Urutkan berdasarkan ukuran elemen terkecil agar dapat tombol paling spesifik
    matches.sort((a, b) => {
      const rectA = a.getBoundingClientRect();
      const rectB = b.getBoundingClientRect();
      return (rectA.width * rectA.height) - (rectB.width * rectB.height);
    });

    const selectBtn = matches[0];

    if (selectBtn) {
      ['mousedown', 'mouseup', 'click'].forEach(type => {
        selectBtn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      });
      // Reset semua state agar siap untuk iterasi berikutnya
      window.__pickerFolderOpened = false;
      window.__pickerFileClicked = false;
      return 'File selected!';
    }

    // Tombol belum muncul, tunggu polling berikutnya
    return 'Waiting for Sisipkan button to appear...';
  }

  // Sub-tahap B1: Cari file target dan klik (lalu pada polling berikutnya baru klik Sisipkan)
  const items = [...document.querySelectorAll('[role="option"], .picker-list-item, .picker-grid-tile, div')];
  
  // Mencari file yang namanya persis "[index].png" atau "[index].jpg" atau "[index]"
  const targetItem = items.find(el => {
    const name = el.textContent.replace(/\s+/g, ' ').trim().toLowerCase();
    return name === `${index}.png` || name === `${index}.jpg` || name === `${index}.jpeg` || name === `${index}`;
  });

  if (!targetItem) {
    // Scroll container hasil pencarian ke bawah secara bertahap jika belum ter-render
    const container = document.querySelector('.picker-list-container') || 
                      document.querySelector('.picker-grid-container') ||
                      document.querySelector('[role="listbox"]');
    if (container) {
      container.scrollTop += 150;
    }
    return `Searching file "${index}" inside folder...`;
  }

  // Klik file target, tapi JANGAN cari tombol Sisipkan sekarang — tunggu polling berikutnya
  targetItem.scrollIntoView({ block: 'nearest' });
  ['mousedown', 'mouseup', 'click'].forEach(type => {
    targetItem.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  });

  // Tandai bahwa file sudah diklik, polling berikutnya akan mencari tombol Sisipkan
  window.__pickerFileClicked = true;
  return 'File clicked, waiting for Sisipkan button...';
}

// ── JALANKAN SATU ITERASI FORM ───────────────────────────────────────────────
async function runSingleIteration(tabId, nama, email, folderName, index, limit) {
  isBotRunning = true; // Kunci agar event onUpdated diabaikan selama iterasi berjalan
  await updateStatus(`🚀 [${index}/${limit}] ✉️ ${email} — Menghubungkan debugger…`, 'running', true);
  
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (err) {
    if (!err.message.toLowerCase().includes('already attached')) {
      isBotRunning = false;
      throw err;
    }
  }

  try {
    // ── TAHAP 1 ──────────────────────────────────────────────────────────────
    await checkStopped();
    await updateStatus(`📝 [${index}/${limit}] TAHAP 1: Mengisi Nama & Email…`, 'running', true);
    await sleep(600);
    await fillInputs(tabId, nama, email);
    await sleep(400);

    await checkStopped();
    await updateStatus(`🖱️ [${index}/${limit}] TAHAP 1: Memilih UP3 Purwokerto…`, 'running', true);
    await pilihDropdown(tabId, 0, 'UP3 Purwokerto');

    await checkStopped();
    await updateStatus(`➡️ [${index}/${limit}] TAHAP 1: Klik Berikutnya…`, 'running', true);
    await klikBerikutnya(tabId);

    // ── TAHAP 2 ──────────────────────────────────────────────────────────────
    await checkStopped();
    await updateStatus(`🖱️ [${index}/${limit}] TAHAP 2: Memilih ULP Wangon…`, 'running', true);
    await sleep(500);
    await pilihDropdown(tabId, 0, 'ULP Wangon');

    await checkStopped();
    await updateStatus(`➡️ [${index}/${limit}] TAHAP 2: Klik Berikutnya…`, 'running', true);
    await klikBerikutnya(tabId);

    // ── TAHAP 3 ──────────────────────────────────────────────────────────────
    await checkStopped();
    await updateStatus(`🖱️ [${index}/${limit}] TAHAP 3: Memilih Bidang NIAGA/ PP…`, 'running', true);
    await sleep(500);
    await pilihDropdown(tabId, 0, 'NIAGA/ PP');

    await checkStopped();
    await updateStatus(`🖱️ [${index}/${limit}] TAHAP 3: Memilih Keterangan KANTOR ULP…`, 'running', true);
    await pilihDropdown(tabId, 1, 'KANTOR ULP');

    // ── PROSES UPLOAD FILE DARI GOOGLE DRIVE (OTOMATIS) ──────────────────────
    await checkStopped();
    await updateStatus(`📁 [${index}/${limit}] TAHAP 3: Membuka Google Picker…`, 'running', true);
    await sleep(500);
    
    // Klik "Tambahkan File"
    const addFileCoords = await inPage(tabId, () => {
      const btn = [...document.querySelectorAll('[role="button"]')].find(el => {
        const t = el.textContent.trim().toLowerCase();
        return t === 'tambahkan file' || t === 'add file';
      });
      if (!btn) return null;
      btn.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = btn.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });

    if (addFileCoords) {
      await cdpClick(tabId, addFileCoords.x, addFileCoords.y);
    } else {
      throw new Error('Tombol "Tambahkan File" tidak ditemukan.');
    }

    // Polling dan injeksi ke Drive Picker iframe
    await updateStatus(`⏳ [${index}/${limit}] Mencari & memilih "${index}" di folder "${folderName}"…`, 'running', true);
    let pickerSuccess = false;
    const pickerStart = Date.now();

    while (Date.now() - pickerStart < 40000) { // maksimal 40 detik
      await checkStopped();

      // Jalankan script di dalam frame Google Picker
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: runInsidePickerFrame,
        args: [folderName, index]
      });

      // Cek apakah salah satu frame mengembalikan hasil 'File selected!'
      const status = results?.find(r => r.result === 'File selected!')?.result;
      if (status === 'File selected!') {
        pickerSuccess = true;
        break;
      }
      await sleep(1500);
    }

    if (!pickerSuccess) {
      throw new Error(`Gagal mendeteksi/memilih file "${index}" di folder "${folderName}".`);
    }

    // Tunggu sampai jendela picker menutup dan kartu file muncul di halaman utama
    await updateStatus(`⏳ [${index}/${limit}] Menunggu konfirmasi file di form…`, 'running', true);
    let fileUploaded = false;
    const fileStart = Date.now();

    while (Date.now() - fileStart < 20000) { // maksimal 20 detik
      fileUploaded = await inPage(tabId, (idx) => {
        // Cek 1: Selector class tradisional Google Forms
        const card = document.querySelector(
          '.appsMaterialWizFilepickerFile, .quantumWizFilepickerFile, [class*="FilepickerFile"], [class*="exportFileCard"]'
        );
        if (card && card.getBoundingClientRect().width > 0) return true;

        // Cek 2: Cari element yang berisi nama file (misal: "1.png" atau "1.jpg")
        const allEls = [...document.querySelectorAll('div, span')];
        const hasFilename = allEls.some(el => {
          const txt = el.textContent.trim().toLowerCase();
          const rect = el.getBoundingClientRect();
          if (rect.width === 0) return false;
          return txt === `${idx}.png` || txt === `${idx}.jpg` || txt === `${idx}.jpeg` || txt === `${idx}`;
        });
        if (hasFilename) return true;

        // Cek 3: Cari tombol "X" atau remove yang biasanya muncul setelah file ditempel
        const removeBtn = allEls.find(el => {
          const lbl = el.getAttribute?.('aria-label')?.toLowerCase() ?? '';
          return lbl.includes('hapus') || lbl.includes('remove') || lbl.includes('delete');
        });
        if (removeBtn && removeBtn.getBoundingClientRect().width > 0) return true;

        return false;
      }, [index]);

      if (fileUploaded) break;
      await sleep(1000);
    }

    if (!fileUploaded) {
      // Lanjutkan saja meskipun tidak terdeteksi - file sudah dipilih dari Drive
      console.warn('[BG-AUTOFILL] Konfirmasi file tidak terdeteksi, melanjutkan ke submit.');
    }

    // ❕ KLIK TOMBOL KIRIM (SUBMIT) ❕
    await checkStopped();
    await updateStatus(`📤 [${index}/${limit}] Mengklik tombol Kirim.`, 'running', true);
    await sleep(800);

    const submitCoords = await inPage(tabId, () => {
      const tombol =
        [...document.querySelectorAll('[role="button"]')].find(el => {
          const t = el.textContent.trim().toLowerCase();
          return t === 'kirim' || t === 'submit' || t === 'send';
        }) ||
        document.querySelector('[jsname="M2UYVd"]') ||
        document.querySelector('[jsname="k6Pyef"]');
      if (!tombol) return null;
      tombol.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = tombol.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });

    if (!submitCoords) throw new Error('Tombol Kirim (submit) tidak ditemukan.');
    await cdpClick(tabId, submitCoords.x, submitCoords.y);

    // Tunggu halaman sukses muncul
    await updateStatus(`⏳ [${index}/${limit}] Menunggu konfirmasi pengiriman.`, 'running', true);
    let submitted = false;
    const submitStart = Date.now();
    while (Date.now() - submitStart < 15000) {
      await checkStopped();
      submitted = await inPage(tabId, () => {
        const txt = document.body?.innerText?.toLowerCase() ?? '';
        return txt.includes('thanks for submitting') ||
               txt.includes('terima kasih') ||
               txt.includes('jawaban anda telah direkam') ||
               txt.includes('your response has been recorded') ||
               txt.includes('kirim jawaban lain');
      });
      if (submitted) break;
      await sleep(700);
    }

    if (!submitted) {
      console.warn('[BG-AUTOFILL] Halaman sukses tidak terdeteksi, melanjutkan.');
    }

    // ❕ ITERASI SELANJUTNYA via "Kirim jawaban lain" ❕
    const nextIndex = index + 1;
    if (nextIndex > limit) {
      // Selesai batch
      await chrome.storage.local.set({
        botActive: false,
        isRunning: false,
        statusText: `✅ Selesai! Berhasil memproses ${limit} foto.`,
        statusMode: 'success'
      });
    } else {
      // Simpan index selanjutnya
      // Hitung email berikutnya dengan rotasi
      const emailsData = await chrome.storage.local.get(['emails']);
      const emailList = Array.isArray(emailsData.emails) ? emailsData.emails : [email];
      const nextEmail = emailList[(nextIndex - 1) % emailList.length];

      await chrome.storage.local.set({
        currentIndex: nextIndex,
        statusText: `🔄 [${nextIndex}/${limit}] ✉️ ${nextEmail} — Lanjut ke foto berikutnya.`,
        statusMode: 'running'
      });

      await updateStatus(`🔗 [${index}/${limit}] Klik "Kirim jawaban lain".`, 'running', true);
      await sleep(1000);

      // Cari dan klik link "Kirim jawaban lain" di halaman sukses
      const clicked = await inPage(tabId, () => {
        const allLinks = [...document.querySelectorAll('a')];
        const link = allLinks.find(el => {
          const txt = el.textContent.replace(/\s+/g, ' ').trim().toLowerCase();
          return txt.includes('kirim jawaban lain') || txt.includes('submit another response') || txt.includes('jawaban lain');
        });
        if (!link) return false;
        link.click();
        return true;
      });

      if (!clicked) {
        // Fallback: redirect ke formUrl jika tombol tidak ditemukan
        console.warn('[BG-AUTOFILL] Link "Kirim jawaban lain" tidak ditemukan, fallback ke redirect.');
        const storageData = await chrome.storage.local.get(['formUrl']);
        isBotRunning = false;
        if (storageData.formUrl) {
          await chrome.tabs.update(tabId, { url: storageData.formUrl });
        } else {
          await chrome.tabs.reload(tabId);
        }
      } else {
        // Link berhasil diklik - onUpdated listener akan menangkap halaman form baru
        isBotRunning = false;
      }
    }
  } catch (err) {
    console.error('[BG-AUTOFILL-ERR]', err);
    await chrome.storage.local.set({
      botActive: false,
      isRunning: false,
      statusText: `❌ Gagal pada foto ${index}: ${err.message}`,
      statusMode: 'error'
    });
  } finally {
    isBotRunning = false; // Pastikan flag direset jika terjadi error/selesai
    try { await chrome.debugger.detach({ tabId }); } catch (_) {}
  }
}

// ── 1. TABS ONUPDATED LISTENER (Pemicu Siklus Batch) ─────────────────────────
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  const url = tab.url ?? '';
  if (!url.includes('docs.google.com/forms')) return;

  // Jika bot sedang melakukan iterasi (masih berjalan), abaikan pemicu onUpdated
  if (isBotRunning) {
    console.log('[BG-ONUPDATED] Mengabaikan event tab load karena otomasi sedang aktif.');
    return;
  }

  const data = await chrome.storage.local.get([
    'botActive', 'tabId', 'nama', 'emails', 'email', 'folderName', 'currentIndex', 'limit'
  ]);
  
  if (!data.botActive || tabId !== data.tabId) return;

  const index = parseInt(data.currentIndex, 10) || 1;
  const limit = parseInt(data.limit, 10) || 1;

  if (index > limit) {
    await chrome.storage.local.set({
      botActive: false,
      isRunning: false,
      statusText: '✅ Semua iterasi selesai!',
      statusMode: 'success'
    });
    return;
  }

  // Rotasi email: pakai modulo agar kembali ke awal jika iterasi melebihi jumlah email
  const emailList = Array.isArray(data.emails) ? data.emails : [data.email || ''];
  const currentEmail = emailList[(index - 1) % emailList.length];

  // Simpan email yang sedang aktif ke storage
  await chrome.storage.local.set({ email: currentEmail });

  // Mulai iterasi saat ini secara asinkron
  runSingleIteration(tabId, data.nama, currentEmail, data.folderName, index, limit);
});

// ── 2. RUNTIME ONMESSAGE LISTENER (Pemicu Awal dari Popup) ────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startAutofill') {
    // Sinyal start hanya menyimpan data dan memicu reload tab pertama, 
    // selanjutnya akan ditangani oleh listener onUpdated di atas.
    sendResponse({ success: true });
  }
  return true;
});
