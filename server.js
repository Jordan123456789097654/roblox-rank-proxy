const express = require("express");
const app = express();
app.use(express.json());

const ROBLOX_API_KEY = process.env.ROBLOX_API_KEY;
const GROUP_ID = process.env.GROUP_ID;

app.post("/setrank", async (req, res) => {
  const { userId, roleId } = req.body;

  try {
    // 1. Get user's membership ID in the group via Roblox Open Cloud API
    const memRes = await fetch(
      `https://apis.roblox.com/cloud/v2/groups/${GROUP_ID}/memberships?maxPageSize=50`,
      { headers: { "x-api-key": ROBLOX_API_KEY } }
    );
    const memData = await memRes.json();
    
    let membershipId = null;
    for (let m of memData.groupMemberships || []) {
      if (m.user.endsWith(`/${userId}`)) {
        membershipId = m.path.split("/")[3];
        break;
      }
    }

    if (!membershipId) {
      return res.status(404).json({ error: "User not found in Roblox group." });
    }

    // 2. Update user's role via Roblox Open Cloud API
    const rankRes = await fetch(
      `https://apis.roblox.com/cloud/v2/groups/${GROUP_ID}/memberships/${membershipId}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ROBLOX_API_KEY
        },
        body: JSON.stringify({
          role: `groups/${GROUP_ID}/roles/${roleId}`
        })
      }
    );

    if (rankRes.ok) {
      return res.json({ success: true, message: "Rank updated successfully!" });
    } else {
      const err = await rankRes.json();
      return res.status(400).json({ error: err });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
