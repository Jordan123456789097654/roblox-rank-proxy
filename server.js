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
    circuitBreakerTimeout: null
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
app.use(helmet());
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
// API Subsystem Routes
// ==========================================

app.get('/', (req, res) => {
    res.status(200).json({ 
        architecture: 'Micro-Proxy Modular Engine',
        version: '5.1-Enterprise-KeepAlive',
        status: systemState.circuitBreakerOpen ? 'Degraded (Circuit Open)' : 'Optimal'
    });
});

// Runtime Health & Diagnostics Telemetry Feed API
app.get('/api/status', authenticateRequest, (req, res) => {
    res.status(200).json({
        online: true,
        uptimeSeconds: Math.floor((Date.now() - systemState.uptime) / 1000),
        totalRequestsHandled: systemState.requestCount,
        activeRankingOperations: systemState.activeRanks,
        queuedTasks: rankQueue.length,
        circuitBreakerTripped: systemState.circuitBreakerOpen
    });
});

// Primary Inbound Ranking Endpoint
app.post('/setrank', express.json(), authenticateRequest, async (req, res) => {
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
    const PING_INTERVAL_MS = 14 * 60 * 1000; // Ping every 14 minutes
    
    setInterval(async () => {
        try {
            console.log(`⏰ [KEEP-ALIVE] Initiating self-ping heartbeat to prevent spin-down...`);
            const response = await fetch(RENDER_EXTERNAL_URL);
            if (response.ok) {
                console.log(`✨ [KEEP-ALIVE] Heartbeat successful. Server is staying active.`);
            } else {
                console.warn(`⚠️ [KEEP-ALIVE] Heartbeat returned non-success status: ${response.status}`);
            }
        } catch (error) {
            console.error(`❌ [KEEP-ALIVE] Heartbeat fetch failed:`, error.message);
        }
    }, PING_INTERVAL_MS);
}

app.listen(PORT, () => {
    console.log(`🔥 [ENTERPRISE CORE] V5 Advanced Proxy listening seamlessly on port ${PORT}`);
});
