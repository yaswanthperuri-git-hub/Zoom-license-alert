const crypto = require('crypto');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const SLACK_URL = process.env.SLACK_WEBHOOK_URL;

  let body = '';
  await new Promise((resolve) => {
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', resolve);
  });

  const parsedBody = JSON.parse(body);
  const { event, payload, event_ts } = parsedBody;
  const ZOOM_SECRET = process.env.ZOOM_SECRET_TOKEN;

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

    // user.updated sends data differently
    const name = obj.first_name && obj.last_name
      ? `${obj.first_name} ${obj.last_name}`
      : obj.display_name || obj.id || 'Unknown User';
    const email = obj.email || obj.work_email || 'N/A';

    console.log('ZOOM EVENT:', event);
    console.log('ZOOM PAYLOAD:', JSON.stringify(parsedBody, null, 2));

    await fetch(SLACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: '🔄 Zoom User Changed' }
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*User:*\n${name}` },
              { type: 'mrkdwn', text: `*Email:*\n${email}` },
              { type: 'mrkdwn', text: `*Event:*\n${event}` },
              { type: 'mrkdwn', text: `*Changes:*\n\`\`\`${JSON.stringify(obj.settings || obj, null, 2).slice(0, 300)}\`\`\`` }
            ]
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `Triggered at <!date^${Math.floor(event_ts / 1000)}^{date_short_pretty} at {time}|just now>`
              }
            ]
          }
        ]
      })
    });
  }

  return res.status(200).send('OK');
};
