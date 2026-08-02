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

app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
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
// Utility Functions
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

// ==========================================
// Routes
// ==========================================
app.get('/', (req, res) => {
    res.status(200).json({ status: 'online', secure: true });
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

    let targetRobloxId = null;

    try {
        // 1. Resolve Discord User to Roblox User via Bloxlink V4 API
        const bloxlinkRes = await fetch(`https://api.blox.link/v4/public/guilds/${discordServerId}/discord-to-roblox/${discordUserId}`, {
            headers: { 'Authorization': bloxlinkApiKey }
        });
        
        const bloxlinkData = await bloxlinkRes.json();
        
        if (!bloxlinkRes.ok || !bloxlinkData.robloxID) {
            throw new Error('User is not verified on Bloxlink or not in the server.');
        }

        targetRobloxId = bloxlinkData.robloxID;

        // 2. Fetch Initial CSRF Token
        let csrfToken = null;
        const csrfResponse = await fetch('https://auth.roblox.com/v1/logout', {
            method: 'POST',
            headers: { 'Cookie': `.ROBLOSECURITY=${cookie}` }
        });
        csrfToken = csrfResponse.headers.get('x-csrf-token');

        if (!csrfToken) {
            throw new Error('Failed to fetch initial X-CSRF-TOKEN.');
        }

        // 3. Rank Update Function
        const attemptRankUpdate = async (token) => {
            return await fetch(`https://groups.roblox.com/v1/groups/${groupId}/users/${targetRobloxId}`, {
                method: 'PATCH',
                headers: {
                    'Cookie': `.ROBLOSECURITY=${cookie}`,
                    'x-csrf-token': token,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ roleId: parseInt(roleId, 10) })
            });
        };

        // 4. First Attempt
        let rankResponse = await attemptRankUpdate(csrfToken);

        // 5. Retry Logic for Stale CSRF Tokens
        if (rankResponse.status === 403 && rankResponse.headers.has('x-csrf-token')) {
            csrfToken = rankResponse.headers.get('x-csrf-token');
            rankResponse = await attemptRankUpdate(csrfToken);
        }

        const responseData = await rankResponse.json().catch(() => ({}));

        // 6. Handle Success
        if (rankResponse.ok) {
            await sendWebhook({
                title: '✅ Rank Update Successful',
                color: 0x2ecc71,
                fields: [
                    { name: 'Discord ID', value: String(discordUserId), inline: true },
                    { name: 'Roblox ID', value: String(targetRobloxId), inline: true },
                    { name: 'New Role ID', value: String(roleId), inline: true }
                ],
                timestamp: new Date().toISOString()
            });
            return res.status(200).json({ success: true, message: 'User ranked successfully.' });
        }

        throw new Error(JSON.stringify(responseData));

    } catch (error) {
        const errorMessage = error.message || 'Unknown error occurred';
        
        await sendWebhook({
            title: '❌ Rank Update Failed',
            color: 0xe74c3c,
            description: `Attempt to rank Discord User **${discordUserId}** failed.`,
            fields: [{ name: 'Error', value: `\`\`\`json\n${errorMessage.substring(0, 500)}\n\`\`\`` }],
            timestamp: new Date().toISOString()
        });

        console.error(`Rank error for User ${discordUserId}:`, errorMessage);
        return res.status(500).json({ success: false, error: 'Failed to rank user.', details: errorMessage });
    }
});

app.listen(PORT, () => {
    console.log(`Secure server listening on port ${PORT}`);
});
