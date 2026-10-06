// AutoMate - Comprehensive Production Security Hardening Test Suite
// Verifies all multi-tenant boundaries, cryptographic identity verification,
// RLS/fallback isolation, path traversal guards, rate limiters, and payload limits.

process.env.NODE_ENV = 'test';
process.env.PORT = '0'; // Ephemeral dynamic port

const http = require('http');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const app = require('./server');
const auth = require('./auth');
const db = require('./db');

let server;
let baseUrl;

function makeRequest({ path, method = 'GET', headers = {}, body = null }) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, baseUrl);
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: method,
            headers: { ...headers }
        };

        let requestData = null;
        if (body !== null) {
            if (typeof body === 'object') {
                requestData = JSON.stringify(body);
                options.headers['Content-Type'] = 'application/json';
            } else {
                requestData = String(body);
            }
            options.headers['Content-Length'] = Buffer.byteLength(requestData);
        }

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                let parsed = null;
                try {
                    parsed = JSON.parse(data);
                } catch (e) {
                    parsed = data;
                }
                resolve({ status: res.statusCode, headers: res.headers, body: parsed });
            });
        });

        req.on('error', reject);
        if (requestData) req.write(requestData);
        req.end();
    });
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  [PASS] ${name}`);
        passed++;
    } catch (err) {
        console.error(`  [FAIL] ${name}:`, err.message);
        failed++;
    }
}

async function runSecuritySuite() {
    console.log('\n======================================================');
    console.log('🛡️  AUTOMATE PRODUCTION SECURITY VERIFICATION SUITE');
    console.log('======================================================\n');

    // 1. Start Server on ephemeral port
    await new Promise((resolve) => {
        server = app.listen(0, () => {
            const port = server.address().port;
            baseUrl = `http://127.0.0.1:${port}`;
            console.log(`Test server running at ${baseUrl}`);
            resolve();
        });
    });

    // Generate tokens for Test User A and User B
    const userA_Id = 'test_user_alpha';
    const userB_Id = 'test_user_beta';
    const userA_Token = auth.generateSandboxToken(userA_Id, 'alpha@example.com');
    const userB_Token = auth.generateSandboxToken(userB_Id, 'beta@example.com');

    // Test 1: Unauthenticated request to protected endpoints is denied
    await test('Unauthenticated -> /api/status -> Denied (HTTP 401)', async () => {
        const res = await makeRequest({ path: '/api/status' });
        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.body.code, 'AUTH_REQUIRED');
    });

    await test('Unauthenticated -> /api/schedule -> Denied (HTTP 401)', async () => {
        const res = await makeRequest({
            path: '/api/schedule',
            method: 'POST',
            body: { message: 'hello', numbers: ['1234567890'], scheduleTime: new Date(Date.now() + 60000).toISOString() }
        });
        assert.strictEqual(res.status, 401);
    });

    await test('Unauthenticated -> /api/wipe-data -> Denied (HTTP 401)', async () => {
        const res = await makeRequest({ path: '/api/wipe-data', method: 'POST' });
        assert.strictEqual(res.status, 401);
    });

    // Test 2: Forged / Tampered token is rejected
    await test('Tampered token signature -> Denied (HTTP 401)', async () => {
        const tamperedToken = userA_Token.slice(0, -6) + 'xxxxxx';
        const res = await makeRequest({
            path: '/api/status',
            headers: { 'Authorization': `Bearer ${tamperedToken}` }
        });
        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.body.code, 'INVALID_TOKEN');
    });

    // Test 3: Forged x-user-id header without valid JWT is rejected
    await test('No JWT + Forged x-user-id -> Denied (HTTP 401)', async () => {
        const res = await makeRequest({
            path: '/api/status',
            headers: { 'x-user-id': 'usr_admin_victim' }
        });
        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.body.code, 'AUTH_REQUIRED');
    });

    // Test 4: Identity Mismatch Attack (User A token + User B x-user-id)
    await test('User A JWT + User B x-user-id -> Rejected (HTTP 403 IDENTITY_MISMATCH)', async () => {
        const res = await makeRequest({
            path: '/api/status',
            headers: {
                'Authorization': `Bearer ${userA_Token}`,
                'x-user-id': `usr_${userB_Id}`
            }
        });
        assert.strictEqual(res.status, 403);
        assert.strictEqual(res.body.code, 'IDENTITY_MISMATCH');
    });

    // Test 5: Legitimate User A authenticated access is allowed
    await test('User A JWT -> User A /api/status -> Allowed (HTTP 200)', async () => {
        const res = await makeRequest({
            path: '/api/status',
            headers: { 'Authorization': `Bearer ${userA_Token}` }
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.userId, `usr_${userA_Id}`);
    });

    // Test 6: Cross-Tenant Scheduled Task Isolation
    let userA_JobId = null;
    await test('User A schedules a task -> Created successfully', async () => {
        const futureTime = new Date(Date.now() + 3600 * 1000).toISOString();
        const res = await makeRequest({
            path: '/api/schedule',
            method: 'POST',
            headers: { 'Authorization': `Bearer ${userA_Token}` },
            body: {
                message: 'Confidential message for User A contacts',
                numbers: ['919876543210'],
                scheduleTime: futureTime
            }
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        userA_JobId = res.body.job.id;
        assert(userA_JobId, 'Job ID should be returned');
    });

    await test('User B lists scheduled tasks -> User A task NOT visible to User B', async () => {
        const res = await makeRequest({
            path: '/api/scheduled',
            headers: { 'Authorization': `Bearer ${userB_Token}` }
        });
        assert.strictEqual(res.status, 200);
        const tasks = res.body;
        assert(Array.isArray(tasks), 'Expected array of tasks');
        const leak = tasks.find(t => t.id === userA_JobId);
        assert.strictEqual(leak, undefined, 'User A task must not be visible to User B');
    });

    await test('User B attempts to delete/cancel User A task -> Denied (HTTP 404/403)', async () => {
        const res = await makeRequest({
            path: `/api/scheduled/${userA_JobId}`,
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${userB_Token}` }
        });
        assert(res.status === 404 || res.status === 403, `Expected 404 or 403, got ${res.status}`);
    });

    // Test 7: Cross-Tenant History Isolation
    await test('User A records history -> User B cannot read User A history', async () => {
        // Record history for User A
        await db.recordHistory({
            deviceId: `usr_${userA_Id}`,
            number: '919876543210',
            status: 'sent',
            time: new Date().toISOString(),
            message: 'Secret payload'
        });

        const resB = await makeRequest({
            path: '/api/history',
            headers: { 'Authorization': `Bearer ${userB_Token}` }
        });
        assert.strictEqual(resB.status, 200);
        const historyB = resB.body;
        const leaked = historyB.find(h => h.message === 'Secret payload');
        assert.strictEqual(leaked, undefined, 'User B must not see User A history logs');
    });

    // Test 8: Cross-Tenant Wipe Isolation
    await test('User B calls wipe-data -> User A data remains intact', async () => {
        const wipeRes = await makeRequest({
            path: '/api/wipe-data',
            method: 'POST',
            headers: { 'Authorization': `Bearer ${userB_Token}` }
        });
        assert.strictEqual(wipeRes.status, 200);

        // Verify User A scheduled task still exists
        const resA = await makeRequest({
            path: '/api/scheduled',
            headers: { 'Authorization': `Bearer ${userA_Token}` }
        });
        assert.strictEqual(resA.status, 200);
        const taskA = resA.body.find(t => t.id === userA_JobId);
        assert(taskA !== undefined, 'User A scheduled task must survive User B data wipe');
    });

    // Test 9: Path Traversal & Tenant Slug Sanitization
    await test('Path Traversal Defense: sanitizeTenantId throws on illegal traversal characters', () => {
        const malicious = '../../etc/passwd';
        assert.throws(() => {
            auth.sanitizeTenantId(malicious);
        }, /Security Violation/);
    });

    await test('Path Traversal Defense: getTenantSessionDir blocks traversal attempts', () => {
        const maliciousId = 'usr_../../../../escaped_dir';
        assert.throws(() => {
            auth.getTenantSessionDir(maliciousId);
        }, /Security Violation/);

        // Valid tenant directory should resolve cleanly inside session_data
        const validPath = auth.getTenantSessionDir('usr_valid_tenant_123');
        assert(validPath.includes('session_data'), 'Must remain within session_data directory');
        assert(validPath.endsWith('usr_valid_tenant_123'), 'Must resolve to specific user slug');
    });

    // Test 10: Payload Size Limit (DoS Protection)
    await test('Oversized request (>500KB) -> Rejected (HTTP 413)', async () => {
        const hugePayload = {
            message: 'A'.repeat(600 * 1024), // 600KB
            numbers: ['919876543210'],
            scheduleTime: new Date(Date.now() + 60000).toISOString()
        };
        const res = await makeRequest({
            path: '/api/schedule',
            method: 'POST',
            headers: { 'Authorization': `Bearer ${userA_Token}` },
            body: hugePayload
        });
        assert.strictEqual(res.status, 413);
    });

    // Test 11: Rate Limiter on Pairing Code Endpoint
    await test('Rate Limiter: Pairing code endpoint rejects excessive requests (HTTP 429)', async () => {
        let reached429 = false;
        // The limit is 5 requests per 5 minutes
        for (let i = 0; i < 7; i++) {
            const res = await makeRequest({
                path: '/api/request-pairing-code',
                method: 'POST',
                headers: { 'Authorization': `Bearer ${userA_Token}` },
                body: { phoneNumber: '919876543210' }
            });
            if (res.status === 429) {
                reached429 = true;
                assert.strictEqual(res.body.code, 'RATE_LIMIT_EXCEEDED');
                break;
            }
        }
        assert.strictEqual(reached429, true, 'Should trigger HTTP 429 Rate Limit Exceeded');
    });

    // Test 12: Public Feedback API Email Masking (Data Privacy)
    await test('Data Privacy: GET /api/feedback masks user emails & hides device IDs', async () => {
        // Submit feedback as User A
        const postRes = await makeRequest({
            path: '/api/feedback',
            method: 'POST',
            headers: { 'Authorization': `Bearer ${userA_Token}` },
            body: {
                rating: 5,
                category: 'general',
                comment: 'Automate security verification review',
                userEmail: 'sensitive.john.doe@enterprise.com'
            }
        });
        assert.strictEqual(postRes.status, 200);

        // Fetch feedback as unauthenticated public user
        const res = await makeRequest({ path: '/api/feedback?limit=10' });
        assert.strictEqual(res.status, 200);
        assert(Array.isArray(res.body), 'Feedback should return an array');
        const found = res.body.find(f => f.comment === 'Automate security verification review');
        assert(found, 'Submitted feedback should be present in recent feedback list');
        assert.strictEqual(found.deviceId, undefined, 'deviceId must NOT be exposed in public API');
        assert(found.userEmail && found.userEmail.includes('***'), 'userEmail must be masked (e.g. s***@enterprise.com)');
        assert(!found.userEmail.includes('john.doe'), 'Original username must not be exposed');
    });

    // Test 13: Clean cleanup: cancel User A test task
    if (userA_JobId) {
        await test('User A cancels own task -> Success', async () => {
            const res = await makeRequest({
                path: `/api/scheduled/${userA_JobId}`,
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${userA_Token}` }
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.success, true);
        });
    }

    // Teardown
    server.close();
    try {
        const testDirs = [
            auth.getTenantSessionDir(`usr_${userA_Id}`),
            auth.getTenantSessionDir(`usr_${userB_Id}`)
        ];
        for (const dir of testDirs) {
            if (fs.existsSync(dir)) {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        }
    } catch (_) {}

    console.log('\n======================================================');
    console.log(`Test Execution Complete: ${passed} Passed, ${failed} Failed`);
    console.log('======================================================\n');

    if (failed > 0) {
        process.exit(1);
    } else {
        process.exit(0);
    }
}

runSecuritySuite().catch((err) => {
    console.error('Fatal test error:', err);
    if (server) server.close();
    process.exit(1);
});
