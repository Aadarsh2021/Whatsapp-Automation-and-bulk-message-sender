const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const pino = require('pino');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Data & Sessions directories
const DATA_DIR = path.join(__dirname, 'data');
const SESSIONS_DIR = path.join(__dirname, 'session_data');
const SCHEDULED_FILE = path.join(DATA_DIR, 'scheduled.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
if (!fs.existsSync(SCHEDULED_FILE)) fs.writeFileSync(SCHEDULED_FILE, JSON.stringify([], null, 2));
if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, JSON.stringify([], null, 2));

// Data access helpers (Multi-Tenant)
function getScheduledJobs() {
    try {
        return JSON.parse(fs.readFileSync(SCHEDULED_FILE, 'utf8'));
    } catch {
        return [];
    }
}

function saveScheduledJobs(jobs) {
    fs.writeFileSync(SCHEDULED_FILE, JSON.stringify(jobs, null, 2));
}

function getHistory() {
    try {
        return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    } catch {
        return [];
    }
}

function appendHistory(entry) {
    const history = getHistory();
    history.unshift(entry);
    if (history.length > 500) history.pop();
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

// ----------------- Multi-Tenant Session Pool -----------------
// Map: userId -> { userId, sock, currentQR, connectionStatus, userInfo, isInitializing }
const sessions = new Map();

function getUserId(req) {
    const raw = req.headers['x-user-id'] || req.query.userId || req.body?.userId || 'default_user';
    // Sanitize user id to alphanumeric and underscores only
    return raw.toString().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'default_user';
}

function getOrCreateSession(userId) {
    if (sessions.has(userId)) {
        return sessions.get(userId);
    }

    const sessionObj = {
        userId,
        sock: null,
        currentQR: null,
        connectionStatus: 'disconnected', // 'connecting', 'qr_ready', 'connected', 'disconnected'
        userInfo: null,
        isInitializing: false
    };

    sessions.set(userId, sessionObj);
    initUserWhatsApp(userId);
    return sessionObj;
}

async function initUserWhatsApp(userId) {
    const session = sessions.get(userId);
    if (!session || session.isInitializing) return;

    session.isInitializing = true;
    session.connectionStatus = 'connecting';
    const userSessionDir = path.join(SESSIONS_DIR, userId);

    if (!fs.existsSync(userSessionDir)) {
        fs.mkdirSync(userSessionDir, { recursive: true });
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState(userSessionDir);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['AutoMate Cloud', 'Chrome', '1.0.0']
        });

        session.sock = sock;

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                try {
                    session.currentQR = await QRCode.toDataURL(qr);
                    session.connectionStatus = 'qr_ready';
                    console.log(`📌 [User: ${userId}] QR Code ready`);
                } catch (err) {
                    console.error(`[User: ${userId}] QR error:`, err);
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`[User: ${userId}] Connection closed (code ${statusCode}). Reconnect: ${shouldReconnect}`);
                session.connectionStatus = 'disconnected';
                session.currentQR = null;
                session.userInfo = null;
                session.isInitializing = false;

                if (shouldReconnect) {
                    setTimeout(() => initUserWhatsApp(userId), 4000);
                }
            } else if (connection === 'open') {
                session.connectionStatus = 'connected';
                session.currentQR = null;
                session.isInitializing = false;
                session.userInfo = {
                    id: sock.user?.id || 'Connected',
                    name: sock.user?.name || `WhatsApp User (${userId})`
                };
                console.log(`✅ [User: ${userId}] WhatsApp Connected: ${session.userInfo.id}`);
            }
        });
    } catch (err) {
        console.error(`Error initializing WhatsApp for ${userId}:`, err);
        session.connectionStatus = 'disconnected';
        session.isInitializing = false;
    }
}

// Auto-restore any existing sessions saved on disk
function restoreSavedSessions() {
    if (fs.existsSync(SESSIONS_DIR)) {
        try {
            const userDirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => d.name);

            for (const uid of userDirs) {
                const credsPath = path.join(SESSIONS_DIR, uid, 'creds.json');
                if (fs.existsSync(credsPath)) {
                    console.log(`🔄 Auto-restoring session for user: ${uid}`);
                    getOrCreateSession(uid);
                }
            }
        } catch (err) {
            console.error('Session restore error:', err);
        }
    }
}

// Start auto-restore
restoreSavedSessions();

// Helper: Send Batch Messages using specific user's socket
async function sendBatchMessages(sock, userId, numbers, message) {
    const results = [];
    for (let i = 0; i < numbers.length; i++) {
        let raw = numbers[i].trim();
        let clean = raw.replace(/\D/g, '');
        if (clean.length === 10) clean = '91' + clean;

        const jid = `${clean}@s.whatsapp.net`;
        const timestamp = new Date().toISOString();

        try {
            await sock.sendMessage(jid, { text: message });
            results.push({ number: clean, status: 'sent', time: timestamp });
            appendHistory({ userId, number: clean, message, status: 'sent', time: timestamp });
            console.log(`[User: ${userId}] Sent to +${clean} (${i + 1}/${numbers.length})`);
        } catch (err) {
            results.push({ number: clean, status: 'failed', error: err.message, time: timestamp });
            appendHistory({ userId, number: clean, message, status: 'failed', error: err.message, time: timestamp });
            console.error(`[User: ${userId}] Failed +${clean}:`, err.message);
        }

        if (i < numbers.length - 1) {
            await new Promise((res) => setTimeout(res, 3000));
        }
    }
    return results;
}

// ----------------- Multi-Tenant Background Scheduler -----------------
setInterval(async () => {
    const jobs = getScheduledJobs();
    const now = new Date();
    let updated = false;

    for (let job of jobs) {
        if (job.status === 'pending') {
            const jobTime = new Date(job.scheduleTime);
            if (jobTime <= now) {
                console.log(`⏰ [User: ${job.userId}] Triggering scheduled job ID: ${job.id}`);
                job.status = 'processing';
                saveScheduledJobs(jobs);

                const session = sessions.get(job.userId);
                if (!session || session.connectionStatus !== 'connected' || !session.sock) {
                    job.status = 'failed';
                    job.error = 'WhatsApp is not connected for this user account.';
                    console.warn(`[User: ${job.userId}] Scheduled job failed: WhatsApp disconnected.`);
                } else {
                    try {
                        const results = await sendBatchMessages(session.sock, job.userId, job.numbers, job.message);
                        job.status = 'completed';
                        job.results = results;
                        job.executedAt = new Date().toISOString();
                    } catch (err) {
                        job.status = 'failed';
                        job.error = err.message;
                    }
                }
                updated = true;
            }
        }
    }

    if (updated) {
        saveScheduledJobs(jobs);
    }
}, 10000); // Checks every 10s

// ----------------- API Endpoints (All Multi-Tenant) -----------------

// User Session Status
app.get('/api/status', (req, res) => {
    const userId = getUserId(req);
    const session = getOrCreateSession(userId);
    res.json({
        userId,
        status: session.connectionStatus,
        qrCode: session.currentQR,
        user: session.userInfo
    });
});

// Request 8-Digit Pairing Code for Specific User
app.post('/api/request-pairing-code', async (req, res) => {
    const userId = getUserId(req);
    const session = getOrCreateSession(userId);
    const { phoneNumber } = req.body;

    if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number is required.' });
    }

    let clean = phoneNumber.replace(/\D/g, '');
    if (clean.length === 10) clean = '91' + clean;

    if (!session.sock) {
        return res.status(500).json({ error: 'WhatsApp socket is initializing. Please retry in 3 seconds.' });
    }

    if (session.connectionStatus === 'connected') {
        return res.status(400).json({ error: 'WhatsApp is already connected for this workspace!' });
    }

    try {
        console.log(`📱 [User: ${userId}] Requesting 8-digit pairing code for: +${clean}`);
        const code = await session.sock.requestPairingCode(clean);
        console.log(`✅ [User: ${userId}] Pairing code generated: ${code}`);
        res.json({ success: true, code });
    } catch (err) {
        console.error(`[User: ${userId}] Pairing code error:`, err);
        res.status(500).json({ error: err.message || 'Failed to generate pairing code.' });
    }
});

// Logout / Disconnect ONLY this user's session
app.post('/api/logout', async (req, res) => {
    const userId = getUserId(req);
    const session = sessions.get(userId);

    try {
        if (session?.sock) {
            await session.sock.logout().catch(() => {});
        }

        const userDir = path.join(SESSIONS_DIR, userId);
        if (fs.existsSync(userDir)) {
            fs.rmSync(userDir, { recursive: true, force: true });
        }

        sessions.delete(userId);
        getOrCreateSession(userId); // Re-initialize clean session for this user

        res.json({ success: true, message: `Workspace ${userId} logged out successfully.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Send Now (Dedicated to user's connected WhatsApp)
app.post('/api/send-now', async (req, res) => {
    const userId = getUserId(req);
    const session = sessions.get(userId);
    const { numbers, message } = req.body;

    if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
        return res.status(400).json({ error: 'Please provide at least one phone number.' });
    }
    if (!message || !message.trim()) {
        return res.status(400).json({ error: 'Message cannot be empty.' });
    }

    if (!session || session.connectionStatus !== 'connected' || !session.sock) {
        return res.status(400).json({ error: 'WhatsApp is not connected for your account. Please link WhatsApp first.' });
    }

    sendBatchMessages(session.sock, userId, numbers, message).catch((e) => console.error(`[User: ${userId}] Batch error:`, e));

    res.json({
        success: true,
        message: `Broadcasting message to ${numbers.length} recipients in background.`
    });
});

// Schedule Message (Dedicated to user)
app.post('/api/schedule', (req, res) => {
    const userId = getUserId(req);
    const { numbers, message, scheduleTime } = req.body;

    if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
        return res.status(400).json({ error: 'Please provide at least one phone number.' });
    }
    if (!message || !message.trim()) {
        return res.status(400).json({ error: 'Message cannot be empty.' });
    }
    if (!scheduleTime) {
        return res.status(400).json({ error: 'Schedule time is required.' });
    }

    const targetDate = new Date(scheduleTime);
    if (isNaN(targetDate.getTime()) || targetDate <= new Date()) {
        return res.status(400).json({ error: 'Schedule time must be in the future.' });
    }

    const jobs = getScheduledJobs();
    const newJob = {
        id: 'job_' + Date.now(),
        userId,
        numbers,
        message,
        scheduleTime: targetDate.toISOString(),
        status: 'pending',
        createdAt: new Date().toISOString()
    };

    jobs.unshift(newJob);
    saveScheduledJobs(jobs);

    res.json({
        success: true,
        job: newJob,
        message: `Message scheduled for ${targetDate.toLocaleString()}`
    });
});

// Get User's Scheduled Jobs (Only their own)
app.get('/api/scheduled', (req, res) => {
    const userId = getUserId(req);
    const jobs = getScheduledJobs().filter(j => j.userId === userId);
    res.json(jobs);
});

// Cancel User's Scheduled Job (Only their own)
app.delete('/api/scheduled/:id', (req, res) => {
    const userId = getUserId(req);
    const jobs = getScheduledJobs();
    const filtered = jobs.filter(j => !(j.id === req.params.id && j.userId === userId));

    if (filtered.length === jobs.length) {
        return res.status(404).json({ error: 'Job not found or not owned by you.' });
    }

    saveScheduledJobs(filtered);
    res.json({ success: true, message: 'Job canceled successfully.' });
});

// Get User's History (Only their own)
app.get('/api/history', (req, res) => {
    const userId = getUserId(req);
    const history = getHistory().filter(h => h.userId === userId);
    res.json(history);
});

app.listen(PORT, () => {
    console.log(`🌐 AutoMate Multi-Tenant Server running on port ${PORT}`);
});
