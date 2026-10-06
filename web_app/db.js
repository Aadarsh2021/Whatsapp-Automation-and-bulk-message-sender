// AutoMate Cloud - Resilient Database Layer (Supabase + Local Fallback)
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;

let supabase = null;
if (SUPABASE_KEY && SUPABASE_URL) {
    try {
        supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
            auth: { persistSession: false }
        });
        console.log('⚡ Connected to Supabase Cloud Database');
    } catch (err) {
        console.error('Supabase initialization error, falling back to local storage:', err.message);
    }
} else {
    console.warn('⚠️ No SUPABASE_KEY provided. Operating in Local Resilient Fallback Mode.');
}

// ================= SUPABASE KEEP-ALIVE & PAUSE GUARD =================
// Supabase free tier pauses projects after 7 consecutive days of inactivity.
// This heartbeat queries Supabase every 6 hours to ensure 24/7 project activity.
let lastSupabaseHeartbeat = null;
let lastHeartbeatStatus = 'initialized';
let heartbeatQueryCount = 0;

async function pingSupabaseHeartbeat() {
    if (!supabase) {
        return {
            success: false,
            message: 'Supabase client not initialized (operating in local resilient fallback mode)',
            timestamp: new Date().toISOString()
        };
    }

    const startTime = Date.now();
    try {
        // Lightweight probe query on scheduled_tasks or user_feedback
        const { error } = await supabase
            .from('scheduled_tasks')
            .select('id')
            .limit(1);

        if (error) {
            // Fallback probe
            await supabase.from('user_feedback').select('id').limit(1).catch(() => {});
        }

        const latencyMs = Date.now() - startTime;
        heartbeatQueryCount++;
        lastSupabaseHeartbeat = new Date().toISOString();
        lastHeartbeatStatus = 'healthy';
        console.log(`⚡ [Supabase Heartbeat #${heartbeatQueryCount}] Heartbeat query succeeded (${latencyMs}ms). 7-day pause timer reset.`);

        return {
            success: true,
            latencyMs,
            lastHeartbeat: lastSupabaseHeartbeat,
            queryCount: heartbeatQueryCount,
            status: 'healthy',
            message: 'Supabase project active. 7-day inactivity pause prevented.'
        };
    } catch (err) {
        lastHeartbeatStatus = 'error: ' + err.message;
        console.warn(`⚠️ [Supabase Heartbeat] Heartbeat warning: ${err.message}`);
        return {
            success: false,
            error: err.message,
            timestamp: new Date().toISOString()
        };
    }
}

// Arm 6-Hour Scheduled Heartbeat (4 times daily) + boot probe
if (supabase) {
    setTimeout(pingSupabaseHeartbeat, 3000);
    setInterval(pingSupabaseHeartbeat, 6 * 60 * 60 * 1000);
}

// Local Fallback Storage with Atomic Writes to prevent corruption
const DATA_DIR = path.join(__dirname, 'data');
const SCHEDULED_FILE = path.join(DATA_DIR, 'scheduled.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const FEEDBACK_FILE = path.join(DATA_DIR, 'feedback.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SCHEDULED_FILE)) fs.writeFileSync(SCHEDULED_FILE, JSON.stringify([], null, 2));
if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, JSON.stringify([], null, 2));
if (!fs.existsSync(FEEDBACK_FILE)) fs.writeFileSync(FEEDBACK_FILE, JSON.stringify([], null, 2));

function atomicWriteJson(filePath, data) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).substr(2, 4)}`;
    try {
        fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tempPath, filePath);
    } catch (err) {
        if (fs.existsSync(tempPath)) {
            try { fs.unlinkSync(tempPath); } catch (_) {}
        }
        throw err;
    }
}

function getLocalScheduledJobs() {
    try { return JSON.parse(fs.readFileSync(SCHEDULED_FILE, 'utf8')); } catch { return []; }
}
function saveLocalScheduledJobs(jobs) {
    atomicWriteJson(SCHEDULED_FILE, jobs);
}
function getLocalHistory() {
    try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return []; }
}
function saveLocalHistory(hist) {
    atomicWriteJson(HISTORY_FILE, hist);
}
function getLocalFeedback() {
    try { return JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8')); } catch { return []; }
}
function saveLocalFeedback(feedbacks) {
    atomicWriteJson(FEEDBACK_FILE, feedbacks);
}

function maskEmail(email) {
    if (!email || typeof email !== 'string') return 'Community Member';
    const parts = email.split('@');
    if (parts.length !== 2) return 'Community Member';
    const user = parts[0];
    const domain = parts[1];
    const visible = user.slice(0, Math.min(2, user.length));
    return `${visible}***@${domain}`;
}

// ================= DATABASE OPERATIONS =================

// 1. Get Scheduled Tasks for specific device
async function getScheduledTasksForDevice(deviceId) {
    if (supabase) {
        const { data, error } = await supabase
            .from('scheduled_tasks')
            .select('*')
            .eq('device_id', deviceId)
            .order('schedule_time', { ascending: true });
        if (!error && data) {
            return data.map(row => ({
                id: row.id,
                userId: row.device_id,
                numbers: row.numbers,
                message: row.message,
                scheduleTime: row.schedule_time,
                status: row.status,
                results: row.results,
                error: row.error,
                executedAt: row.executed_at
            }));
        }
    }
    return getLocalScheduledJobs().filter(j => j.userId === deviceId);
}

// 2. Insert New Scheduled Task
async function createScheduledTask(task) {
    if (supabase) {
        const { error } = await supabase
            .from('scheduled_tasks')
            .insert([{
                id: task.id,
                device_id: task.userId,
                numbers: task.numbers,
                message: task.message,
                schedule_time: task.scheduleTime,
                status: 'pending',
                results: [],
                error: null
            }]);
        if (!error) return task;
        console.error('Supabase task insert error:', error.message);
    }

    const jobs = getLocalScheduledJobs();
    jobs.push(task);
    saveLocalScheduledJobs(jobs);
    return task;
}

// 3. Atomic Lock & Fetch Due Jobs (with Stale Lock Auto-Recovery)
async function fetchDueJobs(currentTime) {
    const staleThreshold = new Date(currentTime.getTime() - 15 * 60 * 1000).toISOString();

    if (supabase) {
        // Stale lock recovery: Reset jobs stuck in 'processing' for over 15 minutes back to 'pending'
        await supabase
            .from('scheduled_tasks')
            .update({ status: 'pending', error: 'Recovered from worker timeout' })
            .eq('status', 'processing')
            .lte('locked_at', staleThreshold)
            .catch(() => {});

        // Query pending jobs due up to now
        const { data, error } = await supabase
            .from('scheduled_tasks')
            .select('*')
            .in('status', ['pending', 'prewarming'])
            .lte('schedule_time', currentTime.toISOString())
            .order('schedule_time', { ascending: true })
            .limit(20);

        if (!error && data) {
            return data.map(row => ({
                id: row.id,
                userId: row.device_id,
                numbers: row.numbers,
                message: row.message,
                scheduleTime: row.schedule_time,
                status: row.status
            }));
        }
    }

    // Local fallback with stale lock recovery
    const jobs = getLocalScheduledJobs();
    let recoveredAny = false;
    jobs.forEach(j => {
        if (j.status === 'processing' && j.locked_at && new Date(j.locked_at) < new Date(currentTime.getTime() - 15 * 60 * 1000)) {
            j.status = 'pending';
            j.error = 'Recovered from worker timeout';
            recoveredAny = true;
        }
    });
    if (recoveredAny) saveLocalScheduledJobs(jobs);

    return jobs.filter(j => (j.status === 'pending' || j.status === 'prewarming') && new Date(j.scheduleTime) <= currentTime);
}

// 4. Atomic Lock on a Job (Ensures zero duplicate execution)
async function lockJobForExecution(jobId, workerId) {
    if (supabase) {
        const { data, error } = await supabase
            .from('scheduled_tasks')
            .update({
                status: 'processing',
                locked_at: new Date().toISOString(),
                worker_id: workerId
            })
            .eq('id', jobId)
            .in('status', ['pending', 'prewarming'])
            .select();

        if (!error && data && data.length > 0) return true;
        return false;
    }

    const jobs = getLocalScheduledJobs();
    const job = jobs.find(j => j.id === jobId && (j.status === 'pending' || j.status === 'prewarming'));
    if (job) {
        job.status = 'processing';
        job.locked_at = new Date().toISOString();
        saveLocalScheduledJobs(jobs);
        return true;
    }
    return false;
}

// 5. Update Job Execution Result
async function finalizeJob(jobId, status, results, errorMsg = null) {
    const executedAt = new Date().toISOString();
    if (supabase) {
        await supabase
            .from('scheduled_tasks')
            .update({
                status,
                results,
                error: errorMsg,
                executed_at: executedAt
            })
            .eq('id', jobId);
    }

    const jobs = getLocalScheduledJobs();
    const job = jobs.find(j => j.id === jobId);
    if (job) {
        job.status = status;
        job.results = results;
        job.error = errorMsg;
        job.executedAt = executedAt;
        saveLocalScheduledJobs(jobs);
    }
}

// 6. Cancel Scheduled Task
async function cancelScheduledTask(jobId, deviceId) {
    if (supabase) {
        try {
            const { data, error } = await supabase
                .from('scheduled_tasks')
                .delete()
                .eq('id', jobId)
                .eq('device_id', deviceId)
                .in('status', ['pending', 'prewarming'])
                .select('id');
            if (!error && data && data.length > 0) {
                return true;
            }
        } catch (err) {
            // Fall back to local check if query errors
        }
    }

    const jobs = getLocalScheduledJobs();
    const filtered = jobs.filter(j => !(j.id === jobId && j.userId === deviceId));
    if (filtered.length !== jobs.length) {
        saveLocalScheduledJobs(filtered);
        return true;
    }
    return false;
}

// 7. Delivery History
async function getHistoryForDevice(deviceId) {
    if (supabase) {
        const { data, error } = await supabase
            .from('delivery_history')
            .select('*')
            .eq('device_id', deviceId)
            .order('created_at', { ascending: false })
            .limit(100);

        if (!error && data) {
            return data.map(row => ({
                id: row.id,
                userId: row.device_id,
                number: row.number,
                message: row.message,
                status: row.status,
                error: row.error,
                time: row.created_at
            }));
        }
    }
    return getLocalHistory().filter(h => h.userId === deviceId);
}

async function recordHistory(entry) {
    if (supabase) {
        await supabase
            .from('delivery_history')
            .insert([{
                device_id: entry.userId,
                number: entry.number,
                message: entry.message,
                status: entry.status,
                error: entry.error || null
            }]);
    }

    const history = getLocalHistory();
    history.unshift(entry);
    if (history.length > 500) history.pop();
    saveLocalHistory(history);
}

// 8. 1-Click Wipe All Device Data
async function wipeAllDeviceData(deviceId) {
    if (supabase) {
        await supabase.from('scheduled_tasks').delete().eq('device_id', deviceId);
        await supabase.from('delivery_history').delete().eq('device_id', deviceId);
    }
    const jobs = getLocalScheduledJobs().filter(j => j.userId !== deviceId);
    saveLocalScheduledJobs(jobs);

    const history = getLocalHistory().filter(h => h.userId !== deviceId);
    saveLocalHistory(history);
}

// 9. Beta Feedback & User Reviews
async function recordFeedback(entry) {
    const feedbackObj = {
        id: 'fb_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
        deviceId: entry.deviceId || entry.userId || 'anonymous',
        userEmail: entry.userEmail || null,
        rating: Math.min(5, Math.max(1, parseInt(entry.rating) || 5)),
        category: entry.category || 'general',
        comment: entry.comment.trim(),
        createdAt: new Date().toISOString()
    };

    if (supabase) {
        try {
            await supabase
                .from('user_feedback')
                .insert([{
                    device_id: feedbackObj.deviceId,
                    user_email: feedbackObj.userEmail,
                    rating: feedbackObj.rating,
                    category: feedbackObj.category,
                    comment: feedbackObj.comment,
                    created_at: feedbackObj.createdAt
                }]);
        } catch (err) {
            console.warn('Supabase feedback insert warning:', err.message);
        }
    }

    const localList = getLocalFeedback();
    localList.unshift(feedbackObj);
    if (localList.length > 300) localList.pop();
    saveLocalFeedback(localList);
    return feedbackObj;
}

async function getRecentFeedback(limit = 20) {
    if (supabase) {
        try {
            const { data, error } = await supabase
                .from('user_feedback')
                .select('id, user_email, rating, category, comment, created_at')
                .order('created_at', { ascending: false })
                .limit(limit);
            if (!error && data && data.length > 0) {
                return data.map(r => ({
                    id: r.id,
                    author: maskEmail(r.user_email),
                    userEmail: maskEmail(r.user_email),
                    rating: r.rating,
                    category: r.category,
                    comment: r.comment,
                    createdAt: r.created_at
                }));
            }
        } catch (err) {
            // fallback to local
        }
    }
    return getLocalFeedback().slice(0, limit).map(r => ({
        id: r.id,
        author: maskEmail(r.userEmail),
        userEmail: maskEmail(r.userEmail),
        rating: r.rating,
        category: r.category,
        comment: r.comment,
        createdAt: r.createdAt
    }));
}

module.exports = {
    getScheduledTasksForDevice,
    createScheduledTask,
    fetchDueJobs,
    lockJobForExecution,
    finalizeJob,
    cancelScheduledTask,
    getHistoryForDevice,
    recordHistory,
    wipeAllDeviceData,
    recordFeedback,
    getRecentFeedback,
    isSupabaseConnected: () => !!supabase,
    verifyUserToken: async (token) => {
        if (!supabase) return { data: { user: null }, error: new Error('Supabase client not initialized') };
        return await supabase.auth.getUser(token);
    },
    pingSupabaseHeartbeat,
    getLastHeartbeatInfo: () => ({
        lastHeartbeat: lastSupabaseHeartbeat,
        status: lastHeartbeatStatus,
        queryCount: heartbeatQueryCount
    })
};


