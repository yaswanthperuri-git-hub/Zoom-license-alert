const crypto = require('crypto');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const SLACK_URL = process.env.SLACK_WEBHOOK_URL;
  const ZOOM_SECRET = process.env.ZOOM_SECRET_TOKEN;
  const ZOOM_ACCOUNT_ID = process.env.ZOOM_ACCOUNT_ID;
  const ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID;
  const ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;

  let body = '';
  await new Promise((resolve) => {
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', resolve);
  });

  const parsedBody = JSON.parse(body);
  const { event, payload, event_ts } = parsedBody;

  // Zoom URL verification handshake
  if (event === 'endpoint.url_validation') {
    const hash = crypto
      .createHmac('sha256', ZOOM_SECRET)
      .update(payload.plainToken)
      .digest('hex');
    return res.json({ plainToken: payload.plainToken, encryptedToken: hash });
  }

  const userEvents = [
    'user.updated',
    'user.settings_updated',
    'user.activated',
    'user.deactivated',
    'user.created'
  ];

  if (userEvents.includes(event)) {
    const obj = payload.object;
    const userId = obj.id;

    // Get Zoom access token
    const tokenRes = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${ZOOM_ACCOUNT_ID}`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    // Fetch user details
    const userRes = await fetch(`https://api.zoom.us/v2/users/${userId}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const userData = await userRes.json();

    const name = `${userData.first_name} ${userData.last_name}`;
    const email = userData.email;

    // Build one line message
    const settings = obj.settings?.feature || obj.settings || obj;
    const messages = [];

    for (const [key, value] of Object.entries(settings)) {
      if (key === 'meeting_capacity') {
        messages.push(`Meeting capacity changed to ${value}`);
      } else if (key === 'large_meeting') {
        messages.push(value
          ? `Large Meeting license has been added`
          : `Large Meeting license has been removed`
        );
      } else if (key === 'large_meeting_capacity') {
        messages.push(`Large Meeting capacity changed to ${value}`);
      } else if (key === 'webinar') {
        messages.push(value
          ? `Webinar license has been added`
          : `Webinar license has been removed`
        );
      } else if (key === 'webinar_capacity') {
        messages.push(`Webinar capacity changed to ${value}`);
      } else if (key === 'zoom_phone') {
        messages.push(value
          ? `Zoom Phone license has been added`
          : `Zoom Phone license has been removed`
        );
      } else {
        messages.push(`${key} changed to ${value}`);
      }
    }

    // Format date
    const date = new Date(event_ts);
    const timeStr = date.toLocaleString('en-US', {
      month: 'short', day: 'numeric',
      year: 'numeric', hour: 'numeric',
      minute: '2-digit', hour12: true
    });

    const messageText = messages.join(', ') + ` — ${timeStr}`;

    await fetch(SLACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `🔄 *Zoom License Changed*\n*Name:* ${name}\n*Email:* ${email}\n*Message:* ${messageText}`
            }
          }
        ]
      })
    });
  }

  return res.status(200).send('OK');
};
