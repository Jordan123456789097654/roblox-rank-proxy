const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const noblox = require('noblox.js'); 
const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// Advanced Configuration & State
// ==========================================
// We cache Bloxlink requests for 5 minutes to prevent rate-limiting during high traffic
const bloxlinkCache = new Map(); 
const CACHE_TTL = 5 * 60 * 1000; 

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

app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
    next();
});

const authenticateRequest = (req, res, next) => {
    const providedKey = req.headers['x-api-key'] || req.body.apiKey;
    const expectedKey = process.env.PROXY_API_KEY;

    if (!expectedKey) {
        return res.status(500).json({ error: 'Server misconfiguration.' });
    }
    if (providedKey !== expectedKey) {
        return res.status(401).json({ error: 'Unauthorized: Invalid API Key.' });
    }
    next();
};

// ==========================================
// Roblox Authentication (Runs on Startup)
// ==========================================
async function startRoblox() {
    const cookie = process.env.ROBLOSECURITY;
    if (!cookie) {
        console.error("⚠️ ROBLOSECURITY cookie is missing from Environment Variables!");
        return;
    }
    try {
        const currentUser = await noblox.setCookie(cookie);
        console.log(`✅ Successfully logged into Roblox as ${currentUser.UserName} (${currentUser.UserID})`);
    } catch (err) {
        console.error("❌ Failed to log into Roblox. Is your cookie valid?", err.message);
    }
}
startRoblox();

// ==========================================
// Routes
// ==========================================
app.get('/', (req, res) => {
    res.status(200).json({ status: 'online', secure: true });
});

// Main Ranking Endpoint 
app.post('/setrank', authenticateRequest, async (req, res) => {
    const { discordUserId, roleId } = req.body;
    const groupId = process.env.GROUP_ID;
    const bloxlinkApiKey = process.env.BLOXLINK_API_KEY;
    const discordServerId = process.env.DISCORD_SERVER_ID;

    if (!groupId || !bloxlinkApiKey || !discordServerId) {
        return res.status(500).json({ error: 'Missing critical environment variables.' });
    }
    if (!discordUserId || !roleId) {
        return res.status(400).json({ error: 'Missing discordUserId or roleId in payload.' });
    }

    let targetRobloxId = null;

    try {
        // 1. Advanced Bloxlink Resolution with Caching
        const cacheKey = `${discordServerId}-${discordUserId}`;
        if (bloxlinkCache.has(cacheKey) && bloxlinkCache.get(cacheKey).expires > Date.now()) {
            targetRobloxId = bloxlinkCache.get(cacheKey).robloxId;
            console.log(`[Cache Hit] Resolved Discord ${discordUserId} to Roblox ${targetRobloxId}`);
        } else {
            const bloxlinkRes = await fetch(`https://api.blox.link/v4/public/guilds/${discordServerId}/discord-to-roblox/${discordUserId}`, {
                headers: { 'Authorization': bloxlinkApiKey }
            });
            
            const bloxlinkData = await bloxlinkRes.json();
            
            if (!bloxlinkRes.ok || !bloxlinkData.robloxID) {
                throw new Error('User is not verified on Bloxlink or not in the server.');
            }

            targetRobloxId = bloxlinkData.robloxID;
            
            // Save to cache
            bloxlinkCache.set(cacheKey, {
                robloxId: targetRobloxId,
                expires: Date.now() + CACHE_TTL
            });
        }

        // 2. Execute Rank Update via Noblox (Automatically handles CSRF)
        await noblox.setRank(parseInt(groupId, 10), parseInt(targetRobloxId, 10), parseInt(roleId, 10));
        
        console.log(`✅ Successfully ranked Roblox ID ${targetRobloxId} to Role ID ${roleId}`);
        return res.status(200).json({ success: true, message: 'User ranked successfully.' });

    } catch (error) {
        console.error(`❌ Rank error for User ${discordUserId}:`, error.message);
        return res.status(500).json({ success: false, error: 'Failed to rank user.', details: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Secure advanced server listening on port ${PORT}`);
});
