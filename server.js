const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// Middleware & Security
// ==========================================
app.use(helmet()); // Secures HTTP headers
app.use(express.json());

// Global Rate Limiter: Max 30 requests per minute per IP
const limiter = rateLimit({
    windowMs: 60 * 1000, 
    max: 30,
    message: { error: 'Too many requests. Please try again later.' }
});
app.use(limiter);

// Custom Middleware: Request Logging
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
    next();
});

// Custom Middleware: API Key Authentication
const authenticateRequest = (req, res, next) => {
    // Allows the key to be sent in headers OR the JSON body
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

// Main Ranking Endpoint (Protected by Authentication)
app.post('/setrank', authenticateRequest, async (req, res) => {
    const { userId, roleId } = req.body;
    const cookie = process.env.ROBLOX_COOKIE;
    const groupId = process.env.GROUP_ID;

    if (!cookie || !groupId) {
        return res.status(500).json({ error: 'Missing ROBLOX_COOKIE or GROUP_ID.' });
    }
    if (!userId || !roleId) {
        return res.status(400).json({ error: 'Missing userId or roleId in request body.' });
    }

    try {
        let csrfToken = null;

        // 1. Fetch Initial CSRF Token
        const csrfResponse = await fetch('https://auth.roblox.com/v1/logout', {
            method: 'POST',
            headers: { 'Cookie': `.ROBLOSECURITY=${cookie}` }
        });
        csrfToken = csrfResponse.headers.get('x-csrf-token');

        if (!csrfToken) {
            throw new Error('Failed to fetch initial X-CSRF-TOKEN.');
        }

        // 2. Function to attempt the rank update
        const attemptRankUpdate = async (token) => {
            return await fetch(`https://groups.roblox.com/v1/groups/${groupId}/users/${userId}`, {
                method: 'PATCH',
                headers: {
                    'Cookie': `.ROBLOSECURITY=${cookie}`,
                    'x-csrf-token': token,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ roleId: parseInt(roleId, 10) })
            });
        };

        // 3. First Attempt
        let rankResponse = await attemptRankUpdate(csrfToken);

        // 4. Retry Logic (If Roblox rejects the token, they send a new one in the headers of the 403 response)
        if (rankResponse.status === 403 && rankResponse.headers.has('x-csrf-token')) {
            console.log('Token rejected. Retrying with fresh token from 403 response...');
            csrfToken = rankResponse.headers.get('x-csrf-token');
            rankResponse = await attemptRankUpdate(csrfToken);
        }

        const responseData = await rankResponse.json().catch(() => ({}));

        // 5. Handle Success
        if (rankResponse.ok) {
            await sendWebhook({
                title: '✅ Rank Update Successful',
                color: 0x2ecc71,
                fields: [
                    { name: 'User ID', value: String(userId), inline: true },
                    { name: 'New Role ID', value: String(roleId), inline: true }
                ],
                timestamp: new Date().toISOString()
            });
            return res.status(200).json({ success: true, message: 'User ranked successfully.' });
        }

        // 6. Handle Failure
        throw new Error(JSON.stringify(responseData));

    } catch (error) {
        const errorMessage = error.message || 'Unknown error occurred';
        
        await sendWebhook({
            title: '❌ Rank Update Failed',
            color: 0xe74c3c,
            description: `Attempt to rank User ID **${userId}** failed.`,
            fields: [{ name: 'Error', value: `\`\`\`json\n${errorMessage.substring(0, 500)}\n\`\`\`` }],
            timestamp: new Date().toISOString()
        });

        console.error(`Rank error for User ${userId}:`, errorMessage);
        return res.status(500).json({ success: false, error: 'Failed to rank user.' });
    }
});

app.listen(PORT, () => {
    console.log(`Secure server listening on port ${PORT}`);
});
