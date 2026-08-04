const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const noblox = require('noblox.js'); 
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// Advanced Configuration & State
// ==========================================
const bloxlinkCache = new Map(); 

let proxyConfig = {
    maintenanceMode: false,
    statusMessage: "All systems operational.",
    cacheTTL: 5 * 60 * 1000 // 5 minutes
};

// Global Error Handlers to prevent container crashes
process.on('uncaughtException', (err) => {
    console.error('🚨 [FATAL ERROR] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('🚨 [FATAL ERROR] Unhandled Rejection at:', promise, 'reason:', reason);
});

// ==========================================
// Advanced Webhook System
// ==========================================
async function sendWebhook(type, title, description, fields = []) {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) return;

    const colors = {
        SUCCESS: 3066993,  // Green
        ERROR: 15158332,   // Red
        WARNING: 16776960, // Yellow
        INFO: 3447003      // Blue
    };

    const embed = {
        title: title,
        description: description,
        color: colors[type] || colors.INFO,
        fields: fields,
        timestamp: new Date().toISOString(),
        footer: { text: 'Roblox Proxy System v2.0' }
    };

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

// Maintenance Mode Interceptor
app.use((req, res, next) => {
    if (proxyConfig.maintenanceMode && req.path !== '/' && req.path !== '/health' && req.path !== '/config' && req.path !== '/dashboard') {
        return res.status(503).json({ 
            error: 'Proxy is currently in maintenance mode.',
            message: proxyConfig.statusMessage 
        });
    }
    next();
});

// Logging Middleware
app.use((req, res, next) => {
    console.log(`🌐 [NETWORK] ${req.method} request incoming to ${req.originalUrl}`);
    next();
});

// Rate Limiting
const limiter = rateLimit({
    windowMs: 60 * 1000, 
    max: 45,
    handler: async (req, res) => {
        console.warn(`⚠️ [RATE LIMIT] Blocked IP for excessive requests.`);
        await sendWebhook('WARNING', '⏳ Rate Limit Exceeded', 'An IP address was throttled for exceeding request limits.');
        res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
});
app.use(limiter);

// Strict Authentication Middleware
const authenticateRequest = async (req, res, next) => {
    const providedKey = req.headers['x-api-key'] || req.body.apiKey;
    const expectedKey = process.env.PROXY_API_KEY;

    if (!expectedKey) {
        console.error(`🚨 [AUTH] SERVER MISCONFIGURED: PROXY_API_KEY is not set!`);
        return res.status(500).json({ error: 'Server misconfiguration: API key not defined.' });
    }

    if (!providedKey || providedKey !== expectedKey) {
        console.warn(`🛑 [AUTH] Unauthorized Request attempt detected.`);
        return res.status(401).json({ error: 'Unauthorized: Invalid or missing API Key.' });
    }

    next();
};

// ==========================================
// Roblox Authentication (Runs on Startup)
// ==========================================
async function startRoblox() {
    console.log(`🤖 [ROBLOX] Initializing Noblox session...`);
    const cookie = process.env.ROBLOSECURITY;
    if (!cookie) {
        console.error(`🚨 [ROBLOX] CRITICAL: ROBLOSECURITY cookie missing from environment variables!`);
        return;
    }
    try {
        const currentUser = await noblox.setCookie(cookie);
        console.log(`✅ [ROBLOX] Authenticated successfully as: ${currentUser.UserName} (ID: ${currentUser.UserID})`);
    } catch (err) {
        console.error(`❌ [ROBLOX] Authentication Failed! Cookie may be expired or invalid.`);
        console.error(`❌ [ROBLOX] Details:`, err.message);
    }
}
startRoblox();

// ==========================================
// System Routes
// ==========================================
app.get('/', (req, res) => {
    res.status(200).json({ status: 'online', service: 'Roblox Management Proxy' });
});

app.get('/health', async (req, res) => {
    try {
        const currentUser = await noblox.getCurrentUser();
        const memoryUsage = Math.round(process.memoryUsage().rss / 1024 / 1024);

        if (!currentUser) throw new Error("Session expired.");

        res.status(200).json({
            status: 'operational',
            robloxConnection: 'healthy',
            botUsername: currentUser.UserName,
            uptimeSeconds: Math.floor(process.uptime()),
            memoryUsageMB: memoryUsage,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(503).json({
            status: 'degraded',
            robloxConnection: 'offline',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Serve Web Dashboard
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Config GET & POST
app.get('/config', authenticateRequest, (req, res) => {
    res.status(200).json(proxyConfig);
});

app.post('/config', authenticateRequest, async (req, res) => {
    const { maintenanceMode, statusMessage, cacheTTL } = req.body;

    if (typeof maintenanceMode !== 'undefined') proxyConfig.maintenanceMode = maintenanceMode;
    if (typeof statusMessage !== 'undefined') proxyConfig.statusMessage = statusMessage;
    if (typeof cacheTTL !== 'undefined') proxyConfig.cacheTTL = cacheTTL;

    await sendWebhook('WARNING', '🎛️ Proxy Config Updated', `**Maintenance:** ${proxyConfig.maintenanceMode}\n**Message:** ${proxyConfig.statusMessage}`);
    res.status(200).json({ success: true, newConfig: proxyConfig });
});

// ==========================================
// Action Endpoints
// ==========================================

// 1. Set Rank via Discord ID (Bloxlink)
app.post('/setrank', authenticateRequest, async (req, res) => {
    let { discordUserId, rankNumber } = req.body; 
    const groupId = process.env.GROUP_ID;
    const bloxlinkApiKey = process.env.BLOXLINK_API_KEY;
    const discordServerId = process.env.DISCORD_SERVER_ID;

    if (!groupId || !bloxlinkApiKey || !discordServerId) {
        return res.status(500).json({ error: 'Missing critical environment variables on server.' });
    }
    if (!discordUserId || !rankNumber) {
        return res.status(400).json({ error: 'Missing discordUserId or rankNumber parameters.' });
    }

    discordUserId = String(discordUserId);

    try {
        let targetRobloxId = null;
        const cacheKey = `${discordServerId}-${discordUserId}`;

        if (bloxlinkCache.has(cacheKey) && bloxlinkCache.get(cacheKey).expires > Date.now()) {
            targetRobloxId = bloxlinkCache.get(cacheKey).robloxId;
        } else {
            const bloxlinkRes = await fetch(`https://api.blox.link/v4/public/guilds/${discordServerId}/discord-to-roblox/${discordUserId}`, {
                headers: { 'Authorization': bloxlinkApiKey } 
            });
            
            if (!bloxlinkRes.ok) throw new Error(`Bloxlink API error status: ${bloxlinkRes.status}`);

            const bloxlinkData = await bloxlinkRes.json();
            if (!bloxlinkData.robloxID) throw new Error('User not verified with Bloxlink in this server.');

            targetRobloxId = bloxlinkData.robloxID;
            bloxlinkCache.set(cacheKey, { robloxId: targetRobloxId, expires: Date.now() + proxyConfig.cacheTTL });
        }

        const playerInfo = await noblox.getPlayerInfo(parseInt(targetRobloxId, 10));
        
        // Smart Ranks Check
        const botId = await noblox.getCurrentUser().then(u => u.UserID);
        const botRank = await noblox.getRankInGroup(parseInt(groupId, 10), botId);
        const targetCurrentRank = await noblox.getRankInGroup(parseInt(groupId, 10), parseInt(targetRobloxId, 10));
        const desiredRank = parseInt(rankNumber, 10);

        if (targetCurrentRank === desiredRank) {
            return res.status(200).json({ success: true, message: 'User is already at this specific rank.' });
        }
        if (targetCurrentRank >= botRank || desiredRank >= botRank) {
            return res.status(400).json({ error: 'Permission Error: Cannot alter ranking for users matching or exceeding bot permissions.' });
        }

        await noblox.setRank(parseInt(groupId, 10), parseInt(targetRobloxId, 10), desiredRank);
        
        await sendWebhook('SUCCESS', '🎉 Rank Update Complete', null, [
            { name: 'Discord Member', value: `<@${discordUserId}>`, inline: true },
            { name: 'Roblox User', value: playerInfo.username, inline: true },
            { name: 'New Rank', value: `\`${rankNumber}\``, inline: true }
        ]);

        return res.status(200).json({ success: true, message: `Successfully ranked ${playerInfo.username}.` });
    } catch (error) {
        await sendWebhook('ERROR', '❌ Rank Modification Failed', error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// 2. Manual Set Rank via Roblox ID
app.post('/setrank-manual', authenticateRequest, async (req, res) => {
    const { robloxId, rankNumber } = req.body;
    const groupId = process.env.GROUP_ID;

    if (!robloxId || !rankNumber) return res.status(400).json({ error: 'Missing robloxId or rankNumber.' });

    try {
        const playerInfo = await noblox.getPlayerInfo(parseInt(robloxId, 10));
        const botId = await noblox.getCurrentUser().then(u => u.UserID);
        const botRank = await noblox.getRankInGroup(parseInt(groupId, 10), botId);
        const targetCurrentRank = await noblox.getRankInGroup(parseInt(groupId, 10), parseInt(robloxId, 10));
        const desiredRank = parseInt(rankNumber, 10);

        if (targetCurrentRank === desiredRank) return res.status(200).json({ success: true, message: 'User is already at this rank.' });
        if (targetCurrentRank >= botRank || desiredRank >= botRank) return res.status(400).json({ error: 'Permission denied by hierarchy rules.' });

        await noblox.setRank(parseInt(groupId, 10), parseInt(robloxId, 10), desiredRank);
        await sendWebhook('SUCCESS', '💻 Manual Dashboard Rank', `Ranked **${playerInfo.username}** to rank \`${rankNumber}\`.`);
        
        res.status(200).json({ success: true, message: `Successfully updated rank for ${playerInfo.username}.` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 3. Shout Endpoint
app.post('/shout', authenticateRequest, async (req, res) => {
    const { message } = req.body;
    const groupId = process.env.GROUP_ID;

    if (!message) return res.status(400).json({ error: 'Missing shout text content.' });

    try {
        await noblox.shout(parseInt(groupId, 10), message);
        await sendWebhook('INFO', '📢 Group Shout Posted', `**Content:**\n${message}`);
        res.status(200).json({ success: true, message: 'Shout updated successfully.' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 4. Exile Endpoint
app.post('/exile', authenticateRequest, async (req, res) => {
    const { robloxId } = req.body;
    const groupId = process.env.GROUP_ID;

    if (!robloxId) return res.status(400).json({ error: 'Missing target robloxId.' });

    try {
        await noblox.exile(parseInt(groupId, 10), parseInt(robloxId, 10));
        await sendWebhook('WARNING', '👢 User Exiled', `Roblox ID **${robloxId}** was removed from the group.`);
        res.status(200).json({ success: true, message: 'User exiled successfully.' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 5. Join Requests Endpoint
app.post('/handle-join-request', authenticateRequest, async (req, res) => {
    const { robloxId, action } = req.body; 
    const groupId = process.env.GROUP_ID;

    if (!robloxId || !['Accept', 'Decline'].includes(action)) {
        return res.status(400).json({ error: "Invalid parameters. Action must be 'Accept' or 'Decline'." });
    }

    try {
        const acceptBool = action === 'Accept';
        await noblox.handleJoinRequest(parseInt(groupId, 10), parseInt(robloxId, 10), acceptBool);
        await sendWebhook('SUCCESS', `🚪 Join Request ${action}ed`, `Processed request for user ID: ${robloxId}`);
        res.status(200).json({ success: true, message: `Join request successfully ${action.toLowerCase()}ed.` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// Start Server
// ==========================================
app.listen(PORT, () => {
    console.log(`========================================`);
    console.log(`🚀 [SERVER] Live and running on Port ${PORT}`);
    console.log(`========================================`);
});
