/**
 * Attendance Management System
 * Offline-first, LocalStorage + Supabase synchronization
 */

(function () {
  'use strict';

  // --- Constants & Storage Keys ---
  const STORAGE_KEY_RECORDS = 'attendance_records';
  const STORAGE_KEY_SUPABASE_URL = 'attendance_supabase_url';
  const STORAGE_KEY_SUPABASE_KEY = 'attendance_supabase_key';

  // --- State ---
  let supabaseClient = null;
  let selectedSection = null; // 'A', 'B', 'C', 'D' or null
  let records = [];
  let editingRecordId = null;

  // --- DOM Elements ---
  const dateInput = document.getElementById('attendance-date');
  const btnSetToday = document.getElementById('btn-set-today');
  const sectionPills = document.querySelectorAll('.section-pill');
  const rollNumbersTextarea = document.getElementById('roll-numbers');
  const rollCountDisplay = document.getElementById('roll-count');
  const attendanceForm = document.getElementById('attendance-form');
  const btnSubmit = document.getElementById('btn-submit');
  const btnReset = document.getElementById('btn-reset');
  const formFeedback = document.getElementById('form-feedback');

  const networkStatusPill = document.getElementById('network-status');
  const networkText = document.getElementById('network-text');
  const syncStatusPill = document.getElementById('sync-status');
  const syncText = document.getElementById('sync-text');
  const btnSyncAll = document.getElementById('btn-sync-all');

  const attendanceTbody = document.getElementById('attendance-tbody');
  const emptyState = document.getElementById('empty-state');
  const btnExportCsv = document.getElementById('btn-export-csv');
  const btnClearAll = document.getElementById('btn-clear-all');

  // Modal DOM Elements
  const viewModal = document.getElementById('view-modal');
  const modalDate = document.getElementById('modal-date');
  const modalSection = document.getElementById('modal-section');
  const modalTotal = document.getElementById('modal-total');
  const modalStatus = document.getElementById('modal-status');
  const modalRollNumbers = document.getElementById('modal-roll-numbers');
  const btnCopyAttendance = document.getElementById('btn-copy-attendance');
  const copyBtnText = document.getElementById('copy-btn-text');
  const btnCloseModal = document.getElementById('btn-close-modal');

  let currentViewRecord = null;

  // --- Utility Functions ---

  function getTodayDateString() {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /**
   * Parse roll numbers from raw text.
   * Handles comma, whitespace, newline, and number ranges (e.g. 1-5 => 1,2,3,4,5).
   */
  function parseRollNumbers(rawText) {
    if (!rawText || !rawText.trim()) return [];

    const tokens = rawText
      .split(/[\s,;\n\r]+/)
      .map(t => t.trim())
      .filter(Boolean);

    const result = new Set();

    for (const token of tokens) {
      // Check for numeric range (e.g., "101-105" or "1-10")
      const rangeMatch = token.match(/^(\d+)-(\d+)$/);
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1], 10);
        const end = parseInt(rangeMatch[2], 10);
        if (start <= end && end - start <= 500) {
          for (let i = start; i <= end; i++) {
            result.add(String(i));
          }
          continue;
        }
      }
      result.add(token);
    }

    // Sort: numeric sort if all numbers, else lexical sort
    const array = Array.from(result);
    const isAllNumeric = array.every(val => /^\d+$/.test(val));
    if (isAllNumeric) {
      array.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    } else {
      array.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    }

    return array;
  }

  function showFeedback(message, type = 'normal', duration = 3000) {
    formFeedback.textContent = message;
    formFeedback.className = 'feedback-msg ' + (type === 'success' ? 'success' : type === 'error' ? 'error' : '');
    if (duration > 0) {
      setTimeout(() => {
        if (formFeedback.textContent === message) {
          formFeedback.textContent = '';
          formFeedback.className = 'feedback-msg';
        }
      }, duration);
    }
  }

  // --- Local Storage Management ---

  function loadRecordsFromLocalStorage() {
    try {
      const data = localStorage.getItem(STORAGE_KEY_RECORDS);
      records = data ? JSON.parse(data) : [];
      if (!Array.isArray(records)) records = [];
    } catch (e) {
      console.error('Failed to parse records from local storage', e);
      records = [];
    }
    renderRecords();
    updateSyncStatusBadge();
  }

  function saveRecordsToLocalStorage() {
    try {
      localStorage.setItem(STORAGE_KEY_RECORDS, JSON.stringify(records));
    } catch (e) {
      console.error('Failed to save to local storage', e);
    }
    updateSyncStatusBadge();
  }

  // --- Environment & Supabase Client Initialization ---

  async function loadEnvConfig() {
    let url = '';
    let key = '';

    // 1. Check window.__ENV__ if defined
    if (window.__ENV__) {
      url = window.__ENV__.SUPABASE_URL || '';
      key = window.__ENV__.SUPABASE_ANON_KEY || '';
    }

    // 2. Fetch .env file if available
    try {
      const res = await fetch('.env');
      if (res.ok) {
        const text = await res.text();
        const lines = text.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx !== -1) {
            const k = trimmed.slice(0, eqIdx).trim();
            let v = trimmed.slice(eqIdx + 1).trim();
            if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
              v = v.slice(1, -1);
            }
            if (k === 'SUPABASE_URL') url = v;
            if (k === 'SUPABASE_ANON_KEY') key = v;
          }
        }
      }
    } catch (e) {
      console.warn('Could not read .env file directly:', e);
    }

    // 3. Fallback to cached local storage
    if (!url) url = localStorage.getItem(STORAGE_KEY_SUPABASE_URL) || '';
    if (!key) key = localStorage.getItem(STORAGE_KEY_SUPABASE_KEY) || '';

    // Cache if valid
    if (url && !url.includes('your-project-id')) {
      localStorage.setItem(STORAGE_KEY_SUPABASE_URL, url);
    }
    if (key && !key.includes('your-anon-public-key')) {
      localStorage.setItem(STORAGE_KEY_SUPABASE_KEY, key);
    }

    return { url, key };
  }

  async function initSupabase() {
    const { url, key } = await loadEnvConfig();

    if (url && key && !url.includes('your-project-id') && window.supabase) {
      try {
        supabaseClient = window.supabase.createClient(url, key);
        console.log('Supabase initialized from .env configuration');
        if (navigator.onLine) {
          await syncPendingRecords();
          await fetchRemoteRecords();
        }
      } catch (e) {
        console.error('Failed to initialize Supabase client:', e);
        supabaseClient = null;
      }
    } else {
      supabaseClient = null;
    }
    updateSyncStatusBadge();
  }

  async function fetchRemoteRecords() {
    if (!supabaseClient || !navigator.onLine) return;
    try {
      const { data, error } = await supabaseClient
        .from('attendance')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);

      if (!error && Array.isArray(data) && data.length > 0) {
        const localIdMap = new Map(records.map(r => [r.id, r]));
        let modified = false;

        for (const remote of data) {
          if (!localIdMap.has(remote.id)) {
            records.push({
              id: remote.id,
              date: remote.date,
              section: remote.section || null,
              roll_numbers: Array.isArray(remote.roll_numbers) && remote.roll_numbers.length > 0
                ? remote.roll_numbers
                : parseRollNumbers(remote.roll || remote.roll_no || ''),
              total: remote.total || (remote.roll_numbers ? remote.roll_numbers.length : 0),
              created_at: remote.created_at,
              synced_at: remote.synced_at || remote.created_at,
              sync_status: 'synced'
            });
            modified = true;
          }
        }

        if (modified) {
          records.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
          saveRecordsToLocalStorage();
          renderRecords();
        }
      }
    } catch (e) {
      console.warn('Could not fetch remote records:', e);
    }
  }

  // --- Network & Continuous Auto-Sync Engine ---

  async function autoSyncCycle() {
    if (!navigator.onLine || !supabaseClient) return;
    try {
      await syncPendingRecords();
      await fetchRemoteRecords();
    } catch (err) {
      console.warn('Auto-sync cycle error:', err);
    }
  }

  function updateNetworkStatus() {
    const isOnline = navigator.onLine;
    if (isOnline) {
      networkStatusPill.className = 'status-pill status-online';
      networkText.textContent = 'Online';
      autoSyncCycle();
    } else {
      networkStatusPill.className = 'status-pill status-offline';
      networkText.textContent = 'Offline';
    }
  }

  function updateSyncStatusBadge() {
    const pendingCount = records.filter(r => r.sync_status === 'pending').length;

    if (!supabaseClient) {
      syncStatusPill.className = 'status-pill status-synced';
      syncText.textContent = 'Local only';
      return;
    }

    if (pendingCount > 0) {
      syncStatusPill.className = 'status-pill status-pending';
      syncText.textContent = `${pendingCount} pending`;
    } else {
      syncStatusPill.className = 'status-pill status-synced';
      syncText.textContent = 'All synced';
    }
  }

  /**
   * Push a single record to Supabase
   */
  async function pushRecordToSupabase(record) {
    if (!supabaseClient) {
      throw new Error('Supabase client not initialized');
    }

    const rollList = Array.isArray(record.roll_numbers) ? record.roll_numbers : [];
    const rollString = rollList.join(', ');
    const totalCount = record.total || rollList.length;

    const payload = {
      id: record.id,
      date: record.date,
      section: record.section || null,
      roll_no: rollString,
      roll: rollString,
      roll_numbers: rollList,
      total: totalCount,
      status: 'Present',
      place: 'Classroom',
      created_at: record.created_at,
      updated_at: new Date().toISOString(),
      synced_at: new Date().toISOString()
    };

    const { error } = await supabaseClient
      .from('attendance')
      .upsert(payload, { onConflict: 'id' });

    if (error) {
      console.error('Supabase upsert error:', error);
      throw error;
    }
  }

  /**
   * Sync all pending records to Supabase
   */
  async function syncPendingRecords() {
    if (!navigator.onLine || !supabaseClient) {
      updateSyncStatusBadge();
      return;
    }

    const pendingList = records.filter(r => r.sync_status === 'pending');
    if (pendingList.length === 0) {
      updateSyncStatusBadge();
      return;
    }

    btnSyncAll.disabled = true;
    syncText.textContent = 'Syncing...';

    let successCount = 0;
    for (const record of pendingList) {
      try {
        await pushRecordToSupabase(record);
        record.sync_status = 'synced';
        record.synced_at = new Date().toISOString();
        successCount++;
      } catch (err) {
        console.warn(`Failed to sync record ${record.id}:`, err);
        // Stop attempting further if complete network error occurs
        if (!navigator.onLine) break;
      }
    }

    saveRecordsToLocalStorage();
    renderRecords();
    btnSyncAll.disabled = false;

    if (successCount > 0) {
      showFeedback(`Synced ${successCount} record(s) to Supabase`, 'success');
    }
  }

  // --- UI Event Handlers ---

  function handleSectionClick(e) {
    const target = e.currentTarget;
    const section = target.dataset.section;

    if (selectedSection === section) {
      // Toggle off if already selected
      selectedSection = null;
      target.classList.remove('active');
    } else {
      sectionPills.forEach(p => p.classList.remove('active'));
      selectedSection = section;
      target.classList.add('active');
    }
  }

  function handleRollNumbersInput() {
    const parsed = parseRollNumbers(rollNumbersTextarea.value);
    rollCountDisplay.textContent = `${parsed.length} entries`;
  }

  async function handleFormSubmit(e) {
    e.preventDefault();

    const dateVal = dateInput.value;
    if (!dateVal) {
      showFeedback('Please select a date', 'error');
      dateInput.focus();
      return;
    }

    const rollNumbers = parseRollNumbers(rollNumbersTextarea.value);
    if (rollNumbers.length === 0) {
      showFeedback('Please enter at least one roll number', 'error');
      rollNumbersTextarea.focus();
      return;
    }

    // --- CASE A: Editing Existing Record ---
    if (editingRecordId) {
      const existingRecord = records.find(r => r.id === editingRecordId);
      if (existingRecord) {
        existingRecord.date = dateVal;
        existingRecord.section = selectedSection || null;
        existingRecord.roll_numbers = rollNumbers;
        existingRecord.total = rollNumbers.length;
        existingRecord.updated_at = new Date().toISOString();
        existingRecord.sync_status = 'pending';

        saveRecordsToLocalStorage();
        renderRecords();

        if (navigator.onLine && supabaseClient) {
          showFeedback('Updating...', 'normal');
          try {
            await pushRecordToSupabase(existingRecord);
            existingRecord.sync_status = 'synced';
            existingRecord.synced_at = new Date().toISOString();
            saveRecordsToLocalStorage();
            renderRecords();
            showFeedback('Updated and auto-synced to Supabase', 'success');
          } catch (err) {
            console.warn('Sync failed:', err);
            showFeedback('Updated locally (queued for sync)', 'normal');
          }
        } else {
          showFeedback('Updated locally (Offline)', 'normal');
        }

        handleFormReset();
        updateSyncStatusBadge();
        return;
      }
    }

    // --- CASE B: Creating New Record ---
    const recordId = generateUUID();
    const nowIso = new Date().toISOString();

    const newRecord = {
      id: recordId,
      date: dateVal,
      section: selectedSection || null,
      roll_numbers: rollNumbers,
      total: rollNumbers.length,
      created_at: nowIso,
      synced_at: null,
      sync_status: 'pending'
    };

    // 1. Immediately store to LocalStorage
    records.unshift(newRecord);
    saveRecordsToLocalStorage();
    renderRecords();

    // 2. Clear input form
    rollNumbersTextarea.value = '';
    handleRollNumbersInput();

    // 3. Attempt direct sync if online and configured
    if (navigator.onLine && supabaseClient) {
      showFeedback('Saving...', 'normal');
      try {
        await pushRecordToSupabase(newRecord);
        newRecord.sync_status = 'synced';
        newRecord.synced_at = new Date().toISOString();
        saveRecordsToLocalStorage();
        renderRecords();
        showFeedback('Saved locally & auto-synced to Supabase', 'success');
      } catch (err) {
        console.warn('Sync failed, queued locally:', err);
        showFeedback('Saved in local storage (sync queued)', 'normal');
      }
    } else if (!navigator.onLine) {
      showFeedback('Saved in local storage (Offline)', 'normal');
    } else {
      showFeedback('Saved in local storage (Supabase not configured)', 'normal');
    }

    updateSyncStatusBadge();
  }

  function handleEditRecord(id) {
    const record = records.find(r => r.id === id);
    if (!record) return;

    editingRecordId = id;

    // Populate date
    dateInput.value = record.date;

    // Populate section
    selectedSection = record.section || null;
    sectionPills.forEach(p => {
      p.classList.toggle('active', p.dataset.section === selectedSection);
    });

    // Populate roll numbers
    const rollList = Array.isArray(record.roll_numbers) ? record.roll_numbers : [];
    rollNumbersTextarea.value = rollList.join(', ');
    handleRollNumbersInput();

    // Switch buttons to editing mode
    btnSubmit.textContent = 'Update Attendance';
    btnReset.textContent = 'Cancel Edit';

    showFeedback(`Editing record for ${record.date}`, 'normal');
    attendanceForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
    rollNumbersTextarea.focus();
  }

  function handleFormReset() {
    editingRecordId = null;
    btnSubmit.textContent = 'Save Attendance';
    btnReset.textContent = 'Clear';
    selectedSection = null;
    sectionPills.forEach(p => p.classList.remove('active'));
    rollNumbersTextarea.value = '';
    handleRollNumbersInput();
    dateInput.value = getTodayDateString();
    formFeedback.textContent = '';
  }

  async function handleDeleteRecord(id) {
    const idx = records.findIndex(r => r.id === id);
    if (idx === -1) return;

    const record = records[idx];
    records.splice(idx, 1);
    saveRecordsToLocalStorage();
    renderRecords();

    // Optionally delete from Supabase if online and configured
    if (navigator.onLine && supabaseClient && record.sync_status === 'synced') {
      try {
        await supabaseClient.from('attendance').delete().eq('id', id);
      } catch (err) {
        console.warn('Could not delete from Supabase:', err);
      }
    }
  }

  // --- View Modal Functions ---

  function handleViewRecord(id) {
    const record = records.find(r => r.id === id);
    if (!record) return;

    currentViewRecord = record;

    modalDate.textContent = record.date;

    if (record.section) {
      modalSection.textContent = 'Section ' + record.section;
      modalSection.style.display = 'inline-block';
    } else {
      modalSection.textContent = '';
      modalSection.style.display = 'none';
    }

    const total = record.total || (record.roll_numbers ? record.roll_numbers.length : 0);
    modalTotal.textContent = `${total} Present`;

    if (record.sync_status === 'synced') {
      modalStatus.className = 'table-badge badge-synced';
      modalStatus.textContent = 'Synced';
    } else {
      modalStatus.className = 'table-badge badge-pending';
      modalStatus.textContent = 'Pending';
    }

    modalRollNumbers.textContent = (record.roll_numbers || []).join(', ');

    // Reset copy button state
    copyBtnText.textContent = 'Copy';
    btnCopyAttendance.classList.remove('copied');

    viewModal.classList.remove('hidden');
  }

  function closeViewModal() {
    viewModal.classList.add('hidden');
    currentViewRecord = null;
  }

  async function handleCopyAttendance() {
    if (!currentViewRecord) return;

    const rollStr = (currentViewRecord.roll_numbers || []).join(', ');
    const total = currentViewRecord.total || (currentViewRecord.roll_numbers ? currentViewRecord.roll_numbers.length : 0);
    const sectionLine = currentViewRecord.section ? `Section: ${currentViewRecord.section}\n` : '';

    const textToCopy = `Date: ${currentViewRecord.date}\n${sectionLine}Total Present: ${total}\nRoll Numbers: ${rollStr}`;

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(textToCopy);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = textToCopy;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }

      copyBtnText.textContent = 'Copied!';
      btnCopyAttendance.classList.add('copied');

      setTimeout(() => {
        copyBtnText.textContent = 'Copy';
        btnCopyAttendance.classList.remove('copied');
      }, 2000);
    } catch (err) {
      console.warn('Failed to copy attendance:', err);
    }
  }

  function handleClearAllRecords() {
    if (records.length === 0) return;
    if (confirm('Clear all local records? Synced cloud entries will not be deleted.')) {
      records = [];
      saveRecordsToLocalStorage();
      renderRecords();
      showFeedback('Local records cleared', 'normal');
    }
  }

  function handleExportCsv() {
    if (records.length === 0) {
      showFeedback('No records to export', 'error');
      return;
    }

    const headers = ['Date', 'Section', 'Total Present', 'Roll Numbers', 'Sync Status', 'Created At'];
    const rows = records.map(r => [
      `"${r.date}"`,
      `"${r.section || ''}"`,
      r.total || (r.roll_numbers ? r.roll_numbers.length : 0),
      `"${(r.roll_numbers || []).join(', ')}"`,
      `"${r.sync_status}"`,
      `"${r.created_at}"`
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `attendance_${getTodayDateString()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // --- Render Table ---

  function renderRecords() {
    attendanceTbody.innerHTML = '';

    if (records.length === 0) {
      emptyState.classList.remove('hidden');
      return;
    }

    emptyState.classList.add('hidden');

    records.forEach(rec => {
      const tr = document.createElement('tr');

      const dateTd = document.createElement('td');
      dateTd.textContent = rec.date;

      const sectionTd = document.createElement('td');
      sectionTd.textContent = rec.section || '—';

      const rollsTd = document.createElement('td');
      const previewSpan = document.createElement('div');
      previewSpan.className = 'roll-preview';
      previewSpan.title = (rec.roll_numbers || []).join(', ');
      previewSpan.textContent = (rec.roll_numbers || []).join(', ');
      rollsTd.appendChild(previewSpan);

      const countTd = document.createElement('td');
      countTd.className = 'text-right';
      countTd.textContent = rec.total || (rec.roll_numbers ? rec.roll_numbers.length : 0);

      const statusTd = document.createElement('td');
      statusTd.className = 'text-center';
      const badge = document.createElement('span');
      if (rec.sync_status === 'synced') {
        badge.className = 'table-badge badge-synced';
        badge.textContent = 'Synced';
      } else {
        badge.className = 'table-badge badge-pending';
        badge.textContent = 'Pending';
      }
      statusTd.appendChild(badge);

      const actionTd = document.createElement('td');
      actionTd.className = 'text-right';
      const actionWrap = document.createElement('div');
      actionWrap.className = 'table-actions';

      const viewBtn = document.createElement('button');
      viewBtn.type = 'button';
      viewBtn.className = 'btn-micro';
      viewBtn.textContent = 'View';
      viewBtn.title = 'View attendance details popup';
      viewBtn.addEventListener('click', () => handleViewRecord(rec.id));

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn-micro';
      editBtn.textContent = 'Edit';
      editBtn.title = 'Edit this attendance record';
      editBtn.addEventListener('click', () => handleEditRecord(rec.id));

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn-micro btn-micro-danger';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', () => handleDeleteRecord(rec.id));

      actionWrap.appendChild(viewBtn);
      actionWrap.appendChild(editBtn);
      actionWrap.appendChild(delBtn);
      actionTd.appendChild(actionWrap);

      tr.appendChild(dateTd);
      tr.appendChild(sectionTd);
      tr.appendChild(rollsTd);
      tr.appendChild(countTd);
      tr.appendChild(statusTd);
      tr.appendChild(actionTd);

      attendanceTbody.appendChild(tr);
    });
  }

  // --- Initialization & Listeners ---

  async function init() {
    // Set default date to today
    dateInput.value = getTodayDateString();

    // Section pills events
    sectionPills.forEach(pill => {
      pill.addEventListener('click', handleSectionClick);
    });

    // Roll numbers dynamic counter
    rollNumbersTextarea.addEventListener('input', handleRollNumbersInput);

    // Date "Today" button
    btnSetToday.addEventListener('click', () => {
      dateInput.value = getTodayDateString();
    });

    // Form submit & reset
    attendanceForm.addEventListener('submit', handleFormSubmit);
    btnReset.addEventListener('click', handleFormReset);

    // Modal listeners
    btnCloseModal.addEventListener('click', closeViewModal);
    btnCopyAttendance.addEventListener('click', handleCopyAttendance);
    viewModal.addEventListener('click', (e) => {
      if (e.target === viewModal) closeViewModal();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !viewModal.classList.contains('hidden')) {
        closeViewModal();
      }
    });

    // Header sync action
    btnSyncAll.addEventListener('click', () => {
      if (!supabaseClient) {
        showFeedback('Supabase credentials not configured in .env', 'normal');
      } else {
        autoSyncCycle();
      }
    });

    // Records actions
    btnExportCsv.addEventListener('click', handleExportCsv);
    btnClearAll.addEventListener('click', handleClearAllRecords);

    // Online / Offline events
    window.addEventListener('online', updateNetworkStatus);
    window.addEventListener('offline', updateNetworkStatus);

    // Window focus auto-sync
    window.addEventListener('focus', () => {
      autoSyncCycle();
    });

    // Continuous recurring background auto-sync every 15 seconds
    setInterval(autoSyncCycle, 15000);

    // Initial state setup
    loadRecordsFromLocalStorage();
    await initSupabase();
    updateNetworkStatus();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
