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
const {
    requireAuth,
    getTenantSessionDir,
    generateSandboxToken,
    maskPhone,
    maskUserId,
    sanitizeErrorMessage,
    pairingCodeLimiter,
    messageDispatchLimiter,
    wipeDataLimiter,
    generalApiLimiter
} = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');

// Security Headers Middleware
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
});

app.use(cors());
app.use(express.json({ limit: '500kb' }));
app.use(express.urlencoded({ extended: true, limit: '500kb' }));
app.use('/api/', generalApiLimiter.middleware(req => req.ip));
app.use(express.static(path.join(__dirname, 'public')));

// Local Session Storage directory
const SESSIONS_DIR = path.resolve(__dirname, 'session_data');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// ----------------- Multi-Tenant Session Pool -----------------
// Map: userId -> { userId, sock, currentQR, connectionStatus, userInfo, isInitializing }
const sessions = new Map();

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
    const userSessionDir = getTenantSessionDir(userId);

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
                    console.log(`📌 [User: ${maskUserId(userId)}] QR Code ready`);
                } catch (err) {
                    console.error(`[User: ${maskUserId(userId)}] QR error:`, sanitizeErrorMessage(err.message || err));
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const isLoggedOut = statusCode === DisconnectReason.loggedOut;
                console.log(`[User: ${maskUserId(userId)}] Connection closed (code ${statusCode}). Logged out: ${isLoggedOut}`);

                session.connectionStatus = 'disconnected';
                session.currentQR = null;
                session.userInfo = null;
                session.isInitializing = false;

                if (isLoggedOut) {
                    // Fail-Safe 1: Clean up unlinked session immediately to prevent infinite reconnect loops
                    console.log(`🧹 [User: ${maskUserId(userId)}] Cleaning unlinked credentials on disk.`);
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
                console.log(`✅ [User: ${maskUserId(userId)}] WhatsApp Connected: ${maskPhone(session.userInfo.id)}`);
            }
        });
    } catch (err) {
        console.error(`Error initializing WhatsApp for ${maskUserId(userId)}:`, sanitizeErrorMessage(err.message || err));
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
                if (!uid.startsWith('usr_')) continue;
                try {
                    const userDir = getTenantSessionDir(uid);
                    const credsPath = path.join(userDir, 'creds.json');
                    if (fs.existsSync(credsPath)) {
                        console.log(`🔄 Auto-restoring session for user: ${maskUserId(uid)}`);
                        getOrCreateSession(uid);
                    }
                } catch (e) {
                    console.warn(`Skipping untrusted session directory: ${maskUserId(uid)}`);
                }
            }
        } catch (err) {
            console.error('Session restore error:', sanitizeErrorMessage(err.message || err));
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
            console.log(`[User: ${maskUserId(userId)}] Sent to ${maskPhone(clean)} (${i + 1}/${numbers.length})`);
        } catch (err) {
            // Fail-Safe 6: Isolated per-recipient try/catch (1 bad number never stops the batch)
            results.push({ number: clean, status: 'failed', error: err.message, time: timestamp });
            await db.recordHistory({ userId, number: clean, message, status: 'failed', error: err.message, time: timestamp });
            console.error(`[User: ${maskUserId(userId)}] Failed ${maskPhone(clean)}:`, sanitizeErrorMessage(err.message));
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
            console.log(`🔥 Pre-warming socket for user: ${maskUserId(job.userId)} (due at ${job.scheduleTime})`);
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
                console.log(`⏰ [Worker: ${workerId}] Executing job ID: ${job.id} for user ${maskUserId(job.userId)}`);
                const session = sessions.get(job.userId);

                if (!session || session.connectionStatus !== 'connected' || !session.sock) {
                    await db.finalizeJob(job.id, 'failed', [], 'WhatsApp is disconnected on user device.');
                    console.warn(`[User: ${maskUserId(job.userId)}] Scheduled job failed: Disconnected.`);
                } else {
                    const results = await sendBatchMessages(session.sock, job.userId, job.numbers, job.message);
                    await db.finalizeJob(job.id, 'completed', results, null);
                    console.log(`✅ [Job: ${job.id}] Finished successfully.`);
                }
            } catch (err) {
                console.error(`Job ${job.id} execution error:`, sanitizeErrorMessage(err.message || err));
                await db.finalizeJob(job.id, 'failed', [], err.message);
            } finally {
                activeWorkers--;
            }
        })();
    }
}, 8000); // Ticks every 8 seconds

// ================= RENDER KEEP-ALIVE AGENT =================
// Prevents Render Free Tier from spinning down / sleeping after 15 minutes of inactivity.
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || 'https://whatsapp-automation-and-bulk-message.onrender.com';
const KEEP_ALIVE_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

let keepAlivePingCount = 0;
let lastKeepAlivePing = null;
let lastKeepAliveStatus = 'initialized';

function triggerRenderPing() {
    try {
        const targetUrl = `${RENDER_EXTERNAL_URL.replace(/\/$/, '')}/api/health`;
        const client = targetUrl.startsWith('https') ? require('https') : require('http');

        const req = client.get(targetUrl, { timeout: 25000 }, (res) => {
            keepAlivePingCount++;
            lastKeepAlivePing = new Date().toISOString();
            lastKeepAliveStatus = res.statusCode === 200 ? 'awake' : `status_${res.statusCode}`;
            console.log(`🛡️ [Render Keep-Alive #${keepAlivePingCount}] Ping sent to ${targetUrl} (HTTP ${res.statusCode}). Spin-down prevented.`);
        });

        req.on('error', (err) => {
            lastKeepAliveStatus = 'warning: ' + err.message;
            console.warn(`⚠️ [Render Keep-Alive] Ping notice: ${sanitizeErrorMessage(err.message)}`);
        });

        req.on('timeout', () => {
            req.destroy();
            lastKeepAliveStatus = 'timeout';
        });
    } catch (err) {
        console.error('Render Keep-Alive trigger error:', sanitizeErrorMessage(err.message || err));
    }
}

function startRenderKeepAliveAgent() {
    console.log(`🛡️ [Render Keep-Alive] Armed. Pinging ${RENDER_EXTERNAL_URL}/api/health every 10 minutes to maintain 24/7 uptime.`);
    // Initial ping after 20 seconds
    setTimeout(triggerRenderPing, 20000);
    // Recurring 10-minute ping loop
    setInterval(triggerRenderPing, KEEP_ALIVE_INTERVAL_MS);
}

// ================= API ENDPOINTS =================

// Comprehensive System Health & Diagnostics Endpoint
app.get('/api/health', (req, res) => {
    const sbInfo = db.getLastHeartbeatInfo();
    res.json({
        status: 'healthy',
        uptimeSeconds: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
        render: {
            service: 'AutoMate Cloud',
            externalUrl: RENDER_EXTERNAL_URL,
            keepAliveAgent: 'active (10m loop)',
            lastPing: lastKeepAlivePing,
            totalPings: keepAlivePingCount,
            status: lastKeepAliveStatus,
            spinDownProtection: 'ENABLED'
        },
        supabase: {
            connected: db.isSupabaseConnected(),
            lastHeartbeat: sbInfo.lastHeartbeat,
            heartbeatStatus: sbInfo.status,
            queryCount: sbInfo.queryCount,
            pauseProtection: 'ENABLED (6h probe loop)'
        },
        activeSessions: sessions.size,
        activeWorkers,
        memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
    });
});

// Dedicated Supabase Keep-Alive Route (resets 7-day inactivity pause)
app.get('/api/keepalive/supabase', async (req, res) => {
    try {
        const result = await db.pingSupabaseHeartbeat();
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Dedicated Render Keep-Alive Trigger Route
app.get('/api/keepalive/render', (req, res) => {
    triggerRenderPing();
    res.json({
        success: true,
        message: 'Render keep-alive ping dispatched.',
        targetUrl: RENDER_EXTERNAL_URL,
        lastPing: lastKeepAlivePing,
        totalPings: keepAlivePingCount,
        status: lastKeepAliveStatus
    });
});

// User Session Status (Cryptographically Verified Tenant Isolation)
app.get('/api/status', requireAuth, (req, res) => {
    const userId = req.userId;
    const session = getOrCreateSession(userId);
    res.json({
        userId,
        status: session.connectionStatus,
        qrCode: session.currentQR,
        user: session.userInfo,
        supabaseActive: db.isSupabaseConnected()
    });
});

// Request 8-Digit Pairing Code (Rate Limited & Input Validated)
app.post('/api/request-pairing-code', requireAuth, pairingCodeLimiter.middleware(req => req.userId), async (req, res) => {
    const userId = req.userId;
    const session = getOrCreateSession(userId);
    const { phoneNumber } = req.body;

    if (!phoneNumber || typeof phoneNumber !== 'string') {
        return res.status(400).json({ error: 'Valid phone number is required.' });
    }

    let clean = phoneNumber.replace(/\D/g, '');
    // Strip leading zeroes (e.g. 09876543210 -> 9876543210)
    if (clean.startsWith('0')) clean = clean.replace(/^0+/, '');
    // Strip duplicate country code if user typed 91 when 91 was already present (e.g. 91919876543210)
    if (clean.length === 12 && clean.startsWith('9191')) {
        clean = clean.slice(2);
    }
    // Auto-prefix Indian country code if 10-digit number is provided
    if (clean.length === 10) clean = '91' + clean;

    if (clean.length < 8 || clean.length > 15) {
        return res.status(400).json({ error: 'Phone number must be between 8 and 15 digits including country code.' });
    }

    if (!session.sock) {
        return res.status(503).json({ error: 'WhatsApp socket is initializing. Please retry in 3 seconds.' });
    }

    if (session.connectionStatus === 'connected') {
        return res.status(400).json({ error: 'WhatsApp is already connected for this workspace.' });
    }

    try {
        console.log(`📱 [User: ${maskUserId(userId)}] Requesting 8-digit pairing code for: ${maskPhone(clean)}`);
        const code = await session.sock.requestPairingCode(clean);
        console.log(`✅ [User: ${maskUserId(userId)}] Pairing code generated successfully.`);
        res.json({ success: true, code, formattedPhone: `+${clean}` });
    } catch (err) {
        console.error(`[User: ${maskUserId(userId)}] Pairing code error:`, sanitizeErrorMessage(err.message || err));
        res.status(500).json({ error: 'Failed to generate pairing code. Please retry.' });
    }
});

// Logout / Disconnect this user's session cleanly
app.post('/api/logout', requireAuth, async (req, res) => {
    const userId = req.userId;
    const session = sessions.get(userId);

    try {
        if (session?.sock) {
            await session.sock.logout().catch(() => {});
            try { session.sock.end(); } catch (e) {}
        }

        const userDir = getTenantSessionDir(userId);
        if (fs.existsSync(userDir)) {
            fs.rmSync(userDir, { recursive: true, force: true });
        }

        sessions.delete(userId);
        res.json({ success: true, message: `Device session ${userId} unlinked successfully.` });
    } catch (err) {
        res.status(500).json({ error: 'Failed to unlink session: ' + err.message });
    }
});

// 1-Click Complete Data Wipe (Rate Limited & Tenant Isolated)
app.post('/api/wipe-data', requireAuth, wipeDataLimiter.middleware(req => req.userId), async (req, res) => {
    const userId = req.userId;
    const session = sessions.get(userId);

    try {
        if (session?.sock) {
            await session.sock.logout().catch(() => {});
            try { session.sock.end(); } catch (e) {}
        }
        const userDir = getTenantSessionDir(userId);
        if (fs.existsSync(userDir)) {
            fs.rmSync(userDir, { recursive: true, force: true });
        }
        sessions.delete(userId);

        await db.wipeAllDeviceData(userId);
        res.json({ success: true, message: 'All personal data and credentials have been permanently wiped.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to wipe data: ' + err.message });
    }
});

// Send Now (Rate Limited & Input Validated)
app.post('/api/send-now', requireAuth, messageDispatchLimiter.middleware(req => req.userId), async (req, res) => {
    const userId = req.userId;
    const session = sessions.get(userId);
    const { numbers, message } = req.body;

    if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
        return res.status(400).json({ error: 'Please provide at least one phone number.' });
    }
    if (numbers.length > 500) {
        return res.status(400).json({ error: 'Batch limit exceeded. Maximum 500 recipients per broadcast.' });
    }
    if (!message || typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'Message cannot be empty.' });
    }
    if (message.length > 4096) {
        return res.status(400).json({ error: 'Message exceeds maximum allowable length of 4096 characters.' });
    }

    if (!session || session.connectionStatus !== 'connected' || !session.sock) {
        return res.status(400).json({ error: 'WhatsApp is not connected. Please link WhatsApp first.' });
    }

    sendBatchMessages(session.sock, userId, numbers, message.trim()).catch((e) => console.error(`[User: ${maskUserId(userId)}] Batch error:`, sanitizeErrorMessage(e.message || e)));

    res.json({
        success: true,
        message: `Broadcasting message to ${numbers.length} recipients in background.`
    });
});

// Schedule Message (Rate Limited & Input Validated)
app.post('/api/schedule', requireAuth, messageDispatchLimiter.middleware(req => req.userId), async (req, res) => {
    const userId = req.userId;
    const { numbers, message, scheduleTime } = req.body;

    if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
        return res.status(400).json({ error: 'Please provide at least one phone number.' });
    }
    if (numbers.length > 500) {
        return res.status(400).json({ error: 'Batch limit exceeded. Maximum 500 recipients per scheduled broadcast.' });
    }
    if (!message || typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'Message cannot be empty.' });
    }
    if (message.length > 4096) {
        return res.status(400).json({ error: 'Message exceeds maximum allowable length of 4096 characters.' });
    }
    if (!scheduleTime) {
        return res.status(400).json({ error: 'Schedule time is required.' });
    }

    const targetDate = new Date(scheduleTime);
    const now = new Date();
    const maxFutureDate = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

    if (isNaN(targetDate.getTime()) || targetDate <= now) {
        return res.status(400).json({ error: 'Schedule time must be a valid future timestamp.' });
    }
    if (targetDate > maxFutureDate) {
        return res.status(400).json({ error: 'Schedule time cannot be more than 1 year in advance.' });
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

// Get User's Scheduled Jobs (Strict Tenant Isolation)
app.get('/api/scheduled', requireAuth, async (req, res) => {
    const userId = req.userId;
    const jobs = await db.getScheduledTasksForDevice(userId);
    res.json(jobs);
});

// Cancel User's Scheduled Job (Ownership Enforced)
app.delete('/api/scheduled/:id', requireAuth, async (req, res) => {
    const userId = req.userId;
    const jobId = req.params.id;
    const canceled = await db.cancelScheduledTask(jobId, userId);

    if (!canceled) {
        return res.status(404).json({ error: 'Job not found, already executed, or unauthorized.' });
    }
    res.json({ success: true, message: 'Job canceled successfully.' });
});

// Get User's History (Strict Tenant Isolation)
app.get('/api/history', requireAuth, async (req, res) => {
    const userId = req.userId;
    const history = await db.getHistoryForDevice(userId);
    res.json(history);
});

// Public Auth Configuration for Supabase Frontend OAuth
app.get('/api/auth/config', (req, res) => {
    res.json({
        supabaseUrl: process.env.SUPABASE_URL || '',
        supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
        isLocalFallback: !db.isSupabaseConnected()
    });
});

// Sandbox Token Generation (Permitted ONLY in offline local fallback mode)
app.post('/api/auth/sandbox-token', (req, res) => {
    if (db.isSupabaseConnected() && process.env.NODE_ENV !== 'test') {
        return res.status(403).json({
            error: 'Sandbox developer tokens are disabled in production when Supabase is connected.',
            code: 'SANDBOX_DISABLED'
        });
    }
    const requestedId = (req.body?.id || 'sandbox_' + Math.random().toString(36).substring(2, 8))
        .replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 36);
    const email = req.body?.email || 'developer@automate.local';
    const token = generateSandboxToken(requestedId, email);
    res.json({
        token,
        userId: `usr_${requestedId}`,
        email,
        expiresIn: 86400
    });
});

// Submit User Feedback / Review (Authenticated with Input Validation)
app.post('/api/feedback', requireAuth, async (req, res) => {
    try {
        const userId = req.userId;
        const { rating, category, comment, userEmail } = req.body;

        if (!comment || typeof comment !== 'string' || !comment.trim()) {
            return res.status(400).json({ error: 'Please enter your feedback comments.' });
        }
        if (comment.length > 1000) {
            return res.status(400).json({ error: 'Comment exceeds maximum allowable length of 1000 characters.' });
        }

        const cleanRating = Math.min(5, Math.max(1, parseInt(rating) || 5));
        const allowedCategories = ['general', 'feature', 'bug', 'performance', 'praise'];
        const cleanCategory = allowedCategories.includes(category) ? category : 'general';

        const saved = await db.recordFeedback({
            rating: cleanRating,
            category: cleanCategory,
            comment: comment.trim(),
            userEmail: userEmail || req.user.email || null,
            deviceId: userId
        });

        res.json({
            success: true,
            feedback: { id: saved.id, rating: saved.rating, category: saved.category, createdAt: saved.createdAt },
            message: 'Thank you! Your feedback helps us improve AutoMate Cloud.'
        });
    } catch (err) {
        console.error('Feedback submission error:', sanitizeErrorMessage(err.message || err));
        res.status(500).json({ error: 'Failed to record feedback.' });
    }
});

// Get Recent Community Feedback / Reviews (Anonymized & Email-Masked)
app.get('/api/feedback', async (req, res) => {
    try {
        const limit = Math.min(50, parseInt(req.query.limit) || 20);
        const list = await db.getRecentFeedback(limit);
        res.json(list);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`🌐 AutoMate Resilient Cloud Server running on port ${PORT}`);
        startRenderKeepAliveAgent();
    });
}

module.exports = app;

