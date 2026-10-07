// AutoMate Production Security Layer - Cryptographic Identity & Rate Limiting
const crypto = require('crypto');
const path = require('path');
const db = require('./db');

const SESSIONS_DIR = path.resolve(__dirname, 'session_data');

// Ephemeral secret for local sandbox tokens (persists for the process lifetime)
const LOCAL_SANDBOX_SECRET = process.env.SANDBOX_SECRET || crypto.randomBytes(32).toString('hex');

/**
 * Validates and sanitizes a tenant ID to prevent filesystem path traversal.
 * Ensures the ID only contains safe alphanumeric, underscore, and dash characters.
 */
function sanitizeTenantId(rawId) {
    if (!rawId || typeof rawId !== 'string') {
        throw new Error('Tenant identifier must be a non-empty string');
    }
    // Explicit security rejection of directory traversal attempts
    if (rawId.includes('..') || rawId.includes('/') || rawId.includes('\\')) {
        throw new Error('Security Violation: Path traversal characters detected in tenant identifier');
    }
    const clean = rawId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
    if (!clean || clean === '.' || clean === '..') {
        throw new Error('Invalid tenant identifier format');
    }
    return clean;
}

/**
 * Resolves a safe filesystem path for a user's WhatsApp session directory.
 * Explicitly guards against directory traversal attacks.
 */
function getTenantSessionDir(userId) {
    const cleanId = sanitizeTenantId(userId);
    const resolvedPath = path.resolve(SESSIONS_DIR, cleanId);
    
    // Strict boundary enforcement: path must be strictly inside SESSIONS_DIR
    const baseDir = path.resolve(SESSIONS_DIR);
    if (!resolvedPath.startsWith(baseDir + path.sep)) {
        throw new Error('Security Violation: Session path traversal detected');
    }
    return resolvedPath;
}

/**
 * Generates an HMAC-signed sandbox token for local offline development.
 */
function generateSandboxToken(userId, email = 'developer@automate.local') {
    const payload = {
        sub: userId,
        email,
        iat: Date.now(),
        exp: Date.now() + (24 * 60 * 60 * 1000) // 24 hours
    };
    const dataStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto.createHmac('sha256', LOCAL_SANDBOX_SECRET).update(dataStr).digest('base64url');
    return `sbx.${dataStr}.${signature}`;
}

/**
 * Verifies an HMAC-signed sandbox token.
 */
function verifySandboxToken(token) {
    if (!token || typeof token !== 'string' || !token.startsWith('sbx.')) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [, dataStr, signature] = parts;

    try {
        const expected = crypto.createHmac('sha256', LOCAL_SANDBOX_SECRET).update(dataStr).digest('base64url');
        const sigBuf = Buffer.from(signature);
        const expBuf = Buffer.from(expected);
        if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
            return null;
        }

        const payload = JSON.parse(Buffer.from(dataStr, 'base64url').toString('utf8'));
        if (payload.exp && Date.now() > payload.exp) {
            return null; // Expired
        }
        return payload;
    } catch {
        return null;
    }
}

/**
 * Safely masks phone numbers for production logs.
 * Example: +919876543210 -> +91******3210
 */
function maskPhone(phone) {
    if (!phone || typeof phone !== 'string') return '***';
    if (phone === 'Connected') return 'Connected';
    const cleanDigits = phone.split('@')[0].split(':')[0].replace(/\D/g, '');
    if (cleanDigits.length < 6) return '******';
    const prefix = cleanDigits.slice(0, 2);
    const suffix = cleanDigits.slice(-4);
    return `+${prefix}******${suffix}`;
}

/**
 * Safely masks user and device identifiers for production logs.
 * Preserves correlation prefix/suffix without exposing the full identifier.
 * Example: usr_test_user_alpha -> usr_test...lpha
 */
function maskUserId(userId) {
    if (!userId || typeof userId !== 'string') return 'usr_anon';
    const clean = userId.trim();
    if (clean.length <= 8) return `${clean.slice(0, 3)}***`;
    const prefix = clean.slice(0, 8);
    const suffix = clean.slice(-4);
    return `${prefix}...${suffix}`;
}

/**
 * Strips secrets, tokens, JWTs, and sensitive credentials from error messages.
 */
function sanitizeErrorMessage(msg) {
    if (!msg) return 'Error';
    const str = typeof msg === 'string' ? msg : (msg.message || String(msg));
    return str
        .replace(/sb_secret_[a-zA-Z0-9_-]+/g, '[REDACTED_SECRET]')
        .replace(/eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]+/g, '[REDACTED_JWT]')
        .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, 'Bearer [REDACTED]')
        .replace(/([?&](?:apikey|token|secret|password|key)=)[^&]+/gi, '$1[REDACTED]');
}

/**
 * Primary Authentication Middleware:
 * Derives user identity strictly from cryptographically verified Bearer tokens.
 * The browser can NEVER choose or forge its identity.
 */
async function requireAuth(req, res, next) {
    const authHeader = req.headers['authorization'];
    let token = null;

    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7).trim();
    }

    if (!token) {
        return res.status(401).json({
            error: 'Authentication required. No Bearer token provided.',
            code: 'AUTH_REQUIRED'
        });
    }

    let verifiedUser = null;

    // 1. Production Mode: Verify with Supabase Auth
    if (db.isSupabaseConnected()) {
        try {
            // In automated test environments, permit verified HMAC-signed test tokens
            if (process.env.NODE_ENV === 'test') {
                const testUser = verifySandboxToken(token);
                if (testUser) {
                    verifiedUser = {
                        id: testUser.sub,
                        email: testUser.email,
                        provider: 'sandbox'
                    };
                }
            }

            if (!verifiedUser) {
                const { data, error } = await db.verifyUserToken(token);
                if (error || !data || !data.user) {
                    return res.status(401).json({
                        error: 'Invalid or expired authentication token: ' + (error ? error.message : 'User not found'),
                        code: 'INVALID_TOKEN'
                    });
                }
                verifiedUser = {
                    id: data.user.id,
                    email: data.user.email,
                    provider: data.user.app_metadata?.provider || 'supabase'
                };
            }
        } catch (err) {
            return res.status(401).json({
                error: 'Token verification service unavailable: ' + err.message,
                code: 'AUTH_SERVICE_ERROR'
            });
        }
    } else {
        // 2. Local Fallback Mode: Verify sandbox HMAC token
        const sandboxUser = verifySandboxToken(token);
        if (sandboxUser) {
            verifiedUser = {
                id: sandboxUser.sub,
                email: sandboxUser.email,
                provider: 'sandbox'
            };
        } else {
            // Also try Supabase in case it was reconnected
            return res.status(401).json({
                error: 'Invalid authentication token (sandbox validation failed).',
                code: 'INVALID_TOKEN'
            });
        }
    }

    // Derive tenant ID strictly from verified token identity
    const sanitizedId = sanitizeTenantId(verifiedUser.id);
    const authenticatedTenantId = `usr_${sanitizedId}`;

    // Defense-in-depth: If client sent an x-user-id header, verify it strictly matches!
    const claimedHeader = req.headers['x-user-id'];
    if (claimedHeader && claimedHeader !== authenticatedTenantId) {
        console.warn(`🚨 [SECURITY ALERT] Identity Mismatch Attempt! Authenticated: ${maskUserId(authenticatedTenantId)}, Claimed: ${maskUserId(claimedHeader)}`);
        return res.status(403).json({
            error: 'Identity mismatch. Claimed user ID does not match authenticated token identity.',
            code: 'IDENTITY_MISMATCH'
        });
    }

    // Attach verified identity to request
    req.user = verifiedUser;
    req.userId = authenticatedTenantId;
    next();
}

// ================= IN-MEMORY RATE LIMITERS =================
// Lightweight sliding-window rate limiters to prevent resource exhaustion

class RateLimiter {
    constructor(windowMs, maxRequests, name = 'RateLimit') {
        this.windowMs = windowMs;
        this.maxRequests = maxRequests;
        this.name = name;
        this.records = new Map(); // key -> [timestamps]

        // Periodic cleanup every 2 minutes
        setInterval(() => this.cleanup(), 2 * 60 * 1000);
    }

    cleanup() {
        const now = Date.now();
        for (const [key, timestamps] of this.records.entries()) {
            const valid = timestamps.filter(t => now - t < this.windowMs);
            if (valid.length === 0) {
                this.records.delete(key);
            } else {
                this.records.set(key, valid);
            }
        }
    }

    middleware(keyGenerator = req => req.userId || req.ip) {
        return (req, res, next) => {
            const key = keyGenerator(req);
            const now = Date.now();
            const timestamps = this.records.get(key) || [];
            const recent = timestamps.filter(t => now - t < this.windowMs);

            if (recent.length >= this.maxRequests) {
                const retryAfter = Math.ceil((this.windowMs - (now - recent[0])) / 1000);
                res.setHeader('Retry-After', retryAfter);
                return res.status(429).json({
                    error: `Too many requests for ${this.name}. Please wait ${retryAfter} seconds.`,
                    code: 'RATE_LIMIT_EXCEEDED',
                    retryAfter
                });
            }

            recent.push(now);
            this.records.set(key, recent);
            next();
        };
    }
}

// 1. Sensitive Endpoint Rate Limiters
const pairingCodeLimiter = new RateLimiter(5 * 60 * 1000, 5, 'Pairing Code Generation'); // 5 per 5 mins
const messageDispatchLimiter = new RateLimiter(60 * 1000, 15, 'Message Dispatch'); // 15 per min
const wipeDataLimiter = new RateLimiter(10 * 60 * 1000, 3, 'Data Wipe'); // 3 per 10 mins
const generalApiLimiter = new RateLimiter(60 * 1000, 120, 'API Requests'); // 120 per min per IP

module.exports = {
    requireAuth,
    sanitizeTenantId,
    getTenantSessionDir,
    generateSandboxToken,
    verifySandboxToken,
    maskPhone,
    maskUserId,
    sanitizeErrorMessage,
    pairingCodeLimiter,
    messageDispatchLimiter,
    wipeDataLimiter,
    generalApiLimiter
};
