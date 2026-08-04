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

// Global Proxy Configuration State (Dashboard)
let proxyConfig = {
    maintenanceMode: false,
    statusMessage: "All systems operational.",
    cacheTTL: 5 * 60 * 1000 // 5 minutes
};

// Global Error Handlers
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

    // Define color codes based on the event type
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
        footer: { text: 'Roblox Proxy System' }
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
    // Allow the ping, health, and config routes to bypass maintenance
    if (proxyConfig.maintenanceMode && req.path !== '/' && req.path !== '/health' && req.path !== '/config' && req.path !== '/dashboard') {
        return res.status(503).json({ 
            error: 'Proxy is currently in maintenance mode.',
            message: proxyConfig.statusMessage 
        });
    }
    next();
});

// Log Every Incoming Connection
app.use((req, res, next) => {
    console.log(`\n========================================`);
    console.log(`🌐 [NETWORK] Incoming ${req.method} request to ${req.originalUrl}`);
    console.log(`========================================`);
    next();
});

// Rate Limiting
const limiter = rateLimit({
    windowMs: 60 * 1000, 
    max: 30,
    handler: async (req, res) => {
        console.warn(`⚠️ [RATE LIMIT] Blocked request. Too many requests.`);
        await sendWebhook('WARNING', '⏳ Rate Limit Exceeded', 'A request was blocked for exceeding the rate limit.');
        res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
});
app.use(limiter);

// Strict Authentication
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
// Utility Routes (Status, Health & Dashboard)
// ==========================================
app.get('/', (req, res) => {
    console.log(`🟢 [PING] Uptime ping received.`);
    res.status(200).json({ status: 'online', secure: true });
});

app.get('/health', async (req, res) => {
    try {
        const currentUser = await noblox.getCurrentUser();
        const memoryUsage = Math.round(process.memoryUsage().rss / 1024 / 1024);

        if (!currentUser) throw new Error("Roblox session expired or invalid.");

        res.status(200).json({
            status: 'operational',
            robloxConnection: 'healthy',
            botUsername: currentUser.UserName,
            uptimeSeconds: Math.floor(process.uptime()),
            memoryUsageMB: memoryUsage,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('🚨 [HEALTH CHECK] Failed:', error.message);
        res.status(503).json({
            status: 'degraded',
            robloxConnection: 'offline',
            error: 'Bot lost connection to Roblox. Check cookie.',
            timestamp: new Date().toISOString()
        });
    }
});

// Serve the Web Dashboard HTML file
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// 🎛️ GET: View Current Config
app.get('/config', authenticateRequest, (req, res) => {
    res.status(200).json(proxyConfig);
});

// 🎛️ POST: Update Config Live
app.post('/config', authenticateRequest, async (req, res) => {
    const { maintenanceMode, statusMessage, cacheTTL } = req.body;

    if (typeof maintenanceMode !== 'undefined') proxyConfig.maintenanceMode = maintenanceMode;
    if (typeof statusMessage !== 'undefined') proxyConfig.statusMessage = statusMessage;
    if (typeof cacheTTL !== 'undefined') proxyConfig.cacheTTL = cacheTTL;

    await sendWebhook('WARNING', '🎛️ Proxy Configuration Changed', `**Maintenance Mode:** ${proxyConfig.maintenanceMode}\n**Message:** ${proxyConfig.statusMessage}`);
    
    res.status(200).json({ success: true, newConfig: proxyConfig });
});

// ==========================================
// Main Group Management Routes
// ==========================================

// 📈 POST: Set Rank via Discord / Bloxlink
app.post('/setrank', authenticateRequest, async (req, res) => {
    console.log(`📦 [PAYLOAD] Request Body Received:`, req.body);

    let { discordUserId, rankNumber } = req.body; 
    const groupId = process.env.GROUP_ID;
    const bloxlinkApiKey = process.env.BLOXLINK_API_KEY;
    const discordServerId = process.env.DISCORD_SERVER_ID;

    if (!groupId || !bloxlinkApiKey || !discordServerId) {
        console.error(`🚨 [ENV] Missing variables!`);
        return res.status(500).json({ error: 'Missing critical environment variables.' });
    }

    if (!discordUserId || !rankNumber) {
        return res.status(400).json({ error: 'Missing discordUserId or rankNumber in payload.' });
    }

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
                headers: { 'Authorization': bloxlinkApiKey } 
            });
            
            if (!bloxlinkRes.ok) {
                const textErr = await bloxlinkRes.text();
                throw new Error(`Bloxlink API Error (${bloxlinkRes.status}): ${textErr}`);
            }

            const bloxlinkData = await bloxlinkRes.json();
            if (!bloxlinkData.robloxID) {
                throw new Error(`Bloxlink API Error: ${bloxlinkData.error || 'User not verified or not in server'}`);
            }

            targetRobloxId = bloxlinkData.robloxID;
            bloxlinkCache.set(cacheKey, { robloxId: targetRobloxId, expires: Date.now() + proxyConfig.cacheTTL });
        }

        const playerInfo = await noblox.getPlayerInfo(parseInt(targetRobloxId, 10));
        const robloxUsername = playerInfo.username;

        // --- SMART RANKING ENGINE ---
        console.log(`🧠 [SMART RANK] Running pre-checks...`);
        const botId = await noblox.getCurrentUser().then(u => u.UserID);
        const botRank = await noblox.getRankInGroup(parseInt(groupId, 10), botId);
        const targetCurrentRank = await noblox.getRankInGroup(parseInt(groupId, 10), parseInt(targetRobloxId, 10));
        const desiredRank = parseInt(rankNumber, 10);

        if (targetCurrentRank === desiredRank) {
            console.log(`⚠️ [SMART RANK] Skipped. User is already Rank ${desiredRank}.`);
            return res.status(200).json({ success: true, message: 'User is already at this rank. No action taken.' });
        }

        if (targetCurrentRank >= botRank) {
            throw new Error(`Permission Denied: Target outranks or equals the bot (Bot: ${botRank}, Target: ${targetCurrentRank}).`);
        }
        if (desiredRank >= botRank) {
            throw new Error(`Permission Denied: Cannot promote someone to a rank equal/higher than the bot.`);
        }

        console.log(`⚙️ [NOBLOX] Pre-checks passed. Executing rank change...`);
        await noblox.setRank(parseInt(groupId, 10), parseInt(targetRobloxId, 10), desiredRank);
        console.log(`🎉 [NOBLOX] SUCCESS! Ranked ${robloxUsername} to Rank ${rankNumber}`);
        
        await sendWebhook('SUCCESS', '🎉 Rank Update Fully Completed', null, [
            { name: 'Discord Member', value: `<@${discordUserId}>`, inline: true },
            { name: 'Roblox Account', value: `[${robloxUsername}](https://www.roblox.com/users/${targetRobloxId}/profile)`, inline: true },
            { name: 'Assigned Rank Number', value: `\`${rankNumber}\``, inline: true }
        ]);

        return res.status(200).json({ success: true, message: 'User ranked successfully.' });

    } catch (error) {
        console.error(`❌ [EXECUTION ERROR] Process failed for User ${discordUserId}:`, error.message);
        
        await sendWebhook('ERROR', '❌ Rank Update Task Failed', `Attempt to rank Discord User <@${discordUserId}> failed.`, [
            { name: 'Error Message', value: `\`\`\`\n${error.message}\n\`\`\``, inline: false }
        ]);

        return res.status(500).json({ success: false, error: 'Failed to rank user.', details: error.message });
    }
});

// 📈 POST: Set Rank Manually (For Web Dashboard - Direct Roblox ID)
app.post('/setrank-manual', authenticateRequest, async (req, res) => {
    const { robloxId, rankNumber } = req.body;
    const groupId = process.env.GROUP_ID;

    if (!robloxId || !rankNumber) {
        return res.status(400).json({ error: 'Missing robloxId or rankNumber.' });
    }

    try {
        const playerInfo = await noblox.getPlayerInfo(parseInt(robloxId, 10));
        
        // Smart checks for manual web ranking
        const botId = await noblox.getCurrentUser().then(u => u.UserID);
        const botRank = await noblox.getRankInGroup(parseInt(groupId, 10), botId);
        const targetCurrentRank = await noblox.getRankInGroup(parseInt(groupId, 10), parseInt(robloxId, 10));
        const desiredRank = parseInt(rankNumber, 10);

        if (targetCurrentRank === desiredRank) {
            return res.status(200).json({ success: true, message: 'User is already at this rank.' });
        }
        if (targetCurrentRank >= botRank || desiredRank >= botRank) {
            return res.status(400).json({ error: 'Permission Denied: Cannot rank user higher than or equal to the bot.' });
        }

        await noblox.setRank(parseInt(groupId, 10), parseInt(robloxId, 10), desiredRank);
        
        await sendWebhook('SUCCESS', '💻 Web Dashboard Rank Update', `Manually ranked **${playerInfo.username}** to Rank \`${rankNumber}\`.`);
        res.status(200).json({ success: true, message: `Ranked ${playerInfo.username} successfully.` });
    } catch (error) {
        res.status(500).json({ error: 'Failed to rank user.', details: error.message });
    }
});

// 📢 POST: Group Shout
app.post('/shout', authenticateRequest, async (req, res) => {
    const { message } = req.body;
    const groupId = process.env.GROUP_ID;

    if (!message) return res.status(400).json({ error: 'Missing shout message.' });

    try {
        await noblox.shout(parseInt(groupId, 10), message);
        await sendWebhook('INFO', '📢 Group Shout Updated', `**New Shout:**\n${message}`);
        res.status(200).json({ success: true, message: 'Shout posted successfully.' });
    } catch (error) {
        await sendWebhook('ERROR', '❌ Shout Failed', error.message);
        res.status(500).json({ error: 'Failed to post shout.' });
    }
});

// 👢 POST: Exile User
app.post('/exile', authenticateRequest, async (req, res) => {
    const { robloxId } = req.body;
    const groupId = process.env.GROUP_ID;

    if (!robloxId) return res.status(400).json({ error: 'Missing robloxId.' });

    try {
        await noblox.exile(parseInt(groupId, 10), parseInt(robloxId, 10));
        await sendWebhook('WARNING', '👢 User Exiled', `Roblox ID **${robloxId}** was exiled from the group.`);
        res.status(200).json({ success: true, message: 'User exiled successfully.' });
    } catch (error) {
        await sendWebhook('ERROR', '❌ Exile Failed', error.message);
        res.status(500).json({ error: 'Failed to exile user.' });
    }
});

// 🚪 POST: Handle Join Request (Accept/Decline)
app.post('/handle-join-request', authenticateRequest, async (req, res) => {
    const { robloxId, action } = req.body; 
    const groupId = process.env.GROUP_ID;

    if (!robloxId || !['Accept', 'Decline'].includes(action)) {
        return res.status(400).json({ error: "Missing robloxId or invalid action (must be 'Accept' or 'Decline')." });
    }

    try {
        const actionBoolean = action === 'Accept';
        await noblox.handleJoinRequest(parseInt(groupId, 10), parseInt(robloxId, 10), actionBoolean);
        
        await sendWebhook('SUCCESS', `🚪 Join Request ${action}ed`, `Processed join request for Roblox ID **${robloxId}**.`);
        res.status(200).json({ success: true, message: `User join request ${action.toLowerCase()}ed.` });
    } catch (error) {
        await sendWebhook('ERROR', '❌ Join Request Handling Failed', error.message);
        res.status(500).json({ error: 'Failed to handle join request.' });
    }
});

// ==========================================
// Start Server
// ==========================================
app.listen(PORT, async () => {
    console.log(`========================================`);
    console.log(`🚀 [SERVER] Host Started on Port ${PORT}`);
    console.log(`========================================`);
});
