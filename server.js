const express = require("express");

const app = express();

// Enable JSON body parsing
app.use(express.json());

// Load Environment Variables from Render
const CONFIG = {
  apiKey: process.env.ROBLOX_API_KEY,
  groupId: process.env.GROUP_ID,
  webhookUrl: process.env.DISCORD_WEBHOOK_URL, // New Discord Webhook URL
  port: process.env.PORT || 3000,
};

// Request logger middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} request to ${req.path}`);
  next();
});

// Helper Function: Send Logs to Discord Webhook
async function sendDiscordLog({ success, userId, roleId, errorDetails }) {
  if (!CONFIG.webhookUrl) return; // Skip if no webhook URL is set in Render

  const embed = {
    title: success ? "✅ Roblox Rank Updated" : "❌ Rank Update Failed",
    color: success ? 0x2ecc71 : 0xe74c3c, // Green for success, Red for failure
    fields: [
      { name: "Roblox User ID", value: `\`${userId || "Unknown"}\``, inline: true },
      { name: "Target Role ID", value: `\`${roleId || "Unknown"}\``, inline: true },
      { name: "Group ID", value: `\`${CONFIG.groupId || "Unknown"}\``, inline: true },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: "Roblox Ranking Proxy Log" }
  };

  if (!success && errorDetails) {
    embed.fields.push({
      name: "Error Details",
      value: `\`\`\`json\n${JSON.stringify(errorDetails, null, 2).slice(0, 1000)}\n\`\`\``
    });
  }

  try {
    await fetch(CONFIG.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
  } catch (err) {
    console.error("[Webhook Error] Failed to send log to Discord:", err.message);
  }
}

// ==========================================
// HEALTH & UPTIME ENDPOINTS
// Keeps UptimeRobot green and handles browser checks
// ==========================================

app.get("/", (req, res) => {
  res.status(200).json({ status: "online", message: "Roblox Rank Proxy Service Active" });
});

app.get("/setrank", (req, res) => {
  res.status(200).json({ status: "ready", message: "Send a POST request with userId and roleId to rank." });
});

// ==========================================
// RANK MANAGEMENT ENDPOINT
// Primary target for BotGhost HTTP actions
// ==========================================

app.post("/setrank", async (req, res) => {
  const { userId, roleId } = req.body;

  // 1. Verify Render Environment Variables
  if (!CONFIG.apiKey || !CONFIG.groupId) {
    console.error("[Config Error] Missing ROBLOX_API_KEY or GROUP_ID in Render Environment Variables.");
    return res.status(500).json({
      success: false,
      error: "Server configuration error: Missing environment variables on host.",
    });
  }

  // 2. Validate Payload
  if (!userId || !roleId) {
    console.warn("[Validation Error] Missing userId or roleId in request body:", req.body);
    return res.status(400).json({
      success: false,
      error: "Invalid request body. 'userId' and 'roleId' are required.",
    });
  }

  try {
    // 3. Fetch User Group Membership directly via Roblox Open Cloud v2
    const lookupUrl = `https://apis.roblox.com/cloud/v2/groups/${CONFIG.groupId}/memberships/-/users/${userId}`;
    
    const lookupResponse = await fetch(lookupUrl, {
      method: "GET",
      headers: {
        "x-api-key": CONFIG.apiKey,
      },
    });

    if (!lookupResponse.ok) {
      const errDetail = await lookupResponse.text();
      console.warn(`[Roblox Lookup Failed] User ${userId} status ${lookupResponse.status}: ${errDetail}`);
      
      // Log failure to Discord
      await sendDiscordLog({ success: false, userId, roleId, errorDetails: errDetail });

      return res.status(404).json({
        success: false,
        error: `User ${userId} not found in group ${CONFIG.groupId} or API Key permissions are invalid.`,
      });
    }

    const membershipData = await lookupResponse.json();
    
    // Extract Membership ID from path format: "groups/{group}/memberships/{membership}"
    const pathParts = membershipData.path ? membershipData.path.split("/") : [];
    const membershipId = pathParts[3];

    if (!membershipId) {
      console.error("[Parsing Error] Unable to resolve membership ID from path:", membershipData.path);
      return res.status(500).json({
        success: false,
        error: "Failed to parse user membership ID from Roblox API response.",
      });
    }

    // 4. Send PATCH Request to Update Role
    const updateUrl = `https://apis.roblox.com/cloud/v2/groups/${CONFIG.groupId}/memberships/${membershipId}`;
    
    const updateResponse = await fetch(updateUrl, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CONFIG.apiKey,
      },
      body: JSON.stringify({
        role: `groups/${CONFIG.groupId}/roles/${roleId}`,
      }),
    });

    if (!updateResponse.ok) {
      const apiError = await updateResponse.json();
      console.error(`[Roblox Role Update Failed] User ${userId}:`, apiError);

      // Log failure to Discord
      await sendDiscordLog({ success: false, userId, roleId, errorDetails: apiError });

      return res.status(updateResponse.status).json({
        success: false,
        error: "Roblox API rejected role update.",
        details: apiError,
      });
    }

    // 5. Success Confirmation & Discord Log
    console.log(`[Success] User ${userId} updated to Role ID ${roleId}`);
    
    // Send success log to Discord Webhook
    await sendDiscordLog({ success: true, userId, roleId });

    return res.status(200).json({
      success: true,
      message: `User ${userId} successfully set to role ${roleId}`,
    });

  } catch (err) {
    console.error("[Runtime Exception]", err);
    
    // Log exception to Discord
    await sendDiscordLog({ success: false, userId, roleId, errorDetails: err.message });

    return res.status(500).json({
      success: false,
      error: "Internal proxy server error.",
      details: err.message,
    });
  }
});

// Start Server Binding
app.listen(CONFIG.port, () => {
  console.log(`========================================`);
  console.log(`Proxy running on port ${CONFIG.port}`);
  console.log(`Ready for incoming BotGhost requests.`);
  console.log(`========================================`);
});
