const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { verifyKeyMiddleware } = require('discord-interactions');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// Centralized Environment Manifest
// ==========================================
const CONFIG = Object.freeze({
    DISCORD_PUBLIC_KEY: process.env.DISCORD_PUBLIC_KEY,
    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
    DISCORD_SERVER_ID: process.env.DISCORD_SERVER_ID,
    DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,
    ERROR_CATEGORY_ID: process.env.ERROR_CATEGORY_ID,
    ROBLOSECURITY: process.env.ROBLOSECURITY || process.env.ROBLOX_COOKIE,
    GROUP_ID: process.env.GROUP_ID,
    BLOXLINK_API_KEY: process.env.BLOXLINK_API_KEY,
    PROXY_API_KEY: process.env.PROXY_API_KEY,
});

const missingKeys = Object.keys(CONFIG).filter(key => !CONFIG[key]);
if (missingKeys.length > 0) {
    console.error(`🚨 [CRITICAL CONFIG ERROR] Unresolved environment parameters: ${missingKeys.join(', ')}`);
}

// ==========================================
// Advanced State Management & Async Queue
// ==========================================
const systemState = {
    uptime: Date.now(),
    requestCount: 0,
    activeRanks: 0,
    circuitBreakerOpen: false,
    circuitBreakerTimeout: null,
    maintenanceMode: false
};

const userCooldowns = new Map();
const ticketOwners = new Map();
const COOLDOWN_TIME = 60 * 1000;

let rankQueue = [];
let isProcessingQueue = false;

async function enqueueRankTask(taskFn) {
    return new Promise((resolve, reject) => {
        rankQueue.push({ taskFn, resolve, reject });
        processQueue();
    });
}

async function processQueue() {
    if (isProcessingQueue || rankQueue.length === 0) return;
    isProcessingQueue = true;

    const { taskFn, resolve, reject } = rankQueue.shift();
    try {
        const result = await taskFn();
        resolve(result);
    } catch (err) {
        reject(err);
    } finally {
        isProcessingQueue = false;
        if (rankQueue.length > 0) processQueue();
    }
}

// ==========================================
// Security & Core Middleware
// ==========================================
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:"],
        },
    },
}));
app.use(express.json());
app.use(rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Rate limit threshold exceeded.' }
}));

app.use((req, res, next) => {
    systemState.requestCount++;
    console.log(`🌐 [INBOUND] ${req.method} request targeting ${req.originalUrl} from ${req.ip}`);
    next();
});

const authenticateRequest = (req, res, next) => {
    const key = req.headers['x-api-key'] || (req.body && req.body.apiKey);
    if (!CONFIG.PROXY_API_KEY || key !== CONFIG.PROXY_API_KEY) {
        console.warn(`🛑 [SECURITY] Unauthorized payload signature match dropped.`);
        return res.status(401).json({ success: false, error: 'Unauthorized: Invalid or missing API key authorization header.' });
    }
    next();
};

const blockIfMaintenance = (req, res, next) => {
    if (systemState.maintenanceMode) {
        const allowedPaths = ['/api/status', '/api/maintenance'];
        if (!allowedPaths.includes(req.path)) {
            return res.status(503).json({
                success: false,
                error: '🚫 System is locked down in MAINTENANCE MODE. All services are offline.'
            });
        }
    }
    next();
};

app.use(blockIfMaintenance);

// ==========================================
// Utility Subsystems
// ==========================================
async function dispatchWebhook(embedPayload) {
    if (!CONFIG.DISCORD_WEBHOOK_URL) return;
    try {
        await fetch(CONFIG.DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ embeds: [embedPayload] })
        });
    } catch (err) {
        console.error('⚠️ [WEBHOOK ERROR] Failed to dispatch telemetry embed:', err);
    }
}

async function executeDiscordApi(endpoint, options = {}, retries = 3) {
    const targetUrl = endpoint.startsWith('http') ? endpoint : `https://discord.com/api/v10${endpoint}`;
    for (let attempt = 1; attempt <= retries; attempt++) {
        const res = await fetch(targetUrl, options);
        if (res.status === 429) {
            const body = await res.json().catch(() => ({}));
            const backoff = (body.retry_after || attempt) * 1000;
            console.warn(`⏳ [DISCORD API] Rate-limited. Sleeping execution thread for ${backoff}ms...`);
            await new Promise(r => setTimeout(r, backoff));
            continue;
        }
        return res;
    }
    throw new Error('Exceeded maximum retry allocations for Discord REST interaction.');
}

function buildEmbed(title, description, color = 0x3498db, ephemeral = true) {
    return {
        type: 4,
        data: {
            embeds: [{
                title,
                description,
                color,
                footer: { text: 'FreshlyPlaza Engine • Protected Proxy' },
                timestamp: new Date().toISOString()
            }],
            flags: ephemeral ? 64 : 0
        }
    };
}

// ==========================================
// Automated Diagnostics & Error Routing
// ==========================================
async function processFailureProtocol(discordUserId, roleId, diagnosticError) {
    const designatedStaffRole = "1529311162183975032";

    await dispatchWebhook({
        title: '❌ Ranking Exception Triggered',
        color: 0xe74c3c,
        description: `Operational pipeline failed to assign role parameters for user <@${discordUserId}>.`,
        fields: [
            { name: 'Target Role ID', value: String(roleId), inline: true },
            { name: 'Exception Stack', value: `\`\`\`json\n${String(diagnosticError).substring(0, 400)}\n\`\`\`` }
        ]
    });

    if (!CONFIG.DISCORD_BOT_TOKEN || !CONFIG.DISCORD_SERVER_ID) return;

    let localizedMessage = String(diagnosticError);
    if (localizedMessage.includes('500') || localizedMessage.includes('502')) {
        localizedMessage = 'Upstream Roblox API Gateway connectivity timeout.';
    }

    try {
        const channelListRes = await executeDiscordApi(`/guilds/${CONFIG.DISCORD_SERVER_ID}/channels`, {
            headers: { 'Authorization': `Bot ${CONFIG.DISCORD_BOT_TOKEN}` }
        });
        const channels = await channelListRes.json();
        
        const channelName = `rank-failed-${discordUserId.slice(-4)}`;
        let targetChannel = channels.find(c => c.name === channelName && c.type === 0);
        let channelId;

        const rowPanel1 = {
            type: 1, components: [
                { type: 2, style: 1, custom_id: `ticket_claim_${discordUserId}`, label: 'Claim' },
                { type: 2, style: 2, custom_id: `ticket_rename_${discordUserId}`, label: 'Rename' },
                { type: 2, style: 2, custom_id: `ticket_add_${discordUserId}`, label: 'Add User' },
                { type: 2, style: 4, custom_id: `ticket_delete_${discordUserId}`, label: 'Delete' }
            ]
        };

        const rowPanel2 = {
            type: 1, components: [
                { type: 2, style: 2, custom_id: `ticket_getinfo_${discordUserId}`, label: 'Get Info' },
                { type: 2, style: 3, custom_id: `ticket_retry_${discordUserId}_${roleId}`, label: 'Retry Rank' }
            ]
        };

        if (targetChannel) {
            channelId = targetChannel.id;
        } else {
            const newChanRes = await executeDiscordApi(`/guilds/${CONFIG.DISCORD_SERVER_ID}/channels`, {
                method: 'POST',
                headers: { 'Authorization': `Bot ${CONFIG.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: channelName,
                    type: 0,
                    parent_id: CONFIG.ERROR_CATEGORY_ID || undefined,
                    permission_overwrites: [
                        { id: CONFIG.DISCORD_SERVER_ID, type: 0, deny: '1024' },
                        { id: discordUserId, type: 1, allow: '1024' },
                        { id: designatedStaffRole, type: 0, allow: '1024' }
                    ]
                })
            });
            const channelData = await newChanRes.json();
            channelId = channelData.id;
        }

        await executeDiscordApi(`/channels/${channelId}/messages`, {
            method: 'POST',
            headers: { 'Authorization': `Bot ${CONFIG.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: `<@${discordUserId}> Automated system check identified a rank execution failure for Role ID \`${roleId}\`.\n**Diagnostic Payload:** \`${localizedMessage}\``,
                components: [rowPanel1, rowPanel2]
            })
        });
    } catch (err) {
        console.error('⚠️ [CRITICAL] Error handler execution sequence failed:', err);
    }
}

// ==========================================
// Core Mutex-Protected Ranking Engine
// ==========================================
async function performRobloxRankingPipeline(discordUserId, roleId) {
    if (systemState.circuitBreakerOpen) {
        throw new Error('Circuit breaker is currently tripped due to prior infrastructure errors. Throttling requests.');
    }

    return enqueueRankTask(async () => {
        systemState.activeRanks++;
        try {
            const bloxFetch = await fetch(`https://api.blox.link/v4/public/guilds/${CONFIG.DISCORD_SERVER_ID}/discord-to-roblox/${discordUserId}`, {
                headers: { 'Authorization': CONFIG.BLOXLINK_API_KEY }
            });
            const bloxJson = await bloxFetch.json();
            if (!bloxFetch.ok || !bloxJson.robloxID) {
                throw new Error('Target user is unverified on Bloxlink or missing from target guild scope.');
            }
            const robloxId = bloxJson.robloxID;

            const memberFetch = await fetch(`https://groups.roblox.com/v1/groups/${CONFIG.GROUP_ID}/users/${robloxId}`);
            if (!memberFetch.ok) {
                throw new Error('Target user is absent from the designated Roblox group structure.');
            }
            const memberJson = await memberFetch.json();
            if (!memberJson.role) {
                throw new Error('User maintains no valid rank baseline inside target group configuration.');
            }

            const targetRoleInt = parseInt(roleId, 10);
            if (memberJson.role.id === targetRoleInt) {
                throw new Error('Target user already possesses the precise requested rank assignment.');
            }

            const authInit = await fetch('https://auth.roblox.com/v1/logout', {
                method: 'POST',
                headers: { 'Cookie': `.ROBLOSECURITY=${CONFIG.ROBLOSECURITY}` }
            });
            let csrfToken = authInit.headers.get('x-csrf-token');
            if (!csrfToken) {
                throw new Error('Failed to derive cryptographic X-CSRF-TOKEN. Authentication cookie may be invalid/expired.');
            }

            const dispatchPatch = async (token) => fetch(`https://groups.roblox.com/v1/groups/${CONFIG.GROUP_ID}/users/${robloxId}`, {
                method: 'PATCH',
                headers: {
                    'Cookie': `.ROBLOSECURITY=${CONFIG.ROBLOSECURITY}`,
                    'x-csrf-token': token,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ roleId: targetRoleInt })
            });

            let patchRes = await dispatchPatch(csrfToken);

            if (patchRes.status === 403 && patchRes.headers.has('x-csrf-token')) {
                csrfToken = patchRes.headers.get('x-csrf-token');
                patchRes = await dispatchPatch(csrfToken);
            }

            if (!patchRes.ok) {
                const errorPayload = await patchRes.json().catch(() => ({}));
                throw new Error(`Roblox Enterprise REST Error Response: ${JSON.stringify(errorPayload)}`);
            }

            await dispatchWebhook({
                title: '✅ Rank Reassignment Confirmed',
                color: 0x2ecc71,
                fields: [
                    { name: 'Discord Snowflake', value: `<@${discordUserId}>`, inline: true },
                    { name: 'Roblox ID', value: String(robloxId), inline: true },
                    { name: 'Assigned Role ID', value: String(roleId), inline: true }
                ]
            });

            return { success: true, robloxId };
        } catch (err) {
            if (err.message.includes('Authentication cookie') || err.message.includes('403')) {
                systemState.circuitBreakerOpen = true;
                if (systemState.circuitBreakerTimeout) clearTimeout(systemState.circuitBreakerTimeout);
                systemState.circuitBreakerTimeout = setTimeout(() => {
                    systemState.circuitBreakerOpen = false;
                }, 300000);
            }
            throw err;
        } finally {
            systemState.activeRanks--;
        }
    });
}

// ==========================================
// API Subsystem Routes & Dashboard Frontend
// ==========================================

app.get('/', (req, res) => {
    res.status(200).send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Enterprise Proxy Administration Dashboard</title>
    <style>
        :root {
            --bg-color: #0f172a;
            --card-bg: #1e293b;
            --accent-color: #3b82f6;
            --accent-hover: #2563eb;
            --text-primary: #f8fafc;
            --text-secondary: #94a3b8;
            --danger: #ef4444;
            --success: #22c55e;
            --border: #334155;
            --warning: #f59e0b;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
        body { background-color: var(--bg-color); color: var(--text-primary); display: flex; height: 100vh; overflow: hidden; }
        aside { width: 260px; background-color: var(--card-bg); border-right: 1px solid var(--border); display: flex; flex-direction: column; }
        .brand { padding: 24px; font-size: 1.2rem; font-weight: bold; border-bottom: 1px solid var(--border); color: var(--accent-color); }
        .nav-links { list-style: none; padding: 20px 0; flex-grow: 1; }
        .nav-links li { padding: 12px 24px; cursor: pointer; color: var(--text-secondary); transition: all 0.2s ease; }
        .nav-links li:hover, .nav-links li.active { background-color: rgba(59, 130, 246, 0.1); color: var(--text-primary); border-left: 4px solid var(--accent-color); }
        main { flex-grow: 1; display: flex; flex-direction: column; overflow-y: auto; }
        header { padding: 20px 32px; border-bottom: 1px solid var(--border); background-color: var(--card-bg); display: flex; justify-content: space-between; align-items: center; }
        .auth-box { display: flex; gap: 12px; align-items: center; }
        input, select, button { background: var(--bg-color); border: 1px solid var(--border); color: var(--text-primary); padding: 8px 14px; border-radius: 6px; outline: none; }
        button { background-color: var(--accent-color); border: none; font-weight: 600; cursor: pointer; transition: background 0.2s; }
        button:hover { background-color: var(--accent-hover); }
        .view-container { padding: 32px; display: none; }
        .view-container.active { display: block; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .card { background-color: var(--card-bg); border: 1px solid var(--border); padding: 20px; border-radius: 8px; margin-bottom: 20px; }
        .card h3 { font-size: 0.9rem; color: var(--text-secondary); margin-bottom: 8px; }
        .card .value { font-size: 1.8rem; font-weight: bold; }
        .table-wrapper { background-color: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
        table { width: 100%; border-collapse: collapse; text-align: left; }
        th, td { padding: 14px 20px; border-bottom: 1px solid var(--border); }
        th { background-color: rgba(0, 0, 0, 0.2); color: var(--text-secondary); font-size: 0.85rem; }
        .status-badge { display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: bold; }
        .badge-success { background: rgba(34, 197, 94, 0.15); color: var(--success); }
        .badge-danger { background: rgba(239, 68, 68, 0.15); color: var(--danger); }
        .badge-warning { background: rgba(245, 158, 11, 0.15); color: var(--warning); }
        .form-group { margin-bottom: 14px; display: flex; flex-direction: column; gap: 6px; }
        label { font-size: 0.85rem; color: var(--text-secondary); }
    </style>
</head>
<body>
    <aside>
        <div class="brand">⚡ Enterprise Engine</div>
        <ul class="nav-links" id="navLinks">
            <li class="active" data-view="dashboard">System Dashboard</li>
            <li data-view="moderation">Discord Moderation Panel</li>
            <li data-view="logs">Live Telemetry Logs</li>
        </ul>
    </aside>
    <main>
        <header>
            <h2 id="view-title">Dashboard Overview</h2>
            <div class="auth-box">
                <input type="password" id="apiKeyInput" placeholder="Enter Proxy API Key...">
                <button id="syncBtn">Authorize & Sync</button>
            </div>
        </header>
        
        <div id="view-dashboard" class="view-container active">
            <div class="card" style="display: flex; justify-content: space-between; align-items: center; border-color: var(--warning);">
                <div>
                    <h3>Infrastructure Maintenance Switch</h3>
                    <p style="color: var(--text-secondary); font-size: 0.85rem;">Taking services offline stops all rank routes while keeping this dashboard active.</p>
                </div>
                <button id="maintBtn" style="background-color: var(--warning); color: #000;">Toggle Maintenance Mode</button>
            </div>
            <div class="grid">
                <div class="card"><h3>Uptime Status</h3><div class="value" id="stat-uptime">0s</div></div>
                <div class="card"><h3>Total Inbound Requests</h3><div class="value" id="stat-requests">0</div></div>
                <div class="card"><h3>Active Rank Operations</h3><div class="value" id="stat-active">0</div></div>
                <div class="card"><h3>System State</h3><div class="value" id="stat-state" style="color: var(--success);">Optimal</div></div>
            </div>
        </div>

        <div id="view-moderation" class="view-container">
            <div class="grid" style="grid-template-columns: repeat(2, 1fr);">
                <div class="card">
                    <h3>🛠️ Channel Management & Tickets</h3>
                    <div class="form-group">
                        <label>Target Channel ID</label>
                        <input type="text" id="modChannelId" placeholder="e.g. 123456789012345678">
                    </div>
                    <div style="display: flex; gap: 10px; margin-top: 10px;">
                        <button id="modRenameBtn">Mark Resolved</button>
                        <button id="modDeleteBtn" style="background-color: var(--danger);">Purge Channel</button>
                    </div>
                </div>

                <div class="card">
                    <h3>🔨 User Member Moderation</h3>
                    <div class="form-group">
                        <label>Target User Discord ID</label>
                        <input type="text" id="modUserId" placeholder="User Snowflake ID...">
                    </div>
                    <div class="form-group">
                        <label>Moderation Action</label>
                        <select id="modActionType">
                            <option value="kick">Kick Member</option>
                            <option value="ban">Ban Member</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Reason / Audit Log Note</label>
                        <input type="text" id="modReason" placeholder="Violation context...">
                    </div>
                    <button id="execUserModBtn" style="margin-top: 6px; width: 100%;">Execute Action</button>
                </div>
            </div>

            <div class="card">
                <h3>💬 Direct Announcement Dispatcher</h3>
                <div class="form-group">
                    <label>Target Channel ID</label>
                    <input type="text" id="annChannelId" placeholder="Channel ID for announcement...">
                </div>
                <div class="form-group">
                    <label>Message Content / Embed Text</label>
                    <input type="text" id="annContent" placeholder="Type announcement message here...">
                </div>
                <button id="sendAnnBtn" style="margin-top: 6px;">Send Announcement</button>
            </div>
        </div>

        <div id="view-logs" class="view-container">
            <div class="table-wrapper">
                <table>
                    <thead><tr><th>Timestamp</th><th>Event Type</th><th>Diagnostic Payload</th></tr></thead>
                    <tbody id="logs-table-body">
                        <tr><td>System Initialized</td><td><span class="status-badge badge-success">OK</span></td><td>Dashboard awaiting active API key synchronization...</td></tr>
                    </tbody>
                </table>
            </div>
        </div>
    </main>
    <script>
        document.addEventListener('DOMContentLoaded', () => {
            const titles = { dashboard: 'System Dashboard Overview', moderation: 'Full Discord Moderation Panel', logs: 'Live Telemetry Audit Logs' };

            document.querySelectorAll('#navLinks li').forEach(li => {
                li.addEventListener('click', (e) => {
                    document.querySelectorAll('.view-container').forEach(el => el.classList.remove('active'));
                    document.querySelectorAll('#navLinks li').forEach(el => el.classList.remove('active'));
                    const viewName = e.currentTarget.getAttribute('data-view');
                    document.getElementById('view-' + viewName).classList.add('active');
                    e.currentTarget.classList.add('active');
                    document.getElementById('view-title').innerText = titles[viewName];
                });
            });

            async function refreshData() {
                const apiKey = document.getElementById('apiKeyInput').value;
                if (!apiKey) { alert('Please enter your Proxy API Key first.'); return; }
                try {
                    const response = await fetch('/api/status', { headers: { 'x-api-key': apiKey } });
                    if (!response.ok) throw new Error('Unauthorized or network exception.');
                    const data = await response.json();
                    document.getElementById('stat-uptime').innerText = data.uptimeSeconds + 's';
                    document.getElementById('stat-requests').innerText = data.totalRequestsHandled;
                    document.getElementById('stat-active').innerText = data.activeRankingOperations;
                    
                    const stateEl = document.getElementById('stat-state');
                    if (data.maintenanceMode) {
                        stateEl.innerText = 'Maintenance ⚠️'; stateEl.style.color = 'var(--warning)';
                    } else if (data.circuitBreakerTripped) {
                        stateEl.innerText = 'Tripped 🛑'; stateEl.style.color = 'var(--danger)';
                    } else {
                        stateEl.innerText = 'Optimal ✅'; stateEl.style.color = 'var(--success)';
                    }
                    alert('Dashboard successfully synced with backend engine!');
                } catch (err) { alert('Sync failed: ' + err.message); }
            }

            document.getElementById('syncBtn').addEventListener('click', refreshData);

            document.getElementById('maintBtn').addEventListener('click', async () => {
                const apiKey = document.getElementById('apiKeyInput').value;
                if (!apiKey) { alert('Please enter your Proxy API Key first.'); return; }
                try {
                    const res = await fetch('/api/maintenance', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey }
                    });
                    const json = await res.json();
                    if (!res.ok) throw new Error(json.error || 'Failed to toggle maintenance.');
                    alert('Maintenance mode is now: ' + (json.maintenanceMode ? 'ACTIVE (Services Offline)' : 'INACTIVE (Services Online)'));
                    refreshData();
                } catch (err) { alert('Error: ' + err.message); }
            });

            async function executeModAction(actionType) {
                const apiKey = document.getElementById('apiKeyInput').value;
                const channelId = document.getElementById('modChannelId').value;
                if (!apiKey || !channelId) { alert('API Key and Target Channel ID are required.'); return; }

                try {
                    const res = await fetch('/api/moderation/channel', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
                        body: JSON.stringify({ channelId, action: actionType })
                    });
                    const json = await res.json();
                    if (!res.ok) throw new Error(json.error || 'Failed to execute command.');
                    alert('Success: Channel command executed successfully.');
                } catch (err) { alert('Moderation Error: ' + err.message); }
            }

            document.getElementById('modRenameBtn').addEventListener('click', () => executeModAction('rename'));
            document.getElementById('modDeleteBtn').addEventListener('click', () => executeModAction('delete'));

            document.getElementById('execUserModBtn').addEventListener('click', async () => {
                const apiKey = document.getElementById('apiKeyInput').value;
                const userId = document.getElementById('modUserId').value;
                const action = document.getElementById('modActionType').value;
                const reason = document.getElementById('modReason').value;

                if (!apiKey || !userId) { alert('API Key and Target User ID are required.'); return; }

                try {
                    const res = await fetch('/api/moderation/user', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
                        body: JSON.stringify({ userId, action, reason })
                    });
                    const json = await res.json();
                    if (!res.ok) throw new Error(json.error || 'Failed to execute user action.');
                    alert('Success: User moderation action completed.');
                } catch (err) { alert('Moderation Error: ' + err.message); }
            });

            document.getElementById('sendAnnBtn').addEventListener('click', async () => {
                const apiKey = document.getElementById('apiKeyInput').value;
                const channelId = document.getElementById('annChannelId').value;
                const content = document.getElementById('annContent').value;

                if (!apiKey || !channelId || !content) { alert('All announcement fields are required.'); return; }

                try {
                    const res = await fetch('/api/moderation/announce', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
                        body: JSON.stringify({ channelId, content })
                    });
                    const json = await res.json();
                    if (!res.ok) throw new Error(json.error || 'Failed to send announcement.');
                    alert('Success: Announcement posted to channel.');
                } catch (err) { alert('Announcement Error: ' + err.message); }
            });
        });
    </script>
</body>
</html>
    `);
});

// Runtime Health & Diagnostics Telemetry Feed API
app.get('/api/status', authenticateRequest, (req, res) => {
    res.status(200).json({
        online: true,
        uptimeSeconds: Math.floor((Date.now() - systemState.uptime) / 1000),
        totalRequestsHandled: systemState.requestCount,
        activeRankingOperations: systemState.activeRanks,
        queuedTasks: rankQueue.length,
        circuitBreakerTripped: systemState.circuitBreakerOpen,
        maintenanceMode: systemState.maintenanceMode
    });
});

// Maintenance Toggle API Endpoint
app.post('/api/maintenance', authenticateRequest, (req, res) => {
    systemState.maintenanceMode = !systemState.maintenanceMode;
    console.log(`🛠️ [MAINTENANCE] System maintenance mode toggled to: ${systemState.maintenanceMode}`);
    return res.status(200).json({ success: true, maintenanceMode: systemState.maintenanceMode });
});

// ==========================================
// Full Functional Discord Moderation API Endpoints
// ==========================================

app.post('/api/moderation/channel', authenticateRequest, async (req, res) => {
    const { channelId, action } = req.body;
    if (!channelId || !action) {
        return res.status(400).json({ success: false, error: 'Missing channelId or action parameters.' });
    }

    try {
        if (action === 'delete') {
            const response = await executeDiscordApi(`/channels/${channelId}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bot ${CONFIG.DISCORD_BOT_TOKEN}` }
            });
            if (!response.ok) throw new Error('Failed to delete target channel.');
            return res.status(200).json({ success: true, message: 'Channel purged successfully.' });
        } else if (action === 'rename') {
            const response = await executeDiscordApi(`/channels/${channelId}`, {
                method: 'PATCH',
                headers: { 'Authorization': `Bot ${CONFIG.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: `resolved-${channelId.slice(-4)}` })
            });
            if (!response.ok) throw new Error('Failed to update channel name.');
            return res.status(200).json({ success: true, message: 'Channel marked as resolved.' });
        }
        return res.status(400).json({ success: false, error: 'Invalid channel action command.' });
    } catch (err) {
        console.error('⚠️ [MODERATION ERROR] Channel action failed:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/moderation/user', authenticateRequest, async (req, res) => {
    const { userId, action, reason } = req.body;
    if (!userId || !action || !CONFIG.DISCORD_SERVER_ID) {
        return res.status(400).json({ success: false, error: 'Missing user moderation parameters.' });
    }

    try {
        if (action === 'kick') {
            const response = await executeDiscordApi(`/guilds/${CONFIG.DISCORD_SERVER_ID}/members/${userId}`, {
                method: 'DELETE',
                headers: { 
                    'Authorization': `Bot ${CONFIG.DISCORD_BOT_TOKEN}`,
                    'X-Audit-Log-Reason': reason || 'Administrative dashboard action'
                }
            });
            if (!response.ok) throw new Error('Failed to kick member from server.');
            return res.status(200).json({ success: true, message: 'Member kicked successfully.' });
        } else if (action === 'ban') {
            const response = await executeDiscordApi(`/guilds/${CONFIG.DISCORD_SERVER_ID}/bans/${userId}`, {
                method: 'PUT',
                headers: { 
                    'Authorization': `Bot ${CONFIG.DISCORD_BOT_TOKEN}`,
                    'Content-Type': 'application/json',
                    'X-Audit-Log-Reason': reason || 'Administrative dashboard ban action'
                },
                body: JSON.stringify({ delete_message_seconds: 0 })
            });
            if (!response.ok) throw new Error('Failed to ban member from server.');
            return res.status(200).json({ success: true, message: 'Member banned successfully.' });
        }
        return res.status(400).json({ success: false, error: 'Invalid user moderation command.' });
    } catch (err) {
        console.error('⚠️ [MODERATION ERROR] User action failed:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/moderation/announce', authenticateRequest, async (req, res) => {
    const { channelId, content } = req.body;
    if (!channelId || !content) {
        return res.status(400).json({ success: false, error: 'Missing channelId or message content.' });
    }

    try {
        const response = await executeDiscordApi(`/channels/${channelId}/messages`, {
            method: 'POST',
            headers: { 'Authorization': `Bot ${CONFIG.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ content })
        });
        if (!response.ok) throw new Error('Failed to post message to target channel.');
        return res.status(200).json({ success: true, message: 'Announcement dispatched successfully.' });
    } catch (err) {
        console.error('⚠️ [MODERATION ERROR] Announcement failed:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Primary Inbound Ranking Endpoint
app.post('/setrank', authenticateRequest, async (req, res) => {
    const { discordUserId, roleId } = req.body;
    if (!discordUserId || !roleId) {
        return res.status(400).json({ success: false, error: 'Missing mandatory payload attributes: discordUserId or roleId.' });
    }

    const timestampKey = userCooldowns.get(discordUserId) || 0;
    if (Date.now() < timestampKey + COOLDOWN_TIME) {
        const remainingWindow = Math.ceil((timestampKey + COOLDOWN_TIME - Date.now()) / 1000);
        return res.status(429).json({ success: false, error: `Cooldown threshold active. Try again in ${remainingWindow} seconds.` });
    }
    userCooldowns.set(discordUserId, Date.now());

    try {
        const resolution = await performRobloxRankingPipeline(discordUserId, roleId);
        return res.status(200).json({ success: true, data: resolution });
    } catch (err) {
        await processFailureProtocol(discordUserId, roleId, err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// Discord UI Component Interaction Controller
// ==========================================
app.post('/api/discord-interactions', verifyKeyMiddleware(CONFIG.DISCORD_PUBLIC_KEY), async (req, res) => {
    const interaction = req.body;

    if (interaction.type === 3) {
        const componentId = interaction.data.custom_id;
        const targetChannelId = interaction.channel.id;
        const executorId = interaction.member.user.id;

        try {
            if (componentId.startsWith('ticket_claim_')) {
                ticketOwners.set(targetChannelId, executorId);
                return res.json(buildEmbed('🔒 Ticket Claimed', `Incident ownership successfully locked to <@${executorId}>.`, 0x3498db));
            }

            if (componentId.startsWith('ticket_getinfo_')) {
                const targetUserSnowflake = componentId.split('_')[2];
                const activeOwner = ticketOwners.get(targetChannelId);
                const diagnosticInfo = `**Target Subject:** <@${targetUserSnowflake}> (\`${targetUserSnowflake}\`)\n**Owner Assigned:** ${activeOwner ? `<@${activeOwner}>` : '*None*'}\n**Channel Snowflake:** \`${targetChannelId}\``;
                return res.json(buildEmbed('📊 Session Diagnostics', diagnosticInfo, 0x2ecc71));
            }

            if (componentId.startsWith('ticket_add_')) {
                return res.json(buildEmbed('➕ Collaborator Control', 'Modify user permissions directly via channel overwrite controls.', 0x95a5a6));
            }

            if (componentId.startsWith('ticket_delete_')) {
                res.json(buildEmbed('🗑️ Purge Initialized', 'Channel teardown sequence executing in 3 seconds.', 0xe74c3c));
                setTimeout(() => {
                    executeDiscordApi(`/channels/${targetChannelId}`, {
                        method: 'DELETE',
                        headers: { 'Authorization': `Bot ${CONFIG.DISCORD_BOT_TOKEN}` }
                    }).catch(err => console.error('⚠️ Teardown error:', err));
                }, 3000);
                return;
            }

            if (componentId.startsWith('ticket_rename_')) {
                res.json(buildEmbed('✏️ Namespace Update', 'Channel state designated as resolved.', 0xf1c40f));
                await executeDiscordApi(`/channels/${targetChannelId}`, {
                    method: 'PATCH',
                    headers: { 'Authorization': `Bot ${CONFIG.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: `resolved-${targetChannelId.slice(-4)}` })
                });
                return;
            }

            if (componentId.startsWith('ticket_retry_')) {
                if (systemState.maintenanceMode) {
                    return res.json(buildEmbed('⚠️ Maintenance Mode', 'Retries are disabled while services are offline for maintenance.', 0xf59e0b));
                }

                const segments = componentId.split('_');
                const discordUserId = segments[2];
                const roleId = segments[3];

                res.json(buildEmbed('🔄 Execution Retried', `Re-evaluating rank assignment sequence for <@${discordUserId}>...`, 0x3498db));

                try {
                    await performRobloxRankingPipeline(discordUserId, roleId);
                    await executeDiscordApi(`/channels/${targetChannelId}/messages`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bot ${CONFIG.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ embeds: [{ title: '✅ Retry Success', description: `User <@${discordUserId}> has been successfully synchronized.`, color: 0x2ecc71 }] })
                    });
                } catch (err) {
                    await executeDiscordApi(`/channels/${targetChannelId}/messages`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bot ${CONFIG.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ embeds: [{ title: '❌ Retry Blocked', description: `Exception: \`${err.message}\``, color: 0xe74c3c }] })
                    });
                }
                return;
            }
        } catch (error) {
            console.error('⚠️ Interaction Dispatch Exception:', error);
            return res.json(buildEmbed('⚠️ System Error', 'An unexpected exception halted component evaluation.', 0xe74c3c));
        }
    }
});

// ==========================================
// Keep-Alive Self-Ping Subsystem
// ==========================================
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;

if (RENDER_EXTERNAL_URL) {
    const PING_INTERVAL_MS = 14 * 60 * 1000;
    
    setInterval(async () => {
        try {
            const response = await fetch(RENDER_EXTERNAL_URL);
            if (response.ok) {
                console.log(`✨ [KEEP-ALIVE] Heartbeat successful. Server is staying active.`);
            }
        } catch (error) {
            console.error(`❌ [KEEP-ALIVE] Heartbeat fetch failed:`, error.message);
        }
    }, PING_INTERVAL_MS);
}

app.listen(PORT, () => {
    console.log(`🔥 [ENTERPRISE CORE] V5 Advanced Proxy with strict block maintenance middleware listening on port ${PORT}`);
});
