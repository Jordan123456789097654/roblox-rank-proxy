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

const userCooldowns = new Map();
const ticketOwners = new Map(); // Tracks staff claims
const COOLDOWN_TIME = 60 * 1000;

app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] [ULTIMATE PROXY] ${req.method} request received at ${req.originalUrl}`);
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

async function handleFailureNotification(discordUserId, roleId, rawError) {
    const botToken = process.env.DISCORD_BOT_TOKEN;
    const guildId = process.env.DISCORD_SERVER_ID;
    const categoryId = process.env.ERROR_CATEGORY_ID; 
    const staffRoleId = "1529311162183975032"; 

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

    if (!botToken || !guildId) {
        console.warn('⚠️ DISCORD_BOT_TOKEN or DISCORD_SERVER_ID missing; skipping ticket routing.');
        return;
    }

    let cleanError = rawError;
    if (!rawError || rawError.includes('500') || rawError.includes('502') || rawError.includes('503') || rawError.includes('504')) {
        cleanError = 'Unknown API error occurred.';
    }

    try {
        const channelsRes = await discordApiFetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
            headers: { 'Authorization': `Bot ${botToken}` }
        });
        const channels = await channelsRes.json();
        
        const expectedChannelName = `rank-failed-${discordUserId.slice(-4)}`;
        let existingChannel = channels.find(c => c.name === expectedChannelName && c.type === 0);

        const actionRow1 = {
            type: 1,
            components: [
                { type: 2, style: 1, custom_id: `ticket_claim_${discordUserId}`, label: 'Claim' },
                { type: 2, style: 2, custom_id: `ticket_rename_${discordUserId}`, label: 'Rename' },
                { type: 2, style: 2, custom_id: `ticket_add_${discordUserId}`, label: 'Add User' },
                { type: 2, style: 4, custom_id: `ticket_delete_${discordUserId}`, label: 'Delete' }
            ]
        };

        const actionRow2 = {
            type: 1,
            components: [
                { type: 2, style: 2, custom_id: `ticket_getinfo_${discordUserId}`, label: 'Get Info' },
                { type: 2, style: 3, custom_id: `ticket_retry_${discordUserId}_${roleId}`, label: 'Retry Rank' }
            ]
        };

        let targetChannelId;

        if (existingChannel) {
            targetChannelId = existingChannel.id;
        } else {
            const createChannelRes = await discordApiFetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bot ${botToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    name: expectedChannelName,
                    type: 0, 
                    parent_id: categoryId || undefined,
                    permission_overwrites: [
                        { id: guildId, type: 0, deny: '1024' },       
                        { id: discordUserId, type: 1, allow: '1024' }, 
                        { id: staffRoleId, type: 0, allow: '1024' }    
                    ]
                })
            });

            const channelData = await createChannelRes.json();
            if (!createChannelRes.ok) throw new Error('Failed to instantiate automated error channel.');
            targetChannelId = channelData.id;
        }

        await discordApiFetch(`https://discord.com/api/v10/channels/${targetChannelId}/messages`, {
            method: 'POST',
            headers: {
                'Authorization': `Bot ${botToken}`,
                'Content-Type': 'application/json'
            },
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
// Core Ranking Execution Function (Reusable)
// ==========================================
async function executeRobloxRanking(discordUserId, roleId) {
    const cookie = process.env.ROBLOX_COOKIE;
    const groupId = process.env.GROUP_ID;
    const bloxlinkApiKey = process.env.BLOXLINK_API_KEY;
    const discordServerId = process.env.DISCORD_SERVER_ID;

    if (!cookie || !groupId || !bloxlinkApiKey || !discordServerId) {
        throw new Error('Server misconfiguration: Missing environment variables.');
    }

    const bloxlinkRes = await fetch(`https://api.blox.link/v4/public/guilds/${discordServerId}/discord-to-roblox/${discordUserId}`, {
        headers: { 'Authorization': bloxlinkApiKey }
    });
    
    const bloxlinkData = await bloxlinkRes.json();
    
    if (!bloxlinkRes.ok || !bloxlinkData.robloxID) {
        throw new Error('User is not verified on Bloxlink or not in the server.');
    }

    const targetRobloxId = bloxlinkData.robloxID;

    const memberRes = await fetch(`https://groups.roblox.com/v1/groups/${groupId}/users/${targetRobloxId}`);
    if (!memberRes.ok) {
        throw new Error('User is not in the Roblox group or group data could not be fetched.');
    }
    const memberData = await memberRes.json();
    
    if (!memberData.role) {
        throw new Error('Target user is not a member of the Roblox group.');
    }

    const targetRoleIdInt = parseInt(roleId, 10);

    if (memberData.role.id === targetRoleIdInt) {
        throw new Error('User already holds this exact rank.');
    }

    let csrfToken = null;
    const csrfResponse = await fetch('https://auth.roblox.com/v1/logout', {
        method: 'POST',
        headers: { 'Cookie': `.ROBLOSECURITY=${cookie}` }
    });
    csrfToken = csrfResponse.headers.get('x-csrf-token');

    if (!csrfToken) {
        throw new Error('Failed to fetch initial X-CSRF-TOKEN.');
    }

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

    let rankResponse = await attemptRankUpdate(csrfToken);

    if (rankResponse.status === 403 && rankResponse.headers.has('x-csrf-token')) {
        csrfToken = rankResponse.headers.get('x-csrf-token');
        rankResponse = await attemptRankUpdate(csrfToken);
    }

    const responseData = await rankResponse.json().catch(() => ({}));

    if (rankResponse.ok) {
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
    }

    throw new Error(JSON.stringify(responseData));
}

// ==========================================
// Routes
// ==========================================
app.get('/', (req, res) => {
    res.status(200).json({ status: 'online', secure: true, engine: 'single-webhook-ticket-reuse' });
});

// Main Ranking Endpoint
app.post('/setrank', authenticateRequest, async (req, res) => {
    const { discordUserId, roleId } = req.body;

    if (!discordUserId || !roleId) {
        return res.status(400).json({ error: 'Missing discordUserId or roleId in request body.' });
    }

    const now = Date.now();
    if (userCooldowns.has(discordUserId)) {
        const expirationTime = userCooldowns.get(discordUserId) + COOLDOWN_TIME;
        if (now < expirationTime) {
            const timeLeft = Math.ceil((expirationTime - now) / 1000);
            return res.status(429).json({ success: false, error: `Cooldown active. Please wait ${timeLeft}s before trying again.` });
        }
    }
    userCooldowns.set(discordUserId, now);

    try {
        await executeRobloxRanking(discordUserId, roleId);
        return res.status(200).json({ success: true, message: 'User successfully ranked.' });
    } catch (error) {
        const errorMessage = error.message || 'Unknown error occurred';
        await handleFailureNotification(discordUserId, roleId, errorMessage);

        console.error(`Rank pipeline exception for User ${discordUserId}:`, errorMessage);
        return res.status(500).json({ success: false, error: 'Failed to rank user.', details: errorMessage });
    }
});

// Interactive Ticket Management Button Endpoint
app.post('/discord-interactions', async (req, res) => {
    const interaction = req.body;
    
    if (interaction.type === 1) {
        return res.json({ type: 1 });
    }

    if (interaction.type === 3) { 
        const customId = interaction.data.custom_id;
        const channelId = interaction.channel.id;
        const staffUserId = interaction.member.user.id;
        const botToken = process.env.DISCORD_BOT_TOKEN;

        // 1. Claim Button
        if (customId.startsWith('ticket_claim_')) {
            ticketOwners.set(channelId, staffUserId);
            return res.json({
                type: 4,
                data: { content: `🔒 Ticket successfully claimed by <@${staffUserId}>!`, flags: 64 }
            });
        }

        // 2. Delete Button
        if (customId.startsWith('ticket_delete_')) {
            // Respond first to acknowledge, then perform async delete
            res.json({ type: 4, data: { content: '🗑️ Deleting ticket channel...', flags: 64 } });
            try {
                await discordApiFetch(`https://discord.com/api/v10/channels/${channelId}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bot ${botToken}` }
                });
            } catch (err) {
                console.error('Failed to delete channel:', err);
            }
            return;
        }

        // 3. Get Info Button
        if (customId.startsWith('ticket_getinfo_')) {
            const targetUser = customId.split('_')[2];
            return res.json({
                type: 4,
                data: { 
                    content: `📊 **Ticket Diagnostics:**\n- Target Discord User ID: \`${targetUser}\`\n- Claimed By: ${ticketOwners.get(channelId) ? `<@${ticketOwners.get(channelId)}>` : 'Unclaimed'}\n- Channel ID: \`${channelId}\``, 
                    flags: 64 
                }
            });
        }

        // 4. Rename Button (Appends '-handled' or similar to channel)
        if (customId.startsWith('ticket_rename_')) {
            res.json({ type: 4, data: { content: '✏️ Renaming channel...', flags: 64 } });
            try {
                await discordApiFetch(`https://discord.com/api/v10/channels/${channelId}`, {
                    method: 'PATCH',
                    headers: {
                        'Authorization': `Bot ${botToken}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ name: `resolved-${channelId.slice(-4)}` })
                });
            } catch (err) {
                console.error('Failed to rename channel:', err);
            }
            return;
        }

        // 5. Add User Button (Instructs staff how to add users)
        if (customId.startsWith('ticket_add_')) {
            return res.json({
                type: 4,
                data: { 
                    content: `➕ To add another user or staff member to this ticket, type \`/add @username\` or modify channel permissions directly.`, 
                    flags: 64 
                }
            });
        }

        // 6. Retry Rank Button (Format: ticket_retry_DISCORDID_ROLEID)
        if (customId.startsWith('ticket_retry_')) {
            const parts = customId.split('_');
            const discordUserId = parts[2];
            const roleId = parts[3];

            // Acknowledge interaction immediately so Discord doesn't timeout
            res.json({ 
                type: 4, 
                data: { content: `🔄 Retrying rank assignment for Role ID \`${roleId}\`... Please wait.`, flags: 64 } 
            });

            try {
                await executeRobloxRanking(discordUserId, roleId);
                // Send success message into the ticket channel
                await discordApiFetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bot ${botToken}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ content: `✅ **Retry Successful!** <@${discordUserId}> has been successfully ranked. You may now close this ticket.` })
                });
            } catch (err) {
                // Send failure error message into the ticket channel
                await discordApiFetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bot ${botToken}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ content: `❌ **Retry Failed:** \`${err.message}\`` })
                });
            }
            return;
        }

        return res.json({ type: 4, data: { content: '⚠️ Action acknowledged by proxy server.', flags: 64 } });
    }

    res.status(400).json({ error: 'Invalid interaction type.' });
});

app.listen(PORT, () => {
    console.log(`Single webhook ticket-reuse proxy server running on port ${PORT}`);
});
