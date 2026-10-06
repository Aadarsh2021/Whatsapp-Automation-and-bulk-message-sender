// AutoMate Cloud - Multi-Tenant Client Engine

let isConnected = false;

// 1. Get or Create Isolated Workspace ID per user
let currentUserId = localStorage.getItem('automate_workspace_id');
if (!currentUserId) {
    currentUserId = 'user_' + Math.random().toString(36).substring(2, 8);
    localStorage.setItem('automate_workspace_id', currentUserId);
}

// Multi-Tenant API Wrapper (Attaches x-user-id header to all requests)
function apiFetch(url, options = {}) {
    options.headers = options.headers || {};
    options.headers['x-user-id'] = currentUserId;
    return fetch(url, options);
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    updateWorkspaceDisplay();
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
});

// Workspace Display & Switcher
function updateWorkspaceDisplay() {
    const wsElem = document.getElementById('displayWorkspaceId');
    if (wsElem) {
        wsElem.textContent = currentUserId;
    }
}

function promptSwitchWorkspace() {
    const input = prompt(
        'Apna Workspace Name ya User ID daalein:\n(Har workspace ka alag WhatsApp aur data hota hai)',
        currentUserId
    );
    if (input && input.trim()) {
        const cleanId = input.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 30);
        if (cleanId) {
            currentUserId = cleanId;
            localStorage.setItem('automate_workspace_id', currentUserId);
            updateWorkspaceDisplay();
            showToast(`Switched to workspace: ${currentUserId}`);
            pollStatus();
            loadScheduledJobs();
            loadHistory();
        }
    }
}

// Live Clock
function initClock() {
    function updateClock() {
        const d = new Date();
        document.getElementById('liveClock').textContent = '🕒 ' + d.toTimeString().split(' ')[0];
    }
    updateClock();
    setInterval(updateClock, 1000);
}

// Tab Switching
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

// Status Polling (Scoped to current user)
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

// Logout (Only current user's session)
async function logoutWhatsApp() {
    if (!confirm(`Are you sure you want to disconnect WhatsApp for workspace "${currentUserId}"?`)) return;
    try {
        await apiFetch('/api/logout', { method: 'POST' });
        showToast('Logged out. Please scan QR or enter pairing code.');
        pollStatus();
    } catch (err) {
        showToast('Error logging out: ' + err.message);
    }
}

// Switch Linking Method (QR vs Phone Number)
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

// Request 8-Digit Pairing Code (Same Phone)
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
            showToast('✅ 8-Digit Code Ready! Enter it in WhatsApp.');
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

// Contacts Management
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

// Message Composer
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

// Mode Toggle
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

// Dispatch Handler
async function handleDispatch() {
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

    const btn = document.getElementById('btnDispatch');
    btn.disabled = true;

    try {
        if (mode === 'instant') {
            const res = await apiFetch('/api/send-now', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ numbers: numbersRaw, message })
            });
            const data = await res.json();
            if (data.success) {
                showToast('🚀 Messages are being sent in the background!');
                loadHistory();
            } else {
                showToast('❌ Error: ' + (data.error || 'Failed to send'));
            }
        } else {
            const scheduleTime = document.getElementById('scheduleDateTime').value;
            if (!scheduleTime) {
                showToast('⚠️ Please select a date and time to schedule.');
                btn.disabled = false;
                return;
            }

            const res = await apiFetch('/api/schedule', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ numbers: numbersRaw, message, scheduleTime })
            });
            const data = await res.json();
            if (data.success) {
                showToast('✅ Broadcast successfully scheduled 24/7 on cloud!');
                switchTab('scheduled');
            } else {
                showToast('❌ Error: ' + (data.error || 'Failed to schedule'));
            }
        }
    } catch (err) {
        showToast('❌ Network error: ' + err.message);
    } finally {
        btn.disabled = false;
    }
}

// Scheduled Tasks (User Scoped)
async function loadScheduledJobs() {
    try {
        const res = await apiFetch('/api/scheduled');
        const jobs = await res.json();

        const container = document.getElementById('scheduledJobsList');
        const badge = document.getElementById('scheduledCountBadge');
        const pendingJobs = jobs.filter(j => j.status === 'pending');
        badge.textContent = pendingJobs.length;

        if (jobs.length === 0) {
            container.innerHTML = '<p class="empty-state">No scheduled tasks found.</p>';
            return;
        }

        container.innerHTML = jobs.map(job => {
            const dateStr = new Date(job.scheduleTime).toLocaleString();
            const statusClass = job.status === 'completed' ? 'sent' : (job.status === 'pending' ? 'badge' : 'failed');
            return `
                <div class="job-card">
                    <div class="job-info">
                        <h4>⏰ ${dateStr}</h4>
                        <p><strong>Recipients:</strong> ${job.numbers.length} contacts | <strong>Status:</strong> <span class="${statusClass}">${job.status}</span></p>
                        <p><strong>Message:</strong> "${job.message.length > 60 ? job.message.substring(0, 60) + '...' : job.message}"</p>
                    </div>
                    ${job.status === 'pending' ? `<button class="danger-outline-btn" onclick="cancelJob('${job.id}')">Cancel</button>` : ''}
                </div>
            `;
        }).join('');
    } catch (err) {
        console.error('Failed to load scheduled jobs:', err);
    }
}

async function cancelJob(id) {
    if (!confirm('Are you sure you want to cancel this scheduled broadcast?')) return;
    try {
        await apiFetch(`/api/scheduled/${id}`, { method: 'DELETE' });
        showToast('Scheduled task canceled.');
        loadScheduledJobs();
    } catch (err) {
        showToast('Error canceling: ' + err.message);
    }
}

// Delivery History (User Scoped)
async function loadHistory() {
    try {
        const res = await apiFetch('/api/history');
        const history = await res.json();
        const tbody = document.getElementById('historyTableBody');

        if (history.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="empty-state">No message history available yet.</td></tr>';
            return;
        }

        tbody.innerHTML = history.map(item => {
            const timeStr = new Date(item.time).toLocaleTimeString();
            return `
                <tr>
                    <td>+${item.number}</td>
                    <td><span class="status-pill ${item.status}">${item.status.toUpperCase()}</span></td>
                    <td>${timeStr}</td>
                    <td>${item.message.length > 50 ? item.message.substring(0, 50) + '...' : item.message}</td>
                </tr>
            `;
        }).join('');
    } catch (err) {
        console.error('Failed to load history:', err);
    }
}

// Toast
function showToast(msg) {
    const toast = document.getElementById('toastNotification');
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3500);
}
