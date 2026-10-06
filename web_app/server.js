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

// Data directories
const DATA_DIR = path.join(__dirname, 'data');
const SESSIONS_DIR = path.join(__dirname, 'session_data');
const SCHEDULED_FILE = path.join(DATA_DIR, 'scheduled.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SCHEDULED_FILE)) fs.writeFileSync(SCHEDULED_FILE, JSON.stringify([], null, 2));
if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, JSON.stringify([], null, 2));

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
    // keep latest 200
    if (history.length > 200) history.pop();
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

// ----------------- WhatsApp Socket Manager -----------------
let sock = null;
let currentQR = null;
let connectionStatus = 'disconnected'; // 'connecting', 'qr_ready', 'connected', 'disconnected'
let userInfo = null;

async function initWhatsApp() {
    try {
        connectionStatus = 'connecting';
        const { state, saveCreds } = await useMultiFileAuthState(SESSIONS_DIR);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['AutoMate Web', 'Chrome', '1.0.0']
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                try {
                    currentQR = await QRCode.toDataURL(qr);
                    connectionStatus = 'qr_ready';
                    console.log('📌 QR Code ready for scanning');
                } catch (err) {
                    console.error('QR code generation error:', err);
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`Connection closed (code ${statusCode}). Reconnecting: ${shouldReconnect}`);
                connectionStatus = 'disconnected';
                currentQR = null;
                userInfo = null;

                if (shouldReconnect) {
                    setTimeout(initWhatsApp, 4000);
                }
            } else if (connection === 'open') {
                connectionStatus = 'connected';
                currentQR = null;
                userInfo = {
                    id: sock.user?.id || 'Connected',
                    name: sock.user?.name || 'WhatsApp User'
                };
                console.log('✅ WhatsApp connected successfully as:', userInfo.id);
            }
        });
    } catch (err) {
        console.error('Error in initWhatsApp:', err);
        connectionStatus = 'disconnected';
    }
}

// Start connection on server boot
initWhatsApp();

// ----------------- Helper: Send Messages Sequentially -----------------
async function sendBatchMessages(numbers, message) {
    if (!sock || connectionStatus !== 'connected') {
        throw new Error('WhatsApp is not connected. Please scan QR code first.');
    }

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
            appendHistory({ number: clean, message, status: 'sent', time: timestamp });
            console.log(`[${i + 1}/${numbers.length}] Sent to +${clean}`);
        } catch (err) {
            results.push({ number: clean, status: 'failed', error: err.message, time: timestamp });
            appendHistory({ number: clean, message, status: 'failed', error: err.message, time: timestamp });
            console.error(`Failed to send to +${clean}:`, err.message);
        }

        // 3-second natural gap between messages
        if (i < numbers.length - 1) {
            await new Promise((res) => setTimeout(res, 3000));
        }
    }
    return results;
}

// ----------------- Background Scheduler Engine -----------------
setInterval(async () => {
    if (!sock || connectionStatus !== 'connected') return;

    const jobs = getScheduledJobs();
    const now = new Date();
    let updated = false;

    for (let job of jobs) {
        if (job.status === 'pending') {
            const jobTime = new Date(job.scheduleTime);
            if (jobTime <= now) {
                console.log(`⏰ Triggering scheduled job ID: ${job.id}`);
                job.status = 'processing';
                saveScheduledJobs(jobs);

                try {
                    const results = await sendBatchMessages(job.numbers, job.message);
                    job.status = 'completed';
                    job.results = results;
                    job.executedAt = new Date().toISOString();
                } catch (err) {
                    job.status = 'failed';
                    job.error = err.message;
                }
                updated = true;
            }
        }
    }

    if (updated) {
        saveScheduledJobs(jobs);
    }
}, 10000); // Check every 10 seconds

// ----------------- API Endpoints -----------------

// Status Check
app.get('/api/status', (req, res) => {
    res.json({
        status: connectionStatus,
        qrCode: currentQR,
        user: userInfo
    });
});

// Request 8-Digit Pairing Code (For same-phone linking without camera/QR)
app.post('/api/request-pairing-code', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number is required.' });
    }

    let clean = phoneNumber.replace(/\D/g, '');
    if (clean.length === 10) clean = '91' + clean;

    if (!sock) {
        return res.status(500).json({ error: 'WhatsApp socket is initializing. Please retry in 3 seconds.' });
    }

    if (connectionStatus === 'connected') {
        return res.status(400).json({ error: 'WhatsApp is already connected!' });
    }

    try {
        console.log(`📱 Requesting 8-digit pairing code for: +${clean}`);
        const code = await sock.requestPairingCode(clean);
        console.log(`✅ Pairing code generated: ${code}`);
        res.json({ success: true, code });
    } catch (err) {
        console.error('Pairing code error:', err);
        res.status(500).json({ error: err.message || 'Failed to generate pairing code. Please ensure the phone number is correct with country code.' });
    }
});

// Logout / Disconnect
app.post('/api/logout', async (req, res) => {
    try {
        if (sock) {
            await sock.logout();
        }
        if (fs.existsSync(SESSIONS_DIR)) {
            fs.rmSync(SESSIONS_DIR, { recursive: true, force: true });
        }
        connectionStatus = 'disconnected';
        currentQR = null;
        userInfo = null;
        setTimeout(initWhatsApp, 2000);
        res.json({ success: true, message: 'Logged out successfully.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Immediate Send
app.post('/api/send-now', async (req, res) => {
    const { numbers, message } = req.body;
    if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
        return res.status(400).json({ error: 'Please provide at least one phone number.' });
    }
    if (!message || !message.trim()) {
        return res.status(400).json({ error: 'Message cannot be empty.' });
    }

    if (connectionStatus !== 'connected') {
        return res.status(400).json({ error: 'WhatsApp is not connected. Scan QR code first.' });
    }

    try {
        // Run in background and return immediate acceptance
        sendBatchMessages(numbers, message).catch((e) => console.error('Batch error:', e));
        res.json({
            success: true,
            message: `Broadcasting message to ${numbers.length} recipients in background.`
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Create Schedule Job
app.post('/api/schedule', (req, res) => {
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
        message: `Message successfully scheduled for ${targetDate.toLocaleString()}`
    });
});

// Get Scheduled Jobs
app.get('/api/scheduled', (req, res) => {
    res.json(getScheduledJobs());
});

// Cancel a Scheduled Job
app.delete('/api/scheduled/:id', (req, res) => {
    const jobs = getScheduledJobs();
    const filtered = jobs.filter((j) => j.id !== req.params.id);
    if (filtered.length === jobs.length) {
        return res.status(404).json({ error: 'Job not found.' });
    }
    saveScheduledJobs(filtered);
    res.json({ success: true, message: 'Job canceled successfully.' });
});

// Get History
app.get('/api/history', (req, res) => {
    res.json(getHistory());
});

app.listen(PORT, () => {
    console.log(`🌐 AutoMate Web Server running at http://localhost:${PORT}`);
});
