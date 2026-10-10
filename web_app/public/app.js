// AutoMate Cloud - Client Engine (Device-Isolated & Modal System)

let isConnected = false;
let pendingDispatchData = null;
let cachedJobs = [];
let cachedHistory = [];
let authenticatedUser = null;

// Supabase Cloud Auth Config (Loaded dynamically from secure backend environment)
let supabaseClient = null;

// 1. Unique, Persistent Device Session ID (Every phone/PC gets its own private space)
let currentDeviceId = localStorage.getItem('automate_device_id');
if (!currentDeviceId) {
    currentDeviceId = 'dev_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36).slice(-4);
    localStorage.setItem('automate_device_id', currentDeviceId);
}

let currentAccessToken = null;

async function getAuthToken() {
    if (currentAccessToken) return currentAccessToken;
    if (supabaseClient) {
        try {
            const { data: { session } } = await supabaseClient.auth.getSession();
            if (session && session.access_token) {
                currentAccessToken = session.access_token;
                return currentAccessToken;
            }
        } catch (e) {}
    }
    const savedDemo = localStorage.getItem('automate_demo_user');
    if (savedDemo) {
        try {
            const parsed = JSON.parse(savedDemo);
            if (parsed.token) {
                currentAccessToken = parsed.token;
                return currentAccessToken;
            }
        } catch (e) {}
    }
    return null;
}

// Scoped API Wrapper: Automatically attaches verified Authorization Bearer token
async function apiFetch(url, options = {}) {
    options.headers = options.headers || {};
    const token = await getAuthToken();
    if (token) {
        options.headers['Authorization'] = `Bearer ${token}`;
    }
    if (currentDeviceId) {
        options.headers['x-user-id'] = currentDeviceId;
    }
    const res = await fetch(url, options);
    // If backend returns 401 or 403 identity mismatch, session expired or revoked
    if (res.status === 401 && authenticatedUser) {
        console.warn('Session expired or revoked by server.');
        applyGuestUser();
    }
    return res;
}

// ================= AUTHENTICATION & GOOGLE OAUTH =================

async function initAuth() {
    try {
        const res = await fetch('/api/auth/config');
        const config = await res.json();
        if (config.adminEmails && Array.isArray(config.adminEmails)) {
            window.adminEmailsList = config.adminEmails.map(e => e.toLowerCase());
        }

        if (window.supabase && config.supabaseUrl && config.supabaseAnonKey) {
            supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
            
            // Check active session
            supabaseClient.auth.getSession().then(({ data: { session } }) => {
                if (session && session.user) {
                    currentAccessToken = session.access_token;
                    applyAuthenticatedUser({
                        id: session.user.id,
                        email: session.user.email,
                        name: session.user.user_metadata?.full_name || session.user.email.split('@')[0],
                        avatar: session.user.user_metadata?.avatar_url || null,
                        provider: 'Google OAuth 2.0'
                    }, false, session.access_token);
                } else {
                    checkSavedAuth();
                }
            }).catch(() => {
                checkSavedAuth();
            });

            // Listen for OAuth redirect / sign in events
            supabaseClient.auth.onAuthStateChange((event, session) => {
                if (session && session.user) {
                    currentAccessToken = session.access_token;
                    applyAuthenticatedUser({
                        id: session.user.id,
                        email: session.user.email,
                        name: session.user.user_metadata?.full_name || session.user.email.split('@')[0],
                        avatar: session.user.user_metadata?.avatar_url || null,
                        provider: 'Google OAuth 2.0'
                    }, true, session.access_token);
                } else if (event === 'SIGNED_OUT') {
                    currentAccessToken = null;
                    applyGuestUser();
                }
            });
        } else {
            checkSavedAuth();
        }
    } catch (e) {
        console.warn('Supabase auth init notice:', e);
        checkSavedAuth();
    }
}

function checkSavedAuth() {
    const savedDemo = localStorage.getItem('automate_demo_user');
    if (savedDemo) {
        try {
            const parsed = JSON.parse(savedDemo);
            currentAccessToken = parsed.token || null;
            applyAuthenticatedUser(parsed, false, parsed.token);
        } catch (e) {
            applyGuestUser();
        }
    } else {
        applyGuestUser();
    }
}

function applyAuthenticatedUser(user, reloadData = true, token = null) {
    authenticatedUser = user;
    if (token) currentAccessToken = token;
    currentDeviceId = 'usr_' + user.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 36);
    
    const authBtn = document.getElementById('googleAuthBtn');
    const profileBadge = document.getElementById('userProfileBadge');
    const avatarImg = document.getElementById('userAvatarImg');
    const nameSpan = document.getElementById('userDisplayName');
    const adminNavBtn = document.getElementById('adminPortalNavBtn');
    
    if (authBtn) authBtn.style.display = 'none';
    if (profileBadge) profileBadge.style.display = 'inline-flex';
    if (avatarImg) {
        avatarImg.src = user.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.name)}&background=00a884&color=fff`;
    }
    if (nameSpan) {
        nameSpan.textContent = user.name || 'User';
    }

    // Show Admin Portal link if user email matches authorized admins
    const userEmail = (user.email || '').toLowerCase();
    const adminList = window.adminEmailsList || ['thakuraadarsh1@gmail.com'];
    const isAdmin = userEmail && adminList.includes(userEmail);
    if (adminNavBtn) {
        adminNavBtn.style.display = isAdmin ? 'inline-flex' : 'none';
    }

    // Unlock WhatsApp Connect section
    const authGate = document.getElementById('authRequiredGate');
    const connectContent = document.getElementById('authenticatedConnectBox');
    if (authGate) authGate.style.display = 'none';
    if (connectContent) connectContent.style.display = 'block';

    const fbEmail = document.getElementById('feedbackEmailInput');
    if (fbEmail && !fbEmail.value && user.email) {
        fbEmail.value = user.email;
    }

    if (reloadData) {
        loadScheduledJobs();
        loadHistory();
        pollStatus();
    }
}

function applyGuestUser() {
    authenticatedUser = null;
    currentAccessToken = null;
    let guestId = localStorage.getItem('automate_device_id');
    if (!guestId) {
        guestId = 'dev_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36).slice(-4);
        localStorage.setItem('automate_device_id', guestId);
    }
    currentDeviceId = guestId;

    const authBtn = document.getElementById('googleAuthBtn');
    const profileBadge = document.getElementById('userProfileBadge');
    const adminNavBtn = document.getElementById('adminPortalNavBtn');
    if (authBtn) authBtn.style.display = 'inline-flex';
    if (profileBadge) profileBadge.style.display = 'none';
    if (adminNavBtn) adminNavBtn.style.display = 'none';

    // Lock WhatsApp QR / pairing code controls behind Google Sign-in Gate
    const authGate = document.getElementById('authRequiredGate');
    const connectContent = document.getElementById('authenticatedConnectBox');
    if (authGate) authGate.style.display = 'flex';
    if (connectContent) connectContent.style.display = 'none';

    const statusBadge = document.getElementById('connectionStatusBadge');
    const statusText = document.getElementById('statusText');
    if (statusBadge) statusBadge.className = 'status-badge disconnected';
    if (statusText) statusText.textContent = 'Login Required';

    cachedJobs = [];
    cachedHistory = [];
    loadScheduledJobs();
    loadHistory();
}

async function signInWithGoogle() {
    if (!supabaseClient) {
        showToast('Initializing secure Google login...');
        return;
    }
    try {
        const { data, error } = await supabaseClient.auth.signInWithOAuth({
            provider: 'google',
            options: {
                redirectTo: window.location.origin
            }
        });
        if (error) {
            console.warn('OAuth notice:', error.message);
            showToast('Google OAuth notice: ' + error.message);
            setTimeout(() => {
                if (confirm('Google OAuth provider is not yet enabled in your Supabase dashboard. Would you like to sign in using Sandbox Developer Mode?')) {
                    signInDemoUser();
                }
            }, 600);
        }
    } catch (err) {
        console.error(err);
        showToast('Google Sign-in error: ' + err.message);
    }
}

async function signInDemoUser() {
    try {
        const res = await fetch('/api/auth/sandbox-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'developer@automate.sandbox' })
        });
        const data = await res.json();
        if (data.token) {
            const demoUser = {
                id: data.userId.replace('usr_', ''),
                email: data.email,
                name: 'Developer Sandbox',
                avatar: 'https://ui-avatars.com/api/?name=Developer+Sandbox&background=00a884&color=fff',
                provider: 'Sandbox Environment',
                token: data.token
            };
            localStorage.setItem('automate_demo_user', JSON.stringify(demoUser));
            applyAuthenticatedUser(demoUser, true, data.token);
            closeModal('modalAuth');
            showToast('Signed in with Sandbox Developer Profile.');
        } else {
            showToast(data.error || 'Sandbox mode is disabled in production.');
        }
    } catch (err) {
        showToast('Sandbox login error: ' + err.message);
    }
}

async function signOutUser() {
    currentAccessToken = null;
    localStorage.removeItem('automate_demo_user');
    if (supabaseClient) {
        await supabaseClient.auth.signOut().catch(() => {});
    }
    applyGuestUser();
    closeModal('modalProfile');
    showToast('Signed out. Switched to isolated guest session.');
    loadScheduledJobs();
    loadHistory();
    pollStatus();
}

function openAuthModal() {
    openModal('modalAuth');
}

function openProfileModal() {
    if (!authenticatedUser) return openAuthModal();
    const modalAvatar = document.getElementById('profileModalAvatar');
    const modalName = document.getElementById('profileModalName');
    const modalEmail = document.getElementById('profileModalEmail');
    const modalUserId = document.getElementById('profileModalUserId');
    const authType = document.getElementById('profileAuthType');

    if (modalAvatar) {
        modalAvatar.src = authenticatedUser.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(authenticatedUser.name)}&background=00a884&color=fff`;
    }
    if (modalName) modalName.textContent = authenticatedUser.name || 'User';
    if (modalEmail) modalEmail.textContent = authenticatedUser.email || 'user@example.com';
    if (modalUserId) modalUserId.textContent = currentDeviceId;
    if (authType) authType.textContent = authenticatedUser.provider || 'Google OAuth 2.0';

    openModal('modalProfile');
}

// Theme Controller (WhatsApp Dark & Light Palette)
function initTheme() {
    const savedTheme = localStorage.getItem('automate_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    updateThemeIcon(savedTheme);
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const nextTheme = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', nextTheme);
    localStorage.setItem('automate_theme', nextTheme);
    updateThemeIcon(nextTheme);
    showToast(`Switched to ${nextTheme === 'dark' ? 'Dark' : 'Light'} Mode`);
}

function updateThemeIcon(theme) {
    const icon = document.getElementById('themeToggleIcon');
    if (!icon) return;
    if (theme === 'dark') {
        icon.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
    } else {
        icon.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
    }
}
initTheme();

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initClock();
    initAuth();
    pollStatus();
    setInterval(pollStatus, 3000);
    updateChatPreview();

    // Event listeners
    document.getElementById('numbersInput').addEventListener('input', updateContactCount);
    document.getElementById('messageInput').addEventListener('input', () => {
        updateCharCount();
        updateChatPreview();
    });

    // Default schedule time = now + 1 hour in local format
    const now = new Date();
    now.setHours(now.getHours() + 1);
    now.setMinutes(0);
    const localISO = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    document.getElementById('scheduleDateTime').value = localISO;

    // Global Modal Backdrop & ESC Listeners & Ctrl+Enter Dispatch Shortcut
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
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            const composeSec = document.getElementById('sectionCompose');
            if (composeSec && composeSec.classList.contains('active')) {
                e.preventDefault();
                promptDispatchConfirm();
            }
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
        const timeStr = d.toTimeString().split(' ')[0];
        const clockSpan = document.getElementById('clockText');
        if (clockSpan) clockSpan.textContent = timeStr;
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
        updateChatPreview();
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
    // Strict Gate: Do not query WhatsApp sessions or generate QR if user is not signed in
    if (!authenticatedUser) {
        const badge = document.getElementById('connectionStatusBadge');
        const statusText = document.getElementById('statusText');
        if (badge) badge.className = 'status-badge disconnected';
        if (statusText) statusText.textContent = 'Login Required';
        const authGate = document.getElementById('authRequiredGate');
        const connectContent = document.getElementById('authenticatedConnectBox');
        if (authGate) authGate.style.display = 'flex';
        if (connectContent) connectContent.style.display = 'none';
        return;
    }

    try {
        const res = await apiFetch('/api/status');
        const data = await res.json();

        const badge = document.getElementById('connectionStatusBadge');
        const statusText = document.getElementById('statusText');
        const qrContainer = document.getElementById('qrContainer');
        const connectedBox = document.getElementById('connectedStateBox');
        const qrImage = document.getElementById('qrImage');
        const qrLoading = document.getElementById('qrLoading');

        if (data.status === 'auth_required') {
            isConnected = false;
            if (badge) badge.className = 'status-badge disconnected';
            if (statusText) statusText.textContent = 'Login Required';
            const authGate = document.getElementById('authRequiredGate');
            const connectContent = document.getElementById('authenticatedConnectBox');
            if (authGate) authGate.style.display = 'flex';
            if (connectContent) connectContent.style.display = 'none';
            return;
        }

        badge.className = 'status-badge ' + data.status;

        if (data.status === 'connected') {
            if (!isConnected) {
                closeModal('modalPairingCode');
                showToast('WhatsApp connected successfully.');
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
    if (!authenticatedUser) {
        showToast('Please sign in with Google to generate a WhatsApp pairing code.');
        openAuthModal();
        return;
    }

    const phoneInput = document.getElementById('pairingPhoneInput');
    const phoneNumber = phoneInput.value.trim();
    const btn = document.getElementById('btnGetPairingCode');
    const resultBox = document.getElementById('pairingCodeResult');
    const displayCode = document.getElementById('displayPairingCode');

    if (!phoneNumber || phoneNumber.replace(/\D/g, '').length < 10) {
        showToast('Please enter a valid phone number with country code (e.g. 919876543210)');
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Generating Code...';

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

            document.getElementById('modalDisplayPairingCode').textContent = data.code;
            openModal('modalPairingCode');
            showToast(`Pairing code generated for ${data.formattedPhone || phoneNumber}. Enter in WhatsApp within 60 seconds.`);
        } else {
            showToast(data.error || 'Failed to generate pairing code');
        }
    } catch (err) {
        showToast('Error: ' + err.message);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Generate Pairing Code';
    }
}

function copyPairingCode() {
    const code = document.getElementById('displayPairingCode').textContent.trim();
    if (!code || code.includes('- -')) return;
    navigator.clipboard.writeText(code).then(() => {
        showToast('Code copied to clipboard.');
    }).catch(() => {
        showToast('Code: ' + code);
    });
}

function copyPairingCodeFromModal() {
    const code = document.getElementById('modalDisplayPairingCode').textContent.trim();
    if (!code || code.includes('- -')) return;
    navigator.clipboard.writeText(code).then(() => {
        showToast('Code copied to clipboard.');
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

// Drag & Drop CSV / TXT Handling
function handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    const zone = document.getElementById('dropZoneWrap');
    if (zone) zone.classList.add('drag-active');
}

function handleDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    const zone = document.getElementById('dropZoneWrap');
    if (zone) zone.classList.remove('drag-active');
}

function handleDropFile(e) {
    e.preventDefault();
    e.stopPropagation();
    const zone = document.getElementById('dropZoneWrap');
    if (zone) zone.classList.remove('drag-active');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        processUploadedFile(e.dataTransfer.files[0]);
    }
}

function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    processUploadedFile(file);
    event.target.value = '';
}

function processUploadedFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        const text = e.target.result;
        // Parse numbers: handles comma, semicolon, newline or tab separated
        const numbers = text.split(/[\r\n,;]+/)
            .map(s => s.trim().replace(/[^0-9+]/g, ''))
            .filter(s => s.length >= 7);

        if (numbers.length === 0) {
            showToast('No valid phone numbers found in file.');
            return;
        }

        const input = document.getElementById('numbersInput');
        const existing = input.value.trim();
        if (existing) {
            input.value = existing + '\n' + numbers.join('\n');
        } else {
            input.value = numbers.join('\n');
        }
        updateContactCount();
        showToast(`Imported ${numbers.length} contacts from ${file.name}.`);
    };
    reader.readAsText(file);
}

function addSampleTestNumber() {
    const input = document.getElementById('numbersInput');
    const sample = '919876543210';
    const current = input.value.trim();
    if (!current) {
        input.value = sample;
    } else {
        input.value = current + '\n' + sample;
    }
    updateContactCount();
    showToast('Added sample test number (+919876543210).');
}

function formatSelection(wrapper) {
    const textarea = document.getElementById('messageInput');
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;

    if (start === end) {
        const sample = 'text';
        textarea.value = text.substring(0, start) + wrapper + sample + wrapper + text.substring(end);
        textarea.selectionStart = start + wrapper.length;
        textarea.selectionEnd = start + wrapper.length + sample.length;
    } else {
        const selected = text.substring(start, end);
        textarea.value = text.substring(0, start) + wrapper + selected + wrapper + text.substring(end);
        textarea.selectionStart = start;
        textarea.selectionEnd = end + (wrapper.length * 2);
    }
    textarea.focus();
    updateCharCount();
    updateChatPreview();
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
    updateChatPreview();
}

function clearMessage() {
    document.getElementById('messageInput').value = '';
    updateCharCount();
    updateChatPreview();
}

function updateCharCount() {
    const text = document.getElementById('messageInput').value;
    const chars = text.length;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    document.getElementById('charCount').textContent = `${chars} characters`;
    document.getElementById('wordCount').textContent = `${words} words`;
}

// Live Realistic WhatsApp Message Preview Formatter
function updateChatPreview() {
    const msgInput = document.getElementById('messageInput');
    const previewBubble = document.getElementById('previewBubbleText');
    const previewTime = document.getElementById('previewBubbleTime');
    if (!previewBubble) return;

    const raw = msgInput ? msgInput.value : '';
    if (!raw.trim()) {
        previewBubble.innerHTML = '<span class="wa-bubble-placeholder">Type a message to preview formatting...</span>';
    } else {
        let formatted = escapeHtml(raw);
        // *bold*
        formatted = formatted.replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>');
        // _italic_
        formatted = formatted.replace(/_([^_\n]+)_/g, '<em>$1</em>');
        // ~strike~
        formatted = formatted.replace(/~([^~\n]+)~/g, '<del>$1</del>');
        // ```code```
        formatted = formatted.replace(/```([^`]+)```/g, '<code>$1</code>');
        // newlines to <br>
        formatted = formatted.replace(/\n/g, '<br>');
        previewBubble.innerHTML = formatted;
    }

    if (previewTime) {
        const d = new Date();
        let hours = d.getHours();
        const minutes = d.getMinutes().toString().padStart(2, '0');
        const ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12;
        hours = hours ? hours : 12;
        previewTime.textContent = `${hours}:${minutes} ${ampm}`;
    }
}

// Quick Schedule Presets
function setQuickSchedule(preset) {
    const d = new Date();
    let toastLabel = '';

    if (preset === 'midnight') {
        // Tonight 12:00 AM (next calendar day at 00:00:00)
        d.setDate(d.getDate() + 1);
        d.setHours(0, 0, 0, 0);
        toastLabel = 'Tonight at 12:00:00 AM (Midnight)';
    } else if (preset === 'tomorrow9am') {
        d.setDate(d.getDate() + 1);
        d.setHours(9, 0, 0, 0);
        toastLabel = 'Tomorrow at 9:00 AM';
    } else if (preset === '1hour') {
        d.setHours(d.getHours() + 1);
        toastLabel = 'In 1 Hour';
    }

    const localISO = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const dateInput = document.getElementById('scheduleDateTime');
    if (dateInput) dateInput.value = localISO;

    const schedRadio = document.querySelector('input[name="dispatchMode"][value="schedule"]');
    if (schedRadio) {
        schedRadio.checked = true;
        toggleDispatchMode();
    }

    showToast(`Schedule preset applied: ${toastLabel}`);
}

function toggleDispatchMode() {
    const mode = document.querySelector('input[name="dispatchMode"]:checked').value;
    const scheduleBox = document.getElementById('scheduleConfigBox');
    const btn = document.getElementById('btnDispatch');
    const btnText = document.getElementById('btnDispatchText');

    if (mode === 'schedule') {
        scheduleBox.style.display = 'block';
        if (btnText) btnText.textContent = 'Schedule Message Broadcast';
        else btn.textContent = 'Schedule Message Broadcast';
    } else {
        scheduleBox.style.display = 'none';
        if (btnText) btnText.textContent = 'Send Message Now';
        else btn.textContent = 'Send Message Now';
    }
}

// ================= DISPATCH CONFIRMATION MODAL =================

function promptDispatchConfirm() {
    if (!authenticatedUser) {
        showToast('Please sign in with Google to broadcast or schedule messages.');
        openAuthModal();
        return;
    }

    const numbersRaw = document.getElementById('numbersInput').value.split('\n')
        .map(n => n.trim())
        .filter(n => n.length > 0);
    const message = document.getElementById('messageInput').value.trim();
    const mode = document.querySelector('input[name="dispatchMode"]:checked').value;

    if (!isConnected) {
        showToast('Please link your WhatsApp first in the "Link WhatsApp" tab.');
        switchTab('connect');
        return;
    }

    if (numbersRaw.length === 0) {
        showToast('Please enter at least one phone number.');
        return;
    }

    if (!message) {
        showToast('Message cannot be empty.');
        return;
    }

    let scheduleTime = null;
    if (mode === 'schedule') {
        scheduleTime = document.getElementById('scheduleDateTime').value;
        if (!scheduleTime) {
            showToast('Please pick a date and time for the schedule.');
            return;
        }
    }

    pendingDispatchData = { numbers: numbersRaw, message, mode, scheduleTime };

    // Fill modal fields
    document.getElementById('dispatchModalTitle').textContent = mode === 'instant' ? 'Confirm Instant Broadcast' : 'Confirm Scheduled Broadcast';
    document.getElementById('dispatchModalRecipientCount').textContent = `${numbersRaw.length} Contacts`;
    document.getElementById('dispatchModalMode').textContent = mode === 'instant' ? 'Instant Send' : 'Cloud Scheduled';
    document.getElementById('dispatchModalTime').textContent = mode === 'instant' ? 'Immediate' : new Date(scheduleTime).toLocaleString();
    document.getElementById('dispatchModalMessagePreview').textContent = message;
    document.getElementById('btnExecuteDispatch').textContent = mode === 'instant' ? 'Confirm & Dispatch' : 'Confirm & Schedule';

    openModal('modalDispatchConfirm');
}

async function executeDispatchFromModal() {
    if (!pendingDispatchData) return;
    const btn = document.getElementById('btnExecuteDispatch');
    btn.disabled = true;
    btn.textContent = 'Processing Dispatch...';

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
                showToast(`Dispatched to ${numbers.length} recipients in background.`);
                loadHistory();
            } else {
                showToast('Error: ' + (data.error || 'Failed to dispatch'));
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
                showToast('Broadcast scheduled successfully.');
                switchTab('scheduled');
            } else {
                showToast('Error: ' + (data.error || 'Failed to schedule'));
            }
        }
    } catch (err) {
        showToast('Network error: ' + err.message);
    } finally {
        btn.disabled = false;
        pendingDispatchData = null;
    }
}

// ================= SCHEDULED TASKS & DETAILS MODAL =================

async function loadScheduledJobs() {
    const container = document.getElementById('scheduledJobsList');
    const badge = document.getElementById('scheduledCountBadge');

    if (!authenticatedUser && !currentAccessToken) {
        cachedJobs = [];
        if (badge) badge.textContent = '0';
        if (container) {
            container.innerHTML = '<p class="empty-state">Please sign in with Google to view scheduled tasks.</p>';
        }
        return;
    }

    try {
        const res = await apiFetch('/api/scheduled');
        if (!res.ok) {
            cachedJobs = [];
        } else {
            const data = await res.json();
            cachedJobs = Array.isArray(data) ? data : [];
        }

        const pendingJobs = cachedJobs.filter(j => j && j.status === 'pending');
        if (badge) badge.textContent = pendingJobs.length;

        if (!container) return;
        if (cachedJobs.length === 0) {
            container.innerHTML = '<p class="empty-state">No scheduled tasks pending.</p>';
            return;
        }

        container.innerHTML = cachedJobs.map(job => {
            const dateStr = escapeHtml(new Date(job.scheduleTime).toLocaleString());
            const statusClass = job.status === 'completed' ? 'sent' : (job.status === 'pending' ? 'badge' : 'failed');
            const statusText = escapeHtml((job.status || 'UNKNOWN').toUpperCase());
            const rawMsg = job.message || '';
            const msgSnippet = escapeHtml(rawMsg.length > 55 ? rawMsg.substring(0, 55) + '...' : rawMsg);
            const safeJobId = encodeURIComponent(job.id);
            const recipientCount = Number(Array.isArray(job.numbers) ? job.numbers.length : 0);
            return `
                <div class="job-card interactive-row" onclick="openJobDetailsModal('${safeJobId}')">
                    <div class="job-info">
                        <h4>${dateStr}</h4>
                        <p><strong>Recipients:</strong> ${recipientCount} contacts | <strong>Status:</strong> <span class="${statusClass}">${statusText}</span></p>
                        <p><strong>Message:</strong> "${msgSnippet}"</p>
                    </div>
                    <div style="display:flex; align-items:center; gap:8px;" onclick="event.stopPropagation()">
                        <button class="secondary-btn" onclick="openJobDetailsModal('${safeJobId}')">Details</button>
                        ${job.status === 'pending' ? `<button class="danger-outline-btn" onclick="cancelJob('${safeJobId}')">Cancel</button>` : ''}
                    </div>
                </div>
            `;
        }).join('');
    } catch (err) {
        console.error('Failed to load scheduled jobs:', err);
    }
}

function openJobDetailsModal(jobId) {
    const job = cachedJobs.find(j => String(j.id) === String(decodeURIComponent(jobId)));
    if (!job) return;

    document.getElementById('detailsModalTitle').textContent = 'Scheduled Task Details';
    document.getElementById('detailsModalStatus').textContent = (job.status || '').toUpperCase();
    document.getElementById('detailsModalTime').textContent = new Date(job.scheduleTime).toLocaleString();
    document.getElementById('detailsModalRecipientCount').textContent = `${(job.numbers || []).length} Contacts`;
    document.getElementById('detailsModalMessage').textContent = job.message || '';

    const recWrap = document.getElementById('detailsModalRecipientsList');
    if (job.results && job.results.length > 0) {
        recWrap.innerHTML = job.results.map(r => {
            const num = escapeHtml(r.number || '');
            const st = escapeHtml((r.status || 'unknown').toUpperCase());
            const pillClass = (r.status === 'sent' || r.status === 'completed') ? 'sent' : 'failed';
            return `
                <div class="recipient-row-item">
                    <span>+${num}</span>
                    <span class="status-pill ${pillClass}">${st}</span>
                </div>
            `;
        }).join('');
    } else {
        recWrap.innerHTML = (job.numbers || []).map(n => {
            const num = escapeHtml(n || '');
            return `
                <div class="recipient-row-item">
                    <span>+${num}</span>
                    <span class="status-pill pending">PENDING</span>
                </div>
            `;
        }).join('');
    }

    const actionDiv = document.getElementById('detailsModalCustomAction');
    if (job.status === 'pending') {
        const safeJobId = encodeURIComponent(job.id);
        actionDiv.innerHTML = `<button class="danger-btn" onclick="cancelJob('${safeJobId}'); closeModal('modalDetails');">Cancel Task</button>`;
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

let currentHistoryFilterStatus = 'all';
let currentHistorySearchQuery = '';

function filterHistoryStatus(status, btn) {
    currentHistoryFilterStatus = status;
    document.querySelectorAll('.history-status-pills .history-pill').forEach(p => p.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderFilteredHistory();
}

function filterHistoryLogs() {
    const input = document.getElementById('historySearchInput');
    currentHistorySearchQuery = (input ? input.value : '').toLowerCase().trim();
    renderFilteredHistory();
}

function renderFilteredHistory() {
    const tbody = document.getElementById('historyTableBody');
    if (!tbody) return;

    if (!authenticatedUser && !currentAccessToken) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty-state">Please sign in with Google to view delivery logs.</td></tr>';
        return;
    }

    let list = Array.isArray(cachedHistory) ? cachedHistory : [];

    if (currentHistoryFilterStatus !== 'all') {
        list = list.filter(item => (item.status || '').toLowerCase() === currentHistoryFilterStatus);
    }

    if (currentHistorySearchQuery) {
        list = list.filter(item => 
            (item.number || '').toLowerCase().includes(currentHistorySearchQuery) ||
            (item.message || '').toLowerCase().includes(currentHistorySearchQuery) ||
            (item.status || '').toLowerCase().includes(currentHistorySearchQuery)
        );
    }

    if (list.length === 0) {
        const msg = (cachedHistory && cachedHistory.length > 0)
            ? 'No delivery records match your filter / search.'
            : 'No message history available yet.';
        tbody.innerHTML = `<tr><td colspan="4" class="empty-state">${msg}</td></tr>`;
        return;
    }

    tbody.innerHTML = list.map((item) => {
        const originalIndex = cachedHistory.indexOf(item);
        const timeStr = item.time ? new Date(item.time).toLocaleString() : 'N/A';
        const statusClass = (item.status === 'sent' || item.status === 'completed') ? 'sent' : 'failed';
        return `
            <tr class="interactive-row" onclick="openHistoryDetailsModal(${originalIndex})">
                <td><strong>+${escapeHtml(item.number)}</strong></td>
                <td><span class="status-pill ${statusClass}">${escapeHtml((item.status || 'UNKNOWN').toUpperCase())}</span></td>
                <td>${timeStr}</td>
                <td>${escapeHtml(item.message && item.message.length > 45 ? item.message.substring(0, 45) + '...' : (item.message || ''))}</td>
            </tr>
        `;
    }).join('');
}

async function loadHistory() {
    if (!authenticatedUser && !currentAccessToken) {
        cachedHistory = [];
        renderFilteredHistory();
        return;
    }

    try {
        const res = await apiFetch('/api/history');
        if (!res.ok) {
            cachedHistory = [];
        } else {
            const data = await res.json();
            cachedHistory = Array.isArray(data) ? data : [];
        }
        renderFilteredHistory();
    } catch (err) {
        console.error('Failed to load history:', err);
        cachedHistory = [];
        renderFilteredHistory();
    }
}

function exportHistoryCSV() {
    if (!cachedHistory || cachedHistory.length === 0) {
        showToast('No delivery logs to export.');
        return;
    }

    let csvContent = "data:text/csv;charset=utf-8,";
    csvContent += "Phone Number,Status,Execution Time,Message,Error Details\r\n";

    cachedHistory.forEach(item => {
        const number = `"+${(item.number || '').replace(/"/g, '""')}"`;
        const status = `"${(item.status || '').replace(/"/g, '""')}"`;
        const time = `"${new Date(item.time).toLocaleString().replace(/"/g, '""')}"`;
        const msg = `"${(item.message || '').replace(/"/g, '""').replace(/\n/g, ' ')}"`;
        const err = `"${(item.error || '').replace(/"/g, '""')}"`;
        csvContent += `${number},${status},${time},${msg},${err}\r\n`;
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `AutoMate_Delivery_Report_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    showToast(`Exported ${cachedHistory.length} delivery records as CSV.`);
}

function openHistoryDetailsModal(index) {
    const item = cachedHistory[index];
    if (!item) return;

    document.getElementById('detailsModalTitle').textContent = 'Delivery Record Details';
    document.getElementById('detailsModalStatus').textContent = (item.status || 'UNKNOWN').toUpperCase();
    document.getElementById('detailsModalTime').textContent = item.time ? new Date(item.time).toLocaleString() : 'N/A';
    document.getElementById('detailsModalRecipientCount').textContent = '1 Recipient';
    document.getElementById('detailsModalMessage').textContent = item.message || '';

    const recWrap = document.getElementById('detailsModalRecipientsList');
    const safeNum = escapeHtml(item.number || '');
    const safeStatus = escapeHtml((item.status || 'UNKNOWN').toUpperCase());
    const pillClass = (item.status === 'sent' || item.status === 'completed') ? 'sent' : 'failed';
    const errorSuffix = item.error ? ` (${escapeHtml(item.error)})` : '';
    recWrap.innerHTML = `
        <div class="recipient-row-item">
            <span>+${safeNum}</span>
            <span class="status-pill ${pillClass}">${safeStatus}${errorSuffix}</span>
        </div>
    `;

    document.getElementById('detailsModalCustomAction').innerHTML = '';
    openModal('modalDetails');
}

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

// ================= MESSAGE TEMPLATES LIBRARY =================

const MESSAGE_TEMPLATES = {
    birthday: "Wishing you a very Happy Birthday! May your upcoming year bring continuous success, good health, and fulfillment.",
    festival: "Warm season's greetings to you and your team. Wishing you peace, prosperity, and continued success.",
    payment: "Friendly reminder regarding outstanding invoice #{Invoice_No} for ₹{Amount}, due on {Date}. Please confirm once processed. Thank you.",
    announcement: "Important Notice: Please take note of the scheduled system maintenance window starting {Date}. For immediate inquiries, contact support.",
    meeting: "Confirmation for our upcoming discussion scheduled on {Date} at {Time}. Please confirm your availability or propose an alternative time slot."
};

function insertTemplate(type) {
    const text = MESSAGE_TEMPLATES[type];
    if (!text) return;
    const msgInput = document.getElementById('messageInput');
    if (!msgInput) return;

    if (msgInput.value.trim().length > 0) {
        if (!confirm('Replace your current draft message with this template?')) {
            return;
        }
    }
    msgInput.value = text;
    updateCharCount();
    updateChatPreview();
    msgInput.focus();
    showToast('Template loaded into composer.');
}

// ================= FEEDBACK & REVIEWS =================

let currentSelectedRating = 5;
let currentSelectedCategory = 'Product Feedback';

function setStarRating(rating) {
    currentSelectedRating = rating;
    const stars = document.querySelectorAll('#starRatingRow .star-btn');
    stars.forEach(s => {
        const r = parseInt(s.getAttribute('data-rating'));
        if (r <= rating) {
            s.classList.add('active');
        } else {
            s.classList.remove('active');
        }
    });

    const labels = {
        1: '1 / 5 - Needs Improvement',
        2: '2 / 5 - Fair',
        3: '3 / 5 - Good',
        4: '4 / 5 - Very Good',
        5: '5 / 5 - Excellent'
    };
    const labelEl = document.getElementById('starRatingLabel');
    if (labelEl) labelEl.textContent = labels[rating] || `${rating} / 5`;
}

function selectCategory(cat, btn) {
    currentSelectedCategory = cat;
    document.querySelectorAll('.category-pills .category-pill').forEach(p => p.classList.remove('active'));
    if (btn) btn.classList.add('active');
}

function openFeedbackModal() {
    loadRecentFeedback();
    openModal('modalFeedback');
}

async function submitFeedback() {
    const commentInput = document.getElementById('feedbackCommentInput');
    const emailInput = document.getElementById('feedbackEmailInput');
    const comment = commentInput ? commentInput.value.trim() : '';
    const email = emailInput ? emailInput.value.trim() : '';

    if (!comment) {
        showToast('Please enter your feedback or note.');
        if (commentInput) commentInput.focus();
        return;
    }

    const submitBtn = document.getElementById('btnSubmitFeedback');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Submitting...';
    }

    try {
        const res = await apiFetch('/api/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                rating: currentSelectedRating,
                category: currentSelectedCategory,
                comment: comment,
                userEmail: email
            })
        });
        const data = await res.json();
        if (data.success) {
            showToast('Thank you! Your feedback has been recorded.');
            if (commentInput) commentInput.value = '';
            closeModal('modalFeedback');
        } else {
            showToast(data.error || 'Failed to submit feedback.');
        }
    } catch (err) {
        showToast('Submission error: ' + err.message);
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Submit Feedback';
        }
    }
}

async function loadRecentFeedback() {
    try {
        const res = await fetch('/api/feedback?limit=5');
        const list = await res.json();
        const container = document.getElementById('recentReviewsList');
        if (!container) return;

        if (!Array.isArray(list) || list.length === 0) {
            container.innerHTML = `
                <div class="review-item-mini">
                    <div class="review-stars">★★★★★</div>
                    <p class="review-text">"Batch notifications execute with zero packet loss and predictable throttling."</p>
                    <span class="review-author">— Verified User</span>
                </div>
            `;
            return;
        }

        container.innerHTML = list.map(item => {
            const stars = '★'.repeat(item.rating) + '☆'.repeat(Math.max(0, 5 - item.rating));
            const dateStr = new Date(item.createdAt).toLocaleDateString();
            const author = item.userEmail ? item.userEmail.split('@')[0] : 'Verified User';
            return `
                <div class="review-item-mini">
                    <div class="review-stars">${stars}</div>
                    <p class="review-text">"${escapeHtml(item.comment)}"</p>
                    <span class="review-author">— ${escapeHtml(author)} (${dateStr})</span>
                </div>
            `;
        }).join('');
    } catch (err) {
        console.warn('Failed to load recent reviews:', err);
    }
}

function escapeHtml(str) {
    if (!str) return '';
    return str.toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

