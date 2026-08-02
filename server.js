const express = require("express");

const app = express();
app.use(express.json());

// Load Environment Variables from Render
const CONFIG = {
  apiKey: process.env.ROBLOX_API_KEY,
  groupId: process.env.GROUP_ID,
  webhookUrl: process.env.DISCORD_WEBHOOK_URL,
  port: process.env.PORT || 3000,
};

// Request logger middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} request to ${req.path}`);
  next();
});

// ==========================================
// DISCORD WEBHOOK LOGGING
// ==========================================
async function sendDiscordLog({ success, userId, roleId, errorMessage, errorDetails }) {
  if (!CONFIG.webhookUrl) return;

  // Format the error description if it's a failure
  let embedDescription = success 
    ? `Successfully updated user rank.` 
    : `**Error Summary:** ${errorMessage || "An unknown error occurred during the ranking process."}`;

  // Try to extract Roblox-specific error messages if available
  if (!success && errorDetails && errorDetails.errors && errorDetails.errors.length > 0) {
    const robloxErr = errorDetails.errors[0];
    embedDescription += `\n**Roblox API Code:** ${robloxErr.code}\n**API Message:** ${robloxErr.message || "No specific message provided by Roblox."}`;
  }

  const embed = {
    title: success ? "✅ Roblox Rank Updated" : "❌ Rank Update Failed",
    description: embedDescription,
    color: success ? 0x2ecc71 : 0xe74c3c,
    fields: [
      { name: "Roblox User ID", value: `\`${userId || "Unknown"}\``, inline: true },
      { name: "Target Role ID", value: `\`${roleId || "Unknown"}\``, inline: true },
      { name: "Group ID", value: `\`${CONFIG.groupId || "Unknown"}\``, inline: true },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: "Roblox Ranking Proxy Log" }
  };

  // Add raw error JSON block for debugging if it failed
  if (!success && errorDetails) {
    const rawErrorString = typeof errorDetails === 'string' 
      ? errorDetails 
      : JSON.stringify(errorDetails, null, 2);
      
    embed.fields.push({
      name: "Raw API Response",
      value: `\`\`\`json\n${rawErrorString.slice(0, 1000)}\n\`\`\``
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
// ==========================================
app.get("/", (req, res) => {
  res.status(200).json({ status: "online", message: "Roblox Rank Proxy Service Active" });
});

app.get("/setrank", (req, res) => {
  res.status(200).json({ status: "ready", message: "Send a POST request with userId and roleId to rank." });
});

// ==========================================
// RANK MANAGEMENT ENDPOINT
// ==========================================
app.post("/setrank", async (req, res) => {
  const { userId, roleId } = req.body;

  if (!CONFIG.apiKey || !CONFIG.groupId) {
    const msg = "Missing ROBLOX_API_KEY or GROUP_ID in Render Environment Variables.";
    console.error(`[Config Error] ${msg}`);
    return res.status(500).json({ success: false, error: msg });
  }

  if (!userId || !roleId) {
    const msg = "Invalid request body. 'userId' and 'roleId' are required.";
    console.warn(`[Validation Error] ${msg}`);
    return res.status(400).json({ success: false, error: msg });
  }

  try {
    // 1. Fetch User Group Membership
    const lookupUrl = `https://apis.roblox.com/cloud/v2/groups/${CONFIG.groupId}/memberships/-/users/${userId}`;
    const lookupResponse = await fetch(lookupUrl, {
      method: "GET",
      headers: { "x-api-key": CONFIG.apiKey },
    });

    if (!lookupResponse.ok) {
      let errDetail;
      try { errDetail = await lookupResponse.json(); } 
      catch (e) { errDetail = await lookupResponse.text(); }

      const msg = `User lookup failed. They may not be in the group, or the API key lacks read permissions.`;
      console.warn(`[Roblox Lookup Failed] User ${userId}:`, errDetail);
      
      await sendDiscordLog({ success: false, userId, roleId, errorMessage: msg, errorDetails: errDetail });
      return res.status(404).json({ success: false, error: msg });
    }

    const membershipData = await lookupResponse.json();
    const pathParts = membershipData.path ? membershipData.path.split("/") : [];
    const membershipId = pathParts[3];

    if (!membershipId) {
      const msg = "Failed to parse user membership ID from Roblox API response.";
      console.error(`[Parsing Error] ${msg}`, membershipData);
      await sendDiscordLog({ success: false, userId, roleId, errorMessage: msg, errorDetails: membershipData });
      return res.status(500).json({ success: false, error: msg });
    }

    // 2. Send PATCH Request to Update Role (Requires ?updateMask=role)
    const updateUrl = `https://apis.roblox.com/cloud/v2/groups/${CONFIG.groupId}/memberships/${membershipId}?updateMask=role`;
    
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
      let apiError;
      try { apiError = await updateResponse.json(); } 
      catch (e) { apiError = await updateResponse.text(); }

      const msg = "Roblox API rejected the role update. Check role hierarchy and API key permissions.";
      console.error(`[Roblox Role Update Failed] User ${userId}:`, apiError);
      
      await sendDiscordLog({ success: false, userId, roleId, errorMessage: msg, errorDetails: apiError });
      return res.status(updateResponse.status).json({ success: false, error: msg, details: apiError });
    }

    // 3. Success Confirmation & Discord Log
    console.log(`[Success] User ${userId} updated to Role ID ${roleId}`);
    await sendDiscordLog({ success: true, userId, roleId });

    return res.status(200).json({
      success: true,
      message: `User ${userId} successfully set to role ${roleId}`,
    });

  } catch (err) {
    const msg = "Internal proxy server exception occurred.";
    console.error("[Runtime Exception]", err);
    await sendDiscordLog({ success: false, userId, roleId, errorMessage: msg, errorDetails: err.message });
    return res.status(500).json({ success: false, error: msg, details: err.message });
  }
});

app.listen(CONFIG.port, () => {
  console.log(`========================================`);
  console.log(`Proxy running on port ${CONFIG.port}`);
  console.log(`Ready for incoming BotGhost requests.`);
  console.log(`========================================`);
});
