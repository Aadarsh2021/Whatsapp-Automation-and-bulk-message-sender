// AutoMate Cloud - Client Engine (Device-Isolated & Modal System)

let isConnected = false;
let pendingDispatchData = null;
let cachedJobs = [];
let cachedHistory = [];

// 1. Unique, Persistent Device Session ID (Every phone/PC gets its own private space)
let currentDeviceId = localStorage.getItem('automate_device_id');
if (!currentDeviceId) {
    currentDeviceId = 'dev_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36).slice(-4);
    localStorage.setItem('automate_device_id', currentDeviceId);
}

// Scoped API Wrapper (Attaches x-user-id header on every request)
function apiFetch(url, options = {}) {
    options.headers = options.headers || {};
    options.headers['x-user-id'] = currentDeviceId;
    return fetch(url, options);
}

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
    initClock();
    pollStatus();
    setInterval(pollStatus, 3000);
    loadScheduledJobs();
    loadHistory();

    // Event listeners
    document.getElementById('numbersInput').addEventListener('input', updateContactCount);
    document.getElementById('messageInput').addEventListener('input', updateCharCount);

    // Default schedule time = now + 1 hour in local format
    const now = new Date();
    now.setHours(now.getHours() + 1);
    now.setMinutes(0);
    const localISO = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    document.getElementById('scheduleDateTime').value = localISO;

    // Global Modal Backdrop & ESC Listeners
    window.addEventListener('click', (e) => {
        if (e.target.classList.contains('modal-overlay')) {
            closeModal(e.target.id);
        }
    });
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal-overlay').forEach(m => {
                if (m.style.display === 'flex') closeModal(m.id);
            });
        }
    });
});

// ================= MODAL CONTROLLER =================

function openModal(id) {
    const modal = document.getElementById(id);
    if (modal) {
        modal.style.display = 'flex';
        document.body.style.overflow = 'hidden';
    }
}

function closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) {
        modal.style.display = 'none';
        const openModals = Array.from(document.querySelectorAll('.modal-overlay')).filter(m => m.style.display === 'flex');
        if (openModals.length === 0) {
            document.body.style.overflow = '';
        }
    }
}

function openPrivacyModal() {
    openModal('modalPrivacy');
}

// ================= LIVE CLOCK & NAVIGATION =================

function initClock() {
    function updateClock() {
        const d = new Date();
        document.getElementById('liveClock').textContent = '🕒 ' + d.toTimeString().split(' ')[0];
    }
    updateClock();
    setInterval(updateClock, 1000);
}

function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.content-section').forEach(sec => sec.classList.remove('active'));

    if (tabName === 'connect') {
        document.getElementById('tabBtnConnect').classList.add('active');
        document.getElementById('sectionConnect').classList.add('active');
    } else if (tabName === 'compose') {
        document.getElementById('tabBtnCompose').classList.add('active');
        document.getElementById('sectionCompose').classList.add('active');
    } else if (tabName === 'scheduled') {
        document.getElementById('tabBtnScheduled').classList.add('active');
        document.getElementById('sectionScheduled').classList.add('active');
        loadScheduledJobs();
    } else if (tabName === 'history') {
        document.getElementById('tabBtnHistory').classList.add('active');
        document.getElementById('sectionHistory').classList.add('active');
        loadHistory();
    }
}

// ================= STATUS & QR POLLING =================

async function pollStatus() {
    try {
        const res = await apiFetch('/api/status');
        const data = await res.json();

        const badge = document.getElementById('connectionStatusBadge');
        const statusText = document.getElementById('statusText');
        const qrContainer = document.getElementById('qrContainer');
        const connectedBox = document.getElementById('connectedStateBox');
        const qrImage = document.getElementById('qrImage');
        const qrLoading = document.getElementById('qrLoading');

        badge.className = 'status-badge ' + data.status;

        if (data.status === 'connected') {
            if (!isConnected) {
                // If just connected, close pairing modal automatically
                closeModal('modalPairingCode');
                showToast('🎉 WhatsApp Connected Successfully!');
            }
            isConnected = true;
            statusText.textContent = 'Connected';
            qrContainer.style.display = 'none';
            connectedBox.style.display = 'flex';
            document.getElementById('connectedAccountName').textContent = data.user?.id || 'Connected';
        } else if (data.status === 'qr_ready' && data.qrCode) {
            isConnected = false;
            statusText.textContent = 'Scan QR Code';
            qrContainer.style.display = 'flex';
            connectedBox.style.display = 'none';
            qrImage.src = data.qrCode;
            qrImage.style.display = 'block';
            qrLoading.style.display = 'none';
        } else {
            isConnected = false;
            statusText.textContent = 'Initializing...';
            qrContainer.style.display = 'flex';
            connectedBox.style.display = 'none';
            qrImage.style.display = 'none';
            qrLoading.style.display = 'flex';
        }
    } catch (err) {
        console.error('Failed to poll status:', err);
    }
}

// ================= LINKING METHODS & PAIRING CODE =================

function switchLinkMethod(method) {
    const btnQR = document.getElementById('btnMethodQR');
    const btnPhone = document.getElementById('btnMethodPhone');
    const qrBox = document.getElementById('qrMethodBox');
    const phoneBox = document.getElementById('phoneMethodBox');

    if (method === 'qr') {
        btnQR.classList.add('active');
        btnPhone.classList.remove('active');
        qrBox.style.display = 'block';
        phoneBox.style.display = 'none';
    } else {
        btnPhone.classList.add('active');
        btnQR.classList.remove('active');
        qrBox.style.display = 'none';
        phoneBox.style.display = 'block';
    }
}

async function requestPairingCode() {
    const phoneInput = document.getElementById('pairingPhoneInput');
    const phoneNumber = phoneInput.value.trim();
    const btn = document.getElementById('btnGetPairingCode');
    const resultBox = document.getElementById('pairingCodeResult');
    const displayCode = document.getElementById('displayPairingCode');

    if (!phoneNumber || phoneNumber.replace(/\D/g, '').length < 10) {
        showToast('⚠️ Please enter a valid phone number with country code (e.g. 919876543210)');
        return;
    }

    btn.disabled = true;
    btn.textContent = '⏳ Generating Code...';

    try {
        const res = await apiFetch('/api/request-pairing-code', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phoneNumber })
        });
        const data = await res.json();

        if (data.success && data.code) {
            displayCode.textContent = data.code;
            resultBox.style.display = 'block';

            // Also open modern high-focus modal
            document.getElementById('modalDisplayPairingCode').textContent = data.code;
            openModal('modalPairingCode');
            showToast('✅ 8-Digit Pairing Code is Ready!');
        } else {
            showToast('❌ ' + (data.error || 'Failed to generate code'));
        }
    } catch (err) {
        showToast('❌ Error: ' + err.message);
    } finally {
        btn.disabled = false;
        btn.textContent = '🔢 Get 8-Digit Code';
    }
}

function copyPairingCode() {
    const code = document.getElementById('displayPairingCode').textContent.trim();
    if (!code || code.includes('- -')) return;
    navigator.clipboard.writeText(code).then(() => {
        showToast('📋 Code copied to clipboard!');
    }).catch(() => {
        showToast('Code: ' + code);
    });
}

function copyPairingCodeFromModal() {
    const code = document.getElementById('modalDisplayPairingCode').textContent.trim();
    if (!code || code.includes('- -')) return;
    navigator.clipboard.writeText(code).then(() => {
        showToast('📋 Code copied to clipboard!');
    }).catch(() => {
        showToast('Code: ' + code);
    });
}

// ================= LOGOUT / DISCONNECT MODAL =================

function openLogoutModal() {
    openModal('modalLogoutConfirm');
}

async function confirmLogoutFromModal() {
    closeModal('modalLogoutConfirm');
    try {
        await apiFetch('/api/logout', { method: 'POST' });
        showToast('Session unlinked from this device.');
        pollStatus();
    } catch (err) {
        showToast('Error logging out: ' + err.message);
    }
}

// ================= CONTACTS & MESSAGE COMPOSITION =================

function updateContactCount() {
    const lines = document.getElementById('numbersInput').value.split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0);
    document.getElementById('contactCountBadge').textContent = `${lines.length} Contacts`;
}

function clearContacts() {
    document.getElementById('numbersInput').value = '';
    updateContactCount();
}

function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        const text = e.target.result;
        document.getElementById('numbersInput').value = text;
        updateContactCount();
        showToast(`Imported ${file.name}`);
    };
    reader.readAsText(file);
}

function insertEmoji(emoji) {
    const textarea = document.getElementById('messageInput');
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;
    textarea.value = text.substring(0, start) + emoji + text.substring(end);
    textarea.selectionStart = textarea.selectionEnd = start + emoji.length;
    textarea.focus();
    updateCharCount();
}

function clearMessage() {
    document.getElementById('messageInput').value = '';
    updateCharCount();
}

function updateCharCount() {
    const text = document.getElementById('messageInput').value;
    const chars = text.length;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    document.getElementById('charCount').textContent = `${chars} characters`;
    document.getElementById('wordCount').textContent = `${words} words`;
}

function toggleDispatchMode() {
    const mode = document.querySelector('input[name="dispatchMode"]:checked').value;
    const scheduleBox = document.getElementById('scheduleConfigBox');
    const btn = document.getElementById('btnDispatch');

    if (mode === 'schedule') {
        scheduleBox.style.display = 'block';
        btn.textContent = '⏰ Schedule Message Broadcast';
    } else {
        scheduleBox.style.display = 'none';
        btn.textContent = '🚀 Send Message Now';
    }
}

// ================= DISPATCH CONFIRMATION MODAL =================

function promptDispatchConfirm() {
    const numbersRaw = document.getElementById('numbersInput').value.split('\n')
        .map(n => n.trim())
        .filter(n => n.length > 0);
    const message = document.getElementById('messageInput').value.trim();
    const mode = document.querySelector('input[name="dispatchMode"]:checked').value;

    if (!isConnected) {
        showToast('⚠️ Please link your WhatsApp first in the "Link WhatsApp" tab!');
        switchTab('connect');
        return;
    }

    if (numbersRaw.length === 0) {
        showToast('⚠️ Please enter at least one phone number.');
        return;
    }

    if (!message) {
        showToast('⚠️ Message cannot be empty.');
        return;
    }

    let scheduleTime = null;
    if (mode === 'schedule') {
        scheduleTime = document.getElementById('scheduleDateTime').value;
        if (!scheduleTime) {
            showToast('⚠️ Please pick a date and time for the schedule.');
            return;
        }
    }

    pendingDispatchData = { numbers: numbersRaw, message, mode, scheduleTime };

    // Fill modal fields
    document.getElementById('dispatchModalTitle').textContent = mode === 'instant' ? 'Confirm Instant Broadcast' : 'Confirm 24/7 Cloud Schedule';
    document.getElementById('dispatchModalRecipientCount').textContent = `${numbersRaw.length} Contacts`;
    document.getElementById('dispatchModalMode').textContent = mode === 'instant' ? '⚡ Instant Send' : '⏰ Cloud Scheduled';
    document.getElementById('dispatchModalTime').textContent = mode === 'instant' ? 'Immediate' : new Date(scheduleTime).toLocaleString();
    document.getElementById('dispatchModalMessagePreview').textContent = message;
    document.getElementById('btnExecuteDispatch').textContent = mode === 'instant' ? 'Confirm & Send Now 🚀' : 'Confirm & Schedule ⏰';

    openModal('modalDispatchConfirm');
}

async function executeDispatchFromModal() {
    if (!pendingDispatchData) return;
    const btn = document.getElementById('btnExecuteDispatch');
    btn.disabled = true;
    btn.textContent = '⏳ Processing Dispatch...';

    try {
        const { numbers, message, mode, scheduleTime } = pendingDispatchData;

        if (mode === 'instant') {
            const res = await apiFetch('/api/send-now', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ numbers, message })
            });
            const data = await res.json();
            if (data.success) {
                closeModal('modalDispatchConfirm');
                showToast(`🚀 Sending to ${numbers.length} recipients in background!`);
                loadHistory();
            } else {
                showToast('❌ Error: ' + (data.error || 'Failed to send'));
            }
        } else {
            const res = await apiFetch('/api/schedule', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ numbers, message, scheduleTime })
            });
            const data = await res.json();
            if (data.success) {
                closeModal('modalDispatchConfirm');
                showToast('✅ Broadcast scheduled 24/7 on cloud!');
                switchTab('scheduled');
            } else {
                showToast('❌ Error: ' + (data.error || 'Failed to schedule'));
            }
        }
    } catch (err) {
        showToast('❌ Network error: ' + err.message);
    } finally {
        btn.disabled = false;
        pendingDispatchData = null;
    }
}

// ================= SCHEDULED TASKS & DETAILS MODAL =================

async function loadScheduledJobs() {
    try {
        const res = await apiFetch('/api/scheduled');
        cachedJobs = await res.json();

        const container = document.getElementById('scheduledJobsList');
        const badge = document.getElementById('scheduledCountBadge');
        const pendingJobs = cachedJobs.filter(j => j.status === 'pending');
        badge.textContent = pendingJobs.length;

        if (cachedJobs.length === 0) {
            container.innerHTML = '<p class="empty-state">No scheduled tasks pending.</p>';
            return;
        }

        container.innerHTML = cachedJobs.map(job => {
            const dateStr = new Date(job.scheduleTime).toLocaleString();
            const statusClass = job.status === 'completed' ? 'sent' : (job.status === 'pending' ? 'badge' : 'failed');
            return `
                <div class="job-card interactive-row" onclick="openJobDetailsModal('${job.id}')">
                    <div class="job-info">
                        <h4>⏰ ${dateStr}</h4>
                        <p><strong>Recipients:</strong> ${job.numbers.length} contacts | <strong>Status:</strong> <span class="${statusClass}">${job.status.toUpperCase()}</span></p>
                        <p><strong>Message:</strong> "${job.message.length > 55 ? job.message.substring(0, 55) + '...' : job.message}"</p>
                    </div>
                    <div style="display:flex; align-items:center; gap:8px;" onclick="event.stopPropagation()">
                        <button class="secondary-btn" onclick="openJobDetailsModal('${job.id}')">Details</button>
                        ${job.status === 'pending' ? `<button class="danger-outline-btn" onclick="cancelJob('${job.id}')">Cancel</button>` : ''}
                    </div>
                </div>
            `;
        }).join('');
    } catch (err) {
        console.error('Failed to load scheduled jobs:', err);
    }
}

function openJobDetailsModal(jobId) {
    const job = cachedJobs.find(j => j.id === jobId);
    if (!job) return;

    document.getElementById('detailsModalTitle').textContent = 'Scheduled Task Details';
    document.getElementById('detailsModalStatus').textContent = job.status.toUpperCase();
    document.getElementById('detailsModalTime').textContent = new Date(job.scheduleTime).toLocaleString();
    document.getElementById('detailsModalRecipientCount').textContent = `${job.numbers.length} Contacts`;
    document.getElementById('detailsModalMessage').textContent = job.message;

    const recWrap = document.getElementById('detailsModalRecipientsList');
    if (job.results && job.results.length > 0) {
        recWrap.innerHTML = job.results.map(r => `
            <div class="recipient-row-item">
                <span>+${r.number}</span>
                <span class="status-pill ${r.status}">${r.status.toUpperCase()}</span>
            </div>
        `).join('');
    } else {
        recWrap.innerHTML = job.numbers.map(n => `
            <div class="recipient-row-item">
                <span>+${n}</span>
                <span class="status-pill pending">PENDING</span>
            </div>
        `).join('');
    }

    const actionDiv = document.getElementById('detailsModalCustomAction');
    if (job.status === 'pending') {
        actionDiv.innerHTML = `<button class="danger-btn" onclick="cancelJob('${job.id}'); closeModal('modalDetails');">Cancel Task</button>`;
    } else {
        actionDiv.innerHTML = '';
    }

    openModal('modalDetails');
}

async function cancelJob(id) {
    try {
        await apiFetch(`/api/scheduled/${id}`, { method: 'DELETE' });
        showToast('Scheduled task canceled.');
        loadScheduledJobs();
    } catch (err) {
        showToast('Error canceling: ' + err.message);
    }
}

// ================= DELIVERY HISTORY & DETAILS MODAL =================

async function loadHistory() {
    try {
        const res = await apiFetch('/api/history');
        cachedHistory = await res.json();
        const tbody = document.getElementById('historyTableBody');

        if (cachedHistory.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="empty-state">No message history available yet.</td></tr>';
            return;
        }

        tbody.innerHTML = cachedHistory.map((item, index) => {
            const timeStr = new Date(item.time).toLocaleTimeString();
            return `
                <tr class="interactive-row" onclick="openHistoryDetailsModal(${index})">
                    <td>+${item.number}</td>
                    <td><span class="status-pill ${item.status}">${item.status.toUpperCase()}</span></td>
                    <td>${timeStr}</td>
                    <td>${item.message.length > 45 ? item.message.substring(0, 45) + '...' : item.message}</td>
                </tr>
            `;
        }).join('');
    } catch (err) {
        console.error('Failed to load history:', err);
    }
}

function openHistoryDetailsModal(index) {
    const item = cachedHistory[index];
    if (!item) return;

    document.getElementById('detailsModalTitle').textContent = 'Delivery Record Details';
    document.getElementById('detailsModalStatus').textContent = item.status.toUpperCase();
    document.getElementById('detailsModalTime').textContent = new Date(item.time).toLocaleString();
    document.getElementById('detailsModalRecipientCount').textContent = '1 Recipient';
    document.getElementById('detailsModalMessage').textContent = item.message;

    const recWrap = document.getElementById('detailsModalRecipientsList');
    recWrap.innerHTML = `
        <div class="recipient-row-item">
            <span>+${item.number}</span>
            <span class="status-pill ${item.status}">${item.status.toUpperCase()}${item.error ? ` (${item.error})` : ''}</span>
        </div>
    `;

// 1-Click Data Wipe & Unlink
async function wipeMyDataFromModal() {
    if (!confirm('Are you sure you want to permanently wipe all scheduled tasks, delivery logs, and disconnect your WhatsApp from this device?')) return;
    try {
        await apiFetch('/api/wipe-data', { method: 'POST' });
        showToast('All data and session wiped cleanly.');
        closeModal('modalPrivacy');
        pollStatus();
        loadScheduledJobs();
        loadHistory();
    } catch (err) {
        showToast('Error wiping data: ' + err.message);
    }
}

// ================= TOAST NOTIFICATION =================

function showToast(msg) {
    const toast = document.getElementById('toastNotification');
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3500);
}
