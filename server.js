const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const noblox = require('noblox.js'); 
const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// Advanced Configuration & State
// ==========================================
const bloxlinkCache = new Map(); 
const CACHE_TTL = 5 * 60 * 1000; 

// Global Error Handlers
process.on('uncaughtException', (err) => {
    console.error('🚨 [FATAL ERROR] Uncaught Exception:', err);
    // Best practice: gracefully restart or exit here in production
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('🚨 [FATAL ERROR] Unhandled Rejection at:', promise, 'reason:', reason);
});

// ==========================================
// Webhook Logging Utility
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
        console.error('❌ [WEBHOOK] Failed to send Discord webhook:', error.message);
    }
}

// ==========================================
// Middleware & Security
// ==========================================
app.use(helmet()); 
app.use(express.json());

// 1. Log Every Incoming Connection
app.use((req, res, next) => {
    console.log(`\n========================================`);
    console.log(`🌐 [NETWORK] Incoming ${req.method} request to ${req.originalUrl}`);
    console.log(`========================================`);
    next();
});

// 2. Rate Limiting with Deep Logging
const limiter = rateLimit({
    windowMs: 60 * 1000, 
    max: 30,
    handler: async (req, res) => {
        console.warn(`⚠️ [RATE LIMIT] Blocked request from IP. Too many requests.`);
        await sendWebhook({
            title: '⏳ Rate Limit Exceeded',
            color: 15844367, 
            description: `A request was blocked for exceeding the rate limit.`,
            timestamp: new Date().toISOString()
        });
        res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
});
app.use(limiter);

// 3. Strict Authentication with Deep Logging
const authenticateRequest = async (req, res, next) => {
    console.log(`🛡️ [AUTH] Verifying API Key...`);
    const providedKey = req.headers['x-api-key'] || req.body.apiKey;
    const expectedKey = process.env.PROXY_API_KEY;

    if (!expectedKey) {
        console.error(`🚨 [AUTH] SERVER MISCONFIGURED: PROXY_API_KEY is not set!`);
        return res.status(500).json({ error: 'Server misconfiguration.' });
    }

    if (providedKey !== expectedKey) {
        console.warn(`🛑 [AUTH] Unauthorized Request! Provided Key: "${providedKey || 'NONE'}"`);
        return res.status(401).json({ error: 'Unauthorized: Invalid API Key.' });
    }

    console.log(`✅ [AUTH] API Key validated successfully.`);
    next();
};

// ==========================================
// Roblox Authentication (Runs on Startup)
// ==========================================
async function startRoblox() {
    console.log(`🤖 [ROBLOX] Initializing Noblox.js...`);
    const cookie = process.env.ROBLOSECURITY;
    if (!cookie) {
        console.error(`🚨 [ROBLOX] ROBLOSECURITY cookie is missing from Environment Variables!`);
        return;
    }
    try {
        const currentUser = await noblox.setCookie(cookie);
        console.log(`✅ [ROBLOX] Successfully logged in as: ${currentUser.UserName} (ID: ${currentUser.UserID})`);
    } catch (err) {
        console.error(`❌ [ROBLOX] Login Failed! Your cookie might be expired or IP-locked.`);
        console.error(`❌ [ROBLOX] Error Details:`, err.message);
    }
}
startRoblox();

// ==========================================
// Routes
// ==========================================
app.get('/', (req, res) => {
    console.log(`🟢 [PING] Uptime ping received.`);
    res.status(200).json({ status: 'online', secure: true });
});

// Main Ranking Endpoint 
app.post('/setrank', authenticateRequest, async (req, res) => {
    console.log(`📦 [PAYLOAD] Request Body Received:`, req.body);

    // CHANGED: Renamed roleId to rankNumber to prevent confusion (see explanation below)
    let { discordUserId, rankNumber } = req.body; 
    const groupId = process.env.GROUP_ID;
    const bloxlinkApiKey = process.env.BLOXLINK_API_KEY;
    const discordServerId = process.env.DISCORD_SERVER_ID;

    // Validate Environment Variables
    if (!groupId || !bloxlinkApiKey || !discordServerId) {
        console.error(`🚨 [ENV] Missing variables! Group: ${!!groupId}, Bloxlink: ${!!bloxlinkApiKey}, ServerID: ${!!discordServerId}`);
        return res.status(500).json({ error: 'Missing critical environment variables.' });
    }

    // Validate Payload
    if (!discordUserId || !rankNumber) {
        console.error(`⚠️ [PAYLOAD] Missing data! discordUserId: ${discordUserId}, rankNumber: ${rankNumber}`);
        return res.status(400).json({ error: 'Missing discordUserId or rankNumber in payload.' });
    }

    // Ensure Discord ID is a string (prevents JS BigInt truncation)
    discordUserId = String(discordUserId);
    let targetRobloxId = null;

    try {
        console.log(`🔍 [BLOXLINK] Checking verification for Discord User: ${discordUserId}`);
        const cacheKey = `${discordServerId}-${discordUserId}`;

        if (bloxlinkCache.has(cacheKey) && bloxlinkCache.get(cacheKey).expires > Date.now()) {
            targetRobloxId = bloxlinkCache.get(cacheKey).robloxId;
            console.log(`⚡ [BLOXLINK] Cache Hit! Roblox ID: ${targetRobloxId}`);
        } else {
            console.log(`🌐 [BLOXLINK] Fetching from API...`);
            const bloxlinkRes = await fetch(`https://api.blox.link/v4/public/guilds/${discordServerId}/discord-to-roblox/${discordUserId}`, {
                headers: { 'Authorization': bloxlinkApiKey } // Make sure your env variable DOES NOT include "Bot " or "Bearer "
            });
            
            // Check for non-200 responses before trying to parse JSON
            if (!bloxlinkRes.ok) {
                const textErr = await bloxlinkRes.text();
                throw new Error(`Bloxlink API Error (${bloxlinkRes.status}): ${textErr}`);
            }

            const bloxlinkData = await bloxlinkRes.json();
            console.log(`📥 [BLOXLINK] API Response Body:`, bloxlinkData);
            
            if (!bloxlinkData.robloxID) {
                throw new Error(`Bloxlink API Error: ${bloxlinkData.error || 'User not verified or not in server'}`);
            }

            targetRobloxId = bloxlinkData.robloxID;
            console.log(`✅ [BLOXLINK] Successfully resolved Roblox ID: ${targetRobloxId}`);
            
            bloxlinkCache.set(cacheKey, {
                robloxId: targetRobloxId,
                expires: Date.now() + CACHE_TTL
            });
        }

        console.log(`👤 [NOBLOX] Fetching Roblox username for ID: ${targetRobloxId}`);
        const playerInfo = await noblox.getPlayerInfo(parseInt(targetRobloxId, 10));
        const robloxUsername = playerInfo.username;
        console.log(`👤 [NOBLOX] Username found: ${robloxUsername}`);

        console.log(`⚙️ [NOBLOX] Attempting to set rank to Rank Number: ${rankNumber}...`);
        
        // NOBLOX REQUIRES THE 1-255 RANK NUMBER, NOT THE ROLESET ID
        await noblox.setRank(parseInt(groupId, 10), parseInt(targetRobloxId, 10), parseInt(rankNumber, 10));
        console.log(`🎉 [NOBLOX] SUCCESS! Ranked ${robloxUsername} to Rank ${rankNumber}`);
        
        await sendWebhook({
            title: '🎉 Rank Update Fully Completed',
            color: 3066993, 
            fields: [
                { name: 'Discord Member', value: `<@${discordUserId}>`, inline: true },
                { name: 'Roblox Account', value: `[${robloxUsername}](https://www.roblox.com/users/${targetRobloxId}/profile)`, inline: true },
                { name: 'Assigned Rank Number', value: `\`${rankNumber}\``, inline: true }
            ],
            timestamp: new Date().toISOString()
        });

        return res.status(200).json({ success: true, message: 'User ranked successfully.' });

    } catch (error) {
        console.error(`❌ [EXECUTION ERROR] Process failed for User ${discordUserId}:`);
        console.error(error.stack || error.message);
        
        await sendWebhook({
            title: '❌ Rank Update Task Failed',
            color: 15158332,
            description: `Attempt to rank Discord User <@${discordUserId}> failed during execution.`,
            fields: [
                { name: 'Error Message', value: `\`\`\`\n${error.message}\n\`\`\``, inline: false }
            ],
            timestamp: new Date().toISOString()
        });

        return res.status(500).json({ success: false, error: 'Failed to rank user.', details: error.message });
    }
});

app.listen(PORT, async () => {
    console.log(`========================================`);
    console.log(`🚀 [SERVER] Host Started on Port ${PORT}`);
    console.log(`========================================`);
});
