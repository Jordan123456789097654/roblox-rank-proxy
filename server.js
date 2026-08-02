const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { verifyKey } = require('discord-interactions');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// Advanced Configuration & Validation
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
    console.error(`🚨 [CRITICAL ERROR] Missing Environment Variables: ${missingKeys.join(', ')}`);
}

const userCooldowns = new Map();
const ticketOwners = new Map();
let isRobloxRanking = false; 

// ==========================================
// Middleware (UPDATED FOR DISCORD VALIDATION)
// ==========================================
app.use(helmet()); 

// CRITICAL FIX: Save the raw unparsed body for Discord's security verification
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

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
    const key = req.headers['x-api-key'] || req.body.apiKey;
    if (key !== CONFIG.PROXY_API_KEY) {
        console.warn(`🛑 [AUTH] Blocked unauthorized request from ${req.ip}`);
        return res.status(401).json({ error: 'Unauthorized: Invalid API Key.' });
    }
    next();
};

// ==========================================
// Advanced Discord Utility
// ==========================================
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
            embeds: [{
                title: title,
                description: description,
                color: color,
                timestamp: new Date().toISOString()
            }],
            flags: ephemeral ? 64 : 0
        }
    };
}

// ==========================================
// Core Roblox Ranking Engine 
// ==========================================
async function executeRobloxRanking(discordUserId, roleId) {
    while (isRobloxRanking) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    isRobloxRanking = true;

    try {
        console.log(`🚀 [ROBLOX] Starting rank pipeline for Discord User: ${discordUserId}`);
        
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
        if (!csrfToken) throw new Error('Roblox CSRF Token generation failed. Cookie may be invalid.');

        let rankResponse = await fetch(`https://groups.roblox.com/v1/groups/${CONFIG.GROUP_ID}/users/${targetRobloxId}`, {
            method: 'PATCH',
            headers: {
                'Cookie': `.ROBLOSECURITY=${CONFIG.ROBLOX_COOKIE}`,
                'x-csrf-token': csrfToken,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ roleId: targetRoleIdInt })
        });

        if (rankResponse.status === 403 && rankResponse.headers.has('x-csrf-token')) {
            csrfToken = rankResponse.headers.get('x-csrf-token');
            rankResponse = await fetch(`https://groups.roblox.com/v1/groups/${CONFIG.GROUP_ID}/users/${targetRobloxId}`, {
                method: 'PATCH',
                headers: {
                    'Cookie': `.ROBLOSECURITY=${CONFIG.ROBLOX_COOKIE}`,
                    'x-csrf-token': csrfToken,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ roleId: targetRoleIdInt })
            });
        }

        if (!rankResponse.ok) {
            const errData = await rankResponse.json().catch(() => ({}));
            throw new Error(`Roblox API Error: ${JSON.stringify(errData)}`);
        }

        console.log(`✅ [ROBLOX] Successfully ranked ${targetRobloxId} to ${roleId}`);
        return true;

    } finally {
        isRobloxRanking = false; 
    }
}

// ==========================================
// Routes
// ==========================================

app.get('/', (req, res) => {
    res.status(200).json({ system: 'Operational', version: '2.1-Advanced-RawBody' });
});

app.post('/setrank', authenticateRequest, async (req, res) => {
    const { discordUserId, roleId } = req.body;
    if (!discordUserId || !roleId) return res.status(400).json({ error: 'Missing parameters.' });

    try {
        await executeRobloxRanking(discordUserId, roleId);
        res.status(200).json({ success: true, message: 'Rank applied successfully.' });
    } catch (error) {
        console.error(`❌ [ERROR] Rank pipeline failed: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Advanced Interactive Discord UI Endpoint
app.post('/api/discord-interactions', async (req, res) => {
    const signature = req.headers['x-signature-ed25519'];
    const timestamp = req.headers['x-signature-timestamp'];

    // CRITICAL FIX: Using req.rawBody instead of JSON.stringify(req.body)
    if (!CONFIG.DISCORD_PUBLIC_KEY || !verifyKey(req.rawBody, signature, timestamp, CONFIG.DISCORD_PUBLIC_KEY)) {
        console.warn('🛑 [DISCORD] Signature verification failed!');
        return res.status(401).send('Invalid signature');
    }

    const interaction = req.body;
    
    // Handshake Check
    if (interaction.type === 1) {
        console.log('✅ [DISCORD] Handshake successful!');
        return res.json({ type: 1 });
    }

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
                return res.json(createEmbedResponse('➕ Add Members', 'Use Discord\'s built in channel settings to add roles, or type a command if your bot supports it.', 0x95a5a6));
            }

            if (customId.startsWith('ticket_delete_')) {
                res.json(createEmbedResponse('🗑️ Deleting...', 'Channel will be destroyed in 3 seconds.', 0xe74c3c));
                setTimeout(() => {
                    discordApiFetch(`/channels/${channelId}`, { 
                        method: 'DELETE', 
                        headers: { 'Authorization': `Bot ${CONFIG.DISCORD_BOT_TOKEN}` } 
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

                res.json(createEmbedResponse('🔄 Retrying...', `Attempting to rank <@${discordUserId}> to \`${roleId}\`. Please wait.`, 0x3498db));

                try {
                    await executeRobloxRanking(discordUserId, roleId);
                    await discordApiFetch(`/channels/${channelId}/messages`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bot ${CONFIG.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                            embeds: [{ title: '✅ Success', description: `<@${discordUserId}> was successfully ranked!`, color: 0x2ecc71 }] 
                        })
                    });
                } catch (err) {
                    await discordApiFetch(`/channels/${channelId}/messages`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bot ${CONFIG.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                            embeds: [{ title: '❌ Failed Again', description: `Error: \`${err.message}\``, color: 0xe74c3c }] 
                        })
                    });
                }
                return;
            }

        } catch (error) {
            console.error('Interaction Error:', error);
            return res.json(createEmbedResponse('⚠️ Error', 'An internal server error occurred while processing this button.', 0xe74c3c));
        }
    }

    res.status(400).json({ error: 'Unknown interaction' });
});

app.listen(PORT, () => {
    console.log(`🔥 [SYSTEM] Advanced Proxy V2 running securely on port ${PORT}`);
});
