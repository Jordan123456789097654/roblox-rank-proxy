const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { verifyKeyMiddleware } = require('discord-interactions');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// Configuration & Validation
// ==========================================
const CONFIG = {
    DISCORD_PUBLIC_KEY: process.env.DISCORD_PUBLIC_KEY,
    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
    DISCORD_SERVER_ID: process.env.DISCORD_SERVER_ID,
    DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,
    ERROR_CATEGORY_ID: process.env.ERROR_CATEGORY_ID,
    ROBLOX_COOKIE: process.env.ROBLOX_COOKIE,
    GROUP_ID: process.env.GROUP_ID,
    BLOXLINK_API_KEY: process.env.BLOXLINK_API_KEY,
    PROXY_API_KEY: process.env.PROXY_API_KEY,
};

const missingKeys = Object.keys(CONFIG).filter(key => !CONFIG[key]);
if (missingKeys.length > 0) {
    console.error(`🚨 [CRITICAL] Missing Environment Variables: ${missingKeys.join(', ')}`);
}

const userCooldowns = new Map();
const ticketOwners = new Map();
const COOLDOWN_TIME = 60 * 1000;
let isRobloxRanking = false; 

// ==========================================
// Global Middleware
// ==========================================
app.use(helmet()); 
app.use(rateLimit({
    windowMs: 60 * 1000, 
    max: 50,
    message: { error: 'Too many requests. Proxy is rate-limited.' }
}));

app.use((req, res, next) => {
    console.log(`🌐 [${new Date().toLocaleTimeString()}] ${req.method} ${req.originalUrl}`);
    next();
});

const authenticateRequest = (req, res, next) => {
    const key = req.headers['x-api-key'] || (req.body && req.body.apiKey);
    if (key !== CONFIG.PROXY_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized: Invalid API Key.' });
    }
    next();
};

// ==========================================
// Restored Utility Functions
// ==========================================
async function sendWebhook(embed) {
    if (!CONFIG.DISCORD_WEBHOOK_URL) return;
    try {
        await fetch(CONFIG.DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ embeds: [embed] })
        });
    } catch (error) {
        console.error('Discord Webhook Error:', error);
    }
}

async function discordApiFetch(endpoint, options, retries = 3) {
    const url = endpoint.startsWith('http') ? endpoint : `https://discord.com/api/v10${endpoint}`;
    for (let i = 0; i < retries; i++) {
        const response = await fetch(url, options);
        if (response.status === 429) {
            const data = await response.json();
            const delay = (data.retry_after || 1) * 1000;
            console.warn(`⏳ [DISCORD] Rate limited. Waiting ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
            continue;
        }
        return response;
    }
    throw new Error('Discord API failed after multiple retries.');
}

function createEmbedResponse(title, description, color, ephemeral = true) {
    return {
        type: 4,
        data: {
            embeds: [{ title, description, color, timestamp: new Date().toISOString() }],
            flags: ephemeral ? 64 : 0
        }
    };
}

// RESTORED: Automated Ticket Creation Feature
async function handleFailureNotification(discordUserId, roleId, rawError) {
    const staffRoleId = "1529311162183975032"; // From your original code

    await sendWebhook({
        title: '❌ Rank Update Failed',
        color: 0xe74c3c,
        description: `Rank transaction failed for user <@${discordUserId}>.`,
        fields: [
            { name: 'Target Role ID', value: String(roleId), inline: true },
            { name: 'Error Diagnostic', value: `\`\`\`json\n${rawError.substring(0, 400)}\n\`\`\`` }
        ],
        timestamp: new Date().toISOString()
    });

    if (!CONFIG.DISCORD_BOT_TOKEN || !CONFIG.DISCORD_SERVER_ID) return;

    let cleanError = rawError;
    if (!rawError || rawError.includes('500') || rawError.includes('502')) cleanError = 'Unknown API error occurred.';

    try {
        const channelsRes = await discordApiFetch(`/guilds/${CONFIG.DISCORD_SERVER_ID}/channels`, {
            headers: { 'Authorization': `Bot ${CONFIG.DISCORD_BOT_TOKEN}` }
        });
        const channels = await channelsRes.json();
        
        const expectedChannelName = `rank-failed-${discordUserId.slice(-4)}`;
        let existingChannel = channels.find(c => c.name === expectedChannelName && c.type === 0);
        let targetChannelId;

        const actionRow1 = {
            type: 1, components: [
                { type: 2, style: 1, custom_id: `ticket_claim_${discordUserId}`, label: 'Claim' },
                { type: 2, style: 2, custom_id: `ticket_rename_${discordUserId}`, label: 'Rename' },
                { type: 2, style: 2, custom_id: `ticket_add_${discordUserId}`, label: 'Add User' },
                { type: 2, style: 4, custom_id: `ticket_delete_${discordUserId}`, label: 'Delete' }
            ]
        };

        const actionRow2 = {
            type: 1, components: [
                { type: 2, style: 2, custom_id: `ticket_getinfo_${discordUserId}`, label: 'Get Info' },
                { type: 2, style: 3, custom_id: `ticket_retry_${discordUserId}_${roleId}`, label: 'Retry Rank' }
            ]
        };

        if (existingChannel) {
            targetChannelId = existingChannel.id;
        } else {
            const createChannelRes = await discordApiFetch(`/guilds/${CONFIG.DISCORD_SERVER_ID}/channels`, {
                method: 'POST',
                headers: { 'Authorization': `Bot ${CONFIG.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: expectedChannelName,
                    type: 0, 
                    parent_id: CONFIG.ERROR_CATEGORY_ID || undefined,
                    permission_overwrites: [
                        { id: CONFIG.DISCORD_SERVER_ID, type: 0, deny: '1024' },       
                        { id: discordUserId, type: 1, allow: '1024' }, 
                        { id: staffRoleId, type: 0, allow: '1024' }    
                    ]
                })
            });
            const channelData = await createChannelRes.json();
            targetChannelId = channelData.id;
        }

        await discordApiFetch(`/channels/${targetChannelId}/messages`, {
            method: 'POST',
            headers: { 'Authorization': `Bot ${CONFIG.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: `<@${discordUserId}> Another rank update failed for Role ID \`${roleId}\`.\n**Reason:** \`${cleanError}\``,
                components: [actionRow1, actionRow2]
            })
        });
    } catch (err) {
        console.error('Error execution failed during ticket routing:', err);
    }
}

// ==========================================
// Core Roblox Ranking Engine 
// ==========================================
async function executeRobloxRanking(discordUserId, roleId) {
    while (isRobloxRanking) { await new Promise(resolve => setTimeout(resolve, 500)); }
    isRobloxRanking = true;

    try {
        const bloxRes = await fetch(`https://api.blox.link/v4/public/guilds/${CONFIG.DISCORD_SERVER_ID}/discord-to-roblox/${discordUserId}`, {
            headers: { 'Authorization': CONFIG.BLOXLINK_API_KEY }
        });
        const bloxData = await bloxRes.json();
        if (!bloxRes.ok || !bloxData.robloxID) throw new Error('User not verified on Bloxlink.');
        const targetRobloxId = bloxData.robloxID;

        const memberRes = await fetch(`https://groups.roblox.com/v1/groups/${CONFIG.GROUP_ID}/users/${targetRobloxId}`);
        if (!memberRes.ok) throw new Error('User is not in the Roblox group.');
        const memberData = await memberRes.json();
        if (!memberData.role) throw new Error('User holds no rank in the group.');

        const targetRoleIdInt = parseInt(roleId, 10);
        if (memberData.role.id === targetRoleIdInt) throw new Error('User already has this rank.');

        let csrfResponse = await fetch('https://auth.roblox.com/v1/logout', {
            method: 'POST',
            headers: { 'Cookie': `.ROBLOSECURITY=${CONFIG.ROBLOX_COOKIE}` }
        });
        let csrfToken = csrfResponse.headers.get('x-csrf-token');
        if (!csrfToken) throw new Error('Roblox CSRF Token generation failed.');

        const attemptRank = async (token) => fetch(`https://groups.roblox.com/v1/groups/${CONFIG.GROUP_ID}/users/${targetRobloxId}`, {
            method: 'PATCH',
            headers: { 'Cookie': `.ROBLOSECURITY=${CONFIG.ROBLOX_COOKIE}`, 'x-csrf-token': token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ roleId: targetRoleIdInt })
        });

        let rankResponse = await attemptRank(csrfToken);

        if (rankResponse.status === 403 && rankResponse.headers.has('x-csrf-token')) {
            csrfToken = rankResponse.headers.get('x-csrf-token');
            rankResponse = await attemptRank(csrfToken);
        }

        if (!rankResponse.ok) {
            const errData = await rankResponse.json().catch(() => ({}));
            throw new Error(`Roblox API Error: ${JSON.stringify(errData)}`);
        }

        // RESTORED: Success Webhook
        await sendWebhook({
            title: '✅ Rank Update Successful',
            color: 0x2ecc71,
            fields: [
                { name: 'Discord User', value: `<@${discordUserId}>`, inline: true },
                { name: 'Roblox ID', value: String(targetRobloxId), inline: true },
                { name: 'New Role ID', value: String(roleId), inline: true }
            ],
            timestamp: new Date().toISOString()
        });

        return true;
    } finally {
        isRobloxRanking = false; 
    }
}

// ==========================================
// Routes
// ==========================================

app.get('/', (req, res) => {
    res.status(200).json({ system: 'Operational', version: '4.0-Restored' });
});

// RESTORED: Main Ranking Route with Error Routing
app.post('/setrank', express.json(), authenticateRequest, async (req, res) => {
    const { discordUserId, roleId } = req.body;
    if (!discordUserId || !roleId) return res.status(400).json({ error: 'Missing parameters.' });

    const now = Date.now();
    if (userCooldowns.has(discordUserId) && now < userCooldowns.get(discordUserId) + COOLDOWN_TIME) {
        return res.status(429).json({ success: false, error: 'Cooldown active.' });
    }
    userCooldowns.set(discordUserId, now);

    try {
        await executeRobloxRanking(discordUserId, roleId);
        res.status(200).json({ success: true, message: 'Rank applied successfully.' });
    } catch (error) {
        // RESTORED: Actually creates the ticket channel when a rank fails!
        await handleFailureNotification(discordUserId, roleId, error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// DISCORD UI INTERACTIONS ROUTE
app.post('/api/discord-interactions', verifyKeyMiddleware(CONFIG.DISCORD_PUBLIC_KEY), async (req, res) => {
    const interaction = req.body;

    if (interaction.type === 3) { 
        const customId = interaction.data.custom_id;
        const channelId = interaction.channel.id;
        const staffUserId = interaction.member.user.id;

        try {
            if (customId.startsWith('ticket_claim_')) {
                ticketOwners.set(channelId, staffUserId);
                return res.json(createEmbedResponse('🔒 Ticket Claimed', `This ticket is now handled by <@${staffUserId}>.`, 0x3498db));
            }

            if (customId.startsWith('ticket_getinfo_')) {
                const targetUser = customId.split('_')[2];
                const owner = ticketOwners.get(channelId);
                const desc = `**Target User:** <@${targetUser}> (\`${targetUser}\`)\n**Claimed By:** ${owner ? `<@${owner}>` : '*Unclaimed*'}\n**Channel ID:** \`${channelId}\``;
                return res.json(createEmbedResponse('📊 Diagnostics', desc, 0x2ecc71));
            }

            if (customId.startsWith('ticket_add_')) {
                return res.json(createEmbedResponse('➕ Add Members', 'Use Discord\'s built-in channel settings to add roles.', 0x95a5a6));
            }

            if (customId.startsWith('ticket_delete_')) {
                res.json(createEmbedResponse('🗑️ Deleting...', 'Channel will be destroyed in 3 seconds.', 0xe74c3c));
                setTimeout(() => {
                    discordApiFetch(`/channels/${channelId}`, { 
                        method: 'DELETE', headers: { 'Authorization': `Bot ${CONFIG.DISCORD_BOT_TOKEN}` } 
                    }).catch(err => console.error('Delete fail:', err));
                }, 3000);
                return;
            }

            if (customId.startsWith('ticket_rename_')) {
                res.json(createEmbedResponse('✏️ Renaming...', 'Channel marked as resolved.', 0xf1c40f));
                await discordApiFetch(`/channels/${channelId}`, {
                    method: 'PATCH',
                    headers: { 'Authorization': `Bot ${CONFIG.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: `resolved-${channelId.slice(-4)}` })
                });
                return;
            }

            if (customId.startsWith('ticket_retry_')) {
                const parts = customId.split('_');
                const discordUserId = parts[2];
                const roleId = parts[3];

                res.json(createEmbedResponse('🔄 Retrying...', `Attempting to rank <@${discordUserId}>...`, 0x3498db));

                try {
                    await executeRobloxRanking(discordUserId, roleId);
                    await discordApiFetch(`/channels/${channelId}/messages`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bot ${CONFIG.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ embeds: [{ title: '✅ Success', description: `<@${discordUserId}> was ranked!`, color: 0x2ecc71 }] })
                    });
                } catch (err) {
                    await discordApiFetch(`/channels/${channelId}/messages`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bot ${CONFIG.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ embeds: [{ title: '❌ Failed Again', description: `Error: \`${err.message}\``, color: 0xe74c3c }] })
                    });
                }
                return;
            }
        } catch (error) {
            console.error('Interaction Error:', error);
            return res.json(createEmbedResponse('⚠️ Error', 'Internal server error processing button.', 0xe74c3c));
        }
    }
});

app.listen(PORT, () => {
    console.log(`🔥 [SYSTEM] Advanced Proxy V4 (Features Restored) running on port ${PORT}`);
});
