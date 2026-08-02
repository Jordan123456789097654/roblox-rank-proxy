const express = require("express");
const app = express();
app.use(express.json());

const ROBLOX_API_KEY = "txSWakGRZkKuci6iNkpP4nTjzAqxzAxk/uNe96pb0C5eugCkZXlKaGJHY2lPaUpTVXpJMU5pSXNJbXRwWkNJNkluTnBaeTB5TURJeExUQTNMVEV6VkRFNE9qVXhPalE1V2lJc0luUjVjQ0k2SWtwWFZDSjkuZXlKaGRXUWlPaUpTYjJKc2IzaEpiblJsY201aGJDSXNJbWx6Y3lJNklrTnNiM1ZrUVhWMGFHVnVkR2xqWVhScGIyNVRaWEoyYVdObElpd2lZbUZ6WlVGd2FVdGxlU0k2SW5SNFUxZGhhMGRTV210TGRXTnBObWxPYTNCUU5HNVVhbnBCY1hoNlFYaHJMM1ZPWlRrMmNHSXdRelZsZFdkRGF5SXNJbTkzYm1WeVNXUWlPaUl4TURRek5ETXlORGs0TUNJc0ltVjRjQ0k2TVRjNE5UWTVOams0TWl3aWFXRjBJam94TnpnMU5qa3pNemd5TENKdVltWWlPakUzT0RVMk9UTXpPREo5Lmx4LWk1MTBGVTNQR0J2RUxWRDNhV2dselV2eFE4NG5OekxpeTVNZ2VoVmlQZTlsTXhBRE9QU2RRUnVpX1dMOGtPWTZyWmJieWI5MWJIblVUQnFibnY3dC1UN1BSSVhveExpSFJRRWI4WER1X1B2bmltN3JoQUd3aXVfRW96a0IteEtFSEVPVlVyM2tOTjBtWUxPMTFaOXdydDkxYXgzazg4a0tTX1RDYnQxZlMzZGlfSXFsdFlndWUzX1VpYjQ5R2pUakpDclZKcXV6SUZmVFBVQlZwMWYzZTlBZ0lQY2Z3UVFTODF5Y001bkFkcUd4U1BrUC1DN200MXd2TkhIcW43UWtfQXp4XzhNRXRCQWtpUU9PLXp3eHYtMTFvMmNKVDZIT1NleE5ld0Q4dV9XX085c0g1UTVDU250cHkxMEdPT3I5Z2VRTnJXYnRSZWMxU3lRZDEyQQ==";
const GROUP_ID = "14910342;

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
