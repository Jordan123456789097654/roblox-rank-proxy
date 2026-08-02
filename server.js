const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// Middleware & Security
// ==========================================
app.use(helmet()); 
app.use(express.json());

const limiter = rateLimit({
    windowMs: 60 * 1000, 
    max: 30,
    message: { error: 'Too many requests. Please try again later.' }
});
app.use(limiter);

// In-memory cooldown tracker (60-second cooldown per user)
const userCooldowns = new Map();
const COOLDOWN_TIME = 60 * 1000;

// Advanced Request Logger
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] [ADVANCED PROXY] ${req.method} request received at ${req.originalUrl}`);
    next();
});

const authenticateRequest = (req, res, next) => {
    const providedKey = req.headers['x-api-key'] || req.body.apiKey;
    const expectedKey = process.env.PROXY_API_KEY;

    if (!expectedKey) {
        console.warn('⚠️ PROXY_API_KEY is not set in environment variables!');
        return res.status(500).json({ error: 'Server misconfiguration.' });
    }

    if (providedKey !== expectedKey) {
        return res.status(401).json({ error: 'Unauthorized: Invalid API Key.' });
    }
    
    next();
};

// ==========================================
// Discord Utility Functions
// ==========================================
async function sendWebhook(embed) {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) return;

    try {
        await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ embeds: [embed] })
        });
    } catch (error) {
        console.error('Discord Webhook Error:', error);
    }
}

// Safely handle Discord API requests with rate-limit (429) protection
async function discordApiFetch(url, options, retries = 3) {
    for (let i = 0; i < retries; i++) {
        const response = await fetch(url, options);
        if (response.status === 429) {
            const data = await response.json();
            const retryAfter = (data.retry_after || 1) * 1000;
            console.warn(`⚠️ Discord Rate Limited. Retrying after ${retryAfter}ms...`);
            await new Promise(resolve => setTimeout(resolve, retryAfter));
            continue;
        }
        return response;
    }
    throw new Error('Exceeded Discord API rate-limit retry attempts.');
}

// Advanced Error Handler: Creates private channel with staff role access and user mention
async function handleFailureNotification(discordUserId, roleId, rawError) {
    const botToken = process.env.DISCORD_BOT_TOKEN;
    const guildId = process.env.DISCORD_SERVER_ID;
    const categoryId = process.env.ERROR_CATEGORY_ID; 
    const staffRoleId = "1529311162183975032"; 

    // 1. Log failure embed to main Discord logging webhook channel
    await sendWebhook({
        title: '❌ Advanced Rank Update Failed',
        color: 0xe74c3c,
        description: `Rank transaction failed for user <@${discordUserId}>.`,
        fields: [
            { name: 'Target Role ID', value: String(roleId), inline: true },
            { name: 'Error Diagnostic', value: `\`\`\`json\n${rawError.substring(0, 400)}\n\`\`\`` }
        ],
        timestamp: new Date().toISOString()
    });

    if (!botToken || !guildId) {
        console.warn('⚠️ DISCORD_BOT_TOKEN or DISCORD_SERVER_ID missing; skipping automated ticket channel creation.');
        return;
    }

    let cleanError = rawError;
    if (!rawError || rawError.includes('500') || rawError.includes('502') || rawError.includes('503') || rawError.includes('504')) {
        cleanError = 'Unknown API error occurred.';
    }

    try {
        // 2. Create private channel with precise role/user overrides
        const createChannelRes = await discordApiFetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
            method: 'POST',
            headers: {
                'Authorization': `Bot ${botToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name: `rank-failed-${discordUserId.slice(-4)}`,
                type: 0, 
                parent_id: categoryId || undefined,
                permission_overwrites: [
                    { id: guildId, type: 0, deny: '1024' },       // Deny @everyone
                    { id: discordUserId, type: 1, allow: '1024' }, // Allow target user
                    { id: staffRoleId, type: 0, allow: '1024' }    // Allow staff role ID
                ]
            })
        });

        const channelData = await createChannelRes.json();
        if (!createChannelRes.ok) throw new Error('Failed to instantiate automated error channel.');

        // 3. Send ping message in the newly created channel
        await discordApiFetch(`https://discord.com/api/v10/channels/${channelData.id}/messages`, {
            method: 'POST',
            headers: {
                'Authorization': `Bot ${botToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                content: `<@${discordUserId}> Your rank update failed for Role ID \`${roleId}\`.\n**Reason:** \`${cleanError}\``
            })
        });

    } catch (err) {
        console.error('Error execution failed during automated ticket generation:', err);
    }
}

// ==========================================
// Routes
// ==========================================
app.get('/', (req, res) => {
    res.status(200).json({ status: 'online', secure: true, engine: 'advanced-proxy-with-guards' });
});

// Main Ranking Endpoint
app.post('/setrank', authenticateRequest, async (req, res) => {
    const { discordUserId, roleId } = req.body;
    const cookie = process.env.ROBLOX_COOKIE;
    const groupId = process.env.GROUP_ID;
    const bloxlinkApiKey = process.env.BLOXLINK_API_KEY;
    const discordServerId = process.env.DISCORD_SERVER_ID;

    if (!cookie || !groupId || !bloxlinkApiKey || !discordServerId) {
        return res.status(500).json({ error: 'Server misconfiguration: Missing environment variables.' });
    }
    if (!discordUserId || !roleId) {
        return res.status(400).json({ error: 'Missing discordUserId or roleId in request body.' });
    }

    // FEATURE 1: Anti-Spam / Cooldown Check
    const now = Date.now();
    if (userCooldowns.has(discordUserId)) {
        const expirationTime = userCooldowns.get(discordUserId) + COOLDOWN_TIME;
        if (now < expirationTime) {
            const timeLeft = Math.ceil((expirationTime - now) / 1000);
            return res.status(429).json({ success: false, error: `Cooldown active. Please wait ${timeLeft}s before trying again.` });
        }
    }
    userCooldowns.set(discordUserId, now);

    let targetRobloxId = null;

    try {
        // Step 1: Resolve Discord User to Roblox ID via Bloxlink V4 API
        const bloxlinkRes = await fetch(`https://api.blox.link/v4/public/guilds/${discordServerId}/discord-to-roblox/${discordUserId}`, {
            headers: { 'Authorization': bloxlinkApiKey }
        });
        
        const bloxlinkData = await bloxlinkRes.json();
        
        if (!bloxlinkRes.ok || !bloxlinkData.robloxID) {
            throw new Error('User is not verified on Bloxlink or not in the server.');
        }

        targetRobloxId = bloxlinkData.robloxID;

        // Step 2: Check current group membership and rank (Group Rank Verification Guard)
        const memberRes = await fetch(`https://groups.roblox.com/v1/groups/${groupId}/users/${targetRobloxId}`);
        if (!memberRes.ok) {
            throw new Error('User is not in the Roblox group or group data could not be fetched.');
        }
        const memberData = await memberRes.json();
        
        // If they don't have a role, they aren't in the group
        if (!memberData.role) {
            throw new Error('Target user is not a member of the Roblox group.');
        }

        const targetRoleIdInt = parseInt(roleId, 10);

        // If they already have this exact role, skip updating to save API limits
        if (memberData.role.id === targetRoleIdInt) {
            return res.status(400).json({ success: false, error: 'User already holds this exact rank.' });
        }

        // Step 3: Fetch Initial CSRF Token from Roblox
        let csrfToken = null;
        const csrfResponse = await fetch('https://auth.roblox.com/v1/logout', {
            method: 'POST',
            headers: { 'Cookie': `.ROBLOSECURITY=${cookie}` }
        });
        csrfToken = csrfResponse.headers.get('x-csrf-token');

        if (!csrfToken) {
            throw new Error('Failed to fetch initial X-CSRF-TOKEN.');
        }

        // Step 4: Core Rank Execution Handler
        const attemptRankUpdate = async (token) => {
            return await fetch(`https://groups.roblox.com/v1/groups/${groupId}/users/${targetRobloxId}`, {
                method: 'PATCH',
                headers: {
                    'Cookie': `.ROBLOSECURITY=${cookie}`,
                    'x-csrf-token': token,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ roleId: targetRoleIdInt })
            });
        };

        // Step 5: First Rank Update Attempt
        let rankResponse = await attemptRankUpdate(csrfToken);

        // Step 6: Handle Stale CSRF Token Auto-Retry (403 Validation Guard)
        if (rankResponse.status === 403 && rankResponse.headers.has('x-csrf-token')) {
            csrfToken = rankResponse.headers.get('x-csrf-token');
            rankResponse = await attemptRankUpdate(csrfToken);
        }

        const responseData = await rankResponse.json().catch(() => ({}));

        // Step 7: Success Handling
        if (rankResponse.ok) {
            await sendWebhook({
                title: '✅ Advanced Rank Update Successful',
                color: 0x2ecc71,
                fields: [
                    { name: 'Discord User', value: `<@${discordUserId}>`, inline: true },
                    { name: 'Roblox ID', value: String(targetRobloxId), inline: true },
                    { name: 'New Role ID', value: String(roleId), inline: true }
                ],
                timestamp: new Date().toISOString()
            });
            return res.status(200).json({ success: true, message: 'User successfully ranked.' });
        }

        throw new Error(JSON.stringify(responseData));

    } catch (error) {
        const errorMessage = error.message || 'Unknown error occurred';
        
        // Trigger advanced failure handling pipeline
        await handleFailureNotification(discordUserId, roleId, errorMessage);

        console.error(`Rank pipeline exception for User ${discordUserId}:`, errorMessage);
        return res.status(500).json({ success: false, error: 'Failed to rank user.', details: errorMessage });
    }
});

app.listen(PORT, () => {
    console.log(`Advanced proxy server running securely on port ${PORT}`);
});
