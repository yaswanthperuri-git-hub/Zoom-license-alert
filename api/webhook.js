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

    // Fetch user details from Zoom API
    const userRes = await fetch(`https://api.zoom.us/v2/users/${userId}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const userData = await userRes.json();

    const name = `${userData.first_name} ${userData.last_name}`;
    const email = userData.email;

    // Format what changed
    const changes = obj.settings
      ? Object.entries(obj.settings).map(([key, val]) => {
          if (typeof val === 'object') {
            return Object.entries(val).map(([k, v]) => `• ${k}: ${v}`).join('\n');
          }
          return `• ${key}: ${val}`;
        }).join('\n')
      : JSON.stringify(obj, null, 2).slice(0, 300);

    console.log('ZOOM EVENT:', event);
    console.log('USER:', name, email);
    console.log('CHANGES:', changes);

    await fetch(SLACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: '🔄 Zoom User Updated' }
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*👤 User:*\n${name}` },
              { type: 'mrkdwn', text: `*📧 Email:*\n${email}` }
            ]
          },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `*🔁 Event:*\n${event}` }
          },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `*📝 What Changed:*\n${changes}` }
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `⏱ Triggered at <!date^${Math.floor(event_ts / 1000)}^{date_short_pretty} at {time}|just now>`
              }
            ]
          }
        ]
      })
    });
  }

  return res.status(200).send('OK');
};
