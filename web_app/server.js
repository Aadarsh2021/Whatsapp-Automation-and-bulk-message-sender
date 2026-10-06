require('dotenv').config();
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

const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Local Session Storage directory
const SESSIONS_DIR = path.join(__dirname, 'session_data');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// ----------------- Multi-Tenant Session Pool -----------------
// Map: userId -> { userId, sock, currentQR, connectionStatus, userInfo, isInitializing }
const sessions = new Map();

function getUserId(req) {
    const raw = req.headers['x-user-id'] || req.query.userId || req.body?.userId || 'default_user';
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
        const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['AutoMate Cloud', 'Chrome', '124.0.0']
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
                const isLoggedOut = statusCode === DisconnectReason.loggedOut;
                console.log(`[User: ${userId}] Connection closed (code ${statusCode}). Logged out: ${isLoggedOut}`);

                session.connectionStatus = 'disconnected';
                session.currentQR = null;
                session.userInfo = null;
                session.isInitializing = false;

                if (isLoggedOut) {
                    // Fail-Safe 1: Clean up unlinked session immediately to prevent infinite reconnect loops
                    console.log(`🧹 [User: ${userId}] Cleaning unlinked credentials on disk.`);
                    if (fs.existsSync(userSessionDir)) {
                        fs.rmSync(userSessionDir, { recursive: true, force: true });
                    }
                    sessions.delete(userId);
                } else {
                    // Transient disconnect: Reconnect after 4s
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

// Auto-restore any existing sessions on server boot
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
restoreSavedSessions();

// ================= ANTI-BAN JITTER BATCH SENDER =================
async function sendBatchMessages(sock, userId, numbers, message) {
    const results = [];

    for (let i = 0; i < numbers.length; i++) {
        let raw = numbers[i].trim();
        let clean = raw.replace(/\D/g, '');
        if (clean.length === 10) clean = '91' + clean;

        const jid = `${clean}@s.whatsapp.net`;
        const timestamp = new Date().toISOString();

        try {
            // Anti-Ban Simulation: Send typing presence 1.2s before message
            await sock.sendPresenceUpdate('composing', jid).catch(() => {});
            await new Promise((res) => setTimeout(res, 1200));

            await sock.sendMessage(jid, { text: message });
            results.push({ number: clean, status: 'sent', time: timestamp });

            await db.recordHistory({ userId, number: clean, message, status: 'sent', time: timestamp });
            console.log(`[User: ${userId}] Sent to +${clean} (${i + 1}/${numbers.length})`);
        } catch (err) {
            // Fail-Safe 6: Isolated per-recipient try/catch (1 bad number never stops the batch)
            results.push({ number: clean, status: 'failed', error: err.message, time: timestamp });
            await db.recordHistory({ userId, number: clean, message, status: 'failed', error: err.message, time: timestamp });
            console.error(`[User: ${userId}] Failed +${clean}:`, err.message);
        }

        // Anti-Ban Dynamic Jitter Delay (3.0s to 5.5s randomized)
        if (i < numbers.length - 1) {
            const jitterDelay = 3000 + Math.floor(Math.random() * 2500);
            await new Promise((res) => setTimeout(res, jitterDelay));
        }
    }
    return results;
}

// ================= WORKER POOL & PRE-WARMED SCHEDULER =================
let activeWorkers = 0;
const MAX_CONCURRENT_WORKERS = 8; // Memory-safe concurrency limit for 512MB RAM

setInterval(async () => {
    const now = new Date();

    // 1. Pre-Warming Pass: Connect sockets 30 seconds before midnight
    const preWarmWindow = new Date(now.getTime() + 35000);
    const upcomingJobs = await db.fetchDueJobs(preWarmWindow);

    for (const job of upcomingJobs) {
        if (!sessions.has(job.userId) || sessions.get(job.userId).connectionStatus !== 'connected') {
            console.log(`🔥 Pre-warming socket for user: ${job.userId} (due at ${job.scheduleTime})`);
            getOrCreateSession(job.userId);
        }
    }

    // 2. Dispatch Execution Pass (Atomic Lock per job)
    const dueJobs = await db.fetchDueJobs(now);

    for (const job of dueJobs) {
        if (activeWorkers >= MAX_CONCURRENT_WORKERS) {
            console.warn(`⏳ Worker pool full (${activeWorkers}/${MAX_CONCURRENT_WORKERS}). Queueing job ${job.id}`);
            break;
        }

        // Atomic Idempotency Lock: Only 1 worker can process this job
        const workerId = `worker_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
        const acquired = await db.lockJobForExecution(job.id, workerId);
        if (!acquired) continue;

        activeWorkers++;
        (async () => {
            try {
                console.log(`⏰ [Worker: ${workerId}] Executing job ID: ${job.id} for user ${job.userId}`);
                const session = sessions.get(job.userId);

                if (!session || session.connectionStatus !== 'connected' || !session.sock) {
                    await db.finalizeJob(job.id, 'failed', [], 'WhatsApp is disconnected on user device.');
                    console.warn(`[User: ${job.userId}] Scheduled job failed: Disconnected.`);
                } else {
                    const results = await sendBatchMessages(session.sock, job.userId, job.numbers, job.message);
                    await db.finalizeJob(job.id, 'completed', results, null);
                    console.log(`✅ [Job: ${job.id}] Finished successfully.`);
                }
            } catch (err) {
                console.error(`Job ${job.id} execution error:`, err);
                await db.finalizeJob(job.id, 'failed', [], err.message);
            } finally {
                activeWorkers--;
            }
        })();
    }
}, 8000); // Ticks every 8 seconds

// ================= API ENDPOINTS =================

// Health & Keep-Alive Endpoint (For UptimeRobot 24/7 pinging)
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        supabaseConnected: db.isSupabaseConnected(),
        activeSessions: sessions.size,
        activeWorkers,
        memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
    });
});

// User Session Status
app.get('/api/status', (req, res) => {
    const userId = getUserId(req);
    const session = getOrCreateSession(userId);
    res.json({
        userId,
        status: session.connectionStatus,
        qrCode: session.currentQR,
        user: session.userInfo,
        supabaseActive: db.isSupabaseConnected()
    });
});

// Request 8-Digit Pairing Code
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

// Logout / Disconnect this user's session
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
        getOrCreateSession(userId);

        res.json({ success: true, message: `Device session ${userId} unlinked successfully.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 1-Click Complete Data Wipe (User Trust & GDPR Safety)
app.post('/api/wipe-data', async (req, res) => {
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

        await db.wipeAllDeviceData(userId);
        res.json({ success: true, message: 'All personal data and credentials have been permanently wiped.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Send Now
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
        return res.status(400).json({ error: 'WhatsApp is not connected. Please link WhatsApp first.' });
    }

    sendBatchMessages(session.sock, userId, numbers, message.trim()).catch((e) => console.error(`[User: ${userId}] Batch error:`, e));

    res.json({
        success: true,
        message: `Broadcasting message to ${numbers.length} recipients in background.`
    });
});

// Schedule Message
app.post('/api/schedule', async (req, res) => {
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

    const newJob = {
        id: 'job_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
        userId,
        numbers,
        message: message.trim(),
        scheduleTime: targetDate.toISOString()
    };

    await db.createScheduledTask(newJob);

    res.json({
        success: true,
        job: newJob,
        message: `Message scheduled for ${targetDate.toLocaleString()}`
    });
});

// Get User's Scheduled Jobs
app.get('/api/scheduled', async (req, res) => {
    const userId = getUserId(req);
    const jobs = await db.getScheduledTasksForDevice(userId);
    res.json(jobs);
});

// Cancel User's Scheduled Job
app.delete('/api/scheduled/:id', async (req, res) => {
    const userId = getUserId(req);
    const canceled = await db.cancelScheduledTask(req.params.id, userId);

    if (!canceled) {
        return res.status(404).json({ error: 'Job not found or already executed.' });
    }
    res.json({ success: true, message: 'Job canceled successfully.' });
});

// Get User's History
app.get('/api/history', async (req, res) => {
    const userId = getUserId(req);
    const history = await db.getHistoryForDevice(userId);
    res.json(history);
});

// Public Auth Configuration for Supabase Frontend OAuth
app.get('/api/auth/config', (req, res) => {
    res.json({
        supabaseUrl: process.env.SUPABASE_URL || 'https://pnjoqcmqlmpnvvehkixr.supabase.co',
        supabaseAnonKey: process.env.SUPABASE_ANON_KEY || 'sb_publishable_aiUtzrjlXuJIzd-Vqcc8Ug_YGs33k1o'
    });
});

// Submit User Feedback / Review
app.post('/api/feedback', async (req, res) => {
    try {
        const userId = getUserId(req);
        const { rating, category, comment, userEmail } = req.body;

        if (!comment || !comment.trim()) {
            return res.status(400).json({ error: 'Please enter your feedback comments.' });
        }

        const saved = await db.recordFeedback({
            rating: rating || 5,
            category: category || 'general',
            comment: comment.trim(),
            userEmail: userEmail || null,
            deviceId: userId
        });

        res.json({
            success: true,
            feedback: saved,
            message: 'Thank you! Your feedback helps us improve AutoMate Cloud.'
        });
    } catch (err) {
        console.error('Feedback submission error:', err);
        res.status(500).json({ error: 'Failed to record feedback: ' + err.message });
    }
});

// Get Recent Community Feedback / Reviews
app.get('/api/feedback', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 20;
        const list = await db.getRecentFeedback(limit);
        res.json(list);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`🌐 AutoMate Resilient Cloud Server running on port ${PORT}`);
});

